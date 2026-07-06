/// <reference types="vite/client" />

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface StoredChatMessage extends ChatMessage {
  id: string;
  reasoning?: string;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  messages: StoredChatMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  messageCount: number;
  preview: string;
}

export interface SessionListResult {
  sessions: SessionSummary[];
  currentSessionId: string;
}

export interface SessionMutationResult extends SessionListResult {
  session: ChatSession;
}

export interface ModelConfig {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

export interface AppSettings {
  fontSize: number;
  systemPrompt: string;
  limitToolRounds: boolean;
  maxToolRounds: number;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

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

export interface SaveMcpServersResult {
  servers: McpServerConfig[];
  tools: McpToolInfo[];
  error?: string;
}

export interface SkillConfig {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
}

export interface StorageLocationInfo {
  path: string;
  configPath: string;
  defaultPath: string;
  isDefault: boolean;
}

export interface AppConfig {
  modelConfig: ModelConfig;
  appSettings: AppSettings;
  allowedDirectories: string[];
  mcpServers: McpServerConfig[];
  mcpTools: McpToolInfo[];
  skills: SkillConfig[];
  storage: StorageLocationInfo;
}

export interface LittleSecretaryApi {
  config: {
    get: () => Promise<AppConfig>;
    setModel: (value: ModelConfig) => Promise<ModelConfig>;
    setSettings: (value: AppSettings) => Promise<AppSettings>;
  };
  mcp: {
    listTools: () => Promise<McpToolInfo[]>;
    setServers: (value: McpServerConfig[]) => Promise<SaveMcpServersResult>;
    onToolsUpdated: (handler: (payload: McpToolInfo[]) => void) => () => void;
    onServersUpdated: (handler: (payload: McpServerConfig[]) => void) => () => void;
  };
  skills: {
    set: (value: SkillConfig[]) => Promise<SkillConfig[]>;
    onUpdated: (handler: (payload: SkillConfig[]) => void) => () => void;
  };
  storage: {
    getLocation: () => Promise<StorageLocationInfo>;
    setLocation: (request: { path: string }) => Promise<StorageLocationInfo>;
  };
  directories: {
    removeAllowed: (request: { path: string }) => Promise<string[]>;
  };
  dialog: {
    selectDirectory: () => Promise<string | null>;
    selectStorageDirectory: () => Promise<string | null>;
    selectFile: () => Promise<string | null>;
    selectSkill: () => Promise<SkillConfig | null>;
  };
  file: {
    read: (request: { filePath: string; encoding?: string }) => Promise<string>;
    write: (request: { filePath: string; content: string; encoding?: string }) => Promise<boolean>;
    listDirectory: (request: { dirPath: string }) => Promise<FileEntry[]>;
    openPath: (targetPath: string) => Promise<string>;
  };
  sessions: {
    list: () => Promise<SessionListResult>;
    get: (sessionId: string) => Promise<ChatSession | null>;
    create: () => Promise<SessionMutationResult>;
    switch: (sessionId: string) => Promise<SessionMutationResult>;
    save: (request: { id?: string; title?: string; messages?: StoredChatMessage[]; activate?: boolean }) => Promise<SessionMutationResult>;
    delete: (sessionId: string) => Promise<SessionMutationResult>;
  };
  chat: {
    startStream: (request: { messages: ChatMessage[]; systemPrompt?: string; sessionId?: string }) => Promise<string>;
    stopStream: (streamId: string) => Promise<boolean>;
    onDelta: (handler: (payload: { streamId: string; type: 'content' | 'reasoning'; text: string }) => void) => () => void;
    onEnd: (handler: (payload: { streamId: string }) => void) => () => void;
    onError: (handler: (payload: { streamId: string; message: string }) => void) => () => void;
  };
}

declare global {
  interface Window {
    littleSecretary: LittleSecretaryApi;
  }
}
