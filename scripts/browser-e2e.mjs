// Browser end-to-end run against the live testnet inbox (Playwright Chromium, headless):
//   1. Send a report: check the demo project (3 checks), write a report, seal it in the page, download the envelope.
//   2. Drop that browser-sealed envelope with the CLI (the reporter's key signs; optional: --no-drop).
//   3. Inbox: list the demo project's drops, load its seal key, open every drop in the page.
// Screenshots go to docs/screenshots/. Needs `npm run build` first.
//
//   node scripts/browser-e2e.mjs [--no-drop]
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const PW = process.env.PLAYWRIGHT_CORE ?? "playwright-core";
const CHROME = process.env.CHROME; // unset: Playwright's own Chromium
const { chromium } = await import(PW);
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const DEMO = "qor1knxej2kffzpx9hcfjd54argxj72vs962nw60fg";
const REPORTER = "qor1uss0ahjc6kgygjmgamsqrmppnpdvd5u7vrlqa5";
const SHOTS = join(APP, "docs/screenshots");
const drop = !process.argv.includes("--no-drop");
mkdirSync(SHOTS, { recursive: true });
mkdirSync(join(APP, "out"), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

const server = spawn("node", ["server.mjs"], { cwd: APP, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE)).ok) break; } catch {}
    await sleep(250);
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, colorScheme: "light" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE);

  // 1. Report
  await page.getByText("Use the testnet demo project").click();
  const checks = page.getByTestId("project-checks");
  await checks.getByText("Ready to receive sealed reports").waitFor({ timeout: 60_000 });
  check((await checks.locator(".mark.pass").count()) === 3, "demo project: 3 of 3 key checks pass in the browser");
  await page.fill("#from", REPORTER);
  await page.fill("#title", "Unchecked return value in Treasury.release");
  await page.selectOption("#severity", "medium");
  await page.fill("#body", "Treasury.release ignores the bool returned by token.transfer.\nA token that returns false instead of reverting marks the payment done without moving funds.\nFix: require the return value, or use a safe-transfer wrapper.");
  await page.fill("#contact", "this inbox");
  await page.screenshot({ path: join(SHOTS, "1-report.png"), fullPage: true });
  await page.getByText("Seal in this browser").click();
  const sealed = page.getByTestId("sealed");
  await sealed.waitFor({ timeout: 30_000 });
  const [dl] = await Promise.all([page.waitForEvent("download"), sealed.getByRole("button", { name: /Download/ }).click()]);
  const file = join(APP, "out", dl.suggestedFilename());
  await dl.saveAs(file);
  const size = statSync(file).size;
  check(size > 1600 && /^report-[0-9a-f]{8}\.sealed$/.test(dl.suggestedFilename()), `browser sealed and downloaded ${dl.suggestedFilename()} (${size} bytes)`);
  await sealed.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, "2-sealed.png"), fullPage: true });

  // 2. Drop it with the CLI
  if (drop) {
    const r = spawnSync("./node_modules/.bin/tsx", ["src/cli/sd.ts", "drop", "--key", "keys/reporter.mnemonic", "--to", DEMO, "--envelope", file], { cwd: APP, encoding: "utf8", timeout: 300_000 });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    console.log(out.trim().split("\n").map((l) => "      " + l.slice(0, 200)).join("\n"));
    check(/Dropped as #\d+/.test(out), "CLI dropped the browser-sealed envelope");
  }

  // 3. Inbox
  await page.getByRole("tab", { name: "Inbox" }).click();
  await page.getByText("Open the testnet demo project's inbox").click();
  await page.getByTestId("drop").first().waitFor({ timeout: 60_000 });
  const n = await page.getByTestId("drop").count();
  check(n >= 2, `inbox lists ${n} drops`);
  await page.screenshot({ path: join(SHOTS, "3-inbox-sealed.png"), fullPage: true });
  await page.getByText("Use the demo seal key").click();
  await page.locator(".status").waitFor({ timeout: 30_000 });
  const opened = await page.locator(".finding-title").allTextContents();
  const refused = await page.locator(".card-refused").count();
  console.log(`      ${(await page.locator(".status").textContent())?.trim()}`);
  check(opened.includes("Reentrancy in ExampleVault.withdraw"), "drop #0 (sealed by the CLI) opens in the browser");
  check(!drop || opened.includes("Unchecked return value in Treasury.release"), "the browser-sealed drop opens in the browser");
  check(refused === 1, `the copied envelope (#1) is refused (${refused} refused)`);
  await page.screenshot({ path: join(SHOTS, "4-inbox-opened.png"), fullPage: true });

  await page.getByRole("tab", { name: "How it works" }).click();
  await page.screenshot({ path: join(SHOTS, "5-how.png"), fullPage: true });
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll browser checks passed.");
process.exitCode = failures ? 1 : 0;
