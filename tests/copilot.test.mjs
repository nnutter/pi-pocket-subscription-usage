import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Replace the credential store and other providers at the extension boundary. No real sign-in or CLI is used.
const agent = `
    export class ModelRuntime {
        static async create() { return { getAuth: async () => undefined }; }
    }
    export function readStoredCredential() { return globalThis.copilotTest.credential; }
`;
const childProcess = `
    import { EventEmitter } from "node:events";
    import { PassThrough } from "node:stream";
    export function spawn() {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => {};
        process.nextTick(() => {
            child.emit("error", Object.assign(new Error("not installed"), { code: "ENOENT" }));
            child.emit("close");
        });
        return child;
    }
`;
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (context.parentURL?.endsWith("/subscription-usage.ts")) {
            if (specifier === "@earendil-works/pi-coding-agent") {
                return { url: moduleUrl(agent), shortCircuit: true };
            }
            if (specifier === "node:child_process") {
                return { url: moduleUrl(childProcess), shortCircuit: true };
            }
        }
        return nextResolve(specifier, context);
    },
});
const { default: createSubscriptionUsage } = await import("../subscription-usage.ts");

async function readUsage({ credential, body = {}, status = 200 }) {
    globalThis.copilotTest = { credential };
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify(body), { status });
    };
    const routes = new Map();
    const web = {
        onDispose() {},
        route(method, path, handler) { routes.set(path, handler); },
        conversationRoute(method, path, handler) { routes.set(path, handler); },
        client() {},
    };
    try {
        createSubscriptionUsage({}, web);
        const { reports } = await routes.get("usage")({ query: new URLSearchParams() });
        const quota = await routes.get("quota/:source")({
            query: new URLSearchParams(),
            conversation: { model: { provider: "github-copilot", id: "model" } },
        });
        return { report: reports.find((report) => report.id === "github-copilot"), requests, quota };
    } finally {
        globalThis.fetch = originalFetch;
    }
}

const signIn = { type: "oauth", refresh: "github-secret", access: "inference-secret", expires: 0 };

test("reports GitHub quotas without exposing credentials", async () => {
    const { report, requests, quota } = await readUsage({
        credential: signIn,
        body: {
            token_based_billing: true,
            quota_reset_date: "2027-03-01",
            quota_snapshots: {
                premium_interactions: { percent_remaining: 24.5, remaining: 367.5, overage_permitted: true, quota_reset_at: 1801440000 },
                chat: { percent_remaining: 90, remaining: 90, quota_reset_at: 0 },
                completions: { unlimited: true },
            },
        },
    });
    assert.deepEqual(report, {
        id: "github-copilot", name: "GitHub Copilot", ok: true,
        limits: [
            { label: "Month", percent: 75.5, remainingCredits: 367.5, resetsAt: "2027-02-01T00:00:00.000Z", level: "warning" },
            { label: "Chat", percent: 10, resetsAt: "2027-03-01T00:00:00.000Z", level: "ok" },
        ],
        notes: ["Month: paid overage is enabled."],
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.github.com/copilot_internal/user");
    assert.equal(requests[0].options.headers.authorization, "token github-secret");
    assert.equal(requests[0].options.redirect, "error");
    assert.doesNotMatch(JSON.stringify(report), /github-secret|inference-secret/);
    assert.equal(quota.label, "Copilot");
    assert.deepEqual(quota.report, report);
});

test("omits the credit balance when GitHub does not confirm credit billing", async () => {
    for (const body of [
        { token_based_billing: true, quota_snapshots: { premium_interactions: { percent_remaining: 25 } } },
        { token_based_billing: false, quota_snapshots: { premium_interactions: { percent_remaining: 25, remaining: 30 } } },
        { quota_snapshots: { premium_interactions: { percent_remaining: 25, remaining: 30 } } },
    ]) {
        const { report } = await readUsage({ credential: signIn, body });
        assert.equal(report.limits[0].percent, 75);
        assert.equal(Object.hasOwn(report.limits[0], "remainingCredits"), false);
    }
});

test("does not invent a quota when GitHub gives no valid percentage", async () => {
    const { report } = await readUsage({
        credential: signIn,
        body: { quota_snapshots: { premium_interactions: { percent_remaining: null } } },
    });
    assert.deepEqual(report.limits, []);
    assert.deepEqual(report.notes, ["GitHub did not report any limited quota data for this account."]);
});

test("does not show notes for unlimited chat or completions", async () => {
    const { report } = await readUsage({
        credential: signIn,
        body: { quota_snapshots: { chat: { unlimited: true }, completions: { unlimited: true } } },
    });
    assert.deepEqual(report.limits, []);
    assert.deepEqual(report.notes, ["GitHub did not report any limited quota data for this account."]);
});

test("does not send credentials when sign-in is absent or for Enterprise", async () => {
    for (const credential of [undefined, { ...signIn, enterpriseUrl: "example.com" }]) {
        const { report, requests } = await readUsage({ credential });
        assert.equal(report.ok, false);
        assert.equal(requests.length, 0);
        assert.equal(Boolean(report.missing), credential === undefined);
        assert.doesNotMatch(JSON.stringify(report), /github-secret|inference-secret/);
    }
});

test("reports a refused sign-in without returning the server response", async () => {
    const { report } = await readUsage({ credential: signIn, status: 401, body: { message: "github-secret" } });
    assert.equal(report.ok, false);
    assert.match(report.error, /refused the sign-in/);
    assert.doesNotMatch(JSON.stringify(report), /github-secret|inference-secret/);
});
