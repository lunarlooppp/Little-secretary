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

type StreamDelta = (payload: { type: 'content' | 'reasoning'; text: string }) => void;

export interface MastraRunOptions {
  messages: ChatMessage[];
  instructions: string;
  modelConfig: ModelConfig;
  mcpManager: McpManager;
  allowedDirectories: string[];
  storageDir: string;
  sessionId?: string;
  maxToolRounds: number;
  signal: AbortSignal;
  onDelta: StreamDelta;
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
    return Array.isArray(parsed) ? parsed.filter((note) => note.kind && note.summary).slice(-MAX_EVOLUTION_NOTES) : [];
  } catch {
    return [];
  }
}

function writeEvolutionNote(storageDir: string, note: EvolutionNote) {
  mkdirSync(storageDir, { recursive: true });
  const filePath = path.join(storageDir, NOTES_FILE);
  const nextNotes = [...readEvolutionNotes(storageDir), note].slice(-MAX_EVOLUTION_NOTES);
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

function summarizeForEvolution(messages: ChatMessage[], resultText: string) {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const compactUser = lastUserMessage.replace(/\s+/g, ' ').slice(0, 180);
  const compactResult = resultText.replace(/\s+/g, ' ').slice(0, 180);
  return `User asked: ${compactUser || '(empty)'}; response pattern: ${compactResult || '(empty)'}`;
}

function summarizeFailure(messages: ChatMessage[], error: unknown) {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const compactUser = lastUserMessage.replace(/\s+/g, ' ').slice(0, 160);
  const message = error instanceof Error ? error.message : String(error);
  return `When handling "${compactUser || '(empty)'}", failure was: ${message.slice(0, 220)}`;
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
  const latestUserMessage = [...options.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const agent = new Agent({
    id: AGENT_ID,
    name: 'Little Secretary',
    instructions: [options.instructions, localFilePrompt, evolutionPrompt].filter(Boolean).join('\n\n'),
    model: toMastraModelConfig(options.modelConfig),
    tools: {
      ...createMcpTools(options.mcpManager, options.onDelta),
      ...createLocalFileTools(options.allowedDirectories, options.onDelta)
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
