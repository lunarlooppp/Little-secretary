import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { app } from 'electron';
import { createServer } from 'node:net';
import { createWebToolsServer } from './webTools.js';

const MCP_REMOTE_PORT_RETRY_LIMIT = 3;

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

function commandPreview(config: McpServerConfig) {
  return [config.command, ...config.args].filter(Boolean).join(' ');
}

function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
}

function formatConnectionError(config: McpServerConfig, error: unknown, stderrOutput = '') {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const stderr = stderrOutput.trim();
  const details = stderr ? `${rawMessage}\n${stderr}` : rawMessage;
  const lowerDetails = details.toLowerCase();

  if (errorCode(error) === 'ENOENT') {
    return `MCP 服务器「${config.name}」启动失败：找不到命令「${config.command}」。请确认安装方式可用，或命令已加入 PATH。\n执行命令：${commandPreview(config)}`;
  }

  if (lowerDetails.includes('eaddrinuse')) {
    return `MCP 服务器「${config.name}」启动失败：本机 OAuth 回调端口被占用。系统已自动尝试更换端口，请刷新 MCP 工具后重试。\n执行命令：${commandPreview(config)}\n错误详情：${details}`;
  }

  if (lowerDetails.includes('unknown option') || lowerDetails.includes('unknown argument') || lowerDetails.includes('unknown or unexpected option')) {
    return `MCP 服务器「${config.name}」启动失败：存在不支持的参数。\n执行命令：${commandPreview(config)}\n错误详情：${details}`;
  }

  return `MCP 服务器「${config.name}」连接失败。\n执行命令：${commandPreview(config)}\n错误详情：${details}`;
}

function findAvailablePort(host = '127.0.0.1') {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function isAddressInUseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('eaddrinuse') || message.toLowerCase().includes('address already in use');
}

function isMcpRemoteConfig(config: McpServerConfig) {
  if (config.command === 'mcp-remote') return true;
  return config.args.some((arg) => {
    const normalizedArg = arg.replace(/\\/g, '/');
    return normalizedArg === 'mcp-remote' || normalizedArg === 'mcp-remote@latest' || normalizedArg.endsWith('/mcp-remote/dist/proxy.js');
  });
}

function withCallbackPort(args: string[], port: number) {
  const remoteUrlIndex = args.findIndex((arg) => /^https?:\/\//i.test(arg));
  if (remoteUrlIndex < 0) return args;

  const callbackPortIndex = remoteUrlIndex + 1;
  const nextArg = args[callbackPortIndex];
  const nextArgs = [...args];

  if (nextArg && /^\d+$/.test(nextArg)) {
    nextArgs[callbackPortIndex] = String(port);
    return nextArgs;
  }

  nextArgs.splice(callbackPortIndex, 0, String(port));
  return nextArgs;
}

function removeInvalidMcpRemoteValueFlags(args: string[]) {
  const nextArgs: string[] = [];
  const valueFlags = new Set(['--header', '--resource']);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!valueFlags.has(arg)) {
      nextArgs.push(arg);
      continue;
    }

    const value = args[index + 1];
    if (value && !value.startsWith('-')) {
      nextArgs.push(arg, value);
      index += 1;
    } else if (value && !value.startsWith('--')) {
      index += 1;
    }
  }

  return nextArgs;
}

async function withAutoCallbackPort(config: McpServerConfig): Promise<McpServerConfig> {
  if (!isMcpRemoteConfig(config)) return config;
  const port = await findAvailablePort();
  return {
    ...config,
    args: withCallbackPort(removeInvalidMcpRemoteValueFlags(config.args), port)
  };
}

export class McpManager {
  private configs: McpServerConfig[] = [];
  private connections = new Map<string, McpConnection>();
  private lastFailures: string[] = [];

  setConfigs(configs: McpServerConfig[]) {
    this.configs = configs.map(normalizeServerConfig);
  }

  getConfigs() {
    return this.configs;
  }

  getLastFailures() {
    return this.lastFailures;
  }

  async refresh() {
    const enabledIds = new Set(this.configs.filter((config) => config.enabled).map((config) => config.id));

    for (const [id, connection] of this.connections) {
      if (!enabledIds.has(id)) {
        await connection.client.close().catch(() => undefined);
        this.connections.delete(id);
      }
    }

    const failures: string[] = [];

    for (const config of this.configs) {
      if (!config.enabled) continue;
      if (this.connections.has(config.id)) continue;
      await this.connect(config).catch((error) => {
        failures.push(error instanceof Error ? error.message : String(error));
      });
    }

    this.lastFailures = failures;

    return this.listTools();
  }

  async connect(config: McpServerConfig) {
    const attempts = isMcpRemoteConfig(config) ? MCP_REMOTE_PORT_RETRY_LIMIT : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const runtimeConfig = await withAutoCallbackPort(config);
      try {
        await this.connectRuntimeConfig(runtimeConfig);
        return;
      } catch (error) {
        lastError = error;
        if (!isAddressInUseError(error) || attempt === attempts - 1) {
          throw error;
        }
      }
    }

    if (lastError) throw lastError;
  }

  private async connectRuntimeConfig(runtimeConfig: McpServerConfig) {
    const server = runtimeConfig.command === 'builtin:web-search' ? createWebToolsServer() : undefined;
    const [clientTransport, serverTransport] = server ? InMemoryTransport.createLinkedPair() : [undefined, undefined];
    let stderrOutput = '';
    const transport =
      clientTransport ??
      new StdioClientTransport({
        command: runtimeConfig.command,
        args: runtimeConfig.args,
        env: {
          ...process.env,
          ...(runtimeConfig.env ?? {})
        } as Record<string, string>,
        stderr: 'pipe'
      });
    const client = new Client({
      name: 'little-secretary',
      version: app.getVersion()
    });

    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on('data', (chunk) => {
        stderrOutput = `${stderrOutput}${String(chunk)}`.slice(-4000);
      });
    }

    try {
      if (server && serverTransport) {
        await server.connect(serverTransport);
      }

      await client.connect(transport);
      const listed = await client.listTools();
      const tools = listed.tools.map((tool: Tool) => ({
        id: toToolId(runtimeConfig.id, tool.name),
        serverId: runtimeConfig.id,
        serverName: runtimeConfig.name,
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema
      }));

      this.connections.set(runtimeConfig.id, {
        config: runtimeConfig,
        client,
        transport,
        server,
        tools
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new Error(formatConnectionError(runtimeConfig, error, stderrOutput));
    }
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
