import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import Store from 'electron-store';
import { copyFileSync, existsSync, mkdirSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getBuiltinWebMcpServer, McpManager, type McpServerConfig } from './mcp.js';
import { deleteMastraThread, runMastraChat } from './mastraAgent.js';
import { loadEnabledSkills, skillsToPrompt, type SkillConfig } from './skills.js';
import { getCurrentTime } from './webTools.js';
import type { ChatMessage, ModelConfig } from './types.js';

interface AppSettings {
  fontSize: number;
  systemPrompt: string;
  limitToolRounds: boolean;
  maxToolRounds: number;
  themeMode: 'day' | 'night';
}

interface StorageLocationInfo {
  path: string;
  configPath: string;
  defaultPath: string;
  isDefault: boolean;
}

interface AppSchema {
  modelConfig: ModelConfig;
  appSettings: AppSettings;
  allowedDirectories: string[];
  mcpServers: McpServerConfig[];
  skills: SkillConfig[];
  chatSessions: ChatSession[];
  currentSessionId: string | null;
}

interface StreamRequest {
  messages: ChatMessage[];
  systemPrompt?: string;
  sessionId?: string;
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

interface RemoveAllowedDirectoryRequest {
  path: string;
}

interface StorageLocationRequest {
  path: string;
}

interface GeneratedSkillRequest {
  name: string;
  content: string;
  enabled?: boolean;
}

interface CapabilityMcpServerRequest {
  id?: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

interface CapabilityDeleteMcpServerRequest {
  id: string;
}

interface CapabilityCleanupMcpServersRequest {
  keepIds?: string[];
  dryRun?: boolean;
}

interface CapabilityCheckConfigurationRequest {
  refresh?: boolean;
}

interface CapabilityDeleteSkillRequest {
  id: string;
  removeFiles?: boolean;
}

interface StoredChatMessage extends ChatMessage {
  id: string;
  reasoning?: string;
  createdAt: string;
}

interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  messages: StoredChatMessage[];
}

interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  messageCount: number;
  preview: string;
}

interface SaveSessionRequest {
  id?: string;
  title?: string;
  messages?: StoredChatMessage[];
  activate?: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const initialUserDataPath = app.getPath('userData');
const stableUserDataPath = path.join(app.getPath('appData'), 'little-secretary');
const storagePointerPath = path.join(stableUserDataPath, 'storage-location.json');

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStorageLocationPointer() {
  if (!existsSync(storagePointerPath)) return stableUserDataPath;

  try {
    const parsed = JSON.parse(readFileSync(storagePointerPath, 'utf8')) as unknown;
    const configuredPath = isRecord(parsed) && typeof parsed.path === 'string' ? parsed.path.trim() : '';
    if (!configuredPath) return stableUserDataPath;
    return path.resolve(configuredPath);
  } catch {
    return stableUserDataPath;
  }
}

function writeStorageLocationPointer(targetPath: string) {
  mkdirSync(stableUserDataPath, { recursive: true });
  writeFileSync(storagePointerPath, JSON.stringify({ path: path.resolve(targetPath) }, null, 2), 'utf8');
}

function getStorageLocationInfo(): StorageLocationInfo {
  return {
    path: activeStoragePath,
    configPath: store.path,
    defaultPath: stableUserDataPath,
    isDefault: path.resolve(activeStoragePath) === path.resolve(stableUserDataPath)
  };
}

function isPathInside(parentPath: string, targetPath: string) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getPathComparisonKey(targetPath: string) {
  const resolved = path.normalize(path.resolve(targetPath));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function migrateStorageLocation(targetPath: string) {
  const trimmedPath = targetPath.trim();
  if (!trimmedPath) throw new Error('请选择有效的存储目录。');
  if (activeStreams.size > 0) throw new Error('请等待当前对话生成结束后再迁移存储目录。');
  const nextPath = path.resolve(trimmedPath);
  const currentPath = path.resolve(activeStoragePath);
  if (nextPath === currentPath) return getStorageLocationInfo();
  if (isPathInside(currentPath, nextPath) || isPathInside(nextPath, currentPath)) {
    throw new Error('新存储目录不能是当前存储目录本身、其子目录或父目录。');
  }

  await fs.mkdir(nextPath, { recursive: true });
  await fs.cp(currentPath, nextPath, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (source) => path.resolve(source) !== path.resolve(storagePointerPath)
  });

  writeStorageLocationPointer(nextPath);
  activeStoragePath = nextPath;
  app.setPath('userData', activeStoragePath);
  store = createStore(activeStoragePath);
  store.set('appSettings', normalizeAppSettings(store.get('appSettings')));
  store.set(
    'skills',
    store.get('skills', []).map((skill) => ({
      ...skill,
      path: rebasePathFromStorage(currentPath, nextPath, skill.path)
    }))
  );
  notifySkillsUpdated();
  persistSessions(store.get('chatSessions', []), store.get('currentSessionId', null));
  await mcpManager.closeAll();
  notifyToolsUpdated([]);
  refreshMcpServersInBackground();
  return getStorageLocationInfo();
}

migrateLegacyConfig();
let activeStoragePath = readStorageLocationPointer();
app.setPath('userData', activeStoragePath);

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
  maxToolRounds: 4,
  themeMode: 'night'
};

const MAX_SESSION_MESSAGES = 240;
const UNTITLED_SESSION_TITLE = '新的会话';

const storeDefaults: AppSchema = {
  modelConfig: defaultModelConfig,
  appSettings: defaultSettings,
  allowedDirectories: [homedir()],
  mcpServers: [],
  skills: [],
  chatSessions: [],
  currentSessionId: null
};

function normalizeAppSettings(value: Partial<AppSettings> = {}): AppSettings {
  const fontSize = Number(value.fontSize);
  const maxToolRounds = Number(value.maxToolRounds);
  const themeMode = value.themeMode === 'day' || value.themeMode === 'night' ? value.themeMode : defaultSettings.themeMode;

  return {
    fontSize: Number.isFinite(fontSize) ? Math.round(Math.min(20, Math.max(10, fontSize))) : defaultSettings.fontSize,
    systemPrompt: typeof value.systemPrompt === 'string' ? value.systemPrompt : defaultSettings.systemPrompt,
    limitToolRounds: value.limitToolRounds !== false,
    maxToolRounds: Number.isFinite(maxToolRounds)
      ? Math.round(Math.min(50, Math.max(1, maxToolRounds)))
      : defaultSettings.maxToolRounds,
    themeMode
  };
}

function createStore(storagePath = activeStoragePath) {
  return new Store<AppSchema>({
    cwd: storagePath,
    defaults: storeDefaults
  });
}

let store = createStore();
store.set('appSettings', normalizeAppSettings(store.get('appSettings')));
persistSessions(store.get('chatSessions', []), store.get('currentSessionId', null));

if (isDev) {
  console.info(`[Little Secretary] userData: ${activeStoragePath}`);
}

let mainWindow: BrowserWindow | null = null;
const activeStreams = new Map<string, AbortController>();
const mcpManager = new McpManager();
let mcpRefreshTask: Promise<void> | null = null;

function notifyToolsUpdated(mcpTools = mcpManager.listTools()) {
  toRenderer('mcp:tools-updated', mcpTools);
}

function notifyMcpServersUpdated(mcpServers = getMcpServerConfigs()) {
  toRenderer('mcp:servers-updated', mcpServers);
}

function notifySkillsUpdated(skills = store.get('skills', [])) {
  toRenderer('skills:updated', skills);
}

disableKnownBrokenAutoMcpServers();

function refreshMcpServersInBackground() {
  if (mcpRefreshTask) return;

  mcpRefreshTask = refreshMcpServers()
    .then((tools) => {
      logMcpFailures();
      notifyToolsUpdated(tools);
    })
    .catch((error) => {
      console.warn('[Little Secretary] MCP refresh failed:', error);
      notifyToolsUpdated();
    })
    .finally(() => {
      mcpRefreshTask = null;
    });
}

async function waitForMcpRefreshTask() {
  if (!mcpRefreshTask) return;
  await mcpRefreshTask.catch(() => undefined);
}

function logMcpFailures() {
  const failures = mcpManager.getLastFailures();
  if (failures.length) {
    console.warn(`[Little Secretary] Some MCP servers failed to connect:\n${failures.join('\n\n')}`);
  }
}

async function restartMcpServersNow() {
  await waitForMcpRefreshTask();
  await mcpManager.closeAll();
  const tools = await refreshMcpServers();
  logMcpFailures();
  notifyToolsUpdated(tools);
  return tools;
}

async function listMcpConfiguration(request?: CapabilityCheckConfigurationRequest) {
  if (request?.refresh) {
    await restartMcpServersNow();
  }
  return getMcpConfigurationHealth();
}

function getAppConfig(mcpTools = mcpManager.listTools()) {
  return {
    modelConfig: store.get('modelConfig'),
    appSettings: store.get('appSettings'),
    allowedDirectories: store.get('allowedDirectories'),
    mcpServers: getMcpServerConfigs(),
    mcpTools,
    skills: store.get('skills', []),
    storage: getStorageLocationInfo()
  };
}

function sanitizeGeneratedId(value: string, fallback = randomUUID()) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || fallback;
}

function rebasePathFromStorage(oldStoragePath: string, nextStoragePath: string, targetPath: string) {
  const resolvedTarget = path.resolve(targetPath);
  if (!isPathInside(oldStoragePath, resolvedTarget)) return targetPath;
  return path.join(nextStoragePath, path.relative(path.resolve(oldStoragePath), resolvedTarget));
}

function normalizeMarkdownLinkArg(value: string) {
  const markdownLinkMatch = value.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/i);
  if (!markdownLinkMatch) return value;
  return markdownLinkMatch[2];
}

function normalizeMcpArgs(args: unknown) {
  if (!Array.isArray(args)) return [];
  return args.map((arg) => normalizeMarkdownLinkArg(String(arg).trim())).filter(Boolean);
}

function normalizeAutoMcpArgs(args: unknown) {
  return normalizeMcpArgs(args).map((arg) => {
    const value = String(arg);
    if (!value) throw new Error('自动 MCP 配置不能包含空参数。');
    if (/[\r\n]|&&|\|\||[;`<>|]/.test(value)) {
      throw new Error('自动 MCP 配置不能包含 shell 拼接或重定向字符。');
    }
    if (value === '-c' || value === '--call' || value === '--shell') {
      throw new Error('自动 MCP 配置不能使用 shell 调用参数。');
    }
    return value;
  });
}

function normalizeStoredMcpServerConfig(server: McpServerConfig): McpServerConfig {
  return {
    id: server.id?.trim() || randomUUID(),
    name: server.name?.trim() || server.id?.trim() || 'MCP Server',
    command: server.command?.trim() || 'node',
    args: normalizeMcpArgs(server.args),
    env: isRecord(server.env) ? Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, String(value)])) : {},
    enabled: server.enabled !== false
  };
}

function disableKnownBrokenAutoMcpServers() {
  const brokenIds = new Set(['duckduckgo-search', 'duckduckgo-search-v2']);
  const servers = store.get('mcpServers', []);
  let changed = false;
  const nextServers = servers.map((server) => {
    if (!brokenIds.has(server.id) || server.enabled === false) return server;
    changed = true;
    return { ...server, enabled: false };
  });

  if (!changed) return;
  store.set('mcpServers', nextServers);
  notifyMcpServersUpdated();
}

function mcpServerSignature(server: McpServerConfig) {
  const env = Object.fromEntries(Object.entries(server.env ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify({
    command: server.command.trim().toLowerCase(),
    args: normalizeMcpArgs(server.args),
    env
  });
}

function getConnectedToolCountsByServer() {
  const counts = new Map<string, number>();
  for (const tool of mcpManager.listTools()) {
    counts.set(tool.serverId, (counts.get(tool.serverId) ?? 0) + 1);
  }
  return counts;
}

function getMcpConfigurationHealth() {
  const servers = getMcpServerConfigs();
  const connectedToolCounts = getConnectedToolCountsByServer();
  const duplicateGroups = new Map<string, McpServerConfig[]>();

  for (const server of servers.filter((item) => item.id !== 'builtin-web-search')) {
    const signature = mcpServerSignature(server);
    duplicateGroups.set(signature, [...(duplicateGroups.get(signature) ?? []), server]);
  }

  const duplicates = [...duplicateGroups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      signature: mcpServerSignature(group[0]),
      servers: group.map((server) => ({
        id: server.id,
        name: server.name,
        enabled: server.enabled,
        toolCount: connectedToolCounts.get(server.id) ?? 0
      }))
    }));

  return {
    mcpServers: servers.map((server) => ({
      ...server,
      connected: server.id === 'builtin-web-search' || (connectedToolCounts.get(server.id) ?? 0) > 0,
      toolCount: connectedToolCounts.get(server.id) ?? 0
    })),
    duplicateGroups: duplicates,
    mcpTools: mcpManager.listTools(),
    failures: mcpManager.getLastFailures(),
    skills: store.get('skills', []),
    storage: getStorageLocationInfo()
  };
}

function normalizeMcpServerInput(server: CapabilityMcpServerRequest): McpServerConfig {
  const command = server.command?.trim() || 'npx';
  const allowedAutoCommands = new Set(['npx', 'pnpm', 'bunx', 'uvx']);
  if (!allowedAutoCommands.has(command)) {
    throw new Error(`自动能力配置只允许使用 ${[...allowedAutoCommands].join('、')}。如需其他命令，请在设置中手动添加 MCP 服务器。`);
  }

  return {
    id: sanitizeGeneratedId(server.id || server.name),
    name: server.name?.trim() || server.id?.trim() || 'MCP Server',
    command,
    args: normalizeAutoMcpArgs(server.args),
    env: isRecord(server.env) ? Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, String(value)])) : {},
    enabled: server.enabled !== false
  };
}

async function verifyMcpServerConfig(config: McpServerConfig) {
  const verifier = new McpManager();
  verifier.setConfigs([{ ...config, enabled: true }]);

  try {
    const tools = await verifier.refresh();
    const failures = verifier.getLastFailures();
    if (failures.length) {
      return {
        verified: false,
        tools: [],
        error: failures.join('\n\n')
      };
    }
    if (tools.length === 0) {
      return {
        verified: false,
        tools: [],
        error: 'MCP 服务器已连接，但没有返回任何工具。'
      };
    }
    return {
      verified: true,
      tools,
      error: ''
    };
  } catch (error) {
    return {
      verified: false,
      tools: [],
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await verifier.closeAll();
  }
}

async function saveMcpServerConfig(server: CapabilityMcpServerRequest) {
  const normalized = normalizeMcpServerInput(server);
  if (normalized.enabled === false) {
    return {
      saved: false,
      verified: false,
      server: normalized,
      error: '自动 MCP 保存工具只用于保存启用且已验证的服务器。要移除重复或废弃配置，请使用 capability_delete_mcp_server 或 capability_cleanup_mcp_servers。',
      note: '配置未保存。'
    };
  }

  const verification = await verifyMcpServerConfig(normalized);
  if (!verification.verified) {
    return {
      saved: false,
      verified: false,
      server: normalized,
      error: verification.error,
      note: 'MCP 服务器连通性验证失败，配置未保存。请重新搜索可用包名、安装方式或服务地址后再尝试。'
    };
  }

  const withoutBuiltin = store.get('mcpServers', []).filter((item) => item.id !== 'builtin-web-search');
  const nextServers = withoutBuiltin.some((item) => item.id === normalized.id)
    ? withoutBuiltin.map((item) => (item.id === normalized.id ? normalized : item))
    : [...withoutBuiltin, normalized];

  store.set('mcpServers', nextServers);
  notifyMcpServersUpdated();
  await restartMcpServersNow();
  const cleanup = await cleanupMcpServerConfigs({ keepIds: [normalized.id] });
  return {
    saved: true,
    verified: true,
    server: normalized,
    tools: verification.tools,
    cleanup,
    note: `MCP 配置已保存并验证连通，发现 ${verification.tools.length} 个工具。`
  };
}

async function deleteMcpServerConfig(request: CapabilityDeleteMcpServerRequest) {
  const targetId = request.id?.trim();
  if (!targetId) throw new Error('MCP 服务器 id 不能为空。');
  if (targetId === 'builtin-web-search') throw new Error('内置基础工具不能删除。');

  const servers = store.get('mcpServers', []);
  const target = servers.find((server) => server.id === targetId);
  if (!target) {
    return {
      deleted: false,
      id: targetId,
      note: '未找到该 MCP 服务器配置。'
    };
  }

  const nextServers = servers.filter((server) => server.id !== targetId);
  store.set('mcpServers', nextServers);
  notifyMcpServersUpdated();
  await restartMcpServersNow();
  return {
    deleted: true,
    server: target,
    remainingServers: getMcpServerConfigs()
  };
}

async function cleanupMcpServerConfigs(request: CapabilityCleanupMcpServersRequest = {}) {
  const keepIds = new Set((request.keepIds ?? []).map((id) => String(id).trim()).filter(Boolean));
  const servers = store.get('mcpServers', []).map(normalizeStoredMcpServerConfig);
  const connectedToolCounts = getConnectedToolCountsByServer();
  const groups = new Map<string, McpServerConfig[]>();

  for (const server of servers) {
    groups.set(mcpServerSignature(server), [...(groups.get(mcpServerSignature(server)) ?? []), server]);
  }

  const removed: McpServerConfig[] = [];
  const kept: McpServerConfig[] = [];

  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }

    const scoreServer = (candidate: McpServerConfig) => (candidate.enabled ? 100 : 0) + (connectedToolCounts.get(candidate.id) ?? 0);
    const keeper =
      group.find((server) => keepIds.has(server.id)) ??
      [...group].sort((left, right) => {
        const rightScore = scoreServer(right);
        const leftScore = scoreServer(left);
        if (rightScore !== leftScore) return rightScore - leftScore;
        return left.name.localeCompare(right.name);
      })[0];

    kept.push(keeper);
    removed.push(...group.filter((server) => server.id !== keeper.id));
  }

  if (!request.dryRun && removed.length > 0) {
    store.set('mcpServers', kept);
    notifyMcpServersUpdated();
    await restartMcpServersNow();
  }

  return {
    changed: !request.dryRun && removed.length > 0,
    dryRun: Boolean(request.dryRun),
    kept: kept.map((server) => ({ id: server.id, name: server.name, command: server.command, args: server.args, enabled: server.enabled })),
    removed: removed.map((server) => ({ id: server.id, name: server.name, command: server.command, args: server.args, enabled: server.enabled })),
    note:
      removed.length === 0
        ? '未发现重复 MCP 配置。'
        : request.dryRun
          ? `发现 ${removed.length} 个可清理的重复 MCP 配置，dryRun=true 未修改。`
          : `已清理 ${removed.length} 个重复 MCP 配置。`
  };
}

async function callConfiguredMcpTool(request: { toolId: string; args?: Record<string, unknown> }) {
  const toolId = request.toolId?.trim();
  if (!toolId) throw new Error('MCP toolId 不能为空。');

  let tool = mcpManager.listTools().find((item) => item.id === toolId);
  if (!tool) {
    await restartMcpServersNow();
    tool = mcpManager.listTools().find((item) => item.id === toolId);
  }
  if (!tool) throw new Error(`MCP 工具不存在或未连接：${toolId}`);

  return {
    tool,
    result: await mcpManager.callTool(toolId, request.args ?? {})
  };
}

async function createGeneratedSkill(request: GeneratedSkillRequest) {
  const rawName = request.name?.trim();
  const content = request.content?.trim();
  if (!rawName) throw new Error('Skill 名称不能为空。');
  if (!content) throw new Error('Skill 内容不能为空。');

  const skillId = sanitizeGeneratedId(rawName);
  const skillDir = path.join(activeStoragePath, 'skills', skillId);
  const skillFile = path.join(skillDir, 'SKILL.md');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(skillFile, content.endsWith('\n') ? content : `${content}\n`, 'utf8');

  const skillConfig: SkillConfig = {
    id: skillId,
    name: rawName,
    path: skillDir,
    enabled: request.enabled !== false
  };
  const skills = store.get('skills', []);
  const nextSkills = skills.some((skill) => skill.id === skillId)
    ? skills.map((skill) => (skill.id === skillId ? skillConfig : skill))
    : [...skills, skillConfig];
  store.set('skills', nextSkills);
  notifySkillsUpdated(nextSkills);

  return skillConfig;
}

async function deleteGeneratedSkill(request: CapabilityDeleteSkillRequest) {
  const targetId = request.id?.trim();
  if (!targetId) throw new Error('Skill id 不能为空。');

  const skills = store.get('skills', []);
  const target = skills.find((skill) => skill.id === targetId);
  if (!target) {
    return {
      deleted: false,
      id: targetId,
      note: '未找到该 Skill 配置。'
    };
  }

  const nextSkills = skills.filter((skill) => skill.id !== targetId);
  store.set('skills', nextSkills);
  notifySkillsUpdated(nextSkills);

  const generatedSkillsRoot = path.join(activeStoragePath, 'skills');
  if (request.removeFiles && isPathInside(generatedSkillsRoot, target.path)) {
    await fs.rm(target.path, { recursive: true, force: true });
  }

  return {
    deleted: true,
    removedFiles: Boolean(request.removeFiles && isPathInside(generatedSkillsRoot, target.path)),
    skill: target,
    skills: nextSkills
  };
}

function isChatRole(value: unknown): value is ChatMessage['role'] {
  return value === 'system' || value === 'user' || value === 'assistant' || value === 'tool';
}

function compactText(value: string, maxLength: number) {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function summarizeSessionTitle(messages: StoredChatMessage[], fallback = UNTITLED_SESSION_TITLE) {
  const source =
    messages.find((message) => message.role === 'user' && message.content.trim()) ??
    messages.find((message) => message.role === 'assistant' && message.content.trim());
  if (!source) return fallback;

  const firstLine = source.content
    .replace(/[#*_`>\-[\](){}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return compactText(firstLine, 22) || fallback;
}

function normalizeStoredMessage(value: Partial<StoredChatMessage> = {}, index = 0): StoredChatMessage | null {
  if (!isChatRole(value.role)) return null;

  const content = typeof value.content === 'string' ? value.content : '';
  const createdAt = typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : new Date().toISOString();
  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id : randomUUID(),
    role: value.role,
    content,
    reasoning: typeof value.reasoning === 'string' ? value.reasoning : undefined,
    createdAt,
    ...(value.tool_calls === undefined ? {} : { tool_calls: value.tool_calls }),
    ...(typeof value.tool_call_id === 'string' ? { tool_call_id: value.tool_call_id } : {})
  };
}

function normalizeSession(value: Partial<ChatSession> = {}, fallbackIndex = 0): ChatSession {
  const now = new Date().toISOString();
  const messages = Array.isArray(value.messages)
    ? value.messages
        .map((message, index) => normalizeStoredMessage(message, index))
        .filter((message): message is StoredChatMessage => Boolean(message))
        .slice(-MAX_SESSION_MESSAGES)
    : [];
  const createdAt = typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : now;
  const updatedAt = typeof value.updatedAt === 'string' && value.updatedAt ? value.updatedAt : createdAt;
  const lastMessageAt =
    typeof value.lastMessageAt === 'string' && value.lastMessageAt
      ? value.lastMessageAt
      : messages.at(-1)?.createdAt ?? updatedAt;
  const explicitTitle = typeof value.title === 'string' ? value.title.trim() : '';

  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id : randomUUID(),
    title: compactText(explicitTitle, 48) || summarizeSessionTitle(messages, `${UNTITLED_SESSION_TITLE} ${fallbackIndex + 1}`),
    createdAt,
    updatedAt,
    lastMessageAt,
    messages
  };
}

function getSessions() {
  const rawSessions = store.get('chatSessions', []);
  return rawSessions.map((session, index) => normalizeSession(session, index));
}

function sortSessions(sessions: ChatSession[]) {
  return [...sessions].sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt));
}

function getSessionPreview(session: ChatSession) {
  const source = [...session.messages].reverse().find((message) => message.content.trim());
  return source ? compactText(source.content, 80) : '暂无消息';
}

function toSessionSummary(session: ChatSession): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastMessageAt: session.lastMessageAt,
    messageCount: session.messages.filter((message) => message.role !== 'system').length,
    preview: getSessionPreview(session)
  };
}

function persistSessions(sessions: ChatSession[], currentSessionId = store.get('currentSessionId', null)) {
  const normalized = sessions.map((session, index) => normalizeSession(session, index));
  store.set('chatSessions', sortSessions(normalized));
  store.set('currentSessionId', currentSessionId);
  return store.get('chatSessions', []);
}

function createChatSession(seed: Partial<ChatSession> = {}) {
  const now = new Date().toISOString();
  return normalizeSession({
    id: randomUUID(),
    title: UNTITLED_SESSION_TITLE,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    messages: [],
    ...seed
  });
}

function getOrCreateCurrentSession() {
  let sessions = getSessions();
  let currentSessionId = store.get('currentSessionId', null);
  let currentSession = currentSessionId ? sessions.find((session) => session.id === currentSessionId) : null;

  if (!currentSession) {
    const fallbackSession = sessions[0] ?? createChatSession();
    currentSession = fallbackSession;
    currentSessionId = currentSession.id;
    if (!sessions.some((session) => session.id === fallbackSession.id)) {
      sessions = [currentSession, ...sessions];
    }
    persistSessions(sessions, currentSessionId);
  } else {
    persistSessions(sessions, currentSessionId);
  }

  return { sessions: getSessions(), currentSessionId, currentSession };
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
      sandbox: false,
      spellcheck: false
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
  const stored = store.get('mcpServers', []);
  const configured = stored.map(normalizeStoredMcpServerConfig);
  if (JSON.stringify(stored) !== JSON.stringify(configured)) store.set('mcpServers', configured);
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
    '- chart 代码块必须是严格 JSON：所有键和字符串使用双引号，不要使用 function、=>、注释、尾逗号、undefined、NaN 或 Infinity。',
    '- 不要输出 Chart.js 回调函数；如需标签、颜色、标题、坐标轴等，只使用 JSON 可表示的字符串、数字、布尔值、数组和对象。',
    '- 不要把 chart 代码块再包进普通 json 代码块。'
  ].join('\n');
  const diagramPrompt = [
    'Diagram capability:',
    '- When a user needs a diagram, drawing, flowchart, architecture map, sequence diagram, state machine, ER diagram, mind map, or Gantt chart, use Mermaid syntax in a fenced code block labeled exactly `mermaid`.',
    '- Use `mermaid` as the code fence language because this app renders `mermaid` blocks as diagrams.',
    '- Keep the diagram valid Mermaid syntax. Put only Mermaid diagram source inside the `mermaid` code block.',
    '- Prefer diagrams for relationships, processes, workflows, system architecture, timelines, and decision trees when they make the answer clearer.'
  ].join('\n');
  const skills = await loadEnabledSkills(store.get('skills', []));
  const skillPrompt = skillsToPrompt(skills);
  const finalPrompt = [prompt, timePrompt, chartPrompt, diagramPrompt, skillPrompt].filter(Boolean).join('\n\n');
  const filteredMessages = messages.filter((message) => message.content.trim().length > 0);

  if (!finalPrompt) return filteredMessages;

  return [{ role: 'system', content: finalPrompt }, ...filteredMessages.filter((message) => message.role !== 'system')];
}

async function streamChat(streamId: string, request: StreamRequest) {
  const modelConfig = store.get('modelConfig');
  const controller = new AbortController();
  activeStreams.set(streamId, controller);

  try {
    if (!modelConfig.baseUrl.trim() || !modelConfig.model.trim()) {
      throw new Error('请先在模型配置中填写 Base URL 和模型名称。');
    }

    refreshMcpServersInBackground();
    const messages = await getChatMessages(request.messages, request.systemPrompt);
    const appSettings = store.get('appSettings');
    const maxToolRounds = appSettings.limitToolRounds ? Math.max(1, Math.floor(appSettings.maxToolRounds)) : Number.POSITIVE_INFINITY;

    await runMastraChat({
      messages,
      instructions: messages.find((message) => message.role === 'system')?.content ?? '',
      modelConfig,
      mcpManager,
      capabilityManager: {
        list: listMcpConfiguration,
        saveMcpServer: saveMcpServerConfig,
        deleteMcpServer: deleteMcpServerConfig,
        cleanupMcpServers: cleanupMcpServerConfigs,
        callMcpTool: callConfiguredMcpTool,
        createSkill: createGeneratedSkill,
        deleteSkill: deleteGeneratedSkill
      },
      allowedDirectories: store.get('allowedDirectories'),
      storageDir: path.join(activeStoragePath, 'mastra'),
      sessionId: request.sessionId,
      maxToolRounds: Number.isFinite(maxToolRounds) ? maxToolRounds : 12,
      signal: controller.signal,
      onDelta: (payload) => toRenderer('chat:stream-delta', { streamId, ...payload })
    });
    toRenderer('chat:stream-end', { streamId });
    return;

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
  refreshMcpServersInBackground();

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

ipcMain.handle('storage:get-location', () => getStorageLocationInfo());

ipcMain.handle('storage:set-location', async (_event, request: StorageLocationRequest) => {
  if (!request?.path?.trim()) throw new Error('请选择有效的存储目录。');
  return migrateStorageLocation(request.path);
});

ipcMain.handle('mcp:list-tools', async () => {
  const tools = await refreshMcpServers();
  logMcpFailures();
  return tools;
});

ipcMain.handle('mcp:set-servers', async (_event, value: McpServerConfig[]) => {
  const configs = value.map(normalizeStoredMcpServerConfig);
  store.set('mcpServers', configs);
  notifyMcpServersUpdated();
  const tools = await restartMcpServersNow();
  return { servers: getMcpServerConfigs(), tools, error: mcpManager.getLastFailures().join('\n\n') || undefined };
});

ipcMain.handle('skills:set', (_event, value: SkillConfig[]) => {
  const skills = value.map((skill) => ({
    id: skill.id?.trim() || randomUUID(),
    name: skill.name?.trim() || path.basename(skill.path ?? ''),
    path: skill.path,
    enabled: skill.enabled !== false
  }));
  store.set('skills', skills);
  notifySkillsUpdated(skills);
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
  notifySkillsUpdated();
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

ipcMain.handle('directories:remove-allowed', (_event, request: RemoveAllowedDirectoryRequest) => {
  const targetPath = request?.path?.trim();
  if (!targetPath) throw new Error('目录路径不能为空。');

  const targetKey = getPathComparisonKey(targetPath);
  const directories = store.get('allowedDirectories', []);
  const nextDirectories = directories.filter((directory) => getPathComparisonKey(directory) !== targetKey);
  store.set('allowedDirectories', nextDirectories);
  return nextDirectories;
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

ipcMain.handle('dialog:select-storage-directory', async () => {
  const result = await showOpenDialog({
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('sessions:list', () => {
  const { sessions, currentSessionId } = getOrCreateCurrentSession();
  return {
    sessions: sortSessions(sessions).map(toSessionSummary),
    currentSessionId
  };
});

ipcMain.handle('sessions:get', (_event, sessionId: string) => {
  const { sessions } = getOrCreateCurrentSession();
  return sessions.find((session) => session.id === sessionId) ?? null;
});

ipcMain.handle('sessions:create', () => {
  const sessions = getSessions();
  const session = createChatSession();
  const savedSessions = persistSessions([session, ...sessions], session.id);
  return {
    session,
    sessions: sortSessions(savedSessions).map(toSessionSummary),
    currentSessionId: session.id
  };
});

ipcMain.handle('sessions:switch', (_event, sessionId: string) => {
  const sessions = getSessions();
  const target = sessions.find((session) => session.id === sessionId);
  if (!target) {
    throw new Error('会话不存在或已被删除。');
  }

  const savedSessions = persistSessions(sessions, target.id);
  return {
    session: target,
    sessions: sortSessions(savedSessions).map(toSessionSummary),
    currentSessionId: target.id
  };
});

ipcMain.handle('sessions:save', (_event, request: SaveSessionRequest) => {
  const sessions = getSessions();
  const currentSessionId = store.get('currentSessionId', null);
  const targetId = request.id?.trim() || currentSessionId || randomUUID();
  const now = new Date().toISOString();
  const existing = sessions.find((session) => session.id === targetId);
  const normalizedMessages = Array.isArray(request.messages)
    ? request.messages
        .map((message, index) => normalizeStoredMessage(message, index))
        .filter((message): message is StoredChatMessage => Boolean(message))
        .slice(-MAX_SESSION_MESSAGES)
    : existing?.messages ?? [];
  const hasExplicitTitle = typeof request.title === 'string' && request.title.trim().length > 0;
  const nextTitle = hasExplicitTitle
    ? compactText(request.title ?? '', 48)
    : normalizedMessages.length > 0
      ? summarizeSessionTitle(normalizedMessages)
      : existing?.title || UNTITLED_SESSION_TITLE;
  const nextSession = normalizeSession({
    id: targetId,
    title: nextTitle,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastMessageAt: normalizedMessages.at(-1)?.createdAt ?? now,
    messages: normalizedMessages
  });
  const nextSessions = existing
    ? sessions.map((session) => (session.id === targetId ? nextSession : session))
    : [nextSession, ...sessions];
  const nextCurrentSessionId = request.activate === true ? targetId : currentSessionId || targetId;
  const savedSessions = persistSessions(nextSessions, nextCurrentSessionId);

  return {
    session: nextSession,
    sessions: sortSessions(savedSessions).map(toSessionSummary),
    currentSessionId: nextCurrentSessionId
  };
});

ipcMain.handle('sessions:delete', async (_event, sessionId: string) => {
  const sessions = getSessions();
  const target = sessions.find((session) => session.id === sessionId);
  if (!target) {
    throw new Error('会话不存在或已被删除。');
  }

  const remaining = sessions.filter((session) => session.id !== sessionId);
  const previousCurrentSessionId = store.get('currentSessionId', null);
  const fallbackSession =
    previousCurrentSessionId && previousCurrentSessionId !== sessionId
      ? remaining.find((session) => session.id === previousCurrentSessionId) ?? remaining[0] ?? createChatSession()
      : remaining[0] ?? createChatSession();
  const nextSessions = remaining.length > 0 ? remaining : [fallbackSession];
  const savedSessions = persistSessions(nextSessions, fallbackSession.id);

  try {
    await deleteMastraThread(path.join(activeStoragePath, 'mastra'), sessionId);
  } catch (error) {
    console.warn('[Little Secretary] failed to delete Mastra thread:', error);
  }

  return {
    session: fallbackSession,
    sessions: sortSessions(savedSessions).map(toSessionSummary),
    currentSessionId: fallbackSession.id
  };
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
