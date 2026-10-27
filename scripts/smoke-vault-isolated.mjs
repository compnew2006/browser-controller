#!/usr/bin/env node
/**
 * Isolated end-to-end vault check. It owns a temporary daemon state directory,
 * extension copy and Chromium profile; it never pairs with a user's browser or
 * daemon. Set VAULT_PLAYWRIGHT_MODULE and VAULT_CHROME_EXECUTABLE when Playwright
 * and Chrome for Testing are supplied by the host rather than this project.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { authenticatedHttpGet } = await import(pathToFileURL(path.join(ROOT, 'mcp-server', 'dist', 'bridge-auth.js')).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const privateDiagnostics = { stage: 'setup', secrets: new Set(), logs: [] };

function scrubDiagnostic(value) {
  let text = String(value);
  for (const secret of privateDiagnostics.secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text;
}

async function playwrightApi() {
  const modulePath = process.env.VAULT_PLAYWRIGHT_MODULE;
  const mod = modulePath
    ? await import(pathToFileURL(path.resolve(modulePath)).href)
    : await import('playwright');
  return mod.chromium || mod.default?.chromium;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForDaemon(port, secret, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('isolated daemon exited before readiness');
    try {
      const response = await authenticatedHttpGet(`http://127.0.0.1:${port}`, '/status', secret, {
        signal: AbortSignal.timeout(700),
      });
      if (response.ok) return;
    } catch { /* wait for listener */ }
    await sleep(100);
  }
  throw new Error('isolated daemon did not become ready');
}

async function waitForEnrollment(stateDir, child) {
  const enrollmentPath = path.join(stateDir, 'enrollment.json');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('isolated daemon exited before enrollment setup');
    try { return JSON.parse(await fs.readFile(enrollmentPath, 'utf8')); }
    catch { await sleep(50); }
  }
  throw new Error('isolated daemon did not create enrollment state');
}

async function startFixture() {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Vault fixture</title>
  <form><label>Username <input name="username" autocomplete="username"></label>
  <label>Password <input id="password" name="password" type="password" autocomplete="section-login current-password"></label>
  <button type="submit">Sign in</button></form><input id="upload" type="file" aria-label="Upload fixture"></html>`;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, url: `${baseUrl}/login/one`, secondUrl: `${baseUrl}/login/two` };
}

function resultText(result) {
  return (result?.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

function parseSuccess(result, toolName) {
  const text = resultText(result);
  if (result?.isError) {
    const code = /^([A-Z][A-Z0-9_]+)/.exec(text)?.[1] || 'UNKNOWN';
    throw new Error(`${toolName} returned ${code} (${scrubDiagnostic(text).slice(0, 400)})`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`${toolName} returned an unexpected result shape`); }
}

async function scanFilesFor(root, needle) {
  let found = false;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(full).catch(() => Buffer.alloc(0));
        if (bytes.includes(Buffer.from(needle))) found = true;
      }
    }
  }
  return found;
}

async function locatePrivateVaultPage(context, extensionId) {
  const prefix = `chrome-extension://${extensionId}/vault/vault.html`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const page = context.pages().find((candidate) => candidate.url().startsWith(prefix));
    if (page) return page;
    await sleep(100);
  }
  throw new Error('private vault page did not open');
}

async function privateRpc(page, payload) {
  return page.evaluate((request) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'vaultUiRequest', payload: request }, (response) => resolve(response));
  }), payload);
}

async function focusByKeyboard(page, target) {
  const matches = (matcher) => page.evaluate((spec) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    if (spec.selector && !active.matches(spec.selector)) return false;
    if (spec.buttonText && (!(active instanceof HTMLButtonElement) || !active.textContent.trim().includes(spec.buttonText))) return false;
    if (spec.scopeSelector && !active.closest(spec.scopeSelector)) return false;
    if (spec.scopeHeading && active.closest('article')?.querySelector('h3')?.textContent.trim() !== spec.scopeHeading) return false;
    return true;
  }, matcher);
  if (await matches(target)) return;
  for (let index = 0; index < 60; index++) {
    await page.keyboard.press('Tab');
    if (await matches(target)) return;
  }
  throw new Error('keyboard focus target was not reachable');
}

async function activateButtonByKeyboard(page, buttonText, options = {}) {
  await focusByKeyboard(page, { buttonText, ...options });
  await page.keyboard.press('Enter');
}

function latencySummary(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50: sorted[Math.floor(sorted.length * 0.50)],
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    underTwoSeconds: sorted.filter((value) => value <= 2_000).length,
    samples: sorted.length,
  };
}

async function main() {
  const chromium = await playwrightApi();
  const executablePath = process.env.VAULT_CHROME_EXECUTABLE || chromium.executablePath();
  ensure(executablePath, 'set VAULT_CHROME_EXECUTABLE to an installed Chrome for Testing binary');
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-vault-isolated-'));
  const stateDir = path.join(tempRoot, 'state');
  const profileDir = path.join(tempRoot, 'profile');
  const extensionDir = path.join(tempRoot, 'extension');
  const wsPort = await freePort();
  const fixture = await startFixture();
  const syntheticPassword = `fixture-${crypto.randomBytes(24).toString('hex')}`;
  privateDiagnostics.secrets.add(syntheticPassword);
  let daemon;
  let context;
  let client;
  let secondClient;
  let transport;
  let secondTransport;
  const fillTimings = [];
  const listTimings = [];
  const daemonLogs = [];
  const mcpLogs = [];
  const mcpResults = [];
  let fillCount = 0;
  let listCount = 0;

  try {
    privateDiagnostics.stage = 'isolated-daemon';
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    daemon = spawn(process.execPath, [path.join(ROOT, 'mcp-server/dist/daemon.js')], {
      cwd: ROOT,
      env: { ...process.env, BC_STATE_DIR: stateDir, WS_PORT: String(wsPort), BC_RATE_LIMIT_PER_MIN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.stdout.on('data', (chunk) => daemonLogs.push(chunk.toString()));
    daemon.stderr.on('data', (chunk) => daemonLogs.push(chunk.toString()));
    daemon.on('error', () => {});
    const enrollment = await waitForEnrollment(stateDir, daemon);
    ensure(typeof enrollment.secret === 'string' && enrollment.secret.length > 0, 'isolated enrollment setup failed');
    privateDiagnostics.secrets.add(enrollment.secret);
    await waitForDaemon(wsPort, enrollment.secret, daemon);

    await fs.cp(path.join(ROOT, 'extension'), extensionDir, { recursive: true });
    const manifestPath = path.join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.permissions = manifest.permissions.filter((permission) => permission !== 'nativeMessaging');
    manifest.host_permissions = manifest.host_permissions.map((entry) => entry.replace('127.0.0.1:7225', `127.0.0.1:${wsPort}`));
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const connectionPolicyPath = path.join(extensionDir, 'lib/connection-policy.js');
    let connectionPolicySource = await fs.readFile(connectionPolicyPath, 'utf8');
    connectionPolicySource = connectionPolicySource.replace('export const DEFAULT_WS_PORT = 7225;', `export const DEFAULT_WS_PORT = ${wsPort};`);
    ensure(connectionPolicySource.includes(`export const DEFAULT_WS_PORT = ${wsPort};`), 'isolated extension port configuration failed');
    await fs.writeFile(connectionPolicyPath, connectionPolicySource);

    const connectionPath = path.join(extensionDir, 'lib/connection.js');
    let connectionSource = await fs.readFile(connectionPath, 'utf8');
    connectionSource = connectionSource.replace("let enrollmentSecret = '';", `let enrollmentSecret = ${JSON.stringify(enrollment.secret)};`);
    connectionSource = connectionSource.replace("const NATIVE_PAIRING_HOST = 'com.browser_controller.pairing';", "const NATIVE_PAIRING_HOST = 'com.browser_controller.fixture-disabled';");
    ensure(connectionSource.includes(JSON.stringify(enrollment.secret))
      && connectionSource.includes("com.browser_controller.fixture-disabled"), 'isolated extension pairing configuration failed');
    await fs.writeFile(connectionPath, connectionSource);

    privateDiagnostics.stage = 'disposable-browser';
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: true,
      args: [
        '--no-first-run', '--disable-default-apps',
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ],
    });
    context.on('console', (message) => privateDiagnostics.logs.push(message.text()));
    context.on('page', (page) => page.on('pageerror', (error) => privateDiagnostics.logs.push(error.message)));
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const extensionId = new URL(worker.url()).host;
    ensure(/^[a-p]{32}$/.test(extensionId), 'isolated extension did not receive an ID');

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'mcp-server/dist/index.js'), '--agent', 'VaultFixture'],
      env: { ...process.env, BC_STATE_DIR: stateDir, WS_PORT: String(wsPort), BROWSER_CONTROLLER_DAEMON_MODE: 'connect' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk) => mcpLogs.push(chunk.toString()));
    privateDiagnostics.stage = 'actual-mcp';
    client = new Client({ name: 'credential-vault-fixture', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    ensure(toolNames.includes('browser_vault'), 'browser_vault is missing from actual MCP tools');
    ensure(!toolNames.some((name) => name.startsWith('browser_vault_internal_')), 'private vault wire actions were exposed as MCP tools');

    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      mcpResults.push(result);
      return result;
    };
    const navigation = await call('browser_navigate', { url: fixture.url, snapshot: false });
    if (navigation?.isError) throw new Error('browser_navigate failed in the isolated fixture');
    const tabMatch = /^tabId:\s*(\d+)$/m.exec(resultText(navigation));
    ensure(tabMatch, 'MCP navigation did not return a tab ID');
    const tabId = Number(tabMatch[1]);
    let fixturePage = context.pages().find((page) => page.url().startsWith(fixture.url));
    ensure(fixturePage, 'MCP-created login fixture tab was not found');

    privateDiagnostics.stage = 'private-save-ui';
    const saveRequest = parseSuccess(await call('browser_vault', { action: 'save_login', tabId, label: 'Synthetic login' }), 'browser_vault save_login');
    ensure(saveRequest.status === 'user_action_required' && typeof saveRequest.requestId === 'string', 'save did not create a private request');
    let vaultPage = await locatePrivateVaultPage(context, extensionId);
    const setupButton = vaultPage.getByRole('button', { name: /Set up local vault|Unlock vault/ });
    await setupButton.waitFor({ timeout: 5_000 }).catch(async () => {
      const uiState = await vaultPage.locator('#vaultState').textContent().catch(() => 'missing');
      const actions = await vaultPage.locator('#accessActions').innerText().catch(() => 'missing');
      throw new Error(`private vault access UI unavailable (state ${uiState}; actions ${actions})`);
    });
    await activateButtonByKeyboard(vaultPage, 'Set up local vault');
    await vaultPage.getByRole('status').waitFor({ state: 'attached', timeout: 2_000 }).catch(() => {});
    await vaultPage.getByText('Unlocked', { exact: true }).waitFor({ timeout: 10_000 });
    await vaultPage.getByRole('heading', { name: 'Save a sign-in' }).waitFor({ timeout: 5_000 });

    const requestCard = vaultPage.locator('#requests article').filter({ has: vaultPage.getByRole('heading', { name: 'Save a sign-in' }) });
    const passwordField = requestCard.getByLabel('Password');
    await focusByKeyboard(vaultPage, { selector: '#requests input[name="label"]' });
    await vaultPage.keyboard.type('Synthetic account');
    await focusByKeyboard(vaultPage, { selector: '#requests input[name="identifier"]' });
    await vaultPage.keyboard.type('fixture-user@example.test');
    await focusByKeyboard(vaultPage, { selector: '#requests input[name="password"]' });
    await vaultPage.keyboard.type(syntheticPassword);
    const formValuesSurvived = await passwordField.evaluate(async (field, expectedPassword) => {
      await new Promise((resolve) => setTimeout(resolve, 5_400));
      const card = field.closest('form');
      return field.value === expectedPassword
        && document.activeElement === field
        && card?.querySelector('input[name="label"]')?.value === 'Synthetic account'
        && card?.querySelector('input[name="identifier"]')?.value === 'fixture-user@example.test';
    }, syntheticPassword);
    ensure(formValuesSurvived, 'private save fields or keyboard focus were lost during the five-second state refresh');
    await activateButtonByKeyboard(vaultPage, 'Save and fill using this session', { scopeHeading: 'Save a sign-in' });
    await vaultPage.getByText('Check the session access box before saving and filling.', { exact: true }).waitFor({ timeout: 2_000 });
    const keyboardValidationErrorDisplayed = await vaultPage.getByRole('status').textContent()
      .then((text) => text?.includes('Check the session access box before saving and filling.') === true);
    ensure(keyboardValidationErrorDisplayed, 'the private UI did not clearly display its keyboard-triggered consent error');
    await focusByKeyboard(vaultPage, { selector: '#requests input[type="checkbox"]' });
    await vaultPage.keyboard.press('Space');
    const sessionConsentChecked = await vaultPage.locator('#requests input[type="checkbox"]').evaluate((checkbox) => checkbox.checked);
    ensure(sessionConsentChecked, 'keyboard input did not check the explicit session-consent control');
    await activateButtonByKeyboard(vaultPage, 'Save and fill using this session', { scopeHeading: 'Save a sign-in' });
    await vaultPage.getByText('The account was saved, session access was granted, and one fill was attempted.').waitFor({ timeout: 20_000 });
    const firstFillCorrect = await fixturePage.locator('#password').evaluate((field, expected) => field.value === expected, syntheticPassword);
    ensure(firstFillCorrect, 'the private save-and-fill flow did not fill the fixture field');
    const accessAfterSave = await vaultPage.locator('#accessActions').innerText();
    const privateStateAfterSave = await privateRpc(vaultPage, { operation: 'getState' });
    const grantSummaryAfterSave = (privateStateAfterSave?.grants || []).map((grant) => ({ purpose: grant.purpose, oneShot: grant.oneShot === true }));
    ensure(accessAfterSave.includes('Session fill'), `save-and-fill did not retain its explicit session grant (access ${accessAfterSave}; grants ${JSON.stringify(grantSummaryAfterSave)})`);
    const reviewScreenshotPath = process.env.VAULT_SCREENSHOT_OUT;
    if (reviewScreenshotPath) await vaultPage.screenshot({ path: reviewScreenshotPath, fullPage: true });
    const savedFillGrant = privateStateAfterSave?.grants?.find((grant) => grant.purpose === 'fill' && grant.handle);
    ensure(savedFillGrant, 'private UI state did not retain the session fill grant');

    const closedRequest = parseSuccess(await call('browser_vault', { action: 'save_login', tabId, label: 'Cancel-on-close fixture' }), 'browser_vault close-cancel request');
    ensure(closedRequest.status === 'user_action_required' && typeof closedRequest.requestId === 'string', 'close-cancel request was not created');
    vaultPage = await locatePrivateVaultPage(context, extensionId);
    await vaultPage.close();
    await sleep(150);
    const cancelledState = parseSuccess(await call('browser_vault', { action: 'status', requestId: closedRequest.requestId }), 'browser_vault cancelled status');
    ensure(cancelledState.status === 'cancelled', 'closing the private vault page did not cancel its pending request');
    const declinedRequest = parseSuccess(await call('browser_vault', { action: 'save_login', tabId, label: 'Decline-state fixture' }), 'browser_vault decline request');
    vaultPage = await locatePrivateVaultPage(context, extensionId);
    await vaultPage.locator('#requests article').filter({ has: vaultPage.getByRole('heading', { name: 'Save a sign-in' }) }).waitFor({ timeout: 5_000 });
    await activateButtonByKeyboard(vaultPage, 'Decline', { scopeHeading: 'Save a sign-in' });
    await vaultPage.getByText('Request declined.', { exact: true }).waitFor({ timeout: 5_000 });
    const keyboardCancelStateDisplayed = await vaultPage.getByRole('status').textContent()
      .then((text) => text?.includes('Request declined.') === true);
    ensure(keyboardCancelStateDisplayed, 'the private UI did not clearly display its keyboard-triggered cancellation state');
    const declinedState = parseSuccess(await call('browser_vault', { action: 'status', requestId: declinedRequest.requestId }), 'browser_vault declined status');
    ensure(declinedState.status === 'declined', 'keyboard decline did not cancel the pending private request');

    secondTransport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'mcp-server/dist/index.js'), '--agent', 'VaultFixtureSecond'],
      env: { ...process.env, BC_STATE_DIR: stateDir, WS_PORT: String(wsPort), BROWSER_CONTROLLER_DAEMON_MODE: 'connect' },
      stderr: 'pipe',
    });
    secondTransport.stderr?.on('data', (chunk) => mcpLogs.push(chunk.toString()));
    secondClient = new Client({ name: 'credential-vault-fixture-second', version: '1.0.0' }, { capabilities: {} });
    await secondClient.connect(secondTransport);
    const callSecond = async (name, args) => {
      const result = await secondClient.callTool({ name, arguments: args });
      mcpResults.push(result);
      return result;
    };
    const secondNavigation = await callSecond('browser_navigate', { url: fixture.secondUrl, snapshot: false });
    ensure(!secondNavigation?.isError, 'second MCP session could not open the second fixture page');
    const secondTabMatch = /^tabId:\s*(\d+)$/m.exec(resultText(secondNavigation));
    ensure(secondTabMatch, 'second MCP session navigation did not return a tab ID');
    const secondSessionTabId = Number(secondTabMatch[1]);
    const secondSessionFixturePage = context.pages().find((page) => page.url().startsWith(fixture.secondUrl));
    ensure(secondSessionFixturePage, 'second MCP-created fixture tab was not found');
    privateDiagnostics.stage = 'second-session-list-request';
    const secondListRequest = parseSuccess(await callSecond('browser_vault', { action: 'list', tabId: secondSessionTabId }), 'second-session browser_vault list request');
    ensure(secondListRequest.status === 'user_action_required' && typeof secondListRequest.requestId === 'string', 'a new session reused another session\'s list grant');
    vaultPage = await locatePrivateVaultPage(context, extensionId);
    const secondSessionCard = vaultPage.locator('#requests article').filter({ hasText: 'VaultFixtureSecond' }).filter({ has: vaultPage.getByRole('heading', { name: 'Approve account access' }) });
    await secondSessionCard.waitFor({ timeout: 5_000 });
    await activateButtonByKeyboard(vaultPage, 'Allow session account list', { scopeHeading: 'Approve account access' });
    await vaultPage.getByText('Account metadata access was approved.').waitFor({ timeout: 10_000 });
    privateDiagnostics.stage = 'second-session-list-approved';
    const approvedListStarted = process.hrtime.bigint();
    const secondListed = parseSuccess(await callSecond('browser_vault', { action: 'list', tabId: secondSessionTabId }), 'second-session browser_vault list');
    listTimings.push(Number(process.hrtime.bigint() - approvedListStarted) / 1_000_000);
    ensure(secondListed.status === 'ready' && Array.isArray(secondListed.accounts) && secondListed.accounts.length === 1, 'explicitly approved account list was not returned');

    const listedStarted = process.hrtime.bigint();
    privateDiagnostics.stage = 'first-session-list-after-approval';
    const listed = parseSuccess(await call('browser_vault', { action: 'list', tabId }), 'browser_vault list');
    listTimings.push(Number(process.hrtime.bigint() - listedStarted) / 1_000_000);
    ensure(listed.status === 'ready' && Array.isArray(listed.accounts) && listed.accounts.length === 1, 'the saved account fill grant did not permit scoped listing');
    const account = listed.accounts[0];
    ensure(typeof account.handle === 'string' && account.id === undefined && typeof account.identifier === 'string', 'public account metadata did not use handle-only identifiers');
    ensure(account.handle === savedFillGrant.handle, 'private fill grant and public account handle were not the same opaque account reference');
    listCount = 2;

    privateDiagnostics.stage = 'primary-second-page';
    const existingPages = new Set(context.pages());
    const primarySecondNavigation = await call('browser_navigate', { url: fixture.secondUrl, snapshot: false });
    ensure(!primarySecondNavigation?.isError, 'primary MCP session could not open its second fixture page');
    const primarySecondTabMatch = /^tabId:\s*(\d+)$/m.exec(resultText(primarySecondNavigation));
    ensure(primarySecondTabMatch, 'primary second-page navigation did not return a tab ID');
    const secondTabId = Number(primarySecondTabMatch[1]);
    const secondFixturePage = context.pages().find((page) => !existingPages.has(page) && page.url().startsWith(fixture.secondUrl));
    ensure(secondFixturePage, 'primary MCP-created second fixture tab was not found');

    for (let index = 0; index < 20; index++) {
      privateDiagnostics.stage = `mcp-fill-${index + 1}`;
      let targetTabId = tabId;
      let targetPage = fixturePage;
      if (index === 10) {
        targetTabId = secondTabId;
        targetPage = secondFixturePage;
      } else if (index > 10) {
        targetTabId = secondTabId;
        targetPage = secondFixturePage;
      }
      await targetPage.locator('#password').fill('');
      const started = process.hrtime.bigint();
      const result = parseSuccess(await call('browser_vault', { action: 'fill', tabId: targetTabId, handle: account.handle }), 'browser_vault fill');
      const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
      fillTimings.push(elapsed);
      ensure(result.success === true && result.filled_fields === 1,
        `an authorized MCP fill did not report one successful field (${JSON.stringify({ success: result.success, status: result.status, filledFields: result.filled_fields, code: result.code, elapsedMs: Math.round(elapsed) })})`);
      const oracleCorrect = await targetPage.locator('#password').evaluate((field, expected) => field.value === expected, syntheticPassword);
      ensure(oracleCorrect, `MCP fill call ${index + 1} failed its immediate page oracle`);
      fillCount++;
    }

    await fixturePage.evaluate((value) => {
      const marker = document.createElement('p');
      marker.textContent = value;
      document.body.append(marker);
      window.fixtureEvalSideEffect = false;
    }, syntheticPassword);
    const evaluateAttempt = await call('browser_evaluate', {
      tabId, expression: 'window.fixtureEvalSideEffect = true; return window.fixtureEvalSideEffect',
    });
    ensure(evaluateAttempt.isError === true && resultText(evaluateAttempt).includes('VAULT_CONTEXT_PROTECTED'), 'protected profile evaluation was not refused');
    const evalSideEffectAbsent = await fixturePage.evaluate(() => window.fixtureEvalSideEffect === false);
    ensure(evalSideEffectAbsent, 'protected evaluation ran before it was rejected');
    const screenshotAttempt = await call('browser_screenshot', { tabId });
    ensure(screenshotAttempt.isError === true && resultText(screenshotAttempt).includes('VAULT_CONTEXT_PROTECTED'), 'protected profile screenshot was not refused');
    const nestedAttempt = await call('browser_batch', {
      tabId, actions: [{ tool: 'browser_evaluate', params: { expression: 'window.fixtureEvalSideEffect = true', tabId } }],
    });
    ensure(nestedAttempt.isError === true && resultText(nestedAttempt).includes('VAULT_CONTEXT_PROTECTED'), 'protected nested batch was not refused');

    const textAttempt = await call('browser_text', { tabId });
    const scrubbedText = resultText(textAttempt);
    ensure(!scrubbedText.includes(syntheticPassword), 'page-authored secret text escaped daemon redaction');
    const storageHasSecret = await vaultPage.evaluate(async (needle) => {
      const [local, session] = await Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)]);
      return JSON.stringify([local, session]).includes(needle);
    }, syntheticPassword);
    ensure(!storageHasSecret, 'synthetic password was written to extension storage');
    ensure(!(await scanFilesFor(stateDir, syntheticPassword)), 'synthetic password was written to a persistent daemon file');
    privateDiagnostics.logs.push(...daemonLogs, ...mcpLogs);
    ensure(!privateDiagnostics.logs.some((line) => line.includes(syntheticPassword)), 'fixture password appeared in daemon, MCP or browser logs');

    const vaultFiles = [];
    const walk = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) vaultFiles.push(full);
      }
    };
    await walk(path.join(stateDir, 'vault'));
    const keyFile = vaultFiles.find((file) => /key/i.test(path.basename(file)));
    ensure(keyFile, 'isolated vault key file was not created');
    const symlinkPath = path.join(tempRoot, 'vault-key-alias');
    await fs.symlink(keyFile, symlinkPath);
    const uploadAttempt = await call('browser_fill', {
      tabId, fields: [{ target: '#upload', value: [keyFile] }],
    });
    ensure(uploadAttempt.isError === true && resultText(uploadAttempt).includes('FILE_NOT_ALLOWED'), 'vault key upload was not refused');
    const symlinkUploadAttempt = await call('browser_fill', {
      tabId, fields: [{ target: '#upload', value: [symlinkPath] }],
    });
    ensure(symlinkUploadAttempt.isError === true && resultText(symlinkUploadAttempt).includes('FILE_NOT_ALLOWED'), 'vault key symlink upload was not refused');

    for (let index = 0; index < 18; index++) {
      const started = process.hrtime.bigint();
      const result = parseSuccess(await call('browser_vault', { action: 'list', tabId }), 'browser_vault list timing sample');
      listTimings.push(Number(process.hrtime.bigint() - started) / 1_000_000);
      ensure(result.status === 'ready' && Array.isArray(result.accounts) && result.accounts.length === 1, `list timing sample ${index + 3} did not return the expected account`);
    }
    listCount += 18;
    const fillLatency = latencySummary(fillTimings);
    const listLatency = latencySummary(listTimings);
    ensure(fillLatency.underTwoSeconds >= Math.ceil(fillTimings.length * 0.95), 'SC-008 fill p95 exceeded two seconds');
    ensure(listLatency.underTwoSeconds >= Math.ceil(listTimings.length * 0.95), 'SC-008 list p95 exceeded two seconds');

    await activateButtonByKeyboard(vaultPage, 'Lock vault', { scopeSelector: '#accessActions' });
    await vaultPage.getByText('Locked', { exact: true }).waitFor({ timeout: 10_000 });
    const lockedStatus = parseSuccess(await call('browser_vault', { action: 'status' }), 'browser_vault locked status');
    ensure(lockedStatus.status === 'locked', 'the keyboard lock action did not lock the local vault');
    const reapproval = parseSuccess(await call('browser_vault', { action: 'list', tabId }), 'browser_vault reapproval request');
    ensure(reapproval.status === 'user_action_required' && typeof reapproval.requestId === 'string', 'lock did not revoke account-list access');
    await vaultPage.locator('#requests article').filter({ has: vaultPage.getByRole('heading', { name: 'Approve account access' }) }).waitFor({ timeout: 5_000 });
    await activateButtonByKeyboard(vaultPage, 'Unlock vault', { scopeHeading: 'Approve account access' });
    await vaultPage.getByText('Unlocked', { exact: true }).waitFor({ timeout: 10_000 });
    await activateButtonByKeyboard(vaultPage, 'Allow session account list', { scopeHeading: 'Approve account access' });
    await vaultPage.getByText('Account metadata access was approved.').waitFor({ timeout: 10_000 });
    const reapprovedState = await privateRpc(vaultPage, { operation: 'getState' });
    ensure(reapprovedState.grants?.some((grant) => grant.purpose === 'list'), 'keyboard account-list consent did not create a grant');
    await activateButtonByKeyboard(vaultPage, 'Revoke', { scopeSelector: '#accessActions' });
    await vaultPage.getByText('Session grant revoked.').waitFor({ timeout: 10_000 });
    await activateButtonByKeyboard(vaultPage, 'Remove', { scopeSelector: '.account-row' });
    await activateButtonByKeyboard(vaultPage, 'Confirm remove', { scopeSelector: '.account-row' });
    await vaultPage.getByText('No saved accounts yet.').waitFor({ timeout: 10_000 });
    ensure(!(await privateRpc(vaultPage, { operation: 'getState' })).entries?.length, 'keyboard remove did not delete the saved account');
    const finalScreenshotPath = process.env.VAULT_FINAL_SCREENSHOT_OUT;
    if (finalScreenshotPath) await vaultPage.screenshot({ path: finalScreenshotPath, fullPage: true });

    privateDiagnostics.logs.push(...daemonLogs, ...mcpLogs);
    const allCaptured = JSON.stringify([mcpResults, privateDiagnostics.logs, daemonLogs, mcpLogs]);
    ensure(![...privateDiagnostics.secrets].some((secret) => secret && allCaptured.includes(secret)), 'fixture password or enrollment material appeared in MCP or process logs');
    const version = await context.browser().version();
    console.log(JSON.stringify({
      result: 'passed',
      fixturePages: 2,
      browser: version,
      identity: 'temporary-disposable-chromium-profile',
      privateUiRefreshPreservedTypedFieldsAndFocus: formValuesSurvived,
      keyboardValidationErrorDisplayed,
      keyboardCancelStateDisplayed,
      keyboardOnlySaveUseLockRevokeDelete: true,
      pendingRequestCancelledOnPrivatePageClose: true,
      mcpAccountsListed: listCount,
      mcpFillsVerified: fillCount,
      fillLatencyMs: fillLatency,
      listLatencyMs: listLatency,
      ...(reviewScreenshotPath ? { privateUiScreenshot: reviewScreenshotPath } : {}),
      ...(finalScreenshotPath ? { emptyStateScreenshot: finalScreenshotPath } : {}),
      protectedEvaluateScreenshotAndBatchDenied: true,
      pageTextRedacted: true,
      extensionStorageAndDaemonFilesContainNoFixturePassword: true,
      vaultFilesAndSymlinkUploadsDenied: true,
      privateActionsInMcpManifest: false,
    }));
  } finally {
    await client?.close().catch(() => {});
    await secondClient?.close().catch(() => {});
    await context?.close().catch(() => {});
    await new Promise((resolve) => fixture.server.close(resolve));
    if (daemon && daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => daemon.once('exit', resolve)),
        sleep(3_000),
      ]);
      if (daemon.exitCode === null) daemon.kill('SIGKILL');
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const errorType = error instanceof Error ? error.name : 'Error';
  console.error(`Isolated vault smoke failed at ${privateDiagnostics.stage} (${errorType}).`);
  if (process.env.VAULT_DEBUG === '1') {
    const safeMessage = error instanceof Error ? scrubDiagnostic(error.message).slice(0, 1_000) : 'unknown failure';
    if (safeMessage) console.error(`Sanitized failure: ${safeMessage}`);
    const lines = privateDiagnostics.logs.map(scrubDiagnostic).filter(Boolean).slice(-12);
    if (lines.length) console.error(`Sanitized diagnostics: ${JSON.stringify(lines)}`);
  }
  process.exitCode = 1;
});
