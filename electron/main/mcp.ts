import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { app } from 'electron';
import { createWebToolsServer } from './webTools.js';

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface McpToolInfo {
  id: string;
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface OpenAiToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface McpConnection {
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport | InMemoryTransport;
  server?: Server;
  tools: McpToolInfo[];
}

export function getBuiltinWebMcpServer(): McpServerConfig {
  return {
    id: 'builtin-web-search',
    name: '内置基础工具',
    command: 'builtin:web-search',
    args: [],
    enabled: true
  };
}

function normalizeServerConfig(config: McpServerConfig): McpServerConfig {
  return {
    id: config.id.trim(),
    name: config.name.trim() || config.id.trim(),
    command: config.command.trim(),
    args: Array.isArray(config.args) ? config.args.map((arg) => String(arg)) : [],
    env: config.env ?? {},
    enabled: config.enabled !== false
  };
}

function toToolId(serverId: string, toolName: string) {
  return `${serverId}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function toolResultToText(result: CallToolResult) {
  return result.content
    .map((item) => {
      if (item.type === 'text') return item.text;
      if (item.type === 'image') return `[image:${item.mimeType}]`;
      if (item.type === 'resource') return JSON.stringify(item.resource);
      return JSON.stringify(item);
    })
    .join('\n');
}

export class McpManager {
  private configs: McpServerConfig[] = [];
  private connections = new Map<string, McpConnection>();

  setConfigs(configs: McpServerConfig[]) {
    this.configs = configs.map(normalizeServerConfig);
  }

  getConfigs() {
    return this.configs;
  }

  async refresh() {
    const enabledIds = new Set(this.configs.filter((config) => config.enabled).map((config) => config.id));

    for (const [id, connection] of this.connections) {
      if (!enabledIds.has(id)) {
        await connection.client.close().catch(() => undefined);
        this.connections.delete(id);
      }
    }

    for (const config of this.configs) {
      if (!config.enabled) continue;
      if (this.connections.has(config.id)) continue;
      await this.connect(config).catch(() => undefined);
    }

    return this.listTools();
  }

  async connect(config: McpServerConfig) {
    const server = config.command === 'builtin:web-search' ? createWebToolsServer() : undefined;
    const [clientTransport, serverTransport] = server ? InMemoryTransport.createLinkedPair() : [undefined, undefined];
    const transport =
      clientTransport ??
      new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: {
          ...process.env,
          ...(config.env ?? {})
        } as Record<string, string>,
        stderr: 'pipe'
      });
    const client = new Client({
      name: 'little-secretary',
      version: app.getVersion()
    });

    if (server && serverTransport) {
      await server.connect(serverTransport);
    }

    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools.map((tool: Tool) => ({
      id: toToolId(config.id, tool.name),
      serverId: config.id,
      serverName: config.name,
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema
    }));

    this.connections.set(config.id, {
      config,
      client,
      transport,
      server,
      tools
    });
  }

  listTools() {
    return [...this.connections.values()].flatMap((connection) => connection.tools);
  }

  toOpenAiTools(): OpenAiToolDefinition[] {
    return this.listTools().map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.id,
        description: `[${tool.serverName}] ${tool.description || tool.name}`,
        parameters: tool.inputSchema || {
          type: 'object',
          properties: {}
        }
      }
    }));
  }

  async callTool(toolId: string, args: unknown) {
    const tool = this.listTools().find((item) => item.id === toolId);
    if (!tool) {
      throw new Error(`MCP 工具不存在或未连接：${toolId}`);
    }

    const connection = this.connections.get(tool.serverId);
    if (!connection) {
      throw new Error(`MCP 服务器未连接：${tool.serverName}`);
    }

    const result = await connection.client.callTool({
      name: tool.name,
      arguments: typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
    });

    return toolResultToText(result as CallToolResult);
  }

  async closeAll() {
    for (const connection of this.connections.values()) {
      await connection.client.close().catch(() => undefined);
    }
    this.connections.clear();
  }
}
