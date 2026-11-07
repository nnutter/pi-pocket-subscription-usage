import assert from "node:assert/strict";
import test from "node:test";
import setup from "../subscription-usage/index.js";

test("the quota page shows Copilot notes and the remaining credit value", () => {
    const report = {
        id: "github-copilot", name: "GitHub Copilot", ok: true,
        limits: [], notes: ["Premium requests are unlimited."],
    };
    const creditReport = {
        id: "github-copilot", name: "GitHub Copilot", ok: true,
        limits: [{ label: "Month", percent: 13, remainingCredits: 1306, level: "ok" }], notes: [],
    };
    const data = { at: Date.now(), reports: [report, creditReport] };
    const disposers = [];
    let page;
    let firstState = true;
    const oldWindow = globalThis.window;
    globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
    const pocket = {
        html: (strings, ...values) => ({ strings, values }),
        useEffect() {},
        useState(initial) {
            const value = firstState ? data : initial;
            firstState = false;
            return [value, () => {}];
        },
        style() {},
        page(options) { page = options.component; },
        rail() { return { update() {} }; },
        launcher() { return { update() {} }; },
        onDispose(fn) { disposers.push(fn); },
        api: async () => data,
    };
    try {
        setup(pocket);
        const pageTree = page();
        const usageTree = pageTree.values[0]({});
        const containsReport = (value) =>
            value === report || (Array.isArray(value) && value.some(containsReport)) ||
            (value && typeof value === "object" && Array.isArray(value.values) && value.values.some(containsReport));
        assert.ok(containsReport(usageTree), "the page must include the Copilot report");
        const plans = usageTree.values.find(Array.isArray);
        const creditPlan = plans.find((plan) => plan.values.includes(creditReport));
        const planTree = creditPlan.values[0]({ report: creditReport, index: 0 });
        const containsLabel = (value) =>
            value === "Month ($13.06)" || (Array.isArray(value) && value.some(containsLabel)) ||
            (value && typeof value === "object" && Array.isArray(value.values) && value.values.some(containsLabel));
        assert.ok(containsLabel(planTree), "the page must show the remaining credits in dollars");
    } finally {
        for (const dispose of disposers) dispose();
        globalThis.window = oldWindow;
    }
});

test("the Copilot status stays concise and identifies separate quotas", async () => {
    const report = {
        id: "github-copilot", name: "GitHub Copilot", ok: true,
        limits: [
            { label: "Month", percent: 60, level: "ok" },
            { label: "Completions", percent: 100, level: "critical" },
        ],
        notes: ["Month: paid overage is enabled."],
    };
    const disposers = [];
    let status;
    let switchConversation;
    const oldWindow = globalThis.window;
    globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
    const pocket = {
        html() {}, useEffect() {}, useState() {}, style() {}, page() {},
        rail() { return { update() {} }; },
        launcher() { return { update() {} }; },
        status(options) { status = options; return { update() {}, remove() {} }; },
        onConversation(fn) { switchConversation = fn; fn("conversation"); return () => {}; },
        conversationId() { return "conversation"; },
        onDispose(fn) { disposers.push(fn); },
        api: async (path) => path.startsWith("quota/")
            ? { at: Date.now(), label: "Copilot", report, model: { provider: "github-copilot" } }
            : { at: Date.now(), reports: [report] },
    };
    try {
        setup(pocket);
        await new Promise((resolve) => setImmediate(resolve));
        assert.match(status.text, /Completions.*0% left/);
        assert.match(status.short, /Completions.*0%/);
        assert.match(status.title, /Month: paid overage is enabled/);
        report.limits.pop();
        switchConversation("conversation");
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(status.text, "Copilot 40% left");
        assert.equal(status.short, "40%");
    } finally {
        for (const dispose of disposers) dispose();
        globalThis.window = oldWindow;
    }
});
