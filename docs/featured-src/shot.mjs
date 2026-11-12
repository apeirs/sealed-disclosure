// Renders docs/featured.png (1280x720) from card.html:  node docs/featured-src/shot.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const b = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto("file://" + join(here, "card.html"));
await p.waitForTimeout(300);
await p.screenshot({ path: join(here, "..", "featured.png") });
await b.close();
