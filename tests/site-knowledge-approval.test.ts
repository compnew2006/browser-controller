import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { KnowledgeDrafts, type DraftBinding } from '../mcp-server/src/memory/knowledge-draft.js';
import { createKnowledgeProposal } from '../mcp-server/src/memory/knowledge-entry.js';
import { isKnownWireTool } from '../mcp-server/src/protocol/wire-tools.js';
import { registerTools } from '../mcp-server/src/register-tools.js';
import { toolMap } from '../mcp-server/src/tools/registry.js';

const binding: DraftBinding = {
  sessionId: 'session-a', connectionId: 'connection-a', browserId: 'profile-a', origin: 'https://example.invalid',
  operation: 'add', revision: 0, policyGeneration: 0, deletionGeneration: 0,
};
const proposal = () => createKnowledgeProposal({ category: 'site', subject: 'اختبار', body: 'بيانات اصطناعية', source: 'task_summary' });

describe('pending approval at commit', () => {
  it('keeps knowledge writes unavailable through MCP, the wire allowlist and batches before interface qualification', async () => {
    const name = 'browser_site_knowledge_manage';
    const dispatch = vi.fn(async () => ({ success: true }));
    const server = new McpServer({ name: 'knowledge-gate-test', version: '0.0.0' });
    registerTools(server, { callTool: dispatch });
    const client = new Client({ name: 'knowledge-gate-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect((await client.listTools()).tools.some((tool) => tool.name === name)).toBe(false);
      expect(isKnownWireTool(name)).toBe(false);
      const direct = await client.callTool({ name, arguments: { tabId: 7, operation: 'confirm', ownerConfirmed: true } });
      expect(direct.isError).toBe(true);
      const batch = toolMap.get('browser_batch')!;
      const result = await batch.handler({ callTool: dispatch }, {
        tabId: 7, actions: [{ tool: name, params: { operation: 'confirm', ownerConfirmed: true } }],
      });
      expect(result.isError).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });

  it('reserves one draft and completes it only once', () => {
    const drafts = new KnowledgeDrafts();
    const draft = drafts.prepare(binding, [proposal()]);
    const lease = drafts.beginCommit(draft.id, binding, () => true);
    expect(() => drafts.beginCommit(draft.id, binding, () => true)).toThrow();
    expect(drafts.validateCommit(lease, binding)).toBe(true);
    expect(drafts.finishCommit(lease, binding).id).toBe(draft.id);
    expect(() => drafts.finishCommit(lease, binding)).toThrow();
  });

  it('refuses a pending commit if its owner approval is revoked', () => {
    const drafts = new KnowledgeDrafts();
    const draft = drafts.prepare(binding, [proposal()]);
    let approved = true;
    const lease = drafts.beginCommit(draft.id, binding, () => approved);
    approved = false;
    expect(() => drafts.finishCommit(lease, binding)).toThrow();
    expect(() => drafts.preview(draft.id, binding)).toThrow();
  });

  it('refuses a pending commit when the session disconnects', () => {
    const drafts = new KnowledgeDrafts();
    const draft = drafts.prepare(binding, [proposal()]);
    const lease = drafts.beginCommit(draft.id, binding, () => true);
    drafts.cancelSession(binding.sessionId);
    expect(() => drafts.finishCommit(lease, binding)).toThrow();
  });

  it('refuses a pending commit when its deadline expires', () => {
    let clock = 0;
    const drafts = new KnowledgeDrafts(() => clock, () => clock);
    const draft = drafts.prepare(binding, [proposal()]);
    const lease = drafts.beginCommit(draft.id, binding, () => true);
    clock = 5 * 60 * 1000;
    expect(() => drafts.finishCommit(lease, binding)).toThrow();
  });
});
