/**
 * Subscription usage: a page on the rail with how much of your Claude, GitHub Copilot, ChatGPT (Codex), OpenCode Go,
 * Grok, Z.ai, MiniMax, and Muse Code plans is used, and when each limit resets, plus the DeepSeek and Ollama Cloud
 * balances when Pi has a key for them. The server asks each service with the sign-ins already on this machine, so no key
 * or token reaches the browser.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as codingAgent from "@earendil-works/pi-coding-agent";
// A type import is gone when the module runs: only the type checker reads this path. Pi Pocket links the public types
// beside the drop-in, as `_pocket.d.ts`.
import type { Web } from "./_pocket.d.ts";

/** The version of Pi Pocket's extension API this module is written for. */
export const pocketApi = 1;

type Level = "ok" | "warning" | "critical";

interface Limit {
    label: string;
    percent: number;
    resetsAt?: string;
    level: Level;
    /** The limit that holds you back now, when the service says which. */
    binding?: boolean;
    /** How long the window is, in milliseconds, when the service says: the page ranks plans by their longest one. */
    windowMs?: number;
    /** Copilot's remaining AI credits, each worth one US cent. */
    remainingCredits?: number;
}

/** A prepaid account's balance: money left, not a share of a plan used. */
interface Balance {
    currency: string;
    total: number;
    granted: number;
    toppedUp: number;
    /** Whether the service says it can take paid calls now. */
    enough: boolean;
}

type Report =
    | { id: string; name: string; ok: true; limits: Limit[]; notes: string[]; balance?: Balance }
    | { id: string; name: string; ok: false; error: string; missing?: boolean };

type OkReport = Extract<Report, { ok: true }>;

/**
 * The plan report that a Pi model provider belongs to, and the name that fits the status line. The report's credentials
 * are Pi's sign-in to the provider (Codex's are the Codex CLI's own): a regional or API-key variant with another
 * sign-in shows no quota.
 */
const PROVIDER_REPORTS: Record<string, { report: string; label: string }> = {
    anthropic: { report: "anthropic", label: "Claude" },
    "github-copilot": { report: "github-copilot", label: "Copilot" },
    "openai-codex": { report: "openai", label: "Codex" },
    "opencode-go": { report: "opencode-go", label: "OpenCode Go" },
    xai: { report: "xai", label: "Grok" },
    zai: { report: "zai", label: "Z.ai" },
    minimax: { report: "minimax", label: "MiniMax" },
    deepseek: { report: "deepseek", label: "DeepSeek" },
    "ollama-cloud": { report: "ollama", label: "Ollama" },
    ollama: { report: "ollama", label: "Ollama" },
    meta: { report: "muse", label: "Muse" },
};

/** How long each service may take to answer. */
const TIMEOUT_MS = 15_000;
/** An answer is kept this long: tabs that look at the same time share one call to each service. */
const FRESH_MS = 60_000;
/** Refresh asks the services again, but not more often than this. */
const MIN_GAP_MS = 10_000;
/** The status line accepts a reading up to this age: a session's provider quota is not worth asking the services often. */
const STATUS_MAX_AGE_MS = 5 * 60_000;
/** Grok's own billing, as the Grok CLI reads it: the plan's shared weekly pool. */
const GROK_BILLING = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
/** Grok CLI settings: the plan's name. */
const GROK_SETTINGS = "https://cli-chat-proxy.grok.com/v1/settings";
/** Z.ai's quota and subscriptions, as its own subscription page reads them. */
const ZAI_QUOTA = "https://api.z.ai/api/monitor/usage/quota/limit";
const ZAI_PLANS = "https://api.z.ai/api/biz/subscription/list";
/** MiniMax's Coding Plan lanes, as its own Coding Plan page reads them. */
const MINIMAX_REMAINS = "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
/** Ollama Cloud's credits: the included allowance, the credits purchased, and the month that the allowance covers. */
const OLLAMA_BALANCE = "https://ollama.com/api/balance";
/** The key that a local Ollama endpoint usually gets: Ollama ignores it, and no account stands behind it. */
const OLLAMA_LOCAL_KEY = "ollama";
/** Z.ai's units for a window's length, in minutes (5 is a month, named on its own). */
const ZAI_UNIT_MINUTES: Record<number, number> = { 3: 60, 4: 1440, 6: 10_080 };

/** Words this module wrote itself, safe to show. Anything else that goes wrong is told in fixed words. */
class Said extends Error {
    /** This machine has no account for the service, so the page leaves the service out. */
    readonly missing: boolean;

    constructor(message: string, missing = false) {
        super(message);
        this.missing = missing;
    }
}

/** A failure that means no account for the service is on this machine: no sign-in, no key, or no command. */
const missing = (message: string) => new Said(message, true);

/** A percent from a service: a finite number, else 0. */
function percentOf(value: unknown): number {
    const number = Number(value);

    return Number.isFinite(number) ? Math.max(0, number) : 0;
}

/** Money from a service, which sends it as text: a finite number, else 0. */
function amountOf(value: unknown): number {
    const number = Number(value);

    return Number.isFinite(number) ? Math.max(0, number) : 0;
}

/** Ollama Cloud's off-peak rates: outside 12:00 to 18:00 UTC on weekdays, and all weekend. */
function offPeakAt(now: number): { offPeak: boolean; until: number } {
    const peak = (time: number) => {
        const at = new Date(time);
        const day = at.getUTCDay();

        // Saturday and Sunday are off-peak all day; a weekday is full price from 12:00 to 18:00 UTC.
        return day !== 0 && day !== 6 && at.getUTCHours() >= 12 && at.getUTCHours() < 18;
    };
    const full = peak(now);
    // The hour at which the price next changes: an hour at a time finds it, since a week holds every change.
    let until = Math.floor(now / 3_600_000) * 3_600_000;

    while (until - now < 8 * 24 * 3_600_000) {
        until += 3_600_000;

        if (peak(until) !== full) {
            break;
        }
    }

    return { offPeak: !full, until };
}

/**
 * The note that says which rates Ollama Cloud charges now, and when that changes: the time in this machine's zone, so
 * the rate's hours stay in UTC, where Ollama sets them, and the note reads in the day of the person who reads it.
 */
function offPeakNote(now: number): string {
    const { offPeak, until } = offPeakAt(now);
    const at = new Date(until);
    const clock = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    const day =
        at.toDateString() === new Date(now).toDateString()
            ? ""
            : `${at.toLocaleDateString("en-US", { weekday: "short" })} `;

    return offPeak
        ? `Off-peak rates until ${day}${clock}.`
        : `Full price until ${day}${clock}: off-peak rates after.`;
}

/** A level from the service's own word for it, else from how full the limit is. */
function levelOf(percent: number, said?: unknown): Level {
    if (said === "critical" || said === "exceeded" || said === "limited" || said === "blocked") {
        return "critical";
    }

    if (said === "warning") {
        return "warning";
    }

    return percent >= 90 ? "critical" : percent >= 75 ? "warning" : "ok";
}

/** Whether a limit is used up: nothing of its window is left. */
const usedUp = (limit: Limit) => percentOf(limit.percent) >= 100;

/**
 * A plan's limits without the ones that no longer matter: when a limit with a longer window is used up, a shorter one
 * cannot matter until the longer one resets, so it is left out. A limit whose window the service does not give stays.
 */
function standingLimits(limits: Limit[]): Limit[] {
    const full = limits.filter(usedUp);

    return limits.filter(
        (limit) =>
            !full.some(
                (other) =>
                    other.windowMs !== undefined &&
                    limit.windowMs !== undefined &&
                    other.windowMs > limit.windowMs,
            ),
    );
}

/** A reset time from milliseconds since 1970, as Z.ai gives it. */
function resetOfMs(value: unknown): { resetsAt?: string } {
    return resetOf(typeof value === "number" ? value / 1000 : value);
}

/** A reset time as ISO text, from ISO text or seconds since 1970; none when it is not a time. */
function resetOf(value: unknown): { resetsAt?: string } {
    const time =
        typeof value === "number"
            ? value * 1000
            : typeof value === "string"
              ? Date.parse(value)
              : NaN;

    // A date holds up to 8.64e15 ms either way of 1970: past that, `toISOString` would throw.
    return Number.isFinite(time) && Math.abs(time) <= 8.64e15
        ? { resetsAt: new Date(time).toISOString() }
        : {};
}

/** A report that failed: what its line on the page says, in the words that `failed` chose, and whether the page must
 * leave it out. */
function failure(error: unknown): { ok: false; error: string; missing?: boolean } {
    return {
        ok: false,
        error: failed(error),
        ...(error instanceof Said && error.missing ? { missing: true } : {}),
    };
}

/** A service's failure in words for its plan on the page, which names the service: never what the service sent back. */
function failed(error: unknown): string {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        return `No answer in ${TIMEOUT_MS / 1000} s.`;
    }

    if (error instanceof Said) {
        return error.message;
    }

    return `It could not be read (${error instanceof Error ? error.name : "unknown error"}): try again later.`;
}

function answered(status: number): Said {
    return new Said(
        status === 401 || status === 403
            ? `It refused the sign-in (${status}): sign in again in Menu → Providers.`
            : `It answered ${status}.`,
    );
}

/** Anthropic's names for its limits, as people read them. */
function claudeLabel(limit: Record<string, any>): string {
    const model = limit.scope?.model?.display_name;

    switch (limit.kind) {
        case "session":
            return "5-hour session";
        case "weekly_all":
            return "Week, all models";
        case "weekly_scoped":
            return `Week, ${typeof model === "string" ? model : "one model"}`;
        default:
            return String(limit.kind ?? "Limit").replaceAll("_", " ");
    }
}

/** A Codex limit's window, as people read it: 300 minutes is "5 hours", 10080 a week. */
function windowLabel(minutes: unknown): string {
    if (typeof minutes !== "number" || !(minutes > 0)) {
        return "Limit";
    }

    if (minutes === 10_080) {
        return "Week";
    }

    if (minutes % 1440 === 0) {
        return minutes === 1440 ? "Day" : `${minutes / 1440} days`;
    }

    return minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`;
}

/** A limit's window, in milliseconds, from the minutes that a service gives: none when it gives no length. */
const windowOf = (minutes: unknown) =>
    typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
        ? { windowMs: minutes * 60_000 }
        : {};

/** A Z.ai window's length in minutes: unit 3 is hours, 4 days, 5 months, 6 weeks. None for a unit it does not know. */
function zaiMinutes(unit: unknown, number: unknown): number | undefined {
    if (typeof unit !== "number" || typeof number !== "number" || !(number > 0)) {
        return undefined;
    }

    const minutes = unit === 5 ? 43_200 : ZAI_UNIT_MINUTES[unit];

    return minutes === undefined ? undefined : minutes * number;
}

/** A Z.ai window as people read it: unit 3 is hours, 4 days, 5 months, 6 weeks. None for a unit it does not know. */
function zaiWindow(unit: unknown, number: unknown): string | undefined {
    if (unit === 5 && typeof number === "number" && number > 0) {
        return number === 1 ? "Month" : `${number} months`;
    }

    const minutes = zaiMinutes(unit, number);

    return minutes === undefined ? undefined : windowLabel(minutes);
}

/** The plan that Codex names, in the report's title: "ChatGPT Plus". */
function chatGptName(plan: unknown): string {
    return typeof plan === "string" && plan.trim() !== ""
        ? `ChatGPT ${capitalized(plan.trim())}`
        : "ChatGPT";
}

/** Anthropic's windows are fixed lengths that its answer does not repeat: a 5-hour session, else a week. */
const claudeWindowMs = (kind: unknown) =>
    kind === "session" ? 5 * 3_600_000 : 7 * 24 * 3_600_000;

/** "GrokBuild" as "Grok Build". */
const spaced = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2");

/** "video" as "Video". */
const capitalized = (name: string) => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/**
 * Ask Codex's own app server (`codex app-server`, JSON-RPC over stdio) for the account's limits. Codex reads and
 * renews its sign-in itself, so no token passes through here. The server is started for one question and stopped.
 */
function askCodex(signal: AbortSignal, children: Set<ChildProcess>): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);

            return;
        }

        const child = spawn("codex", ["app-server"], {
            cwd: homedir(),
            stdio: ["pipe", "pipe", "ignore"],
        });
        let done = false;

        // Kept until it ends: the module going waits for it. `close` comes when it ended, and when it never started (no
        // `codex` to run), when `exit` does not.
        children.add(child);
        child.once("close", () => children.delete(child));

        const finish = (run: () => void) => {
            if (done) {
                return;
            }

            done = true;
            signal.removeEventListener("abort", stop);
            child.stdin.end();
            child.kill();
            // A Codex that does not stop when asked is stopped for good.
            setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill("SIGKILL");
                }
            }, 2000).unref();
            run();
        };

        const stop = () => finish(() => reject(signal.reason));
        const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);

        signal.addEventListener("abort", stop, { once: true });
        child.stdin.on("error", () => {});
        child.stdout.on("error", () => {});
        child.on("error", (error: NodeJS.ErrnoException) =>
            finish(() =>
                reject(
                    error.code === "ENOENT"
                        ? missing(
                              "The Codex CLI is not installed on the server: install it, then run codex login.",
                          )
                        : error,
                ),
            ),
        );
        child.on("exit", () =>
            finish(() =>
                reject(
                    new Said("Codex stopped before it answered: run codex login, then try again."),
                ),
            ),
        );

        // Nothing in here may throw: a throw in a stream's handler is not this promise's to catch, and would stop the
        // whole server.
        createInterface({ input: child.stdout }).on("line", (line) => {
            try {
                if (done) {
                    return;
                }

                let message: unknown;

                try {
                    message = JSON.parse(line);
                } catch {
                    return;
                }

                if (message === null || typeof message !== "object" || Array.isArray(message)) {
                    return;
                }

                const { id, result, method } = message as {
                    id?: unknown;
                    result?: unknown;
                    method?: unknown;
                };

                // Requests and notifications from Codex carry a method: only answers to ours count.
                if (method !== undefined) {
                    return;
                }

                if (id === 0) {
                    send({ method: "initialized" });
                    send({ method: "account/rateLimits/read", id: 1 });
                } else if (id === 1) {
                    finish(() =>
                        result !== null && typeof result === "object"
                            ? resolve(result as Record<string, any>)
                            : reject(
                                  missing(
                                      "Codex could not read the limits: run codex login, then try again.",
                                  ),
                              ),
                    );
                }
            } catch (error) {
                finish(() => reject(error));
            }
        });

        send({
            method: "initialize",
            id: 0,
            params: {
                clientInfo: {
                    name: "pi_pocket_usage",
                    title: "Pi Pocket subscription usage",
                    version: "1.0.0",
                },
                capabilities: null,
            },
        });
    });
}

/**
 * Ask the Muse Code CLI (`muse usage --json`) for the account's allowance: the usage window it last observed, and the
 * week's. Muse reads and renews its own sign-in, so no token passes through here. It answers one JSON object and ends.
 */
function askMuse(signal: AbortSignal, children: Set<ChildProcess>): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);

            return;
        }

        // The home folder, as for Codex: the session's folder may be gone, and Muse keeps its sign-in there.
        const child = spawn("muse", ["usage", "--json"], {
            cwd: homedir(),
            stdio: ["ignore", "pipe", "ignore"],
        });
        let out = "";
        let done = false;

        children.add(child);
        child.once("close", () => children.delete(child));

        const finish = (run: () => void) => {
            if (done) {
                return;
            }

            done = true;
            signal.removeEventListener("abort", stop);
            run();
        };
        // Nothing waits on a Muse that ignores the end of the read: it is stopped, and the read fails.
        const stop = () =>
            finish(() => {
                child.kill("SIGKILL");
                reject(signal.reason);
            });

        signal.addEventListener("abort", stop, { once: true });

        child.stdout.on("error", () => {});
        child.stdout.on("data", (chunk) => (out += String(chunk)));
        child.on("error", (error: NodeJS.ErrnoException) =>
            finish(() =>
                reject(
                    error.code === "ENOENT"
                        ? missing("The Muse CLI is not installed on the server: install it, then run muse login.")
                        : error,
                ),
            ),
        );
        child.on("close", () =>
            finish(() => {
                let data: unknown;

                try {
                    data = JSON.parse(out);
                } catch {
                    data = undefined;
                }

                if (data !== null && typeof data === "object" && !Array.isArray(data)) {
                    resolve(data as Record<string, any>);
                } else {
                    reject(
                        missing("The Muse CLI did not answer with its usage: run muse login, then try again."),
                    );
                }
            }),
        );
    });
}

export default function createSubscriptionUsage(_host: unknown, web: Web) {
    // Pi's own models and sign-ins: `getAuth` renews an expiring subscription token under Pi's lock, as Pi does.
    let runtime: Promise<ModelRuntime> | undefined;
    let last: { at: number; reports: Report[] } | undefined;
    let pending: Promise<{ at: number; reports: Report[] }> | undefined;
    // Turning the module off, or a new version of it, stops the reads still running, and the commands they started with
    // them: the module is gone once every one of those ended (a Codex that ignores being asked to stop is killed after
    // 2 s, and a Muse at once).
    const alive = new AbortController();
    const children = new Set<ChildProcess>();

    web.onDispose(() => {
        alive.abort();

        return Promise.all(
            [...children].map(
                (child) =>
                    new Promise<void>((resolve) => {
                        if (child.exitCode !== null || child.signalCode !== null) {
                            resolve();
                        } else {
                            child.once("close", () => resolve());
                        }
                    }),
            ),
        );
    });

    const models = () =>
        (runtime ??= ModelRuntime.create({ refreshOnCreate: false }).catch((error: unknown) => {
            // A failure is not kept: the next read tries again.
            runtime = undefined;

            throw error;
        }));

    /** Pi's sign-in to a provider, and how it signed in ("OAuth" for a subscription), or none. */
    const signIn = async (provider: string, signal: AbortSignal) => {
        const found = await (await models()).getAuth(provider, { signal });
        const key = found?.auth.apiKey;

        return typeof key === "string" && key !== "" ? { key, source: found?.source } : undefined;
    };

    const credential = async (provider: string, signal: AbortSignal) => {
        const found = await signIn(provider, signal);

        if (found === undefined) {
            throw missing("Pi is not signed in to it: sign in under Menu → Providers.");
        }

        return found.key;
    };

    /** Copilot's quota endpoint needs the GitHub OAuth token, not the short-lived inference token from getAuth. */
    async function copilot(signal: AbortSignal): Promise<Report> {
        const name = "GitHub Copilot";

        try {
            if (typeof codingAgent.readStoredCredential !== "function") {
                throw missing("Update Pi to read the GitHub Copilot sign-in.");
            }

            const stored = codingAgent.readStoredCredential("github-copilot");

            if (stored?.type !== "oauth" || typeof stored.refresh !== "string" || stored.refresh === "") {
                throw missing("Pi is not signed in to it: sign in under Menu → Providers.");
            }

            // Do not send an enterprise token to github.com, or to a host taken from the credential.
            if (stored.enterpriseUrl) {
                throw new Said("GitHub Enterprise Copilot usage is not supported yet.");
            }

            const response = await fetch("https://api.github.com/copilot_internal/user", {
                headers: {
                    authorization: `token ${stored.refresh}`,
                    accept: "application/json",
                    "x-github-api-version": "2025-04-01",
                },
                redirect: "error",
                signal,
            });

            if (!response.ok) {
                throw answered(response.status);
            }

            const data = (await response.json()) as Record<string, any>;
            const limits: Limit[] = [];
            const notes: string[] = [];
            const snapshots = data?.quota_snapshots;

            for (const [field, label] of [
                ["premium_interactions", "Month"],
                ["chat", "Chat"],
                ["completions", "Completions"],
            ]) {
                const snapshot = snapshots?.[field!];

                if (snapshot === null || typeof snapshot !== "object") {
                    continue;
                }

                if (snapshot.unlimited === true) {
                    if (field === "premium_interactions") {
                        notes.push("Premium requests are unlimited.");
                    }
                } else if (typeof snapshot.percent_remaining === "number" && Number.isFinite(snapshot.percent_remaining)) {
                    const percent = 100 - Math.max(0, Math.min(100, snapshot.percent_remaining));
                    const quotaReset = resetOf(snapshot.quota_reset_at);
                    // GitHub uses 0 when a snapshot has no reset; use the account's reset date in that case.
                    const reset = Date.parse(quotaReset.resetsAt ?? "") > 0 ? quotaReset : resetOf(data.quota_reset_date);

                    limits.push({
                        label: label!,
                        percent,
                        ...reset,
                        level: levelOf(percent),
                        ...(field === "premium_interactions" &&
                        data.token_based_billing === true &&
                        typeof snapshot.remaining === "number" &&
                        Number.isFinite(snapshot.remaining) &&
                        snapshot.remaining >= 0
                            ? { remainingCredits: snapshot.remaining }
                            : {}),
                    });
                }

                if (snapshot.overage_permitted === true) {
                    notes.push(`${label}: paid overage is enabled.`);
                }
            }

            if (limits.length === 0 && notes.length === 0) {
                notes.push("GitHub did not report any limited quota data for this account.");
            }

            return { id: "github-copilot", name, ok: true, limits, notes };
        } catch (error) {
            return { id: "github-copilot", name, ...failure(error) };
        }
    }

    async function claude(signal: AbortSignal): Promise<Report> {
        const name = "Claude (Anthropic)";

        try {
            const token = await credential("anthropic", signal);
            const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
                headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
                redirect: "error",
                signal,
            });

            if (!response.ok) {
                throw answered(response.status);
            }

            const data = (await response.json()) as Record<string, any>;
            let limits: Limit[];

            if (Array.isArray(data.limits)) {
                limits = data.limits
                    .filter((limit: unknown) => limit !== null && typeof limit === "object")
                    .map((limit: Record<string, any>) => {
                        const percent = percentOf(limit.percent);

                        return {
                            label: claudeLabel(limit),
                            percent,
                            ...resetOf(limit.resets_at),
                            level: levelOf(percent, limit.severity),
                            binding: limit.is_active === true,
                            windowMs: claudeWindowMs(limit.kind),
                        };
                    });
            } else {
                // An older answer: the 5-hour and weekly windows alone.
                limits = [
                    ["five_hour", "5-hour session"],
                    ["seven_day", "Week, all models"],
                ].flatMap(([field, label]) => {
                    const window = data[field!];

                    if (window === null || typeof window !== "object") {
                        return [];
                    }

                    const percent = percentOf(window.utilization);

                    return [
                        {
                            label: label!,
                            percent,
                            ...resetOf(window.resets_at),
                            level: levelOf(percent),
                            windowMs: claudeWindowMs(field === "five_hour" ? "session" : "weekly_all"),
                        },
                    ];
                });
            }

            return {
                id: "anthropic",
                name,
                ok: true,
                limits,
                notes: [
                    data.extra_usage?.is_enabled === true
                        ? "Extra usage is on."
                        : "Extra usage is off.",
                ],
            };
        } catch (error) {
            return { id: "anthropic", name, ...failure(error) };
        }
    }

    async function chatGpt(signal: AbortSignal): Promise<Report> {
        const name = "ChatGPT";

        try {
            const data = await askCodex(signal, children);
            const byId = data.rateLimitsByLimitId;
            const snapshots = (
                byId !== null && typeof byId === "object" ? Object.values(byId) : [data.rateLimits]
            ).filter(
                (each): each is Record<string, any> => each !== null && typeof each === "object",
            );
            const limits: Limit[] = [];
            const notes: string[] = [];

            for (const snapshot of snapshots) {
                // The plan's own limit goes without a name; another one (a model's, say) is named.
                const prefix =
                    snapshot.limitId === "codex" || snapshot.limitId == null
                        ? ""
                        : `${String(snapshot.limitName ?? snapshot.limitId)}, `;

                for (const window of [snapshot.primary, snapshot.secondary]) {
                    if (window === null || typeof window !== "object") {
                        continue;
                    }

                    const percent = percentOf(window.usedPercent);

                    limits.push({
                        label: prefix + windowLabel(window.windowDurationMins),
                        percent,
                        ...resetOf(window.resetsAt),
                        level: snapshot.rateLimitReachedType ? "critical" : levelOf(percent),
                        ...windowOf(window.windowDurationMins),
                    });
                }
            }

            const plan = snapshots.find((each) => typeof each.planType === "string")?.planType;
            const resets = data.rateLimitResetCredits?.availableCount;
            const credits = snapshots.find((each) => each.credits?.hasCredits === true)?.credits;

            if (data.ordinaryUsageAllowed === false) {
                notes.push("Codex says the plan's usage is used up for now.");
            }

            if (credits) {
                notes.push(
                    credits.unlimited
                        ? "Credits: unlimited."
                        : `Credits: ${String(credits.balance ?? 0)}.`,
                );
            }

            if (typeof resets === "number" && resets > 0) {
                notes.push(`${resets} free full reset${resets === 1 ? "" : "s"} available.`);
            }

            return { id: "openai", name: chatGptName(plan), ok: true, limits, notes };
        } catch (error) {
            return { id: "openai", name, ...failure(error) };
        }
    }

    async function openCodeGo(signal: AbortSignal): Promise<Report> {
        const name = "OpenCode Go";

        try {
            const key = await credential("opencode-go", signal);
            const response = await fetch("https://opencode.ai/zen/go/v1/usage", {
                headers: { authorization: `Bearer ${key}` },
                redirect: "error",
                signal,
            });

            if (!response.ok) {
                throw answered(response.status);
            }

            const usage = ((await response.json()) as { usage?: Record<string, any> }).usage ?? {};
            const limits = [
                { field: "rolling", label: "5 hours", minutes: 300, rolling: true },
                { field: "weekly", label: "Week", minutes: 10_080, rolling: false },
                { field: "monthly", label: "Month", minutes: 43_200, rolling: false },
            ].flatMap(({ field, label, minutes, rolling }) => {
                const window = usage[field];

                if (window === null || typeof window !== "object") {
                    return [];
                }

                const percent = percentOf(window.percent);

                // Its own word for the state ("ok", or a word for over), else how full it is.
                return [
                    {
                        label,
                        percent,
                        // A rolling window moves with every call, so it has no single time to name.
                        ...(rolling ? {} : resetOf(window.resetsAt)),
                        level: levelOf(percent, window.status),
                        windowMs: minutes * 60_000,
                    },
                ];
            });

            return { id: "opencode-go", name, ok: true, limits, notes: [] };
        } catch (error) {
            return { id: "opencode-go", name, ...failure(error) };
        }
    }

    /**
     * Grok's shared weekly pool, from the SuperGrok or X Premium sign-in: the one the Grok CLI uses. Without it there is
     * no plan to show (an xAI API key pays as it goes), so the page leaves Grok out.
     */
    async function grok(signal: AbortSignal): Promise<Report | undefined> {
        const name = "Grok";

        try {
            const found = await signIn("xai", signal);

            if (found?.source !== "OAuth") {
                return undefined;
            }

            const headers = {
                authorization: `Bearer ${found.key}`,
                "x-xai-token-auth": "xai-grok-cli",
                accept: "application/json",
            };
            // The plan's name is a nice to have: when it cannot be read, the pool still shows.
            const tier = fetch(GROK_SETTINGS, { headers, redirect: "error", signal })
                .then((response) => (response.ok ? response.json() : undefined))
                .then(
                    (settings: Record<string, any> | undefined) =>
                        settings?.subscription_tier_display,
                )
                .catch(() => undefined);
            const response = await fetch(GROK_BILLING, { headers, redirect: "error", signal });

            if (response.status === 412) {
                throw new Said("Grok keeps no personal quota for a team account.");
            }

            if (!response.ok) {
                throw answered(response.status);
            }

            // Grok answers in proto JSON, which leaves out every field that is 0: a missing percent is 0%.
            const config =
                ((await response.json()) as { config?: Record<string, any> }).config ?? {};
            const period = config.currentPeriod ?? {};
            const start = Date.parse(period.start);
            const end = Date.parse(period.end);
            const limits: Limit[] = [];
            const notes: string[] = [];

            if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
                const percent = percentOf(config.creditUsagePercent);

                limits.push({
                    label: windowLabel(Math.round((end - start) / 60_000)),
                    percent,
                    ...resetOf(period.end),
                    level: levelOf(percent),
                    windowMs: end - start,
                });
            }

            const plan = await tier;
            const cap = percentOf(config.onDemandCap?.val);

            // Only a plan that bought pay-as-you-go credits needs to say so: off is the usual case.
            if (cap > 0) {
                notes.push(`Pay as you go: up to ${cap} credits.`);
            }

            return {
                id: "xai",
                name: typeof plan === "string" && plan.trim() !== "" ? plan.trim() : name,
                ok: true,
                limits,
                notes,
            };
        } catch (error) {
            return { id: "xai", name, ...failure(error) };
        }
    }

    /** Z.ai's GLM Coding Plan, from Pi's Z.ai key. Without one, the page leaves Z.ai out. */
    async function zai(signal: AbortSignal): Promise<Report | undefined> {
        const name = "Z.ai (GLM Coding Plan)";

        try {
            const found = await signIn("zai", signal);

            if (found === undefined) {
                return undefined;
            }

            const headers = { authorization: `Bearer ${found.key}`, accept: "application/json" };
            // The plan's name is a nice to have: when it cannot be read, the limits still show.
            const product = fetch(ZAI_PLANS, { headers, redirect: "error", signal })
                .then((response) => (response.ok ? response.json() : undefined))
                .then((plans: { data?: unknown } | undefined) => {
                    const list = Array.isArray(plans?.data) ? plans.data : [];
                    const plan =
                        list.find(
                            (each: any) =>
                                each?.status === "VALID" && each?.inCurrentPeriod === true,
                        ) ?? list[0];

                    return plan?.productName;
                })
                .catch(() => undefined);
            const response = await fetch(ZAI_QUOTA, { headers, redirect: "error", signal });

            if (!response.ok) {
                throw answered(response.status);
            }

            const body = (await response.json()) as Record<string, any>;

            // A key with no coding plan gets 200 with success false, and a message that names the plan.
            if (body.success === false) {
                throw new Said(
                    String(body.msg ?? "")
                        .toLowerCase()
                        .includes("coding plan")
                        ? "This key has no GLM Coding Plan: subscribe at z.ai/subscribe."
                        : "It refused to read the quota.",
                );
            }

            const data = body.data ?? body;
            const entries = (Array.isArray(data.limits) ? data.limits : []).filter(
                (each: unknown): each is Record<string, any> =>
                    each !== null && typeof each === "object",
            );
            const limits: Limit[] = [];
            const counts: Limit[] = [];
            const notes: string[] = [];

            for (const entry of entries) {
                const type = entry.type ?? entry.name;
                const window = zaiWindow(entry.unit, entry.number);

                if (window === undefined) {
                    continue;
                }

                if (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") {
                    const percent = percentOf(entry.percentage);

                    limits.push({
                        label: window,
                        percent,
                        ...resetOfMs(entry.nextResetTime),
                        level: levelOf(percent),
                        ...windowOf(zaiMinutes(entry.unit, entry.number)),
                    });
                } else if (type === "TIME_LIMIT") {
                    // Web search, web reader, and Zread calls: a count, not tokens.
                    const used = percentOf(entry.currentValue);
                    const total = percentOf(entry.usage);
                    const percent =
                        entry.percentage === undefined && total > 0
                            ? (used / total) * 100
                            : percentOf(entry.percentage);

                    counts.push({
                        label: `Web tools, ${used}/${total}`,
                        percent,
                        ...resetOfMs(entry.nextResetTime),
                        level: levelOf(percent),
                        ...windowOf(zaiMinutes(entry.unit, entry.number)),
                    });
                    notes.push(
                        `Web tools: web search, web reader, and Zread calls, for each ${window.toLowerCase()}.`,
                    );
                }
            }

            const plan = await product;

            return {
                id: "zai",
                name,
                ok: true,
                // The token windows first: they are what holds the work back.
                limits: [...limits, ...counts],
                notes: [
                    typeof plan === "string" && plan.trim() !== ""
                        ? `${plan.trim()}, from Pi's Z.ai key.`
                        : "From Pi's Z.ai key.",
                    ...notes,
                ],
            };
        } catch (error) {
            return { id: "zai", name, ...failure(error) };
        }
    }

    /**
     * MiniMax's Coding Plan, from Pi's MiniMax key: text ("general") and each other lane, in its short window and its
     * week. A standard key (`sk-api-`) pays as it goes, and has no plan: then, and without a key, the page leaves
     * MiniMax out.
     */
    async function miniMax(signal: AbortSignal): Promise<Report | undefined> {
        const name = "MiniMax (Coding Plan)";

        try {
            const found = await signIn("minimax", signal);

            if (found === undefined || found.key.startsWith("sk-api-")) {
                return undefined;
            }

            const response = await fetch(MINIMAX_REMAINS, {
                headers: { authorization: `Bearer ${found.key}`, accept: "application/json" },
                redirect: "error",
                signal,
            });

            if (!response.ok) {
                throw answered(response.status);
            }

            const body = (await response.json()) as Record<string, any>;
            const code = body.base_resp?.status_code;

            if (code !== 0) {
                throw new Said(
                    code === 1004
                        ? "It refused the key: sign in again in Menu → Providers."
                        : `It refused to read the plan (code ${Number(code) || "unknown"}).`,
                );
            }

            const lanes = (Array.isArray(body.model_remains) ? body.model_remains : []).filter(
                (each: unknown): each is Record<string, any> =>
                    each !== null && typeof each === "object",
            );
            const limits: Limit[] = [];
            const others: Limit[] = [];
            const notes = ["From Pi's MiniMax key."];

            for (const lane of lanes) {
                const text = lane.model_name === "general";
                const prefix = text ? "" : `${capitalized(String(lane.model_name ?? "other"))}, `;

                for (const window of [
                    {
                        start: lane.start_time,
                        end: lane.end_time,
                        total: lane.current_interval_total_count,
                        remaining: lane.current_interval_usage_count,
                        left: lane.current_interval_remaining_percent,
                        status: lane.current_interval_status,
                    },
                    {
                        start: lane.weekly_start_time,
                        end: lane.weekly_end_time,
                        total: lane.current_weekly_total_count,
                        remaining: lane.current_weekly_usage_count,
                        left: lane.current_weekly_remaining_percent,
                        status: lane.current_weekly_status,
                    },
                ]) {
                    const minutes = Math.round(
                        (Number(window.end) - Number(window.start)) / 60_000,
                    );

                    if (!(minutes > 0)) {
                        continue;
                    }

                    const label = windowLabel(minutes);

                    // Status 3 with nothing in it: a lane the plan leaves out, or (for text in a week) no limit at all.
                    if (
                        window.status === 3 &&
                        !(Number(window.total) > 0) &&
                        Number(window.left) >= 100
                    ) {
                        if (text && label === "Week") {
                            notes.push("Text has no weekly limit.");
                        }

                        continue;
                    }

                    // `usage_count` holds what is left, not what is used: the percent left is the surer field.
                    const used =
                        typeof window.left === "number"
                            ? 100 - window.left
                            : Number(window.total) > 0
                              ? ((Number(window.total) - Number(window.remaining)) /
                                    Number(window.total)) *
                                100
                              : undefined;

                    if (used === undefined || !Number.isFinite(used)) {
                        continue;
                    }

                    const percent = Math.min(100, percentOf(used));

                    (text ? limits : others).push({
                        label: prefix + label,
                        percent,
                        ...resetOfMs(Number(window.end)),
                        level: levelOf(percent),
                        windowMs: minutes * 60_000,
                    });
                }
            }

            // Text first: it is what the work runs on.
            return { id: "minimax", name, ok: true, limits: [...limits, ...others], notes };
        } catch (error) {
            return { id: "minimax", name, ...failure(error) };
        }
    }

    async function deepSeek(signal: AbortSignal): Promise<Report | undefined> {
        const name = "DeepSeek";

        try {
            const key = (await signIn("deepseek", signal))?.key;

            // It is a prepaid account, not a subscription: its card shows only when Pi can read the key.
            if (key === undefined) {
                return undefined;
            }

            const response = await fetch("https://api.deepseek.com/user/balance", {
                headers: { authorization: `Bearer ${key}` },
                redirect: "error",
                signal,
            });

            if (!response.ok) {
                throw answered(response.status);
            }

            const data = (await response.json()) as Record<string, any>;
            const infos = (Array.isArray(data.balance_infos) ? data.balance_infos : []).filter(
                (info: unknown): info is Record<string, any> =>
                    info !== null && typeof info === "object" && !Array.isArray(info),
            );
            const main = infos.find((info) => info.currency === "CNY") ?? infos[0];

            if (main === undefined) {
                throw new Said("The answer named no balance.");
            }

            const total = amountOf(main.total_balance);

            return {
                id: "deepseek",
                name,
                ok: true,
                limits: [],
                notes: [],
                balance: {
                    currency: typeof main.currency === "string" ? main.currency : "",
                    total,
                    granted: amountOf(main.granted_balance),
                    toppedUp: amountOf(main.topped_up_balance),
                    enough:
                        data.is_available === true || (data.is_available !== false && total > 0),
                },
            };
        } catch (error) {
            return { id: "deepseek", name, ...failure(error) };
        }
    }

    async function ollama(signal: AbortSignal): Promise<Report | undefined> {
        const name = "Ollama Cloud";

        try {
            // Pi's provider for an endpoint of one's own carries the name its owner chose: `ollama-cloud` is the cloud.
            // A local server has no account, and its placeholder key is no sign-in, so the card stays out.
            const found = (await signIn("ollama-cloud", signal)) ?? (await signIn("ollama", signal));

            if (found === undefined || found.key === OLLAMA_LOCAL_KEY) {
                return undefined;
            }

            const response = await fetch(OLLAMA_BALANCE, {
                headers: { authorization: `Bearer ${found.key}` },
                redirect: "error",
                signal,
            });

            if (!response.ok) {
                throw answered(response.status);
            }

            const data = (await response.json()) as Record<string, any>;
            const included = data.included ?? {};
            const allowance = amountOf(included.allowance_usd);
            // What is left of the month's allowance, and what is left of the credits that were bought. Ollama spends
            // the included credits first, then the purchased ones.
            const granted = amountOf(included.balance_usd);
            const toppedUp = amountOf(data.purchased?.balance_usd);
            const limits: Limit[] = [];

            // A paid plan includes credits each month, and its share used is the plan's limit. Pay as you go has none.
            if (allowance > 0) {
                const percent = Math.min(100, Math.max(0, ((allowance - granted) / allowance) * 100));
                const from = Date.parse(included.period?.from ?? "");
                const until = Date.parse(included.period?.until ?? "");

                limits.push({
                    label: "Month",
                    percent,
                    ...resetOf(included.period?.until),
                    level: levelOf(percent),
                    ...(Number.isFinite(from) && Number.isFinite(until) && until > from
                        ? { windowMs: until - from }
                        : {}),
                });
            }

            const total = granted + toppedUp;

            return {
                id: "ollama",
                name,
                ok: true,
                limits,
                notes: [offPeakNote(Date.now())],
                balance: {
                    currency: "USD",
                    total,
                    granted,
                    toppedUp,
                    enough: total > 0,
                },
            };
        } catch (error) {
            return { id: "ollama", name, ...failure(error) };
        }
    }

    async function muse(signal: AbortSignal): Promise<Report> {
        const name = "Muse Code";

        try {
            const data = await askMuse(signal, children);
            const found = data.allowance;
            const allowance =
                found !== null && typeof found === "object" && !Array.isArray(found)
                    ? (found as Record<string, any>)
                    : undefined;

            // Before the first use in a window, Muse has observed nothing, and it says so rather than guessing.
            if (allowance === undefined) {
                return {
                    id: "muse",
                    name,
                    ok: true,
                    limits: [],
                    notes: [
                        "No usage observed yet: Muse reports it after the first use in a window.",
                    ],
                };
            }

            const window = percentOf(allowance.usedPercent);
            const weekly = allowance.weekly;
            const limits: Limit[] = [
                {
                    // Muse names the window's length when it knows it: its 5-hour block, unless it says otherwise.
                    label:
                        typeof allowance.windowDurationMins === "number"
                            ? windowLabel(allowance.windowDurationMins)
                            : "5 hours",
                    percent: window,
                    ...resetOfMs(allowance.resetsAtMs),
                    level: levelOf(window),
                    ...windowOf(
                        typeof allowance.windowDurationMins === "number"
                            ? allowance.windowDurationMins
                            : 300,
                    ),
                },
            ];

            if (weekly !== null && typeof weekly === "object" && !Array.isArray(weekly)) {
                const percent = percentOf((weekly as Record<string, any>).usedPercent);

                limits.push({
                    label: "Week",
                    percent,
                    ...resetOfMs(weekly.resetsAtMs),
                    level: levelOf(percent),
                    windowMs: 7 * 24 * 3_600_000,
                });
            }

            const notes =
                typeof allowance.tier === "string" && allowance.tier !== ""
                    ? [`${capitalized(spaced(allowance.tier))} plan.`]
                    : [];

            return { id: "muse", name, ok: true, limits, notes };
        } catch (error) {
            return { id: "muse", name, ...failure(error) };
        }
    }

    /** Every service at once, each on its own: one that fails leaves the others' answers. */
    const read = async () => {
        const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), alive.signal]);
        const reports = (
            await Promise.all([
                claude(signal),
                copilot(signal),
                chatGpt(signal),
                openCodeGo(signal),
                grok(signal),
                zai(signal),
                miniMax(signal),
                deepSeek(signal),
                ollama(signal),
                muse(signal),
            ])
        )
            .filter((report): report is Report => report !== undefined)
            // Every answer hides the limits that a used-up longer one makes moot: the page, the panel, and the status
            // item read the same list.
            .map((report) => (report.ok ? { ...report, limits: standingLimits(report.limits) } : report))
            // The plans that answered first, each group in its own order: what failed goes to the end.
            .sort((a, b) => Number(b.ok) - Number(a.ok));

        last = { at: Date.now(), reports };

        return last;
    };

    /**
     * The last answer while it is fresh, else a new read: one at a time, shared by the page, the command, and the
     * status line. `maxAge` lets the status line accept an older reading, so it asks the services less often.
     */
    const usage = (fresh: boolean, maxAge = FRESH_MS) => {
        const age = last === undefined ? Infinity : Date.now() - last.at;

        if (last !== undefined && (age < MIN_GAP_MS || (!fresh && age < maxAge))) {
            return Promise.resolve(last);
        }

        pending ??= read().finally(() => {
            pending = undefined;
        });

        return pending;
    };

    // GET /api/x/subscription-usage/usage, and ?fresh=1 to ask again now. The owner's alone (the default).
    web.route("GET", "usage", ({ query }) => usage(query.get("fresh") === "1"));

    // GET /api/x/subscription-usage/quota/:source: the quota of the plan that the model in that session belongs to.
    // The model comes from the bound session, never from the browser. A reading up to 5 minutes old is enough, so a
    // status line that checks it often asks the services no more than every 5 minutes; ?fresh=1 reads again (the server
    // still keeps MIN_GAP_MS between reads). A provider with no report, or a report that failed, gives `report: null`.
    if (typeof web.conversationRoute === "function") {
        web.conversationRoute(
            "GET",
            "quota/:source",
            async ({ conversation, query }) => {
                const model = conversation.model;
                const mapped = model === undefined ? undefined : PROVIDER_REPORTS[model.provider];

                if (mapped === undefined) {
                    return {
                        at: last?.at ?? null,
                        model: model ?? null,
                        label: null,
                        report: null,
                    };
                }

                const data = await usage(query.get("fresh") === "1", STATUS_MAX_AGE_MS);
                const report = data.reports.find(
                    (each): each is OkReport => each.id === mapped.report && each.ok,
                );

                return {
                    at: data.at,
                    model: model ?? null,
                    label: mapped.label,
                    report: report ?? null,
                };
            },
            { conversation: "source" },
        );
    }

    web.client("subscription-usage");
}
