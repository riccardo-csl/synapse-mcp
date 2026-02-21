#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { toolDefinitions } from "./lib/mcp/tools.js";
import { executeTool } from "./lib/mcp/handlers.js";

const server = new Server(
  {
    name: "mcp-broker",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const result = await executeTool(name, args || {});
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
