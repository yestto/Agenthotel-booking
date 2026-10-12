import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(path => path && existsSync(path));
const html = (await readFile(new URL("../src/agent-console.html", import.meta.url), "utf8")).replace("    connectRuntime();", "");
const browser = await chromium.launch({ executablePath, headless: true });
await mkdir("artifacts", { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.route("**/*", route => route.abort());
  await page.setContent(html.replace("<head>", '<head><meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;; img-src &#39;self&#39; data:; style-src &#39;self&#39; &#39;unsafe-inline&#39;; script-src &#39;self&#39; &#39;unsafe-inline&#39;; connect-src &#39;self&#39;">'));
  await page.evaluate(() => {
    window.discoveryAttack = false;
    showDiscovery({ status: "consistent", summary: "Controlled discovery fixture — not live sources.",
      claims: [{ text: "Example Hotel has a cited geographic address. <img src=x onerror=window.discoveryAttack=true>", sourceIds: ["safe", "unsafe"] }],
      sources: [{ id: "safe", title: "Official address — fixture", url: "https://example-hotel.com/location" }, { id: "unsafe", title: "Unsafe", url: "javascript:window.discoveryAttack=true" }],
      searchSuggestions: '<div>Search suggestions — fixture</div><script>parent.discoveryAttack=true</script><img src=x onerror="parent.discoveryAttack=true">',
    });
  });
  assert.equal(await page.locator("#discovery").isVisible(), true);
  assert.equal(await page.locator("#discoveryClaims a").count(), 1);
  assert.equal(await page.locator("#discoveryClaims img").count(), 0);
  assert.equal(await page.locator("#searchSuggestions").getAttribute("sandbox"), "allow-popups allow-popups-to-escape-sandbox");
  await page.frameLocator("#searchSuggestions").getByText("Search suggestions — fixture").waitFor();
  assert.equal(await page.evaluate(() => window.discoveryAttack), false, "Untrusted markup must not execute in the app or frame");
  await page.locator("#discovery").screenshot({ path: "artifacts/discovery-ui-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Citation panel must not overflow mobile layout");
  await page.locator("#discovery").screenshot({ path: "artifacts/discovery-ui-mobile.png" });
  console.log("Discovery browser UI passed: citations render, unsafe links/markup blocked, provider HTML sandboxed, desktop/mobile layout verified against controlled evidence.");
} finally { await browser.close(); }
