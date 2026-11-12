import { chromium } from "/home/a/.npm/_npx/a1722018f28f9df2/node_modules/playwright-core/index.mjs";
const b = await chromium.launch({ executablePath: "/home/a/.cache/ms-playwright/chromium-1194/chrome-linux/chrome", headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto("file://" + process.argv[2]);
await p.waitForTimeout(300);
await p.screenshot({ path: process.argv[3] });
await b.close();
