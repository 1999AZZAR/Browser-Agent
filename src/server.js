#!/usr/bin/env node
/*
 * Copyright (c) 2026 Azzar Budiyanto / LilyOpenCMS.
 * Licensed under the MIT License.
 * Contact: azzar.mr.zs@gmail.com for inquiries.
 *
 * MCP Server entry point — exposes browser automation tools via Model Context
 * Protocol over stdio transport for CLI integration.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { TOOLS, handleToolCall } = require('./tools');
const browser = require('./core/browser');

const server = new Server(
    { name: 'general-browser-agent', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

// List all available tools — called once when the MCP client connects
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS
}));

// Route tool calls to the handler — wraps in try/catch for clean error reporting
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        return await handleToolCall(name, args);
    } catch (e) {
        return {
            isError: true,
            content: [{ type: 'text', text: `Error: ${e.message}` }]
        };
    }
});

async function run() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[MCP] General Browser Agent running on stdio');
}

// Graceful Shutdown Sequence
async function gracefulShutdown(signal) {
    console.error(`\n[MCP] Received ${signal}. Executing graceful shutdown...`);
    try {
        await browser.saveState(); // Ensure last state is saved before exit
        await browser.closeBrowser();
        console.error('[MCP] Browser context cleanly closed.');
    } catch (e) {
        console.error(`[MCP] Error during shutdown: ${e.message}`);
    } finally {
        process.exit(0);
    }
}

['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => process.on(sig, () => gracefulShutdown(sig)));

run().catch(console.error);
