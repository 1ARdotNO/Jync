// Drive Obsidian-in-ignis via headless Chromium and exercise the Jync plugin.
//   node run.mjs sync              -> run one sync, print report
//   node run.mjs eval "<jsExpr>"   -> run arbitrary code in the app context
// URL via IGNIS_URL (default http://localhost:8082 — localhost is a secure context).
import { chromium } from "playwright";

const URL = process.env.IGNIS_URL || "http://localhost:8082";
const action = process.argv[2] || "sync";
const expr = process.argv[3] || "";
const BOOT_TIMEOUT = 90_000;

const logs = [];
const errors = [];

const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.on("console", (m) => { const t = m.text(); if (t.includes("[jync]") || m.type() === "error") logs.push(`${m.type()}: ${t}`); });
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // wait for Obsidian app + workspace + plugin registry
  await page.waitForFunction(() => !!(window.app && window.app.plugins && window.app.workspace && window.app.vault), null, { timeout: BOOT_TIMEOUT });
  await page.waitForFunction(() => window.app.workspace.layoutReady === true, null, { timeout: BOOT_TIMEOUT }).catch(() => {});

  // ensure the plugin system is on (fresh browser sessions boot in restricted mode)
  // and jync is loaded.
  const loaded = await page.evaluate(async () => {
    const P = window.app.plugins;
    try { await P.setEnable(true); } catch (e) { /* already on */ }
    if (!P.plugins.jync) {
      try { await P.loadPlugin("jync"); } catch (e) { return { ok: false, err: String(e) }; }
    }
    await new Promise((r) => setTimeout(r, 800));
    return { ok: !!P.plugins.jync, enabled: [...(P.enabledPlugins || [])].includes("jync") };
  });

  let result;
  if (action === "sync") {
    result = await page.evaluate(async () => {
      const p = window.app.plugins.plugins.jync;
      if (!p) return { error: "plugin not loaded" };
      const t0 = Date.now();
      let r, err = null;
      try { r = await p.runSync("manual"); } catch (e) { err = String(e); }
      const report = r ?? p.lastReport;
      return {
        ms: Date.now() - t0,
        report,
        err,
        syncStateFiles: Object.keys(p.syncState?.files || {}),
        settings: { base: p.settings.baseUrl, root: p.settings.syncRoot },
      };
    });
  } else if (action === "eval") {
    result = await page.evaluate((code) => {
      // eslint-disable-next-line no-eval
      return (async () => eval(code))();
    }, expr);
  }

  console.log(JSON.stringify({ url: URL, loaded, action, result, jyncLogs: logs.filter((l) => l.includes("[jync]")), errors }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ url: URL, fatal: String(e), logs, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
