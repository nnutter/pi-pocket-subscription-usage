import assert from "node:assert/strict";
import test from "node:test";
import setup from "../subscription-usage/index.js";

function renderQuotaPage(reports) {
    const data = { at: Date.now(), reports };
    const disposers = [];
    let page;
    let firstState = true;
    const oldWindow = globalThis.window;
    globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
    try {
        setup({
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
        });
        return page().values[0]({}).values.find(Array.isArray);
    } finally {
        for (const dispose of disposers) dispose();
        globalThis.window = oldWindow;
    }
}

test("the quota page shows Copilot notes and the remaining credit value", () => {
    const report = {
        id: "github-copilot", name: "GitHub Copilot", ok: true,
        limits: [], notes: ["Premium requests are unlimited."],
    };
    const creditReport = {
        id: "github-copilot", name: "GitHub Copilot", ok: true,
        limits: [{ label: "Month", percent: 13, remainingCredits: 1306, level: "ok" }], notes: [],
    };
    const plans = renderQuotaPage([report, creditReport]);
    assert.ok(plans.some((plan) => plan.values.includes(report)), "the page must include the Copilot report");
    const creditPlan = plans.find((plan) => plan.values.includes(creditReport));
    const planTree = creditPlan.values[0]({ report: creditReport, index: 0 });
    const containsLabel = (value) =>
        value === "Month ($13.06)" || (Array.isArray(value) && value.some(containsLabel)) ||
        (value && typeof value === "object" && Array.isArray(value.values) && value.values.some(containsLabel));
    assert.ok(containsLabel(planTree), "the page must show the remaining credits in dollars");
});

test("the quota page prioritizes remaining quota relative to time left", () => {
    const hour = 3_600_000;
    const now = Date.now();
    const timed = (percent, hoursLeft, hoursTotal = 10) => ({
        label: "Window", percent, windowMs: hoursTotal * hour,
        resetsAt: new Date(now + hoursLeft * hour).toISOString(), level: "ok",
    });
    const plan = (id, limits) => ({ id, name: id, ok: true, limits });
    const untimed = plan("untimed", [{ label: "Rolling", percent: 0, windowMs: 100 * hour }]);
    const later = plan("later", [timed(20, 5), timed(0, 0, 1)]);
    const sooner = plan("sooner", [timed(60, 1), { ...untimed.limits[0], percent: 70 }]);
    const expired = plan("expired", [timed(90, -1)]);
    const reports = [untimed, later, sooner, expired];
    const shown = renderQuotaPage(reports);
    assert.deepEqual(
        shown.map((row) => reports.find((report) => row.values.includes(report))?.id),
        ["expired", "sooner", "later", "untimed"],
    );
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
