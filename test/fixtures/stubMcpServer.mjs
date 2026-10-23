import { writeFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "stub", version: "1.0.0" });
server.registerTool("ping", { description: "Answers pong" }, async () => ({ content: [{ type: "text", text: "pong" }] }));

writeFileSync(process.argv[2], String(process.pid));
await server.connect(new StdioServerTransport());
