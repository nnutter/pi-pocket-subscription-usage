# Subscription usage

A drop-in extension for [Pi Pocket](https://github.com/TannerMidd/pi-pocket). It adds a page to the rail. The page shows how much of your Claude, ChatGPT (Codex), OpenCode Go, Grok, Z.ai, MiniMax, and Muse Code plans you used, and when each limit resets. When Pi has a DeepSeek key, it also shows the DeepSeek balance, in money left rather than a percentage. With an Ollama Cloud key, it shows that plan's included credits, the money left in them, and the credits bought on top. When a plan's longer limit is used up, the shorter limits do not show.

## Install

In Pi Pocket 0.14 or newer, open **Menu → Extensions → Find extensions**, and find **Subscription usage**. The gallery installs it turned off. Read its source, or ask Pi to review it. Then turn it on in **Menu → Extensions**.

You can also copy these files into the extensions folder of Pi Pocket (`~/.pi-pocket/extensions/`), with the same names:

- `subscription-usage.ts`
- `subscription-usage/index.js`
- `subscription-usage/look.css`

## What it does

- **On the server:** it adds one route, `GET usage`, for the owner only. The route asks each service for your usage:
    - Claude and OpenCode Go: with the sign-ins that Pi already has on this computer.
    - ChatGPT (Codex): it starts the Codex CLI (`codex app-server`), which uses its own sign-in. The Codex CLI must be installed and signed in (`codex login`).
    - Grok: with Pi's xAI sign-in for SuperGrok or X Premium (Menu → Providers). It reads the shared weekly pool, as the Grok CLI does. An xAI API key has no plan, so the page leaves Grok out.
    - Z.ai: with Pi's Z.ai key, for a GLM Coding Plan. It reads the 5-hour (and, on bigger plans, weekly) token windows and the monthly count of web search, web reader, and Zread calls. Without a Z.ai key, the page leaves Z.ai out.
    - MiniMax: with Pi's MiniMax key, for a Coding Plan (`sk-cp-` keys). It reads text and each other lane (video, say), in its short window and its week. A standard key (`sk-api-`) pays as it goes and has no plan, so the page leaves MiniMax out, as it does without a key.
    - DeepSeek: with the API key that Pi has, it asks [`GET /user/balance`](https://api-docs.deepseek.com/api/get-user-balance) for the money left, whether the key can take calls, and what makes up the balance (granted and topped up). Its card shows only when Pi has a DeepSeek key, so an account that does not use DeepSeek sees no card.
    - Ollama Cloud: with Pi's key for the provider that points at Ollama Cloud (`ollama-cloud` in `models.json`), it asks [`GET /api/balance`](https://docs.ollama.com/api/balance) for the month's included credits and the credits bought on top. The card shows a gauge of the included credits that the month used, with its reset, and the money left. Ollama spends the included credits first, then the bought ones. An account with no key, or with the placeholder key of a local Ollama server, sees no card. Ollama's off-peak rates run outside 12:00 to 18:00 UTC on weekdays, and all weekend; its [pricing page](https://ollama.com/pricing) lists the models that have them, most at half price. The card's note says which rates apply now, and when they change.
    - Muse Code: with the Muse CLI, which reads and renews its own sign-in (install it, then run `muse login`). It runs `muse usage --json` and reads the subscription allowance: the current 5-hour window and the rolling week, each with the percent used and when it resets. Muse reports nothing before the first use in a window, and the card says so rather than guessing. With no CLI, or with no sign-in to it, the page says so and the card leaves Muse out.
- **In the browser:** it adds a page and a rail button, for the owner only. The page shows the usage, and the DeepSeek and Ollama Cloud balances. A line under each gauge shows how much of its window has passed, so a gauge that runs past the line is outpacing the window, and one that stops short of it is lagging. The line turns yellow when use is 5 points or more behind its window, and red at 15 or more. A limit whose service gives no window length or no reset (a rolling window, say) gets no line. The rail button counts the plans that are behind their window, where their quota may go unused: a plan counts once its longest window is past half over and its use is at least 5 points under the part of that window that has passed. A plan with no window clock is not counted. In Pi Pocket 0.19 or newer it adds the same page as a panel too, which docks beside the conversation where the screen has room for it (1100 pixels wide or more, which is the app's own rule for a panel). A tap on the status line's quota, on the rail's button, or in the launcher opens the panel there, and the page in the conversation's place on a smaller screen, such as a phone or an iPad in portrait. The view follows the screen: a panel that no longer fits becomes a page, and a page becomes a panel when the screen widens. No key or token goes to the browser.
- **In the status line:** one item shows the quota of the current model's provider: what is left of the limit in force (or the tightest), and when it resets; for DeepSeek and Ollama Cloud, the money left. Its tooltip lists the same limits, and a warning or critical level colors it. It follows model changes and otherwise refreshes at most every 5 minutes, shows nothing when that plan has no report, and can be hidden in Appearance → Layout.

It runs no tools and changes nothing in your sessions.

## License

MIT
