import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = ["subscription-usage.ts", "subscription-usage/index.js", "subscription-usage/look.css"];

test("the mise task installs and replaces the extension in Pi Pocket's data folder", () => {
    const sandbox = mkdtempSync(join(root, ".install-test-"));
    const home = join(sandbox, "home");
    mkdirSync(home);
    const env = {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: join(sandbox, "cache"),
        MISE_DATA_DIR: join(sandbox, "mise-data"),
        MISE_CONFIG_DIR: join(sandbox, "mise-config"),
        MISE_TRUSTED_CONFIG_PATHS: root,
    };

    try {
        for (const dataDir of [join(home, ".pi-pocket"), join(sandbox, "custom data")]) {
            if (dataDir === join(home, ".pi-pocket")) {
                delete env.PI_POCKET_DIR;
            } else {
                env.PI_POCKET_DIR = dataDir;
            }
            const extensions = join(dataDir, "extensions");
            mkdirSync(extensions, { recursive: true });
            writeFileSync(join(extensions, "subscription-usage.ts"), "previous version");
            execFileSync("mise", ["run", "ext:install"], { cwd: join(root, "tests"), env, stdio: "pipe" });

            for (const file of files) {
                assert.deepEqual(readFileSync(join(extensions, file)), readFileSync(join(root, file)), file);
            }
        }
    } finally {
        rmSync(sandbox, { recursive: true, force: true });
    }
});
