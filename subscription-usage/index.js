// Subscription usage's browser module: a rail button (with the number of plans whose quota may go unused on it, those
// behind their window), a launcher action, a page (and a panel) with each plan's limits as rows of small squares (the
// home screen's color swatches) with how full each is and when it resets, and a prepaid account's balance (DeepSeek,
// Ollama Cloud) as money left. The plans that are fullest against their window's clock come first, and a footer says how
// old the reading is. It also adds a status line item with the quota of the current model's provider.
// The server module asks the services; this only shows what it says.

export const pocketApi = 1;

/** Three bars of rising height, as a 24×24 stroked path like the app's own icons. */
const BARS = "M5 20v-5M12 20V9M19 20V4M3 20h18";
/** A circle with a clock's hands, for when a limit resets. */
const CLOCK = "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7.5V12l3 2";
/** A circle with "!" in it, for what went wrong. */
const ALERT = "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7.5v5.5M12 16.5v.01";
/** How often the page reads again while it shows, and the rail's badge in the background. */
const PAGE_EVERY_MS = 60_000;
/** How often the age under the plans counts up, between reads. */
const AGE_EVERY_MS = 30_000;
/** How often the panel reads again: it stays open across the work, so it asks the services less often than the page. */
const PANEL_EVERY_MS = 10 * 60_000;
const BADGE_EVERY_MS = 5 * 60_000;
/** How often the status item checks the session's model. The check reads the server's cache, never a service. */
const QUOTA_EVERY_MS = 30_000;
/** A reset further away than this shows its date, not only its weekday. */
const NEAR_MS = 6 * 86_400_000;
/** The points a limit must be behind its window by before its line turns yellow, and a plan before the rail counts it. */
const LAG_POINTS = 5;
/** The points a limit must be behind its window by before its line turns red. */
const LAG_FAR_POINTS = 15;
/** How far a window must run before a lag says anything: a window that just started lags in every plan. */
const LAG_AFTER = 50;
/** The squares in a gauge: each is 5% of a limit. */
const CELLS = 20;
/** What "In force" on a limit means. */
const IN_FORCE = "The limit that holds you back now";

/** "in 2d 4h", "in 3h 10m", "in 12m" (and "in 19d", "in 2h" with nothing after): how long until a limit resets. */
function untilThen(time) {
    const minutes = Math.max(0, Math.round((time - Date.now()) / 60_000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;

    if (minutes === 0) {
        return "now";
    }

    return days > 0
        ? `in ${days}d${hours > 0 ? ` ${hours}h` : ""}`
        : hours > 0
          ? `in ${hours}h${rest > 0 ? ` ${rest}m` : ""}`
          : `in ${minutes}m`;
}

/** "Mon 4:08 AM" for a reset this week; "Nov 5, 2:08 AM" for one further away, where a weekday alone is not clear. */
const when = (time) =>
    new Date(time).toLocaleString(
        undefined,
        time - Date.now() > NEAR_MS
            ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
            : { weekday: "short", hour: "numeric", minute: "2-digit" },
    );

/** How many of a gauge's squares are lit: at least one for any use, and not all of them until a limit is full. */
function lit(percent) {
    if (percent <= 0) {
        return 0;
    }

    const n = Math.max(1, Math.round(percent / (100 / CELLS)));

    return percent < 100 ? Math.min(n, CELLS - 1) : CELLS;
}

/**
 * How far a limit is into its window, in percent: null when the service gives no length for the window or no reset, as
 * for a rolling window, which moves with every call.
 */
function windowShare(limit, now = Date.now()) {
    const span = Number(limit.windowMs);
    const reset = Date.parse(limit.resetsAt ?? "");

    if (!Number.isFinite(span) || !(span > 0) || !Number.isFinite(reset)) {
        return null;
    }

    // A reset behind us is a window the service has not rolled yet: all of it has passed.
    const left = Math.max(0, Math.min(span, reset - now));

    return Math.round(100 - (left / span) * 100);
}

/**
 * How far a limit lags its window: the share of the window that has passed, and the points that use is behind it (a
 * negative number when use is ahead of the window). Null when the service gives no clock, as for a rolling window.
 */
function lagOf(limit) {
    const share = windowShare(limit);

    return share === null ? null : { share, points: share - (Number(limit.percent) || 0) };
}

/** Money as the browser writes it, or its code and number when that code is not one it knows. */
function money(value, currency) {
    const amount = Number(value) || 0;

    try {
        return new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: currency || "CNY",
            currencyDisplay: "narrowSymbol",
            minimumFractionDigits: 2,
        }).format(amount);
    } catch {
        return `${currency} ${amount.toFixed(2)}`.trim();
    }
}

/** How much of a limit is left, in percent, from how much is used. */
const leftOf = (percent) => Math.max(0, Math.min(100, Math.round(100 - (Number(percent) || 0))));

/** The limit that holds you back now, or the tightest one: the one with the least left. */
function tightest(limits) {
    let top;

    for (const limit of limits) {
        if (top === undefined || (Number(limit.percent) || 0) > (Number(top.percent) || 0)) {
            top = limit;
        }
    }

    return limits.find((limit) => limit.binding) ?? top;
}

/** When the reading was taken, for the item's tooltip. */
function readTime(at) {
    if (typeof at !== "number") {
        return "";
    }

    const read = new Date(at);

    return Number.isFinite(read.getTime())
        ? read.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
        : "";
}

/** The item's tooltip: every limit of the plan, with what is left and when it resets. */
function quotaTitle(report, label, at) {
    const lines = [report.name === label ? label : `${label} · ${report.name}`];

    if (report.balance) {
        const { total, currency, enough } = report.balance;

        lines.push(
            `${money(total, currency)} left · ${enough ? "available" : "not enough for calls"}`,
        );
    }

    for (const limit of report.limits) {
        const reset = Date.parse(limit.resetsAt ?? "");
        const parts = [`${leftOf(limit.percent)}% left`];

        if (limit.binding) {
            parts.push("in force");
        }

        if (Number.isFinite(reset) && reset > Date.now()) {
            parts.push(`resets ${untilThen(reset)}`);
        }

        lines.push(`${limit.label}: ${parts.join(" · ")}`);
    }

    const read = readTime(at);

    if (read !== "") {
        lines.push(`Read ${read}`);
    }

    return lines.join("\n");
}

/** What the status item says for a provider's report, or null when there is nothing to show. */
function quotaOf(next) {
    const report = next?.report;

    if (!report || report.ok !== true) {
        return null;
    }

    const label = typeof next.label === "string" && next.label !== "" ? next.label : report.name;
    const title = quotaTitle(report, label, next.at);

    if (report.balance) {
        const amount = money(report.balance.total, report.balance.currency);

        // A balance has no level: clear a tone left from another provider's limit.
        return { text: `${label} ${amount}`, short: amount, title, tone: undefined };
    }

    const limit = tightest(report.limits);

    if (limit === undefined) {
        return null;
    }

    const left = leftOf(limit.percent);
    const reset = Date.parse(limit.resetsAt ?? "");
    const resets =
        Number.isFinite(reset) && reset > Date.now()
            ? ` · ${untilThen(reset).replace(/^in /, "")}`
            : "";

    return {
        text: `${label} ${left}% left${resets}`,
        short: `${left}%`,
        title,
        tone:
            limit.level === "critical"
                ? "error"
                : limit.level === "warning"
                  ? "warn"
                  : undefined,
    };
}

/** "3m ago" or "just now": how old the reading under the plans is. */
function ageOf(at) {
    const seconds = Math.max(0, Math.round((Date.now() - (Number(at) || 0)) / 1000));

    if (seconds < 45) {
        return "just now";
    }

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) {
        return `${minutes}m ago`;
    }

    const hours = Math.floor(minutes / 60);

    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** The plans with something to say: an account that is here, and a limit or a balance to show. */
const kept = (reports) =>
    (reports ?? []).filter((report) =>
        report.ok ? report.limits.length > 0 || report.balance : !report.missing,
    );

/** The limit that says the most about a plan: the one with the longest window, which it runs out of over time. */
function longest(limits) {
    let best;

    for (const limit of limits ?? []) {
        const span = Number(limit.windowMs);
        const key = Number.isFinite(span) ? span : -1;

        if (best === undefined || key > best.span) {
            best = { span: key, limit };
        }
    }

    return best?.limit;
}

/**
 * Where a plan goes in the list, as two numbers to sort by: the least used of its longest window first. A plan that
 * only has a balance has no window to compare, and a plan that failed comes after both.
 */
function rank(report) {
    if (!report.ok) {
        return [2, 0];
    }

    const limit = longest(report.limits);

    return limit === undefined ? [1, 0] : [0, Number(limit.percent) || 0];
}

/**
 * Whether a plan is behind its window, where its quota may go unused: its longest limit, once that window is past
 * `LAG_AFTER` percent over, is `LAG_POINTS` or more under the share of the window that has passed. A plan with no window
 * clock has nothing to be behind, and one that failed is not judged.
 */
function lagging(report) {
    if (!report.ok) {
        return false;
    }

    const limit = longest(report.limits);
    const lag = limit === undefined ? null : lagOf(limit);

    return lag !== null && lag.share >= LAG_AFTER && lag.points >= LAG_POINTS;
}

export default function setup(pocket) {
    const { html, useEffect, useState, Icon, Loader, Spinner } = pocket;

    pocket.style("look.css");

    // Where the quotas open: the page in the conversation's place, or the panel beside the conversation. Each names one
    // target and clears the other, because a button does one thing at a time.
    const IN_PAGE = { page: "usage", panel: undefined };
    const IN_PANEL = { page: undefined, panel: "usage" };

    /**
     * A plan's limit: its name, a gauge of squares, how full it is, and when it resets, in a word on the right. Under
     * the gauge, a line says how much of the window has passed, so a gauge that runs past it is outpacing the window; it
     * turns yellow and then red as use falls further behind the window, where quota may go unused.
     */
    function LimitRow({ limit, label = limit.label }) {
        const reset = Date.parse(limit.resetsAt ?? "");
        const percent = Number(limit.percent) || 0;
        const on = lit(percent);
        const timed = Number.isFinite(reset);
        const lag = lagOf(limit);
        const gap = lag === null ? 0 : Math.round(lag.points);
        const behind = gap >= LAG_POINTS;
        const far = gap >= LAG_FAR_POINTS;
        const spoken =
            lag === null
                ? " used"
                : ` used, ${lag.share}% into the window${behind ? `, ${gap} points behind` : ""}`;
        const paceTitle =
            lag === null
                ? ""
                : `${lag.share}% of the window has passed${behind ? `: use is ${gap} points behind` : ""}`;

        return html`<li class=${`su-limit su-${limit.level}`}>
            <span class="su-label">${label}</span>
            <span class="su-meter">
                <span class="su-gauge" aria-hidden="true">
                    ${Array.from(
                        { length: CELLS },
                        (_, at) =>
                            html`<span
                                class=${at < on ? "su-cell su-on" : "su-cell"}
                                style=${`--c:${at}`}
                            ></span>`,
                    )}
                </span>
                ${
                    lag !== null &&
                    html`<span
                        class=${`su-pace${far ? " su-far" : behind ? " su-warn" : ""}`}
                        style=${`--at:${lag.share}%`}
                        aria-hidden="true"
                        title=${paceTitle}
                        ><i></i
                    ></span>`
                }
            </span>
            <span class="su-when">
                ${
                    limit.binding &&
                    html`<span class="su-binding" title=${IN_FORCE}>In force</span>`
                }
                ${
                    limit.binding &&
                    timed &&
                    html`<span class="su-sep" aria-hidden="true">·</span>`
                }
                ${
                    timed &&
                    html`<span class="su-resets" title=${when(reset)}
                        ><${Icon} path=${CLOCK} size=${13} />${untilThen(reset).replace(/^in /, "")}</span
                    >`
                }
            </span>
            <span class="su-value"
                >${Math.round(percent)}<span class="su-unit">%</span
                ><span class="su-sr">${spoken}</span></span
            >
        </li>`;
    }

    /** A prepaid account: the money left, when it cannot take calls, and what makes it up. */
    function BalanceRow({ balance }) {
        const total = Number(balance.total) || 0;
        const granted = Number(balance.granted) || 0;
        const toppedUp = Number(balance.toppedUp) || 0;
        // A part that is the whole balance says nothing: the amount above already says it.
        const parts = [
            ["Granted", granted],
            ["Topped up", toppedUp],
        ]
            .filter(([, amount]) => Number(amount) > 0 && Number(amount) !== total)
            .map(([name, amount]) => `${name} ${money(amount, balance.currency)}`);

        return html`<div class=${`su-balance${balance.enough ? "" : " su-critical"}`}>
            <p class="su-balance-amount">
                <span class="su-sr">Balance </span>${money(total, balance.currency)}
            </p>
            ${
                !balance.enough &&
                html`<span class="su-flag su-critical">Not enough for calls</span>`
            }
            ${parts.length > 0 && html`<p class="su-meta">${parts.join(" · ")}</p>`}
        </div>`;
    }

    /** A plan's section: its name, its limits, and what it has to say, or why it could not be read. */
    function Plan({ report, index }) {
        const head = `su-plan-${report.id}`;
        const notes = report.ok ? (report.notes ?? []) : [];

        return html`<section class="su-plan" aria-labelledby=${head} style=${`--i:${index}`}>
            <header class="su-plan-head">
                <h3 id=${head}>${report.name}</h3>
                <span class="su-rule" aria-hidden="true"></span>
                ${report.ok ? null : html`<span class="su-flag su-failed">Unavailable</span>`}
            </header>
            ${
                report.ok
                    ? html`${
                          report.balance &&
                          (report.id !== "ollama" || report.limits.length === 0 ||
                              report.balance.toppedUp > 0 || !report.balance.enough) &&
                          html`<${BalanceRow} balance=${report.balance} />`
                      }
                      ${
                          report.limits.length > 0 &&
                          html`<ul class="su-limits" role="list">
                              ${report.limits.map(
                                  (limit, at) => html`<${LimitRow}
                                      key=${at}
                                      limit=${limit}
                                      label=${report.id === "ollama" && report.balance
                                          ? `${limit.label} (${money(report.balance.granted, report.balance.currency)})`
                                          : limit.label}
                                  />`,
                              )}
                          </ul>`
                      }
                      ${
                          notes.length > 0 &&
                          html`<div class="su-notes">
                              ${notes.map((note) => html`<p>${note}</p>`)}
                          </div>`
                      }`
                    : html`<p class="su-problem">
                          <${Icon} path=${ALERT} size=${15} />
                          <span>${report.error}</span>
                      </p>`
            }
        </section>`;
    }

    /**
     * The page: loading, then the plans, then how old the reading is, with Refresh. It reads again on its own clock:
     * `every` is a minute on the page, and longer in the panel, which stays open across the work.
     */
    function Usage({ every = PAGE_EVERY_MS }) {
        const [data, setData] = useState(null);
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);
        // The age under the plans ticks on its own, so a read that failed leaves a reading that still counts up.
        const [, setTick] = useState(0);

        const load = async (fresh, signal) => {
            setBusy(true);

            try {
                const next = await pocket.api(`usage${fresh ? "?fresh=1" : ""}`, undefined, {
                    signal,
                });

                setData(next);
                setError(null);
                badge(next);
            } catch (failure) {
                if (!signal?.aborted) {
                    setError(failure.message);
                }
            } finally {
                if (!signal?.aborted) {
                    setBusy(false);
                }
            }
        };

        useEffect(() => {
            const stop = new AbortController();

            void load(false, stop.signal);
            const timer = setInterval(() => void load(false, stop.signal), every);
            const tick = setInterval(() => setTick((count) => count + 1), AGE_EVERY_MS);

            return () => {
                stop.abort();
                clearInterval(timer);
                clearInterval(tick);
            };
        }, []);

        if (!data && error) {
            return html`<div class="su">
                <div class="su-state" role="alert">
                    <${Icon} path=${ALERT} size=${16} />
                    <div class="su-state-text">
                        <p class="su-state-title">Could not read your usage</p>
                        <p class="su-state-detail">${error}</p>
                    </div>
                </div>
                <div class="su-actions">
                    <button
                        class="button small"
                        aria-disabled=${busy ? "true" : "false"}
                        onClick=${() => !busy && load(true)}
                    >
                        ${busy ? "Trying again…" : "Try again"}
                    </button>
                </div>
            </div>`;
        }

        if (!data) {
            return html`<div class="su" aria-busy="true">
                <${Loader} label="Asking your plans" />
            </div>`;
        }

        // The plans that have something to say, the fullest against its window's clock first.
        const shown = kept(data.reports)
            .map((report) => ({ report, key: rank(report) }))
            .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1])
            .map(({ report }) => report);

        return html`<div class="su" aria-busy=${busy ? "true" : undefined}>
            ${
                error &&
                html`<p class="error-box small" role="alert">Could not refresh: ${error}</p>`
            }
            ${
                shown.length === 0
                    ? html`<p class="su-empty">No plans reported: sign in under Menu → Providers.</p>`
                    : shown.map(
                          (report, at) =>
                              html`<${Plan} key=${report.id} report=${report} index=${at} />`,
                      )
            }
            <footer class="su-foot">
                <span class="su-age" aria-live="polite">${ageOf(data.at)}</span>
                <button
                    class="button small su-refresh"
                    style=${{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flex: "none",
                        width: "28px",
                        height: "28px",
                        padding: "0",
                    }}
                    aria-disabled=${busy ? "true" : "false"}
                    aria-label="Refresh"
                    title="Read your plans again"
                    onClick=${() => !busy && load(true)}
                >
                    ${
                        busy
                            ? html`<span class="su-spin" aria-hidden="true"><${Spinner} /></span>`
                            : html`<${Icon} name="reload" size=${16} />`
                    }
                </button>
            </footer>
        </div>`;
    }

    /** The panel's own copy of the page: it stays open across the work, so it reads again every 10 minutes. */
    const Docked = () => html`<${Usage} every=${PANEL_EVERY_MS} />`;

    const rail = pocket.rail({
        id: "usage",
        title: "Quotas",
        iconPath: BARS,
        ...IN_PAGE,
    });

    /** The rail's button counts the plans that are behind their window, where their quota may go unused. */
    function badge(data) {
        const behind = (data?.reports ?? []).filter(lagging).length;

        rail.update({ badge: behind > 0 ? behind : null });
    }

    pocket.page({ id: "usage", title: "Quotas", component: Usage });

    // The same page beside the conversation, where the app's own Browser and Files panels dock: one tap on the status
    // line's quota shows it. A panel is experimental, so an older app gets the page alone.
    const docks = typeof pocket.panel === "function";

    if (docks) {
        pocket.panel({
            id: "usage",
            title: "Quotas",
            iconPath: BARS,
            component: Docked,
        });
    }
    pocket.launcher({
        id: "usage",
        label: "Quotas",
        detail: "Plan limits and prepaid balances",
        iconPath: BARS,
        keywords: [
            "anthropic",
            "claude",
            "openai",
            "chatgpt",
            "codex",
            "opencode",
            "grok",
            "xai",
            "zai",
            "glm",
            "minimax",
            "deepseek",
            "ollama",
            "muse",
            "meta",
            "balance",
            "credit",
            "quota",
            "limits",
            "usage",
        ],
        ...IN_PAGE,
    });

    // The status line's quota: the plan that the model in the open session belongs to. It is experimental in Pi Pocket
    // 0.19, so an older app gets no item. The server reads the model from the session and keeps a reading up to 5
    // minutes, so this check costs no call to a service; when the model's provider changes, it asks for a fresh one.
    if (typeof pocket.status === "function") {
        let item = null;
        let session = null;
        let shown = null;
        let generation = 0;
        let stopped = false;
        const stop = new AbortController();

        const hide = () => {
            item?.remove();
            item = null;
        };

        const show = (next) => {
            const quota = quotaOf(next);

            if (quota === null) {
                hide();
                return;
            }

            if (item === null) {
                item = pocket.status({
                    id: "quota",
                    label: "Model quota",
                    text: quota.text,
                    short: quota.short,
                    title: quota.title,
                    tone: quota.tone,
                    ...(docks ? IN_PANEL : IN_PAGE),
                });
            } else {
                item.update(quota);
            }
        };

        const read = async (fresh) => {
            if (session === null || stopped) {
                return;
            }

            const id = session;
            const turn = ++generation;

            try {
                const next = await pocket.api(
                    `quota/${id}${fresh ? "?fresh=1" : ""}`,
                    undefined,
                    { signal: stop.signal },
                );

                if (stopped || id !== session || turn !== generation) {
                    return;
                }

                // Only the provider picks the report: another model of the same provider needs no fresh read.
                const key = next.model ? next.model.provider : null;
                const changed = key !== null && shown !== null && key !== shown;

                shown = key;
                show(next);

                // The session's provider changed: read the services now instead of waiting for the 5 minutes to pass.
                // The server still keeps 10 s between reads, and this one is used only if it is the latest.
                if (changed && !fresh) {
                    void read(true);
                }
            } catch {
                if (!stopped && id === session && turn === generation) {
                    hide();
                }
            }
        };

        const switchTo = (id) => {
            generation++;
            session = id;
            shown = null;
            hide();

            if (id !== null) {
                void read(false);
            }
        };

        let stopConversation = () => {};

        if (typeof pocket.onConversation === "function") {
            stopConversation = pocket.onConversation(switchTo);
        } else {
            switchTo(pocket.conversationId());
        }

        const timer = setInterval(() => {
            const id = pocket.conversationId();

            if (id !== session) {
                switchTo(id);
            } else {
                void read(false);
            }
        }, QUOTA_EVERY_MS);

        pocket.onDispose(() => {
            stopped = true;
            generation++;
            clearInterval(timer);
            stopConversation();
            stop.abort();
            hide();
        });
    }

    // A reading in the background for the badge, while this tab is open; the server keeps answers a minute.
    const check = () =>
        pocket.api("usage").then(
            (data) => {
                try {
                    badge(data);
                } catch {
                    // A badge that cannot be drawn waits for the next reading.
                }
            },
            () => {},
        );
    const timer = setInterval(check, BADGE_EVERY_MS);

    void check();
    pocket.onDispose(() => clearInterval(timer));
}
