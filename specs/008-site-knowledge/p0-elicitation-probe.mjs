#!/usr/bin/env node
// Isolated P0 fixture: no Browser Controller, filesystem writes, or real data.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'site-knowledge-p0-probe', version: '0.1.0' });
const pages = [
  `اختبار اصطناعي — صفحة 1/3\nالموقع: https://example.invalid\nالملف: اختبار فقط\nالعملية: مراجعة دون حفظ\nتحذير: لا توجد بيانات حقيقية.\n${'بيانات تجربة فقط. '.repeat(120)}\nEND-PAGE-1`,
  `اختبار اصطناعي — صفحة 2/3\nالمصدر: سجل تجريبي\n${'Synthetic review content; no private data. '.repeat(45)}\nEND-PAGE-2`,
  'اختبار اصطناعي — صفحة 3/3\nتحذير: قد تعيد النسخة القديمة معلومات حُذفت سابقًا.\nEND-PAGE-3',
];

server.registerTool('site_knowledge_preview_probe', {
  description: 'اختبار عرض موافقة اصطناعية متعددة الصفحات فقط؛ لا يقرأ أو يكتب معرفة المواقع.',
  inputSchema: {},
}, async () => {
  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    return { isError: true, content: [{ type: 'text', text: 'Client does not support form elicitation; no operation performed.' }] };
  }
  try {
    for (const message of pages) {
      const answer = await server.server.elicitInput({
        mode: 'form', message,
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean', title: 'قرأت الصفحة كاملة (اختبار فقط)' } },
          required: ['confirm'],
        },
      });
      if (answer.action !== 'accept' || answer.content?.confirm !== true) {
        return { content: [{ type: 'text', text: 'Probe cancelled; no operation performed.' }] };
      }
    }
    return { content: [{ type: 'text', text: 'Probe responses received. This does not prove that the UI displayed complete content.' }] };
  } catch {
    return { isError: true, content: [{ type: 'text', text: 'Probe unavailable or interrupted; no operation performed.' }] };
  }
});

await server.connect(new StdioServerTransport());
