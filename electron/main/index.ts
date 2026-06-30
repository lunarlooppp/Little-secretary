import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import Store from 'electron-store';
import { copyFileSync, existsSync, mkdirSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getBuiltinWebMcpServer, McpManager, type McpServerConfig } from './mcp.js';
import { loadEnabledSkills, skillsToPrompt, type SkillConfig } from './skills.js';
import { getCurrentTime } from './webTools.js';

type ChatRole = 'system' | 'user' | 'assistant';

interface ChatMessage {
  role: ChatRole | 'tool';
  content: string;
  tool_calls?: PendingToolCall[];
  tool_call_id?: string;
}

interface ModelConfig {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

interface AppSettings {
  fontSize: number;
  systemPrompt: string;
  limitToolRounds: boolean;
  maxToolRounds: number;
}

interface AppSchema {
  modelConfig: ModelConfig;
  appSettings: AppSettings;
  allowedDirectories: string[];
  mcpServers: McpServerConfig[];
  skills: SkillConfig[];
}

interface StreamRequest {
  messages: ChatMessage[];
  systemPrompt?: string;
}

interface FileReadRequest {
  filePath: string;
  encoding?: BufferEncoding;
}

interface FileWriteRequest {
  filePath: string;
  content: string;
  encoding?: BufferEncoding;
}

interface DirectoryListRequest {
  dirPath: string;
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface PendingToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatRequestPayload {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  stream: boolean;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: unknown;
    };
  }>;
  tool_choice?: 'auto';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const initialUserDataPath = app.getPath('userData');
const stableUserDataPath = path.join(app.getPath('appData'), 'little-secretary');

function migrateLegacyConfig() {
  const targetConfigPath = path.join(stableUserDataPath, 'config.json');
  if (existsSync(targetConfigPath)) return;

  const candidates = [
    initialUserDataPath,
    path.join(app.getPath('appData'), 'Little Secretary'),
    path.join(app.getPath('appData'), 'LittleSecretary'),
    path.join(app.getPath('appData'), 'little secretary')
  ];
  const sourceConfigPath = candidates
    .filter((candidate, index, values) => values.indexOf(candidate) === index)
    .filter((candidate) => path.resolve(candidate) !== path.resolve(stableUserDataPath))
    .map((candidate) => path.join(candidate, 'config.json'))
    .find((candidate) => existsSync(candidate));

  if (!sourceConfigPath) return;

  mkdirSync(stableUserDataPath, { recursive: true });
  copyFileSync(sourceConfigPath, targetConfigPath);
}

migrateLegacyConfig();
app.setPath('userData', stableUserDataPath);

const defaultModelConfig: ModelConfig = {
  providerName: 'OpenAI Compatible',
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKey: '',
  model: 'qwen3:8b',
  temperature: 0.7
};

const defaultSettings: AppSettings = {
  fontSize: 14,
  systemPrompt: '你是一个高效、简洁的桌面秘书。回答要清晰、准确，并在需要时使用 Markdown 或图表。',
  limitToolRounds: true,
  maxToolRounds: 4
};

function normalizeAppSettings(value: Partial<AppSettings> = {}): AppSettings {
  const fontSize = Number(value.fontSize);
  const maxToolRounds = Number(value.maxToolRounds);

  return {
    fontSize: Number.isFinite(fontSize) ? Math.round(Math.min(20, Math.max(10, fontSize))) : defaultSettings.fontSize,
    systemPrompt: typeof value.systemPrompt === 'string' ? value.systemPrompt : defaultSettings.systemPrompt,
    limitToolRounds: value.limitToolRounds !== false,
    maxToolRounds: Number.isFinite(maxToolRounds)
      ? Math.round(Math.min(50, Math.max(1, maxToolRounds)))
      : defaultSettings.maxToolRounds
  };
}

const store = new Store<AppSchema>({
  defaults: {
    modelConfig: defaultModelConfig,
    appSettings: defaultSettings,
    allowedDirectories: [homedir()],
    mcpServers: [],
    skills: []
  }
});

store.set('appSettings', normalizeAppSettings(store.get('appSettings')));

if (isDev) {
  console.info(`[Little Secretary] userData: ${app.getPath('userData')}`);
}

let mainWindow: BrowserWindow | null = null;
const activeStreams = new Map<string, AbortController>();
const mcpManager = new McpManager();

function getAppConfig(mcpTools = mcpManager.listTools()) {
  return {
    modelConfig: store.get('modelConfig'),
    appSettings: store.get('appSettings'),
    allowedDirectories: store.get('allowedDirectories'),
    mcpServers: getMcpServerConfigs(),
    mcpTools,
    skills: store.get('skills', [])
  };
}

function getPreloadPath() {
  return path.join(__dirname, '../preload/index.js');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 760,
    minHeight: 560,
    autoHideMenuBar: true,
    backgroundColor: '#0c0f14',
    title: 'Little Secretary',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.setMenuBarVisibility(false);
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.setMenuBarVisibility(false);
    void mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

function ensureInsideAllowedDirectory(targetPath: string) {
  const resolvedTarget = path.resolve(targetPath);
  const allowedDirectories = store.get('allowedDirectories', []);
  const isAllowed = allowedDirectories.some((directory) => {
    const resolvedDirectory = path.resolve(directory);
    const relative = path.relative(resolvedDirectory, resolvedTarget);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });

  if (!isAllowed) {
    throw new Error('该路径未授权。请先在系统设置中添加允许访问的目录。');
  }

  return resolvedTarget;
}

function toRenderer(channel: string, payload: unknown) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function showOpenDialog(options: Electron.OpenDialogOptions) {
  return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
}

function getMcpServerConfigs() {
  const configured = store.get('mcpServers', []);
  const hasBuiltin = configured.some((server) => server.id === 'builtin-web-search');
  return hasBuiltin ? configured : [getBuiltinWebMcpServer(), ...configured];
}

async function refreshMcpServers() {
  const configs = getMcpServerConfigs();
  mcpManager.setConfigs(configs);
  return mcpManager.refresh();
}

async function getChatMessages(messages: ChatMessage[], systemPrompt?: string): Promise<ChatMessage[]> {
  const prompt = systemPrompt?.trim() || store.get('appSettings').systemPrompt.trim();
  const currentTime = getCurrentTime({ locale: 'zh-CN' });
  const timePrompt = [
    '运行时上下文：',
    `- 当前时间：${currentTime.formatted}`,
    `- 当前日期：${currentTime.current_date}`,
    `- 本机时区：${currentTime.local_time_zone}`,
    `- ISO 时间：${currentTime.iso}`,
    '当用户提到“现在”“今日”“今天”“当前”“昨天”“明天”等相对时间时，以以上时间为基准；如果需要更精确或其他时区，请调用 get_current_time 工具。'
  ].join('\n');
  const chartPrompt = [
    '图表能力：',
    '- 当用户要求绘制、可视化、对比趋势、分布、占比或统计数据时，可以输出 Chart.js JSON 配置。',
    '- 图表必须放在 ```chart 代码块中，JSON 至少包含 type 和 data 字段。',
    '- 支持常见 type：bar、line、pie、doughnut、radar、polarArea、scatter、bubble。',
    '- 不要把 chart 代码块再包进普通 json 代码块。'
  ].join('\n');
  const skills = await loadEnabledSkills(store.get('skills', []));
  const skillPrompt = skillsToPrompt(skills);
  const finalPrompt = [prompt, timePrompt, chartPrompt, skillPrompt].filter(Boolean).join('\n\n');
  const filteredMessages = messages.filter((message) => message.content.trim().length > 0);

  if (!finalPrompt) return filteredMessages;

  return [{ role: 'system', content: finalPrompt }, ...filteredMessages.filter((message) => message.role !== 'system')];
}

function parseStreamLines(buffer: string) {
  const lines = buffer.split(/\r?\n/);
  return {
    completeLines: lines.slice(0, -1),
    rest: lines.at(-1) ?? ''
  };
}

function appendToolCallDelta(toolCalls: PendingToolCall[], delta: ToolCallDelta) {
  const index = delta.index ?? 0;
  const existing =
    toolCalls[index] ??
    ({
      id: delta.id ?? `tool-${index}`,
      type: 'function',
      function: {
        name: '',
        arguments: ''
      }
    } satisfies PendingToolCall);

  if (delta.id) existing.id = delta.id;
  if (delta.function?.name) existing.function.name += delta.function.name;
  if (delta.function?.arguments) existing.function.arguments += delta.function.arguments;
  toolCalls[index] = existing;
}

function handleStreamLine(streamId: string, line: string, toolCalls: PendingToolCall[]) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return;

  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return;

  const parsed = JSON.parse(data) as OpenAIChunk;
  const delta = parsed.choices?.[0]?.delta;
  const content = delta?.content ?? '';
  const reasoning = delta?.reasoning_content ?? delta?.reasoning ?? '';
  const toolCallDeltas = delta?.tool_calls ?? [];

  if (reasoning) {
    toRenderer('chat:stream-delta', { streamId, type: 'reasoning', text: reasoning });
  }

  if (content) {
    toRenderer('chat:stream-delta', { streamId, type: 'content', text: content });
  }

  for (const toolCallDelta of toolCallDeltas) {
    appendToolCallDelta(toolCalls, toolCallDelta);
  }
}

async function requestChatCompletion(modelConfig: ModelConfig, payload: ChatRequestPayload, signal: AbortSignal) {
  const response = await fetch(`${normalizeBaseUrl(modelConfig.baseUrl)}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(modelConfig.apiKey ? { Authorization: `Bearer ${modelConfig.apiKey}` } : {})
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`模型请求失败：${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`);
  }

  return response.body.getReader();
}

async function executeToolCalls(streamId: string, messages: ChatMessage[], toolCalls: PendingToolCall[]) {
  if (toolCalls.length === 0) return false;

  messages.push({
    role: 'assistant',
    content: '',
    tool_calls: toolCalls
  } as ChatMessage);

  for (const toolCall of toolCalls) {
    const toolName = toolCall.function.name;
    let args: unknown = {};

    try {
      args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
    } catch {
      args = {};
    }

    toRenderer('chat:stream-delta', {
      streamId,
      type: 'reasoning',
      text: `\n[调用工具 ${toolName}]\n`
    });

    const result = await mcpManager.callTool(toolName, args);

    messages.push({
      role: 'tool',
      content: result,
      tool_call_id: toolCall.id
    } as ChatMessage);
  }

  return true;
}

async function streamChat(streamId: string, request: StreamRequest) {
  const modelConfig = store.get('modelConfig');
  const controller = new AbortController();
  activeStreams.set(streamId, controller);

  try {
    if (!modelConfig.baseUrl.trim() || !modelConfig.model.trim()) {
      throw new Error('请先在模型配置中填写 Base URL 和模型名称。');
    }

    await refreshMcpServers();
    const tools = mcpManager.toOpenAiTools();
    const messages = await getChatMessages(request.messages, request.systemPrompt);
    const appSettings = store.get('appSettings');
    const maxToolRounds = appSettings.limitToolRounds ? Math.max(1, Math.floor(appSettings.maxToolRounds)) : Number.POSITIVE_INFINITY;
    let toolRounds = 0;

    while (true) {
      const payload: ChatRequestPayload = {
        model: modelConfig.model,
        messages,
        temperature: modelConfig.temperature,
        stream: true,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
      };

      const reader = await requestChatCompletion(modelConfig, payload, controller.signal);
      const decoder = new TextDecoder();
      const toolCalls: PendingToolCall[] = [];
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { completeLines, rest } = parseStreamLines(buffer);
        buffer = rest;

        for (const line of completeLines) {
          handleStreamLine(streamId, line, toolCalls);
        }
      }

      if (buffer.trim()) {
        handleStreamLine(streamId, buffer, toolCalls);
      }

      if (!(await executeToolCalls(streamId, messages, toolCalls))) {
        toRenderer('chat:stream-end', { streamId });
        return;
      }

      toolRounds += 1;
      if (toolRounds >= maxToolRounds) break;
    }

    throw new Error(Number.isFinite(maxToolRounds) ? `工具调用轮次超过上限 ${maxToolRounds}，已停止。` : '工具调用轮次过多，已停止。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'This operation was aborted') {
      toRenderer('chat:stream-error', { streamId, message });
    }
  } finally {
    activeStreams.delete(streamId);
  }
}

ipcMain.handle('config:get', async () => {
  const config = getAppConfig();
  refreshMcpServers()
    .then((tools) => {
      toRenderer('mcp:tools-updated', tools);
    })
    .catch(() => undefined);

  return config;
});

ipcMain.handle('config:set-model', (_event, value: ModelConfig) => {
  const config: ModelConfig = {
    providerName: value.providerName?.trim() || defaultModelConfig.providerName,
    baseUrl: value.baseUrl?.trim() || defaultModelConfig.baseUrl,
    apiKey: value.apiKey ?? '',
    model: value.model?.trim() || defaultModelConfig.model,
    temperature: Number.isFinite(value.temperature) ? Math.min(2, Math.max(0, value.temperature)) : 0.7
  };
  store.set('modelConfig', config);
  return config;
});

ipcMain.handle('config:set-settings', (_event, value: AppSettings) => {
  const settings = normalizeAppSettings(value);
  store.set('appSettings', settings);
  return settings;
});

ipcMain.handle('mcp:list-tools', async () => {
  return refreshMcpServers();
});

ipcMain.handle('mcp:set-servers', async (_event, value: McpServerConfig[]) => {
  const configs = value.map((server) => ({
    id: server.id?.trim() || randomUUID(),
    name: server.name?.trim() || server.id?.trim() || 'MCP Server',
    command: server.command?.trim() || 'node',
    args: Array.isArray(server.args) ? server.args.map((arg) => String(arg)) : [],
    env: server.env ?? {},
    enabled: server.enabled !== false
  }));
  store.set('mcpServers', configs);
  mcpManager
    .closeAll()
    .then(() => refreshMcpServers())
    .then((tools) => {
      toRenderer('mcp:tools-updated', tools);
    })
    .catch(() => undefined);
  return getMcpServerConfigs();
});

ipcMain.handle('skills:set', (_event, value: SkillConfig[]) => {
  const skills = value.map((skill) => ({
    id: skill.id?.trim() || randomUUID(),
    name: skill.name?.trim() || path.basename(skill.path ?? ''),
    path: skill.path,
    enabled: skill.enabled !== false
  }));
  store.set('skills', skills);
  return skills;
});

ipcMain.handle('dialog:select-skill', async () => {
  const result = await showOpenDialog({
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const selected = result.filePaths[0];
  const skillFile = path.join(selected, 'SKILL.md');
  await fs.access(skillFile);

  const skills = store.get('skills', []);
  const nextSkill: SkillConfig = {
    id: randomUUID(),
    name: path.basename(selected),
    path: selected,
    enabled: true
  };
  store.set('skills', [...skills, nextSkill]);
  return nextSkill;
});

ipcMain.handle('dialog:select-directory', async () => {
  const result = await showOpenDialog({
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const selected = result.filePaths[0];
  const directories = new Set(store.get('allowedDirectories', []));
  directories.add(selected);
  store.set('allowedDirectories', [...directories]);
  return selected;
});

ipcMain.handle('dialog:select-file', async () => {
  const result = await showOpenDialog({
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  ensureInsideAllowedDirectory(result.filePaths[0]);
  return result.filePaths[0];
});

ipcMain.handle('file:read', async (_event, request: FileReadRequest) => {
  const filePath = ensureInsideAllowedDirectory(request.filePath);
  return fs.readFile(filePath, request.encoding ?? 'utf8');
});

ipcMain.handle('file:write', async (_event, request: FileWriteRequest) => {
  const filePath = ensureInsideAllowedDirectory(request.filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, request.content, request.encoding ?? 'utf8');
  return true;
});

ipcMain.handle('file:list-directory', async (_event, request: DirectoryListRequest) => {
  const dirPath = ensureInsideAllowedDirectory(request.dirPath);
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    path: path.join(dirPath, entry.name),
    type: entry.isDirectory() ? 'directory' : 'file'
  }));
});

ipcMain.handle('file:open-path', async (_event, targetPath: string) => {
  const allowedPath = ensureInsideAllowedDirectory(targetPath);
  return shell.openPath(allowedPath);
});

ipcMain.handle('chat:start-stream', (_event, request: StreamRequest) => {
  const streamId = randomUUID();
  setImmediate(() => void streamChat(streamId, request));
  return streamId;
});

ipcMain.handle('chat:stop-stream', (_event, streamId: string) => {
  activeStreams.get(streamId)?.abort();
  activeStreams.delete(streamId);
  return true;
});

app.whenReady().then(() => {
  if (!isDev) {
    Menu.setApplicationMenu(null);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  void mcpManager.closeAll();
  if (process.platform !== 'darwin') app.quit();
});
