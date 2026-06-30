/// <reference types="vite/client" />

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_calls?: unknown;
  tool_call_id?: string;
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

export interface SkillConfig {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
}

export interface AppConfig {
  modelConfig: ModelConfig;
  appSettings: AppSettings;
  allowedDirectories: string[];
  mcpServers: McpServerConfig[];
  mcpTools: McpToolInfo[];
  skills: SkillConfig[];
}

export interface LittleSecretaryApi {
  config: {
    get: () => Promise<AppConfig>;
    setModel: (value: ModelConfig) => Promise<ModelConfig>;
    setSettings: (value: AppSettings) => Promise<AppSettings>;
  };
  mcp: {
    listTools: () => Promise<McpToolInfo[]>;
    setServers: (value: McpServerConfig[]) => Promise<McpServerConfig[]>;
    onToolsUpdated: (handler: (payload: McpToolInfo[]) => void) => () => void;
  };
  skills: {
    set: (value: SkillConfig[]) => Promise<SkillConfig[]>;
  };
  dialog: {
    selectDirectory: () => Promise<string | null>;
    selectFile: () => Promise<string | null>;
    selectSkill: () => Promise<SkillConfig | null>;
  };
  file: {
    read: (request: { filePath: string; encoding?: string }) => Promise<string>;
    write: (request: { filePath: string; content: string; encoding?: string }) => Promise<boolean>;
    listDirectory: (request: { dirPath: string }) => Promise<FileEntry[]>;
    openPath: (targetPath: string) => Promise<string>;
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
