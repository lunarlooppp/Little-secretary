import { defineStore } from 'pinia';
import type { AppConfig, AppSettings, McpServerConfig, McpToolInfo, ModelConfig, SkillConfig } from '../env';

const fallbackConfig: AppConfig = {
  modelConfig: {
    providerName: 'OpenAI Compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    model: 'qwen3:8b',
    temperature: 0.7
  },
  appSettings: {
    fontSize: 14,
    systemPrompt: '你是一个高效、简洁的桌面秘书。回答要清晰、准确，并在需要时使用 Markdown 或图表。',
    limitToolRounds: true,
    maxToolRounds: 4
  },
  allowedDirectories: [],
  mcpServers: [],
  mcpTools: [],
  skills: []
};

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    modelConfig: { ...fallbackConfig.modelConfig },
    appSettings: { ...fallbackConfig.appSettings },
    allowedDirectories: [] as string[],
    mcpServers: [] as McpServerConfig[],
    mcpTools: [] as McpToolInfo[],
    skills: [] as SkillConfig[],
    loaded: false
  }),
  actions: {
    async load() {
      const config = await window.littleSecretary.config.get();
      this.modelConfig = config.modelConfig;
      this.appSettings = config.appSettings;
      this.allowedDirectories = config.allowedDirectories;
      this.mcpServers = config.mcpServers;
      this.mcpTools = config.mcpTools;
      this.skills = config.skills;
      this.loaded = true;
      document.documentElement.style.setProperty('--app-font-size', `${config.appSettings.fontSize}px`);
    },
    subscribeMcpToolUpdates() {
      return window.littleSecretary.mcp.onToolsUpdated((tools) => {
        this.mcpTools = tools;
      });
    },
    async saveModel(config: ModelConfig) {
      this.modelConfig = await window.littleSecretary.config.setModel(config);
    },
    async saveSettings(settings: AppSettings) {
      this.appSettings = await window.littleSecretary.config.setSettings({
        ...settings,
        maxToolRounds: Math.round(Math.min(50, Math.max(1, Number(settings.maxToolRounds) || 4))),
        limitToolRounds: settings.limitToolRounds !== false
      });
      document.documentElement.style.setProperty('--app-font-size', `${this.appSettings.fontSize}px`);
    },
    async addAllowedDirectory() {
      const selected = await window.littleSecretary.dialog.selectDirectory();
      if (selected && !this.allowedDirectories.includes(selected)) {
        this.allowedDirectories.push(selected);
      }
      const config = await window.littleSecretary.config.get();
      this.allowedDirectories = config.allowedDirectories;
    },
    async saveMcpServers(servers: McpServerConfig[]) {
      const serializableServers = servers.map((server) => ({
        id: String(server.id),
        name: String(server.name),
        command: String(server.command),
        args: Array.isArray(server.args) ? server.args.map((arg) => String(arg)) : [],
        env: Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [String(key), String(value)])),
        enabled: Boolean(server.enabled)
      }));

      const result = await window.littleSecretary.mcp.setServers(serializableServers);
      this.mcpServers = result.servers;
      this.mcpTools = result.tools;
      return result;
    },
    async refreshMcpTools() {
      this.mcpTools = await window.littleSecretary.mcp.listTools();
    },
    async saveSkills(skills: SkillConfig[]) {
      this.skills = await window.littleSecretary.skills.set(skills);
    },
    async importSkill() {
      const skill = await window.littleSecretary.dialog.selectSkill();
      if (!skill) return;
      const config = await window.littleSecretary.config.get();
      this.skills = config.skills;
    }
  }
});
