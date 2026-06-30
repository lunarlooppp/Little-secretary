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

            <section v-else class="settings-content" aria-label="能力扩展">
              <div class="directory-row">
                <span>MCP 服务器</span>
                <button v-motion="'button'" v-ripple class="secondary-button" type="button" @click="addMcpServer">
                  <PlugZap :size="15" />
                  添加
                </button>
              </div>

              <div class="capability-list">
                <div v-for="server in mcpDraft" :key="server.id" class="capability-item">
                  <div class="capability-topline">
                    <label class="inline-check">
                      <input v-model="server.enabled" type="checkbox" :disabled="server.id === 'builtin-web-search'" />
                      <span>{{ server.id === 'builtin-web-search' ? server.name : '启用' }}</span>
                    </label>
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
                  <label class="capability-field">
                    <span>名称</span>
                    <input
                      v-model="server.name"
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      :disabled="server.id === 'builtin-web-search'"
                      placeholder="Lona Trading"
                    />
                  </label>
                  <label class="capability-field">
                    <span>命令</span>
                    <input
                      v-model="server.command"
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      :disabled="server.id === 'builtin-web-search'"
                      placeholder="npx"
                    />
                  </label>
                  <label class="capability-field">
                    <span>参数</span>
                    <input
                      v-model="server.argsText"
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      :disabled="server.id === 'builtin-web-search'"
                      placeholder="-y mcp-remote https://mcp.lona.agency/mcp --transport http-only"
                    />
                  </label>
                </div>
              </div>

              <div class="directory-row">
                <span>可用工具</span>
                <button v-motion="'button'" v-ripple class="secondary-button" type="button" @click="refreshTools">
                  <RefreshCw :size="15" />
                  刷新
                </button>
              </div>
              <ul class="directory-list tool-list">
                <li v-for="tool in settings.mcpTools" :key="tool.id">
                  {{ tool.serverName }} / {{ tool.name }}
                </li>
                <li v-if="settings.mcpTools.length === 0">暂无已连接工具</li>
              </ul>

              <div class="directory-row">
                <span>Skills</span>
                <button v-motion="'button'" v-ripple class="secondary-button" type="button" @click="importSkill">
                  <FolderPlus :size="15" />
                  导入
                </button>
              </div>
              <ul class="directory-list">
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

              <button v-motion="'buttonPrimary'" v-ripple class="primary-button" type="button" @click="saveMcpServers">保存能力配置</button>
            </section>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { FolderPlus, PlugZap, RefreshCw, Trash2, X } from 'lucide-vue-next';
import { reactive, ref, watch } from 'vue';
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

function syncMcpDraft() {
  mcpDraft.value = settings.mcpServers.map((server) => ({
    ...server,
    argsText: server.args.join(' ')
  }));
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
  const id = crypto.randomUUID();
  mcpDraft.value.push({
    id,
    name: '自定义 MCP',
    command: '',
    args: [],
    argsText: '',
    enabled: true
  });
}

function removeMcpServer(id: string) {
  mcpDraft.value = mcpDraft.value.filter((server) => server.id !== id);
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

async function saveMcpServers() {
  const servers = mcpDraft.value.map((server) => ({
    id: String(server.id),
    name: String(server.name),
    command: String(server.command),
    args: parseArgs(server.argsText).map((arg) => String(arg)),
    env: Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [String(key), String(value)])),
    enabled: Boolean(server.enabled)
  }));

  await settings.saveMcpServers(servers);
  syncMcpDraft();
  toast.show('能力配置已保存');
}

async function refreshTools() {
  await settings.refreshMcpTools();
}

async function importSkill() {
  await settings.importSkill();
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
