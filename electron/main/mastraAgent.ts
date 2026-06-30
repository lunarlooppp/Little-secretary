import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { ChunkType, ToolCallPayload, ToolResultPayload } from '@mastra/core/stream';
import { createTool } from '@mastra/core/tools';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const AGENT_ID = 'little-secretary-agent';
const DEFAULT_RESOURCE_ID = 'local-user';
const NOTES_FILE = 'evolution-notes.json';
const MAX_EVOLUTION_NOTES = 24;

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
      lastMessages: 18,
      semanticRecall: false,
      workingMemory: {
        enabled: true,
        scope: 'resource'
      },
      threads: {
        generateTitle: false
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
  const latestUserMessage = [...options.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const agent = new Agent({
    id: AGENT_ID,
    name: 'Little Secretary',
    instructions: [options.instructions, evolutionPrompt].filter(Boolean).join('\n\n'),
    model: toMastraModelConfig(options.modelConfig),
    tools: createMcpTools(options.mcpManager, options.onDelta),
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
