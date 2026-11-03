// Happy-path browser test at a phone viewport. Needs `pnpm dev` + mock Gemini running.
// Usage: node scripts/e2e.mjs [baseUrl] [video] [screenshotDir]
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright"); // pre-installed globally in CI image; or `pnpm add -D playwright`
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:5173";
const video = process.argv[3] ?? "scripts/fixtures/sample.mp4";
const shots = process.argv[4] ?? "test-results";
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["Pixel 7"], acceptDownloads: true });
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && console.log("[browser]", m.text()));

await page.goto(base);
await page.setInputFiles('input[type="file"]', video);
await page.fill('input[placeholder^="e.g."]', "blue shirt, near side");
await page.check('input[type="checkbox"]');
await page.screenshot({ path: `${shots}/1-upload.png`, fullPage: true });
await page.click("text=Analyse my match");
await page.waitForSelector("text=Analysing your match", { timeout: 60_000 });
await page.screenshot({ path: `${shots}/2-progress.png` });
await page.waitForSelector("text=Your 3 takeaways", { timeout: 240_000 });
if (!/\?id=[a-f0-9]{32}/.test(page.url())) throw new Error("URL has no analysis id");

// Seek to a moment and check the overlay canvas actually has pixels drawn.
await page.click("text=▶ 0:22");
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector("video")?.pause());
const drawn = await page.evaluate(() => {
  const c = document.querySelector(".stage canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});
if (drawn < 1000) throw new Error(`overlay not drawn (${drawn} px)`);
await page.locator(".player").screenshot({ path: `${shots}/3-player.png` });
await page.screenshot({ path: `${shots}/4-report.png`, fullPage: true });

// Export the annotated video.
await page.click("text=Get annotated video");
const link = page.locator("a.button", { hasText: "Save" });
await link.waitFor({ timeout: 300_000 });
const [dl] = await Promise.all([page.waitForEvent("download"), link.click()]);
const out = `${shots}/annotated.mp4`;
await dl.saveAs(out);
console.log("E2E OK", JSON.stringify({ overlayPixels: drawn, annotated: out }));
await browser.close();
