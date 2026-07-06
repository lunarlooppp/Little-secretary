import { contextBridge, ipcRenderer } from 'electron';

type StreamDeltaHandler = (payload: { streamId: string; type: 'content' | 'reasoning'; text: string }) => void;
type StreamEndHandler = (payload: { streamId: string }) => void;
type StreamErrorHandler = (payload: { streamId: string; message: string }) => void;
type McpToolsHandler = (payload: unknown[]) => void;
type McpServersHandler = (payload: unknown[]) => void;
type SkillsHandler = (payload: unknown[]) => void;

const api = {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    setModel: (value: unknown) => ipcRenderer.invoke('config:set-model', value),
    setSettings: (value: unknown) => ipcRenderer.invoke('config:set-settings', value)
  },
  mcp: {
    listTools: () => ipcRenderer.invoke('mcp:list-tools'),
    setServers: (value: unknown) => ipcRenderer.invoke('mcp:set-servers', value),
    onToolsUpdated: (handler: McpToolsHandler) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<McpToolsHandler>[0]) => handler(payload);
      ipcRenderer.on('mcp:tools-updated', listener);
      return () => ipcRenderer.removeListener('mcp:tools-updated', listener);
    },
    onServersUpdated: (handler: McpServersHandler) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<McpServersHandler>[0]) => handler(payload);
      ipcRenderer.on('mcp:servers-updated', listener);
      return () => ipcRenderer.removeListener('mcp:servers-updated', listener);
    }
  },
  skills: {
    set: (value: unknown) => ipcRenderer.invoke('skills:set', value),
    onUpdated: (handler: SkillsHandler) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<SkillsHandler>[0]) => handler(payload);
      ipcRenderer.on('skills:updated', listener);
      return () => ipcRenderer.removeListener('skills:updated', listener);
    }
  },
  storage: {
    getLocation: () => ipcRenderer.invoke('storage:get-location'),
    setLocation: (request: unknown) => ipcRenderer.invoke('storage:set-location', request)
  },
  directories: {
    removeAllowed: (request: unknown) => ipcRenderer.invoke('directories:remove-allowed', request)
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
    selectStorageDirectory: () => ipcRenderer.invoke('dialog:select-storage-directory'),
    selectFile: () => ipcRenderer.invoke('dialog:select-file'),
    selectSkill: () => ipcRenderer.invoke('dialog:select-skill')
  },
  file: {
    read: (request: unknown) => ipcRenderer.invoke('file:read', request),
    write: (request: unknown) => ipcRenderer.invoke('file:write', request),
    listDirectory: (request: unknown) => ipcRenderer.invoke('file:list-directory', request),
    openPath: (targetPath: string) => ipcRenderer.invoke('file:open-path', targetPath)
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    get: (sessionId: string) => ipcRenderer.invoke('sessions:get', sessionId),
    create: () => ipcRenderer.invoke('sessions:create'),
    switch: (sessionId: string) => ipcRenderer.invoke('sessions:switch', sessionId),
    save: (request: unknown) => ipcRenderer.invoke('sessions:save', request),
    delete: (sessionId: string) => ipcRenderer.invoke('sessions:delete', sessionId)
  },
  chat: {
    startStream: (request: unknown) => ipcRenderer.invoke('chat:start-stream', request),
    stopStream: (streamId: string) => ipcRenderer.invoke('chat:stop-stream', streamId),
    onDelta: (handler: StreamDeltaHandler) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<StreamDeltaHandler>[0]) => handler(payload);
      ipcRenderer.on('chat:stream-delta', listener);
      return () => ipcRenderer.removeListener('chat:stream-delta', listener);
    },
    onEnd: (handler: StreamEndHandler) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<StreamEndHandler>[0]) => handler(payload);
      ipcRenderer.on('chat:stream-end', listener);
      return () => ipcRenderer.removeListener('chat:stream-end', listener);
    },
    onError: (handler: StreamErrorHandler) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<StreamErrorHandler>[0]) => handler(payload);
      ipcRenderer.on('chat:stream-error', listener);
      return () => ipcRenderer.removeListener('chat:stream-error', listener);
    }
  }
};

contextBridge.exposeInMainWorld('littleSecretary', api);
