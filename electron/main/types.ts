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
