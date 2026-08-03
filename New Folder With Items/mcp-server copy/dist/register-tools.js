import { allTools } from './tools/index.js';
import { createMetaTool } from './tools/meta.js';
/** Wrap a tool handler so a throw becomes an isError result, never a protocol error. */
function wrapHandler(tool, host) {
    return async (params) => {
        try {
            return await tool.handler(host, params);
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    };
}
export function registerTools(server, host, fullMode, log = () => { }) {
    // Track which tools are enabled (for the meta tool's isActive callback).
    const activeTools = new Set();
    const toolHandles = new Map();
    const metaDeps = {
        onActivate: (toolName) => {
            if (activeTools.has(toolName))
                return; // already active
            const handle = toolHandles.get(toolName);
            if (handle) {
                handle.enable();
                activeTools.add(toolName);
                server.sendToolListChanged();
                log(`progressive disclosure: activated "${toolName}"`);
            }
        },
        isActive: (toolName) => activeTools.has(toolName),
    };
    // Register all browser tools, keeping handles for enable/disable control.
    for (const tool of allTools) {
        const handle = server.tool(tool.name, tool.description, tool.inputSchema.shape, wrapHandler(tool, host));
        toolHandles.set(tool.name, handle);
        if (fullMode) {
            activeTools.add(tool.name);
        }
        else {
            handle.disable(); // hidden until the agent activates it via browser_tools
        }
    }
    // Register the meta tool LAST (always enabled — it's the discovery entry point).
    const metaTool = createMetaTool(metaDeps);
    server.tool(metaTool.name, metaTool.description, metaTool.inputSchema.shape, wrapHandler(metaTool, host));
    return { toolHandles, activeTools };
}
//# sourceMappingURL=register-tools.js.map