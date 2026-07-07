import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { ChunkType, ToolCallPayload, ToolResultPayload } from '@mastra/core/stream';
import { createTool } from '@mastra/core/tools';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { existsSync, mkdirSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpManager } from './mcp.js';
import type { ChatMessage, ModelConfig } from './types.js';
import { fetchPage, getCurrentTime, webSearch } from './webTools.js';

type StreamDelta = (payload: { type: 'content' | 'reasoning'; text: string }) => void;

export interface MastraRunOptions {
  messages: ChatMessage[];
  instructions: string;
  modelConfig: ModelConfig;
  mcpManager: McpManager;
  capabilityManager?: CapabilityManager;
  allowedDirectories: string[];
  storageDir: string;
  sessionId?: string;
  maxToolRounds: number;
  signal: AbortSignal;
  onDelta: StreamDelta;
}

export interface CapabilityManager {
  list: (request?: { refresh?: boolean }) => unknown;
  saveMcpServer: (server: {
    id?: string;
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
    enabled?: boolean;
  }) => Promise<unknown>;
  deleteMcpServer: (request: { id: string }) => Promise<unknown>;
  cleanupMcpServers: (request?: { keepIds?: string[]; dryRun?: boolean }) => Promise<unknown>;
  callMcpTool: (request: { toolId: string; args?: Record<string, unknown> }) => Promise<unknown>;
  createSkill: (skill: { name: string; content: string; enabled?: boolean }) => Promise<unknown>;
  deleteSkill: (request: { id: string; removeFiles?: boolean }) => Promise<unknown>;
}

interface EvolutionNote {
  at: string;
  kind: 'success' | 'failure';
  summary: string;
}

interface LocalListDirectoryRequest {
  dirPath: string;
  maxEntries?: number;
}

interface LocalReadFileRequest {
  filePath: string;
  maxBytes?: number;
}

interface LocalWriteFileRequest {
  filePath: string;
  content: string;
  overwrite?: boolean;
}

const AGENT_ID = 'little-secretary-agent';
const DEFAULT_RESOURCE_ID = 'local-user';
const NOTES_FILE = 'evolution-notes.json';
const MAX_EVOLUTION_NOTES = 24;
const MAX_FILE_READ_BYTES = 256 * 1024;
const MAX_FILE_WRITE_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 300;
const REPLACEMENT_CHARACTER = '\uFFFD';

let memory: Memory | null = null;
let storage: LibSQLStore | null = null;
let memoryDir = '';

function ensureMemory(storageDir: string) {
  if (memory && storage && memoryDir === storageDir) return memory;

  mkdirSync(storageDir, { recursive: true });
  storage = new LibSQLStore({
    id: 'little-secretary-memory',
    url: `file:${path.join(storageDir, 'mastra.db')}`
  });
  memory = new Memory({
    storage,
    options: {
      generateTitle: false,
      lastMessages: 18,
      semanticRecall: false,
      workingMemory: {
        enabled: true,
        scope: 'resource'
      }
    }
  });
  memoryDir = storageDir;
  return memory;
}

function sanitizeId(value: string, fallback: string) {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 96);
  return normalized || fallback;
}

function getThreadId(sessionId?: string) {
  return sanitizeId(sessionId || 'default-session', 'default-session');
}

function sliceTextByCodePoint(value: string, maxLength: number) {
  return Array.from(value).slice(0, maxLength).join('');
}

function sanitizeLlmText(value: string) {
  return value
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, REPLACEMENT_CHARACTER)
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, REPLACEMENT_CHARACTER)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function toMastraModelConfig(modelConfig: ModelConfig): MastraModelConfig {
  return {
    providerId: sanitizeId(modelConfig.providerName || 'openai-compatible', 'openai-compatible').toLowerCase(),
    modelId: modelConfig.model,
    url: modelConfig.baseUrl.replace(/\/+$/, ''),
    apiKey: modelConfig.apiKey || undefined
  };
}

function readEvolutionNotes(storageDir: string): EvolutionNote[] {
  const filePath = path.join(storageDir, NOTES_FILE);
  if (!existsSync(filePath)) return [];

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as EvolutionNote[];
    return Array.isArray(parsed)
      ? parsed
          .filter((note) => note.kind && note.summary)
          .map((note) => ({
            ...note,
            summary: sanitizeLlmText(note.summary)
          }))
          .slice(-MAX_EVOLUTION_NOTES)
      : [];
  } catch {
    return [];
  }
}

function writeEvolutionNote(storageDir: string, note: EvolutionNote) {
  mkdirSync(storageDir, { recursive: true });
  const filePath = path.join(storageDir, NOTES_FILE);
  const nextNotes = [
    ...readEvolutionNotes(storageDir),
    {
      ...note,
      summary: sanitizeLlmText(note.summary)
    }
  ].slice(-MAX_EVOLUTION_NOTES);
  writeFileSync(filePath, JSON.stringify(nextNotes, null, 2), 'utf8');
}

function buildEvolutionPrompt(storageDir: string) {
  const notes = readEvolutionNotes(storageDir);
  if (notes.length === 0) return '';

  const recentNotes = notes
    .slice(-8)
    .map((note) => `- ${note.kind === 'failure' ? 'Avoid' : 'Reuse'}: ${note.summary}`)
    .join('\n');

  return ['Self-improvement notes from previous runs:', recentNotes].join('\n');
}

function buildLocalFilePrompt(allowedDirectories: string[]) {
  if (allowedDirectories.length === 0) {
    return [
      'Local file tools:',
      '- No local directories are currently authorized.',
      '- If the user asks to read, write, or list local files, ask them to add an allowed directory in System Settings first.'
    ].join('\n');
  }

  const directories = allowedDirectories.map((directory) => `- ${directory}`).join('\n');
  return [
    'Local file tools:',
    '- You can read UTF-8 files, write UTF-8 files, and list directories only inside the user-authorized directories below.',
    '- Before accessing an unclear path, list the authorized directories or ask the user for the exact path.',
    '- Do not delete files. When overwriting a file, only use overwrite=true if the user clearly requested replacement.',
    'Authorized directories:',
    directories
  ].join('\n');
}

function buildCapabilityPrompt() {
  return [
    'Capability configuration tools:',
    '- You may configure MCP servers and local Skills when the user asks for new capabilities or when solving their request clearly requires a reusable capability.',
    '- Keep configuration minimal and tidy. Before adding a new MCP server or Skill, list current configuration and prefer updating an existing related item over creating a new duplicate.',
    '- Prefer free MCP servers and popular/well-maintained Skills. Search the web first when choosing third-party servers or Skill content, verify package names and install commands from current sources, and summarize the source/maintenance signal to the user.',
    '- Do not add paid, private, credential-requiring, or obscure MCP servers unless the user explicitly asks for them.',
    '- For automatically saved MCP servers, use only npx, pnpm, bunx, or uvx as the command. Use direct argv-style args; do not use shell snippets, redirects, pipes, or secrets.',
    '- For MCP servers, save only command/args/env configuration. Do not invent secrets. If credentials are required, tell the user what environment variable or setup is needed.',
    '- Do not use save_mcp_server with enabled=false to disable duplicates. Use delete_mcp_server or cleanup_mcp_servers for cleanup.',
    '- Saving an MCP server performs a real connectivity check before persistence. Only tell the user it is configured when the tool result has saved=true and verified=true; if verification fails, explain the failure and search for another viable option.',
    '- Newly saved MCP tools are immediately callable in the current response through capability_call_mcp_tool using the tool id returned by save/list configuration.',
    '- After a successful MCP save, run cleanup for duplicate MCP servers unless the user explicitly wants multiple redundant providers. If an attempted capability is superseded, delete the old duplicate configuration.',
    '- For Skills, create focused SKILL.md instructions that are reusable, concise, and enabled by default only when broadly useful.'
  ].join('\n');
}

function summarizeForEvolution(messages: ChatMessage[], resultText: string) {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const compactUser = sliceTextByCodePoint(sanitizeLlmText(lastUserMessage.replace(/\s+/g, ' ')), 180);
  const compactResult = sliceTextByCodePoint(sanitizeLlmText(resultText.replace(/\s+/g, ' ')), 180);
  return `User asked: ${compactUser || '(empty)'}; response pattern: ${compactResult || '(empty)'}`;
}

function summarizeFailure(messages: ChatMessage[], error: unknown) {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const compactUser = sliceTextByCodePoint(sanitizeLlmText(lastUserMessage.replace(/\s+/g, ' ')), 160);
  const message = error instanceof Error ? error.message : String(error);
  return `When handling "${compactUser || '(empty)'}", failure was: ${sliceTextByCodePoint(sanitizeLlmText(message), 220)}`;
}

function createMcpTools(mcpManager: McpManager, onDelta: StreamDelta) {
  const tools: Record<string, ReturnType<typeof createTool>> = {};

  for (const tool of mcpManager.listTools()) {
    tools[tool.id] = createTool({
      id: tool.id,
      description: `[${tool.serverName}] ${tool.description || tool.name}`,
      inputSchema: z.record(z.unknown()).default({}),
      execute: async (input) => {
        onDelta({
          type: 'reasoning',
          text: `\n[Calling tool ${tool.id}]\n`
        });
        return mcpManager.callTool(tool.id, input);
      }
    });
  }

  return tools;
}

function createBuiltinWebTools(onDelta: StreamDelta) {
  return {
    web_search: createTool({
      id: 'web_search',
      description: 'Search current web information by keyword and return title, URL and snippet results.',
      inputSchema: z
        .object({
          query: z.string().describe('Search keywords.'),
          max_results: z.number().int().min(1).max(10).optional().default(5)
        })
        .default({ query: '', max_results: 5 }),
      execute: async (input) => {
        onDelta({
          type: 'reasoning',
          text: `\n[Calling tool web_search] ${formatJson(input)}\n`
        });
        return webSearch(input as Record<string, unknown>);
      }
    }),
    fetch_page: createTool({
      id: 'fetch_page',
      description: 'Fetch a web page URL and extract readable title, description and text content.',
      inputSchema: z
        .object({
          url: z.string().describe('URL to fetch.'),
          max_chars: z.number().int().min(1000).max(20000).optional().default(8000)
        })
        .default({ url: '', max_chars: 8000 }),
      execute: async (input) => {
        onDelta({
          type: 'reasoning',
          text: `\n[Calling tool fetch_page] ${formatJson(input)}\n`
        });
        return fetchPage(input as Record<string, unknown>);
      }
    }),
    get_current_time: createTool({
      id: 'get_current_time',
      description: 'Get the current date and time. Use this for relative time words such as now, today, current, yesterday or tomorrow.',
      inputSchema: z
        .object({
          time_zone: z.string().optional(),
          locale: z.string().optional()
        })
        .default({}),
      execute: async (input) => {
        onDelta({
          type: 'reasoning',
          text: `\n[Calling tool get_current_time] ${formatJson(input)}\n`
        });
        return getCurrentTime(input as Record<string, unknown>);
      }
    })
  };
}

function isPathInside(parentPath: string, targetPath: string) {
  const relative = path.relative(parentPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveRealTargetForPermission(resolvedTarget: string) {
  let current = resolvedTarget;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const realCurrent = await fs.realpath(current);
      return path.join(realCurrent, ...missingSegments.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolvedTarget;
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

async function ensureInsideAllowedDirectory(targetPath: string, allowedDirectories: string[]) {
  const resolvedTarget = path.resolve(targetPath);
  const normalizedAllowed = allowedDirectories.map((directory) => path.resolve(directory));

  for (const allowedDirectory of normalizedAllowed) {
    if (!isPathInside(allowedDirectory, resolvedTarget)) continue;

    const realAllowedDirectory = await fs.realpath(allowedDirectory).catch(() => allowedDirectory);
    const realTarget = await resolveRealTargetForPermission(resolvedTarget);
    if (isPathInside(realAllowedDirectory, realTarget)) return resolvedTarget;
  }

  throw new Error('该路径未授权。请先在系统设置中添加允许访问的目录。');
}

function createLocalFileTools(allowedDirectories: string[], onDelta: StreamDelta) {
  const tools: Record<string, ReturnType<typeof createTool>> = {};

  tools.local_list_allowed_directories = createTool({
    id: 'local_list_allowed_directories',
    description: 'List local directories that the user has authorized this agent to access.',
    inputSchema: z.object({}).default({}),
    execute: async () => {
      onDelta({
        type: 'reasoning',
        text: '\n[Calling tool local_list_allowed_directories]\n'
      });
      return { allowedDirectories };
    }
  });

  tools.local_list_directory = createTool({
    id: 'local_list_directory',
    description: 'List files and folders in an authorized local directory. Only paths inside allowed directories are accessible.',
    inputSchema: z
      .object({
        dirPath: z.string().describe('Absolute or relative directory path to list.'),
        maxEntries: z.number().int().min(1).max(MAX_DIRECTORY_ENTRIES).optional()
      })
      .default({ dirPath: '.' }),
    execute: async (input) => {
      const request = (input ?? { dirPath: '.' }) as LocalListDirectoryRequest;
      onDelta({
        type: 'reasoning',
        text: `\n[Calling tool local_list_directory] ${formatJson(request)}\n`
      });
      const dirPath = await ensureInsideAllowedDirectory(request.dirPath, allowedDirectories);
      const maxEntries = request.maxEntries ?? MAX_DIRECTORY_ENTRIES;
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const sortedEntries = entries.sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name);
      });

      return {
        path: dirPath,
        truncated: sortedEntries.length > maxEntries,
        entries: sortedEntries.slice(0, maxEntries).map((entry) => ({
          name: entry.name,
          path: path.join(dirPath, entry.name),
          type: entry.isDirectory() ? 'directory' : 'file'
        }))
      };
    }
  });

  tools.local_read_file = createTool({
    id: 'local_read_file',
    description: 'Read a UTF-8 text file from an authorized local directory. Large files are truncated.',
    inputSchema: z
      .object({
        filePath: z.string().describe('Absolute or relative file path to read.'),
        maxBytes: z.number().int().min(1).max(MAX_FILE_READ_BYTES).optional()
      })
      .default({ filePath: '' }),
    execute: async (input) => {
      const request = (input ?? { filePath: '' }) as LocalReadFileRequest;
      onDelta({
        type: 'reasoning',
        text: `\n[Calling tool local_read_file] ${formatJson(request)}\n`
      });
      const filePath = await ensureInsideAllowedDirectory(request.filePath, allowedDirectories);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error('目标路径不是文件。');

      const maxBytes = request.maxBytes ?? MAX_FILE_READ_BYTES;
      const bytesToRead = Math.min(stat.size, maxBytes);
      const handle = await fs.open(filePath, 'r');

      try {
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
        return {
          path: filePath,
          sizeBytes: stat.size,
          truncated: stat.size > bytesRead,
          content: buffer.toString('utf8', 0, bytesRead)
        };
      } finally {
        await handle.close();
      }
    }
  });

  tools.local_write_file = createTool({
    id: 'local_write_file',
    description:
      'Write a UTF-8 text file inside an authorized local directory. Existing files require overwrite=true. This tool does not delete files.',
    inputSchema: z
      .object({
        filePath: z.string().describe('Absolute or relative file path to write.'),
        content: z.string().describe('UTF-8 text content to write.'),
        overwrite: z.boolean().optional().default(false)
      })
      .default({ filePath: '', content: '', overwrite: false }),
    execute: async (input) => {
      const request = (input ?? { filePath: '', content: '', overwrite: false }) as LocalWriteFileRequest;
      onDelta({
        type: 'reasoning',
        text: `\n[Calling tool local_write_file] ${formatJson({ filePath: request.filePath, overwrite: request.overwrite })}\n`
      });
      const filePath = await ensureInsideAllowedDirectory(request.filePath, allowedDirectories);
      const sizeBytes = Buffer.byteLength(request.content, 'utf8');
      if (sizeBytes > MAX_FILE_WRITE_BYTES) {
        throw new Error(`写入内容过大，当前限制为 ${MAX_FILE_WRITE_BYTES} bytes。`);
      }

      const existingStat = await fs.stat(filePath).catch(() => null);
      if (existingStat?.isDirectory()) throw new Error('目标路径是目录，不能写入文件内容。');
      if (existingStat && !request.overwrite) throw new Error('文件已存在。如需覆盖，请设置 overwrite=true。');

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, request.content, 'utf8');
      return {
        path: filePath,
        sizeBytes,
        overwritten: Boolean(existingStat)
      };
    }
  });

  return tools;
}

function createCapabilityTools(capabilityManager: CapabilityManager | undefined, onDelta: StreamDelta) {
  const tools: Record<string, ReturnType<typeof createTool>> = {};
  if (!capabilityManager) return tools;

  tools.capability_list_configuration = createTool({
    id: 'capability_list_configuration',
    description: 'List current capability configuration, including MCP health, duplicate MCP groups, connected tools, Skills, and storage.',
    inputSchema: z
      .object({
        refresh: z.boolean().optional().default(false).describe('Whether to refresh MCP connections before listing. Use true when checking current health.')
      })
      .default({ refresh: false }),
    execute: async (input) => {
      const request = input as Parameters<CapabilityManager['list']>[0];
      onDelta({
        type: 'reasoning',
        text: `\n[Calling tool capability_list_configuration] ${formatJson(request)}\n`
      });
      return capabilityManager.list(request);
    }
  });

  tools.capability_save_mcp_server = createTool({
    id: 'capability_save_mcp_server',
    description:
      'Add or update one MCP server configuration after a real connectivity check. Prefer free, popular, well-maintained MCP servers. The configuration is saved only when verified.',
    inputSchema: z
      .object({
        id: z.string().optional().describe('Stable id such as filesystem, fetch, memory, or github.'),
        name: z.string().describe('Human readable MCP server name.'),
        command: z.string().describe('Command to run. Automatic MCP configuration only supports npx, pnpm, bunx, or uvx.'),
        args: z.array(z.string()).default([]).describe('Direct command arguments verified from current sources. Do not include shell snippets, pipes, redirects, Markdown links, or secrets.'),
        env: z.record(z.string()).optional().describe('Optional environment variables. Do not include secrets unless the user provided them.'),
        enabled: z.boolean().optional().default(true).describe('Must remain true for automatic saves. Use delete/cleanup tools to remove obsolete MCP servers.')
      })
      .default({ name: '', command: '', args: [] }),
    execute: async (input) => {
      const request = input as Parameters<CapabilityManager['saveMcpServer']>[0];
      onDelta({
        type: 'reasoning',
        text: `\n[Calling tool capability_save_mcp_server] ${formatJson({ id: request.id, name: request.name, command: request.command, args: request.args })}\n`
      });
      return capabilityManager.saveMcpServer(request);
    }
  });

  tools.capability_delete_mcp_server = createTool({
    id: 'capability_delete_mcp_server',
    description: 'Delete one MCP server configuration by id. Use this to remove failed, obsolete, or duplicate MCP attempts.',
    inputSchema: z
      .object({
        id: z.string().describe('MCP server id to delete. The built-in server cannot be deleted.')
      })
      .default({ id: '' }),
    execute: async (input) => {
      const request = input as Parameters<CapabilityManager['deleteMcpServer']>[0];
      onDelta({
        type: 'reasoning',
        text: `\n[Calling tool capability_delete_mcp_server] ${formatJson(request)}\n`
      });
      return capabilityManager.deleteMcpServer(request);
    }
  });

  tools.capability_cleanup_mcp_servers = createTool({
    id: 'capability_cleanup_mcp_servers',
    description:
      'Remove duplicate MCP server configurations that use the same command, args, and env. Keeps one best candidate or any id listed in keepIds.',
    inputSchema: z
      .object({
        keepIds: z.array(z.string()).optional().default([]).describe('Preferred MCP server ids to keep when duplicates exist.'),
        dryRun: z.boolean().optional().default(false).describe('Preview cleanup without modifying configuration.')
      })
      .default({ keepIds: [], dryRun: false }),
    execute: async (input) => {
      const request = input as Parameters<CapabilityManager['cleanupMcpServers']>[0];
      onDelta({
        type: 'reasoning',
        text: `\n[Calling tool capability_cleanup_mcp_servers] ${formatJson(request)}\n`
      });
      return capabilityManager.cleanupMcpServers(request);
    }
  });

  tools.capability_call_mcp_tool = createTool({
    id: 'capability_call_mcp_tool',
    description:
      'Call any currently connected MCP tool by tool id. Use this for MCP tools that were added during the current response and are not available as named tools until the next agent run.',
    inputSchema: z
      .object({
        toolId: z.string().describe('Exact MCP tool id from capability_save_mcp_server.tools or capability_list_configuration.mcpTools.'),
        args: z.record(z.unknown()).optional().default({}).describe('Arguments for the MCP tool.')
      })
      .default({ toolId: '', args: {} }),
    execute: async (input) => {
      const request = input as Parameters<CapabilityManager['callMcpTool']>[0];
      onDelta({
        type: 'reasoning',
        text: `\n[Calling tool capability_call_mcp_tool] ${formatJson({ toolId: request.toolId, args: request.args ?? {} })}\n`
      });
      return capabilityManager.callMcpTool(request);
    }
  });

  tools.capability_create_skill = createTool({
    id: 'capability_create_skill',
    description: 'Create or update a local Skill by writing a SKILL.md file in the app storage directory and enabling it.',
    inputSchema: z
      .object({
        name: z.string().describe('Skill name.'),
        content: z.string().describe('Complete SKILL.md content.'),
        enabled: z.boolean().optional().default(true)
      })
      .default({ name: '', content: '' }),
    execute: async (input) => {
      const request = input as Parameters<CapabilityManager['createSkill']>[0];
      onDelta({
        type: 'reasoning',
        text: `\n[Calling tool capability_create_skill] ${formatJson({ name: request.name, enabled: request.enabled !== false })}\n`
      });
      return capabilityManager.createSkill(request);
    }
  });

  tools.capability_delete_skill = createTool({
    id: 'capability_delete_skill',
    description: 'Delete one local Skill configuration by id. Generated Skill files can optionally be removed when they are inside app storage.',
    inputSchema: z
      .object({
        id: z.string().describe('Skill id to delete.'),
        removeFiles: z.boolean().optional().default(false).describe('Whether to remove generated files if they live under app storage.')
      })
      .default({ id: '', removeFiles: false }),
    execute: async (input) => {
      const request = input as Parameters<CapabilityManager['deleteSkill']>[0];
      onDelta({
        type: 'reasoning',
        text: `\n[Calling tool capability_delete_skill] ${formatJson(request)}\n`
      });
      return capabilityManager.deleteSkill(request);
    }
  });

  return tools;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getPayloadText(chunk: ChunkType, key: 'text' | 'reason') {
  if (!isRecord(chunk) || !isRecord(chunk.payload)) return '';
  const value = chunk.payload[key];
  return typeof value === 'string' ? value : '';
}

function formatJson(value: unknown) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function handleToolCall(payload: ToolCallPayload | undefined, onDelta: StreamDelta) {
  if (!payload) return;
  const args = payload.args ? ` ${formatJson(payload.args)}` : '';
  onDelta({
    type: 'reasoning',
    text: `\n[Tool call ${payload.toolName}]${args}\n`
  });
}

function handleToolResult(payload: ToolResultPayload | undefined, onDelta: StreamDelta) {
  if (!payload) return;
  onDelta({
    type: 'reasoning',
    text: `[Tool result ${payload.toolName}]\n${formatJson(payload.result).slice(0, 4000)}\n`
  });
}

async function streamMastraOutput(
  output: Awaited<ReturnType<Agent['stream']>>,
  onDelta: StreamDelta,
  signal: AbortSignal
) {
  const reader = output.fullStream.getReader();
  let text = '';

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new Error('This operation was aborted');
      }

      const { done, value } = await reader.read();
      if (done) break;

      if (value.type === 'text-delta') {
        const delta = getPayloadText(value, 'text');
        text += delta;
        if (delta) onDelta({ type: 'content', text: delta });
      } else if (value.type === 'reasoning-delta') {
        const delta = getPayloadText(value, 'text');
        if (delta) onDelta({ type: 'reasoning', text: delta });
      } else if (value.type === 'tool-call') {
        handleToolCall(value.payload as ToolCallPayload, onDelta);
      } else if (value.type === 'tool-result') {
        handleToolResult(value.payload as ToolResultPayload, onDelta);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return text || (await output.text.catch(() => ''));
}

export async function runMastraChat(options: MastraRunOptions) {
  const agentMemory = ensureMemory(options.storageDir);
  const threadId = getThreadId(options.sessionId);
  const evolutionPrompt = buildEvolutionPrompt(options.storageDir);
  const localFilePrompt = buildLocalFilePrompt(options.allowedDirectories);
  const capabilityPrompt = buildCapabilityPrompt();
  const latestUserMessage = [...options.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const agent = new Agent({
    id: AGENT_ID,
    name: 'Little Secretary',
    instructions: sanitizeLlmText([options.instructions, localFilePrompt, capabilityPrompt, evolutionPrompt].filter(Boolean).join('\n\n')),
    model: toMastraModelConfig(options.modelConfig),
    tools: {
      ...createBuiltinWebTools(options.onDelta),
      ...createMcpTools(options.mcpManager, options.onDelta),
      ...createLocalFileTools(options.allowedDirectories, options.onDelta),
      ...createCapabilityTools(options.capabilityManager, options.onDelta)
    },
    memory: agentMemory,
    maxRetries: 2
  });

  try {
    const output = await agent.stream(latestUserMessage, {
      memory: {
        thread: threadId,
        resource: DEFAULT_RESOURCE_ID
      },
      maxSteps: Math.max(1, options.maxToolRounds + 1),
      toolChoice: 'auto',
      modelSettings: {
        temperature: options.modelConfig.temperature
      },
      abortSignal: options.signal
    });
    const text = await streamMastraOutput(output, options.onDelta, options.signal);
    writeEvolutionNote(options.storageDir, {
      at: new Date().toISOString(),
      kind: 'success',
      summary: summarizeForEvolution(options.messages, text)
    });
  } catch (error) {
    writeEvolutionNote(options.storageDir, {
      at: new Date().toISOString(),
      kind: 'failure',
      summary: summarizeFailure(options.messages, error)
    });
    throw error;
  }
}

export async function deleteMastraThread(storageDir: string, sessionId: string) {
  const agentMemory = ensureMemory(storageDir);
  await agentMemory.deleteThread(getThreadId(sessionId));
}
