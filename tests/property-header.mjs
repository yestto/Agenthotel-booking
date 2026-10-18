import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { BrowserToolGateway } from "../scripts/agent-orchestrator.mjs";

const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((path) => path && existsSync(path));
assert.ok(executablePath, "Set CHROME_PATH to run browser regression tests.");
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  const tools = new BrowserToolGateway({ trace: { emit() {} }, signal: new AbortController().signal });
  tools.page = page;
  const address = "New No 297, KEB Colony, 560048 Bangalore, India";
  for (const markup of [
    `<button>${address}</button>`,
    `<button style="display:flex"><span>New No 297, KEB Colony,</span><span>560048 Bangalore,</span><span>India</span></button>`,
    `<div><span>New No 297, KEB Colony,</span><span>560048 Bangalore,</span><span>India</span></div>`,
    `<span style="display:contents">${address}</span>`,
    `<div style="display:contents"><span style="display:contents">${address}</span></div>`,
    `<div>${address}<div class="guest-review">An unrelated review address</div></div>`,
    `<div style="height:20px;position:relative">${address}<div style="opacity:0;position:absolute;top:500px">Road, 799120 Udaipur, Tripura, India</div></div>`,
  ]) {
    await page.setContent(`<h1>Observed Hotel</h1>${markup}`);
    assert.ok((await tools.observePropertyHeader("Observed Hotel")).visibleHeader.includes(address), "Visible address segments must remain readable with word boundaries");
  }
  await page.setContent(`<h1>Observed Hotel</h1><div>${address}<div class="guest-review">Road, 799120 Udaipur, Tripura, India</div></div>`);
  const mixedHeader = (await tools.observePropertyHeader("Observed Hotel")).visibleHeader;
  assert.ok(mixedHeader.includes(address), "A review widget beside a real address cannot hide the address's own visible text");
  assert.ok(!mixedHeader.includes("Udaipur"), "Including an address container cannot include its review subtree");
  await page.setContent(`<h1>Observed Hotel</h1><div style="height:20px;position:relative">${address}<span aria-hidden="true">Map icon</span><div style="opacity:0;position:absolute;top:500px">Road, 799120 Udaipur, Tripura, India</div></div>`);
  const popupHeader = (await tools.observePropertyHeader("Observed Hotel")).visibleHeader;
  assert.ok(popupHeader.includes(address), "A hidden tooltip's geometry cannot exclude the actual twenty-pixel address row");
  assert.ok(!popupHeader.includes("Udaipur"), "Hidden tooltip content still cannot establish physical location");
  for (const markup of [
    `<button style="opacity:0">${address}</button>`,
    `<button><span style="visibility:hidden">${address}</span>Show on map</button>`,
    `<div class="guest-review"><button>${address}</button></div>`,
    `<footer><button>${address}</button></footer>`,
    `<button aria-hidden="true">${address}</button>`,
    `<div style="opacity:0"><span style="display:contents">${address}</span></div>`,
  ]) {
    await page.setContent(`<h1>Observed Hotel</h1>${markup}`);
    assert.ok(!(await tools.observePropertyHeader("Observed Hotel")).visibleHeader.includes(address), "Hidden, review and footer text cannot establish physical location");
  }
  console.log("Property header checks passed: visible buttons and split address text; hidden, review and footer content excluded");
} finally { await browser.close(); }
