import type { ToolDefinition } from './types.js';
export declare const allTools: ToolDefinition[];
export declare const toolMap: Map<string, ToolDefinition>;
export declare function isIdempotent(tool: string): boolean;
export declare function toolTimeoutMs(tool: string): number | undefined;
//# sourceMappingURL=index.d.ts.map