<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="open" class="settings-shell" @click.self="$emit('close')">
        <aside class="settings-panel" aria-label="设置">
          <header class="settings-header">
            <span>设置</span>
            <button v-motion="'button'" v-ripple class="icon-button" type="button" aria-label="关闭设置" @click="$emit('close')">
              <X :size="17" />
            </button>
          </header>

          <div class="settings-body">
            <nav class="settings-nav" aria-label="设置目录">
              <button v-motion="'button'" v-ripple :class="{ active: activeTab === 'model' }" type="button" @click="activeTab = 'model'">
                模型配置
              </button>
              <button v-motion="'button'" v-ripple :class="{ active: activeTab === 'system' }" type="button" @click="activeTab = 'system'">
                系统设置
              </button>
              <button v-motion="'button'" v-ripple :class="{ active: activeTab === 'capability' }" type="button" @click="activeTab = 'capability'">
                能力扩展
              </button>
            </nav>

            <section v-if="activeTab === 'model'" class="settings-content" aria-label="模型配置">
              <label>
                <span>服务名称</span>
                <input v-model="modelDraft.providerName" type="text" autocomplete="off" />
              </label>
              <label>
                <span>Base URL</span>
                <input v-model="modelDraft.baseUrl" type="text" autocomplete="off" spellcheck="false" />
              </label>
              <label>
                <span>API Key</span>
                <input v-model="modelDraft.apiKey" type="password" autocomplete="off" spellcheck="false" />
              </label>
              <label>
                <span>模型名称</span>
                <input v-model="modelDraft.model" type="text" autocomplete="off" spellcheck="false" />
              </label>
              <label>
                <span>Temperature</span>
                <input v-model.number="modelDraft.temperature" type="number" min="0" max="2" step="0.1" />
              </label>
              <button v-motion="'buttonPrimary'" v-ripple class="primary-button" type="button" @click="saveModel">保存模型配置</button>
            </section>

            <section v-else-if="activeTab === 'system'" class="settings-content" aria-label="系统设置">
              <label>
                <span>系统字体 {{ settingsDraft.fontSize }}px</span>
                <input v-model.number="settingsDraft.fontSize" type="range" min="10" max="20" step="1" @input="previewFontSize" />
              </label>
              <label>
                <span>系统提示词</span>
                <textarea v-model="settingsDraft.systemPrompt" rows="7" />
              </label>
              <label class="inline-check settings-check">
                <input v-model="settingsDraft.limitToolRounds" type="checkbox" />
                <span>限制工具调用轮次</span>
              </label>
              <label>
                <span>最大工具调用轮次</span>
                <input
                  v-model.number="settingsDraft.maxToolRounds"
                  type="number"
                  min="1"
                  max="50"
                  step="1"
                  :disabled="!settingsDraft.limitToolRounds"
                />
              </label>
              <div class="directory-row">
                <span>允许访问目录</span>
                <button v-motion="'button'" v-ripple class="secondary-button" type="button" @click="addDirectory">
                  <FolderPlus :size="15" />
                  添加
                </button>
              </div>
              <ul class="directory-list">
                <li v-for="directory in settings.allowedDirectories" :key="directory">{{ directory }}</li>
              </ul>
              <button v-motion="'buttonPrimary'" v-ripple class="primary-button" type="button" @click="saveSettings">保存系统设置</button>
            </section>

            <section v-else class="settings-content capability-content" aria-label="能力扩展">
              <section class="settings-list-section" :class="{ expanded: capabilitySections.mcpServers }">
                <div class="settings-list-header">
                  <button
                    v-motion="'button'"
                    v-ripple
                    class="settings-list-toggle"
                    type="button"
                    :aria-expanded="capabilitySections.mcpServers"
                    aria-controls="mcp-server-list"
                    @click="toggleCapabilitySection('mcpServers')"
                  >
                    <ChevronDown :size="16" />
                    <span>MCP 服务器</span>
                    <span class="settings-list-count">{{ mcpDraft.length }}</span>
                  </button>
                  <button v-motion="'button'" v-ripple class="secondary-button" type="button" @click="addMcpServer">
                    <PlugZap :size="15" />
                    添加
                  </button>
                </div>

                <div v-if="capabilitySections.mcpServers" id="mcp-server-list" class="capability-list">
                  <div v-for="server in mcpDraft" :key="server.id" class="capability-item">
                    <div class="capability-topline">
                      <label class="inline-check">
                        <input v-model="server.enabled" type="checkbox" :disabled="server.id === 'builtin-web-search'" />
                        <span>{{ server.id === 'builtin-web-search' ? server.name : '启用' }}</span>
                      </label>
                      <div class="capability-actions">
                        <button
                          v-if="server.id !== 'builtin-web-search'"
                          v-motion="'button'"
                          v-ripple
                          class="secondary-button compact-button"
                          type="button"
                          @click="editMcpServer(server)"
                        >
                          编辑
                        </button>
                        <button
                          v-if="server.id !== 'builtin-web-search'"
                          v-motion="'buttonDanger'"
                          v-ripple
                          class="danger-icon-button"
                          type="button"
                          aria-label="删除 MCP 服务器"
                          title="删除 MCP 服务器"
                          @click="removeMcpServer(server.id)"
                        >
                          <Trash2 :size="15" />
                        </button>
                      </div>
                    </div>
                    <div class="capability-summary">
                      <strong>{{ server.name }}</strong>
                      <span>{{ describeMcpServer(server) }}</span>
                    </div>
                  </div>
                </div>
              </section>

              <section class="settings-list-section" :class="{ expanded: capabilitySections.tools }">
                <div class="settings-list-header">
                  <button
                    v-motion="'button'"
                    v-ripple
                    class="settings-list-toggle"
                    type="button"
                    :aria-expanded="capabilitySections.tools"
                    aria-controls="mcp-tool-list"
                    @click="toggleCapabilitySection('tools')"
                  >
                    <ChevronDown :size="16" />
                    <span>可用工具</span>
                    <span class="settings-list-count">{{ settings.mcpTools.length }}</span>
                  </button>
                  <button v-motion="'button'" v-ripple class="secondary-button" type="button" @click="refreshTools">
                    <RefreshCw :size="15" />
                    刷新
                  </button>
                </div>
                <ul v-if="capabilitySections.tools" id="mcp-tool-list" class="directory-list tool-list">
                  <li v-for="tool in settings.mcpTools" :key="tool.id">
                    {{ tool.serverName }} / {{ tool.name }}
                  </li>
                  <li v-if="settings.mcpTools.length === 0">暂无已连接工具</li>
                </ul>
              </section>

              <section class="settings-list-section" :class="{ expanded: capabilitySections.skills }">
                <div class="settings-list-header">
                  <button
                    v-motion="'button'"
                    v-ripple
                    class="settings-list-toggle"
                    type="button"
                    :aria-expanded="capabilitySections.skills"
                    aria-controls="skill-list"
                    @click="toggleCapabilitySection('skills')"
                  >
                    <ChevronDown :size="16" />
                    <span>Skills</span>
                    <span class="settings-list-count">{{ settings.skills.length }}</span>
                  </button>
                  <button v-motion="'button'" v-ripple class="secondary-button" type="button" @click="importSkill">
                    <FolderPlus :size="15" />
                    导入
                  </button>
                </div>
                <ul v-if="capabilitySections.skills" id="skill-list" class="directory-list">
                  <li v-for="skill in settings.skills" :key="skill.id" class="skill-row">
                    <label class="inline-check">
                      <input v-model="skill.enabled" type="checkbox" @change="saveSkills" />
                      <span>{{ skill.name }} - {{ skill.path }}</span>
                    </label>
                    <button
                      v-motion="'buttonDanger'"
                      v-ripple
                      class="danger-icon-button"
                      type="button"
                      aria-label="删除 Skill"
                      title="删除 Skill"
                      @click="removeSkill(skill.id)"
                    >
                      <Trash2 :size="15" />
                    </button>
                  </li>
                  <li v-if="settings.skills.length === 0">暂无 Skill</li>
                </ul>
              </section>

              <button v-motion="'buttonPrimary'" v-ripple class="primary-button" type="button" @click="saveMcpServers">保存能力配置</button>
            </section>
          </div>

          <div v-if="mcpEditorOpen" class="modal-overlay" @click.self="closeMcpEditor">
            <section class="modal-panel" aria-label="MCP 服务器配置">
              <header class="modal-header">
                <span>{{ editingMcpId ? '编辑 MCP 服务器' : '添加 MCP 服务器' }}</span>
                <button v-motion="'button'" v-ripple class="icon-button" type="button" aria-label="关闭 MCP 配置" @click="closeMcpEditor">
                  <X :size="17" />
                </button>
              </header>

              <div class="modal-body">
                <label class="capability-field">
                  <span>名称</span>
                  <input v-model="mcpEditor.name" type="text" autocomplete="off" spellcheck="false" placeholder="BittleBits GEO Assistant" />
                </label>

                <label class="capability-field">
                  <span>安装方式</span>
                  <select v-model="mcpEditor.installMethod" @change="applyInstallDefaults">
                    <option value="npx">临时安装 npx</option>
                    <option value="global">全局安装 mcp-remote</option>
                    <option value="pnpm">pnpm dlx</option>
                    <option value="bunx">bunx</option>
                    <option value="node-path">本地脚本路径</option>
                    <option value="custom">自定义命令</option>
                  </select>
                </label>

                <template v-if="mcpEditor.installMethod === 'custom'">
                  <label class="capability-field">
                    <span>命令</span>
                    <input v-model="mcpEditor.customCommand" type="text" autocomplete="off" spellcheck="false" placeholder="npx" />
                  </label>
                  <label class="capability-field">
                    <span>参数</span>
                    <input v-model="mcpEditor.customArgs" type="text" autocomplete="off" spellcheck="false" placeholder="-y mcp-remote https://example.com/mcp" />
                  </label>
                </template>

                <template v-else>
                  <label v-if="mcpEditor.installMethod === 'node-path'" class="capability-field">
                    <span>脚本路径</span>
                    <input
                      v-model="mcpEditor.scriptPath"
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      placeholder="C:\\Users\\Lunar\\Documents\\Little-secretary\\node_modules\\mcp-remote\\dist\\proxy.js"
                    />
                  </label>

                  <label class="capability-field">
                    <span>远程 MCP 地址</span>
                    <input v-model="mcpEditor.remoteUrl" type="text" autocomplete="off" spellcheck="false" placeholder="https://bittlebits.ai/mcp" />
                  </label>

                  <label class="capability-field">
                    <span>传输方式</span>
                    <select v-model="mcpEditor.transport">
                      <option value="http-only">http-only</option>
                      <option value="http-first">http-first</option>
                      <option value="sse-only">sse-only</option>
                      <option value="sse-first">sse-first</option>
                    </select>
                  </label>

                  <label class="inline-check">
                    <input v-model="mcpEditor.useLatest" type="checkbox" :disabled="mcpEditor.installMethod !== 'npx'" />
                    <span>使用 mcp-remote@latest</span>
                  </label>

                  <label class="inline-check">
                    <input v-model="mcpEditor.silent" type="checkbox" />
                    <span>静默日志</span>
                  </label>

                  <label class="inline-check">
                    <input v-model="mcpEditor.debug" type="checkbox" />
                    <span>调试日志</span>
                  </label>

                  <label class="inline-check">
                    <input v-model="mcpEditor.enableProxy" type="checkbox" />
                    <span>启用代理环境变量</span>
                  </label>

                  <label class="capability-field">
                    <span>认证超时秒数</span>
                    <input v-model="mcpEditor.authTimeout" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="30" />
                  </label>

                  <label class="capability-field">
                    <span>其他参数</span>
                    <input
                      v-model="mcpEditor.extraArgs"
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      placeholder="例如：--header Authorization:${AUTH_HEADER} --resource https://tenant.example.com/"
                    />
                  </label>
                </template>

                <label class="inline-check">
                  <input v-model="mcpEditor.enabled" type="checkbox" />
                  <span>启用该服务器</span>
                </label>

                <div class="command-preview">
                  <span>将执行</span>
                  <code>{{ commandPreview }}</code>
                </div>
              </div>

              <footer class="modal-actions">
                <button v-motion="'button'" v-ripple class="secondary-button" type="button" @click="closeMcpEditor">取消</button>
                <button v-motion="'buttonPrimary'" v-ripple class="primary-button" type="button" :disabled="mcpEditorSaving" @click="confirmMcpEditor">
                  确认并保存
                </button>
              </footer>
            </section>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ChevronDown, FolderPlus, PlugZap, RefreshCw, Trash2, X } from 'lucide-vue-next';
import { computed, reactive, ref, watch } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { useToastStore } from '../stores/toast';
import type { McpServerConfig } from '../env';

const props = defineProps<{
  open: boolean;
}>();

defineEmits<{
  close: [];
}>();

const settings = useSettingsStore();
const toast = useToastStore();
const activeTab = ref<'model' | 'system' | 'capability'>('model');

const fallbackSettingsDraft = {
  fontSize: 14,
  systemPrompt: '',
  limitToolRounds: true,
  maxToolRounds: 4
};

const modelDraft = reactive({ ...settings.modelConfig });
const settingsDraft = reactive({ ...fallbackSettingsDraft, ...settings.appSettings });
const mcpDraft = ref<Array<McpServerConfig & { argsText: string }>>([]);
const mcpEditorOpen = ref(false);
const editingMcpId = ref<string | null>(null);
const mcpEditorSaving = ref(false);
const capabilitySections = reactive({
  mcpServers: false,
  tools: false,
  skills: false
});

type CapabilitySection = keyof typeof capabilitySections;

type InstallMethod = 'npx' | 'global' | 'pnpm' | 'bunx' | 'node-path' | 'custom';
type TransportMode = 'http-only' | 'http-first' | 'sse-only' | 'sse-first';

const defaultMcpEditor = {
  name: 'BittleBits GEO Assistant',
  installMethod: 'npx' as InstallMethod,
  remoteUrl: 'https://bittlebits.ai/mcp',
  transport: 'http-only' as TransportMode,
  useLatest: false,
  silent: true,
  debug: false,
  enableProxy: false,
  authTimeout: '30',
  extraArgs: '',
  scriptPath: '',
  customCommand: 'npx',
  customArgs: '-y mcp-remote https://bittlebits.ai/mcp --transport http-only',
  enabled: true
};

const mcpEditor = reactive({ ...defaultMcpEditor });

function resetMcpEditor() {
  Object.assign(mcpEditor, defaultMcpEditor);
}

function syncMcpDraft() {
  mcpDraft.value = settings.mcpServers.map((server) => ({
    ...server,
    argsText: server.args.join(' ')
  }));
}

function toggleCapabilitySection(section: CapabilitySection) {
  capabilitySections[section] = !capabilitySections[section];
}

function parseArgs(value: string) {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }

  return tokens;
}

function toArgsText(args: string[]) {
  return args.map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ');
}

function addOptionalArg(args: string[], flag: string, value: string) {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (flag) args.push(flag);
  args.push(trimmed);
}

function getFlagValue(args: string[], flag: string, fallback = '') {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;

  const value = args[index + 1];
  if (!value || value.startsWith('--')) return fallback;
  return value;
}

function collectExtraArgs(args: string[], installMethod: InstallMethod) {
  const consumed = new Set<number>();
  const consumeFlagWithValue = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0) return;
    consumed.add(index);
    if (args[index + 1] && !args[index + 1].startsWith('--')) consumed.add(index + 1);
  };

  const consumeFlag = (flag: string) => {
    const index = args.indexOf(flag);
    if (index >= 0) consumed.add(index);
  };

  const remoteUrlIndex = args.findIndex((arg) => /^https?:\/\//i.test(arg));
  if (remoteUrlIndex >= 0) {
    consumed.add(remoteUrlIndex);
    if (args[remoteUrlIndex + 1] && /^\d+$/.test(args[remoteUrlIndex + 1])) consumed.add(remoteUrlIndex + 1);
  }

  const packageIndex = args.findIndex((arg) => arg === 'mcp-remote' || arg === 'mcp-remote@latest');
  if (packageIndex >= 0) consumed.add(packageIndex);
  if (args[0] === '-y') consumed.add(0);
  if (args[0] === 'dlx') consumed.add(0);
  if (installMethod === 'node-path' && args[0]) consumed.add(0);

  consumeFlagWithValue('--transport');
  consumeFlagWithValue('--auth-timeout');
  consumeFlag('--silent');
  consumeFlag('--debug');
  consumeFlag('--enable-proxy');

  return args.filter((_arg, index) => !consumed.has(index));
}

function removeEmptyValueFlags(args: string[]) {
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

function buildMcpCommand() {
  if (mcpEditor.installMethod === 'custom') {
    return {
      command: mcpEditor.customCommand.trim(),
      args: parseArgs(mcpEditor.customArgs)
    };
  }

  const args: string[] = [];
  const packageName = mcpEditor.useLatest && mcpEditor.installMethod === 'npx' ? 'mcp-remote@latest' : 'mcp-remote';

  if (mcpEditor.installMethod === 'npx') {
    args.push('-y', packageName);
  } else if (mcpEditor.installMethod === 'pnpm') {
    args.push('dlx', 'mcp-remote');
  } else if (mcpEditor.installMethod === 'bunx') {
    args.push('mcp-remote');
  } else if (mcpEditor.installMethod === 'node-path') {
    args.push(mcpEditor.scriptPath.trim());
  }

  args.push(mcpEditor.remoteUrl.trim());
  if (mcpEditor.transport) args.push('--transport', mcpEditor.transport);
  if (mcpEditor.silent) args.push('--silent');
  if (mcpEditor.debug) args.push('--debug');
  if (mcpEditor.enableProxy) args.push('--enable-proxy');
  addOptionalArg(args, '--auth-timeout', mcpEditor.authTimeout);

  const extraArgs = parseArgs(mcpEditor.extraArgs);
  if (extraArgs.length) args.push(...extraArgs);

  const commandByMethod: Record<InstallMethod, string> = {
    npx: 'npx',
    global: 'mcp-remote',
    pnpm: 'pnpm',
    bunx: 'bunx',
    'node-path': 'node',
    custom: mcpEditor.customCommand.trim()
  };

  return {
    command: commandByMethod[mcpEditor.installMethod],
    args
  };
}

function applyInstallDefaults() {
  if (mcpEditor.installMethod === 'custom') {
    if (!mcpEditor.customCommand.trim()) mcpEditor.customCommand = 'npx';
    if (!mcpEditor.customArgs.trim()) mcpEditor.customArgs = '-y mcp-remote https://bittlebits.ai/mcp --transport http-only';
    return;
  }

  if (mcpEditor.installMethod !== 'npx') mcpEditor.useLatest = false;
  if (mcpEditor.installMethod === 'global') mcpEditor.silent = true;
}

const commandPreview = computed(() => {
  const built = buildMcpCommand();
  return [built.command, ...built.args].filter(Boolean).join(' ');
});

function describeMcpServer(server: McpServerConfig & { argsText: string }) {
  const command = [server.command, ...server.args].filter(Boolean).join(' ');
  return command || '未配置命令';
}

function closeMcpEditor() {
  mcpEditorOpen.value = false;
  editingMcpId.value = null;
}

function parseServerToEditor(server: McpServerConfig & { argsText: string }) {
  resetMcpEditor();
  mcpEditor.name = server.name;
  mcpEditor.enabled = server.enabled;
  mcpEditor.customCommand = server.command;
  mcpEditor.customArgs = server.argsText;

  const args = server.args;
  if (server.command === 'npx' && (args.includes('mcp-remote') || args.includes('mcp-remote@latest'))) {
    mcpEditor.installMethod = 'npx';
    mcpEditor.useLatest = args.includes('mcp-remote@latest');
  } else if (server.command === 'mcp-remote') {
    mcpEditor.installMethod = 'global';
  } else if (server.command === 'pnpm' && args[0] === 'dlx') {
    mcpEditor.installMethod = 'pnpm';
  } else if (server.command === 'bunx') {
    mcpEditor.installMethod = 'bunx';
  } else if (server.command === 'node') {
    mcpEditor.installMethod = 'node-path';
    mcpEditor.scriptPath = args[0] ?? '';
  } else {
    mcpEditor.installMethod = 'custom';
    return;
  }

  const remoteUrl = args.find((arg) => /^https?:\/\//i.test(arg));
  if (remoteUrl) mcpEditor.remoteUrl = remoteUrl;

  const transportIndex = args.indexOf('--transport');
  if (transportIndex >= 0 && args[transportIndex + 1]) {
    mcpEditor.transport = args[transportIndex + 1] as TransportMode;
  }

  mcpEditor.silent = args.includes('--silent');
  mcpEditor.debug = args.includes('--debug');
  mcpEditor.enableProxy = args.includes('--enable-proxy');
  mcpEditor.authTimeout = getFlagValue(args, '--auth-timeout', defaultMcpEditor.authTimeout);
  mcpEditor.extraArgs = toArgsText(collectExtraArgs(args, mcpEditor.installMethod));
}

watch(
  () => props.open,
  (value) => {
    if (!value) return;
    Object.assign(modelDraft, settings.modelConfig);
    Object.assign(settingsDraft, fallbackSettingsDraft, settings.appSettings);
    syncMcpDraft();
  }
);

function previewFontSize() {
  settingsDraft.fontSize = Math.round(Math.min(20, Math.max(10, settingsDraft.fontSize)));
  document.documentElement.style.setProperty('--app-font-size', `${settingsDraft.fontSize}px`);
}

async function saveModel() {
  await settings.saveModel({ ...modelDraft });
  toast.show('模型配置已保存');
}

async function saveSettings() {
  previewFontSize();
  settingsDraft.maxToolRounds = Math.round(Math.min(50, Math.max(1, Number(settingsDraft.maxToolRounds) || 4)));
  await settings.saveSettings({ ...settingsDraft });
  toast.show('系统设置已保存');
}

async function addDirectory() {
  await settings.addAllowedDirectory();
}

function addMcpServer() {
  capabilitySections.mcpServers = true;
  resetMcpEditor();
  editingMcpId.value = null;
  mcpEditorSaving.value = false;
  mcpEditorOpen.value = true;
}

function editMcpServer(server: McpServerConfig & { argsText: string }) {
  editingMcpId.value = server.id;
  mcpEditorSaving.value = false;
  parseServerToEditor(server);
  mcpEditorOpen.value = true;
}

function removeMcpServer(id: string) {
  mcpDraft.value = mcpDraft.value.filter((server) => server.id !== id);
}

async function persistMcpDraft(successMessage: string) {
  const servers = mcpDraft.value.map((server) => ({
    id: String(server.id),
    name: String(server.name),
    command: String(server.command),
    args: server.args.map((arg) => String(arg)),
    env: Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [String(key), String(value)])),
    enabled: Boolean(server.enabled)
  }));

  const result = await settings.saveMcpServers(servers);
  syncMcpDraft();
  if (result.error) {
    toast.show(result.error, 'error');
    return false;
  }

  toast.show(successMessage);
  return true;
}

async function confirmMcpEditor() {
  if (mcpEditorSaving.value) return;

  if (!mcpEditor.name.trim()) {
    toast.show('请填写 MCP 服务器名称', 'error');
    return;
  }

  const built = buildMcpCommand();
  if (!built.command.trim()) {
    toast.show('请选择安装方式或填写命令', 'error');
    return;
  }
  if (mcpEditor.installMethod !== 'custom' && !mcpEditor.remoteUrl.trim()) {
    toast.show('请填写远程 MCP 地址', 'error');
    return;
  }
  if (mcpEditor.installMethod === 'node-path' && !mcpEditor.scriptPath.trim()) {
    toast.show('请填写本地脚本路径', 'error');
    return;
  }

  mcpEditorSaving.value = true;
  const wasEditing = Boolean(editingMcpId.value);
  const id = editingMcpId.value ?? crypto.randomUUID();
  const nextArgs = removeEmptyValueFlags(built.args.filter((arg) => arg.trim()));
  const nextServer = {
    id,
    name: mcpEditor.name.trim(),
    command: built.command.trim(),
    args: nextArgs,
    argsText: toArgsText(nextArgs),
    env: {},
    enabled: mcpEditor.enabled
  };

  const existingIndex = mcpDraft.value.findIndex((server) => server.id === id);
  if (existingIndex >= 0) {
    mcpDraft.value.splice(existingIndex, 1, nextServer);
  } else {
    mcpDraft.value.push(nextServer);
  }
  capabilitySections.mcpServers = true;

  closeMcpEditor();
  const saved = await persistMcpDraft(wasEditing ? 'MCP 服务器已更新并保存，正在后台连接' : 'MCP 服务器已添加并保存，正在后台连接');
  if (!saved) {
    toast.show('MCP 配置已保留在界面中，请检查后重新保存', 'error');
  }
  mcpEditorSaving.value = false;
}

async function saveMcpServers() {
  await persistMcpDraft('能力配置已保存');
}

async function refreshTools() {
  try {
    await settings.refreshMcpTools();
    capabilitySections.tools = true;
    toast.show('MCP 工具已刷新');
  } catch (error) {
    toast.show(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function importSkill() {
  await settings.importSkill();
  capabilitySections.skills = true;
}

async function removeSkill(id: string) {
  await settings.saveSkills(settings.skills.filter((skill) => skill.id !== id).map((skill) => ({ ...skill })));
  toast.show('Skill 已删除');
}

async function saveSkills() {
  await settings.saveSkills(settings.skills.map((skill) => ({ ...skill })));
  toast.show('Skills 已保存');
}
</script>
