import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export function parseToolEnvelope(response) {
  const text = response?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("tool response must contain text payload");
  }
  return JSON.parse(text);
}

export async function createMcpClient({ serverPath, cwd }) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    cwd,
    stderr: "pipe"
  });
  const client = new Client({ name: "mcp-broker-tests", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

export async function callTool(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  return parseToolEnvelope(response);
}
