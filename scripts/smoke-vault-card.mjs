#!/usr/bin/env node
/**
 * The vault approval card's own guards (specs/006 FR-006) in real Chromium, with trusted mouse input:
 * no early choice, a restyled or resized card waits again, a partly covered card takes no choice, a
 * card moved out of place sends the owner to the vault page, and "Always" needs the same input as
 * Allow. It loads extension/vault/vault-card.js into a blank page with a stub runtime, so it needs no
 * daemon, extension or profile. Harness only: the shadow root is opened so the buttons can be found;
 * the card's checks do not depend on it being closed. Set VAULT_PLAYWRIGHT_MODULE and
 * VAULT_CHROME_EXECUTABLE when Playwright and Chrome for Testing are supplied by the host.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARMED_MS = 1_100;
const PAGE = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
  + '<body style="margin:0;font:15px system-ui"><h1>Sign in</h1><input><input type="password"></body></html>';

async function loadChromium() {
  const modulePath = process.env.VAULT_PLAYWRIGHT_MODULE;
  const mod = modulePath
    ? await import(pathToFileURL(path.resolve(modulePath)).href)
    : await import('playwright');
  return mod.chromium || mod.default?.chromium;
}

const chromium = await loadChromium();
const cardScript = await fs.readFile(path.join(ROOT, 'extension', 'vault', 'vault-card.js'), 'utf8');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VAULT_CHROME_EXECUTABLE ? { executablePath: process.env.VAULT_CHROME_EXECUTABLE } : {}),
});
const results = {};

async function openCard(viewport = { width: 1280, height: 800 }) {
  const page = await browser.newPage({ viewport });
  await page.setContent(PAGE);
  await page.evaluate(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) { return attach.call(this, { ...init, mode: 'open' }); };
    window.__sent = [];
    const runtime = { sendMessage(message, callback) { window.__sent.push(message); callback({ success: true }); } };
    // Full Chrome defines a window.chrome that cannot be replaced; the headless shell does not.
    if (Object.getOwnPropertyDescriptor(window, 'chrome')?.configurable === false) window.chrome.runtime = runtime;
    else Object.defineProperty(window, 'chrome', { configurable: true, value: { runtime } });
  });
  await page.addScriptTag({ content: cardScript });
  await page.bringToFront();
  await page.evaluate(() => globalThis.__bcVaultCard.show({
    requestId: 'req_ab12', token: 'token', origin: 'https://fixture.test', purpose: 'list', agentName: 'Agent',
    browserLabel: 'Work', unlock: false, expiresAt: Date.now() + 120_000, lang: 'en',
  }));
  return page;
}

async function clickOn(page, selector) {
  const { x, y } = await page.evaluate((selector) => {
    const rect = document.querySelector('bc-vault-approval').shadowRoot.querySelector(selector).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, selector);
  await page.mouse.click(x, y);
}

const sent = (page) => page.evaluate(() => window.__sent.slice());

async function check(name, run) {
  const page = await openCard();
  try {
    results[name] = (await run(page)) === true ? 'ok' : 'failed';
  } catch (error) {
    results[name] = `failed: ${error.message}`;
  } finally {
    await page.close();
  }
}

await check('earlyClickIgnoredArmedClickSent', async (page) => {
  await page.waitForTimeout(150);
  await clickOn(page, '.button.primary');
  const early = await sent(page);
  await page.waitForTimeout(ARMED_MS);
  await clickOn(page, '.button.primary');
  const later = await sent(page);
  return early.length === 0 && later.length === 1 && later[0].decision === 'allow' && later[0].always === false;
});

await check('restyledHostRestoredAndWaitsAgain', async (page) => {
  await page.waitForTimeout(ARMED_MS);
  const top = () => page.evaluate(() => document.querySelector('bc-vault-approval').getBoundingClientRect().top);
  const before = await top();
  await page.evaluate(() => document.querySelector('bc-vault-approval').style.setProperty('top', '400px', 'important'));
  await page.waitForTimeout(20);
  const after = await top();
  await clickOn(page, '.button.primary');
  const blocked = await sent(page);
  await page.waitForTimeout(ARMED_MS);
  await clickOn(page, '.button.primary');
  return before === after && blocked.length === 0 && (await sent(page)).length === 1;
});

await check('partlyCoveredCardTakesNoChoice', async (page) => {
  await page.waitForTimeout(ARMED_MS);
  // A later top-layer popover over the title only: the buttons themselves stay clear.
  await page.evaluate(() => {
    const cover = document.createElement('div');
    cover.id = 'cover';
    cover.setAttribute('popover', 'manual');
    const rect = document.querySelector('bc-vault-approval').getBoundingClientRect();
    cover.style.cssText = `position:fixed;inset:auto;margin:0;padding:0;border:0;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:40px;background:#fff`;
    document.body.append(cover);
    cover.showPopover();
  });
  await page.waitForTimeout(400);
  await clickOn(page, '.button.primary');
  const blocked = await sent(page);
  await page.evaluate(() => document.getElementById('cover').remove());
  await page.waitForTimeout(ARMED_MS + 100);
  await clickOn(page, '.button.primary');
  return blocked.length === 0 && (await sent(page)).length === 1;
});

await check('movedCardSendsOwnerToVaultPage', async (page) => {
  await page.waitForTimeout(300);
  await page.evaluate(() => document.body.append(document.querySelector('bc-vault-approval')));
  await page.waitForTimeout(50);
  const list = await sent(page);
  const gone = await page.evaluate(() => !document.querySelector('bc-vault-approval'));
  return list.length === 1 && list[0].decision === 'page' && gone;
});

await check('alwaysTakesNoEarlyClick', async (page) => {
  await page.waitForTimeout(150);
  await clickOn(page, '.always input');
  await page.waitForTimeout(ARMED_MS);
  await clickOn(page, '.button.primary');
  const list = await sent(page);
  return list.length === 1 && list[0].always === false;
});

await check('alwaysTakesAnArmedClick', async (page) => {
  await page.waitForTimeout(ARMED_MS);
  await clickOn(page, '.always input');
  await clickOn(page, '.button.primary');
  const list = await sent(page);
  return list.length === 1 && list[0].always === true;
});

await check('resizedCardWaitsAgain', async (page) => {
  await page.waitForTimeout(ARMED_MS);
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(30);
  await clickOn(page, '.button.primary');
  const blocked = await sent(page);
  await page.waitForTimeout(ARMED_MS);
  await clickOn(page, '.button.primary');
  return blocked.length === 0 && (await sent(page)).length === 1;
});

const version = browser.version();
await browser.close();
const passed = Object.values(results).every((value) => value === 'ok');
console.log(JSON.stringify({ result: passed ? 'passed' : 'failed', browser: version, checks: results }));
process.exitCode = passed ? 0 : 1;
