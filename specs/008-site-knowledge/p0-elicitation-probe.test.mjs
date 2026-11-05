// Protocol tests only. A passing test does not qualify any visible client UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./p0-elicitation-probe.mjs', import.meta.url));

async function run(mode) {
  const client = new Client({ name: 'site-knowledge-p0-test', version: '1.0.0' }, {
    capabilities: mode === 'unsupported' ? {} : { elicitation: { form: {} } },
  });
  const messages = [];
  if (mode !== 'unsupported') {
    client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
      messages.push(params.message);
      if (mode === 'cancel') return { action: 'cancel' };
      if (mode === 'false') return { action: 'accept', content: { confirm: false } };
      if (mode === 'error') throw new Error('synthetic client failure');
      if (mode === 'disconnect') {
        await client.close();
        throw new Error('synthetic client disconnection');
      }
      return { action: 'accept', content: { confirm: true } };
    });
  }
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fixture], stderr: 'pipe' }));
  try {
    const result = await client.callTool({ name: 'site_knowledge_preview_probe', arguments: {} });
    return { result, messages };
  } finally {
    await client.close();
  }
}

test('passes three unmodified synthetic messages, without claiming display', async () => {
  const { result, messages } = await run('accept');
  assert.equal(messages.length, 3);
  assert.ok(Buffer.byteLength(messages[0], 'utf8') > 4000);
  assert.ok(Buffer.byteLength(messages[0], 'utf8') <= 4096);
  for (let i = 0; i < messages.length; i += 1) {
    assert.ok(messages[i].endsWith(`END-PAGE-${i + 1}`));
  }
  assert.match(messages[0], /https:\/\/example\.invalid/);
  assert.match(messages[2], /تحذير/);
  assert.match(result.content[0].text, /does not prove/);
});

for (const mode of ['cancel', 'false']) {
  test(`${mode} stops before further pages`, async () => {
    const { result, messages } = await run(mode);
    assert.equal(messages.length, 1);
    assert.match(result.content[0].text, /cancelled/);
  });
}

test('unsupported client fails closed', async () => {
  const { result, messages } = await run('unsupported');
  assert.equal(messages.length, 0);
  assert.equal(result.isError, true);
});

test('client error fails closed', async () => {
  const { result, messages } = await run('error');
  assert.equal(messages.length, 1);
  assert.equal(result.isError, true);
});

test('disconnect interrupts the probe', async () => {
  await assert.rejects(run('disconnect'));
});
