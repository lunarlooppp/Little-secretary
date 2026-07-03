<template>
  <main :class="['app-shell', { 'sessions-open': sessionPanelOpen }]">
    <aside
      class="session-sidebar"
      aria-label="会话列表"
    >
      <div class="session-hover-zone" aria-hidden="true" @mouseenter="openSessionPanel"></div>
      <div class="session-rail" aria-hidden="true">
        <span></span>
      </div>

      <div class="session-panel">
        <header class="session-header">
          <span>会话</span>
          <button
            v-motion="'button'"
            v-ripple
            class="icon-button"
            type="button"
            aria-label="新建会话"
            title="新建会话"
            :disabled="sessionControlDisabled"
            @click="createSession"
          >
            <Plus :size="18" />
          </button>
        </header>

        <div class="session-list" aria-live="polite">
          <div
            v-for="session in sessionSummaries"
            :key="session.id"
            :class="['session-item', { active: session.id === sessionId, streaming: isSessionStreaming(session.id) }]"
            @contextmenu.prevent="openSessionMenu($event, session.id)"
          >
            <button
              class="session-select"
              type="button"
              :disabled="sessionControlDisabled || session.id === sessionId"
              @click="switchSession(session.id)"
            >
              <span class="session-title-row">
                <span class="session-item-title">{{ session.title }}</span>
                <span class="session-item-time">{{ formatSessionTime(session.lastMessageAt) }}</span>
              </span>
              <span class="session-preview-row">
                <span class="session-item-preview">{{ session.preview }}</span>
                <span class="session-item-count">{{ isSessionStreaming(session.id) ? '生成中' : formatMessageCount(session.messageCount) }}</span>
              </span>
            </button>
          </div>
          <div v-if="sessionSummaries.length === 0" class="session-empty">暂无会话</div>
        </div>
      </div>
    </aside>

    <section class="chat-area">
      <header class="topbar">
        <div class="title-stack">
          <h1>{{ activeSessionTitle }}</h1>
          <span v-if="activeSessionSubtitle">{{ activeSessionSubtitle }}</span>
        </div>
        <button
          v-motion="'button'"
          v-ripple
          class="icon-button"
          type="button"
          aria-label="打开设置"
          @click="settingsOpen = true"
        >
          <Settings :size="18" />
        </button>
      </header>

      <section ref="scrollEl" class="chat-scroll" aria-live="polite">
        <article v-for="message in visibleMessages" :key="message.id" :class="['message', message.role]">
          <details v-if="message.reasoning" class="reasoning" open>
            <summary>思考内容</summary>
            <MessageContent :content="message.reasoning" />
          </details>
          <MessageContent
            :content="message.content || (message.role === 'assistant' && message.id !== activeStreamingMessageId ? '...' : '')"
            :streaming="message.id === activeStreamingMessageId"
          />
        </article>
      </section>

      <form class="composer" @submit.prevent="sendMessage">
        <div class="composer-surface" @pointerdown.self="focusComposer">
          <div class="composer-input-region" @pointerdown.self="focusComposer">
            <textarea
              ref="composerInputEl"
              v-model="input"
              class="composer-input"
              rows="1"
              placeholder="输入消息..."
              :disabled="sessionsLoading"
              @input="handleComposerInput"
              @keydown.enter.exact.prevent="sendMessage"
              @keydown.enter.shift.exact.stop
            />
          </div>
          <div class="composer-actions" @pointerdown.self="focusComposer">
            <button
              v-motion="'buttonPrimary'"
              v-ripple
              class="send-button"
              type="submit"
              aria-label="发送"
              title="发送"
              :disabled="activeSessionStreaming || sessionsLoading || !input.trim()"
            >
              <SendHorizontal :size="18" />
            </button>
          </div>
        </div>
      </form>
    </section>

    <Teleport to="body">
      <Transition name="fade">
        <div v-if="sessionMenu.open" class="session-menu-layer" @pointerdown.self="closeSessionMenu" @contextmenu.prevent>
          <div
            class="session-context-menu"
            :style="sessionMenuStyle"
            role="menu"
            aria-label="会话操作"
            @mouseleave="closeSessionMenu"
          >
            <button
              v-ripple
              class="session-menu-item danger"
              type="button"
              role="menuitem"
              :disabled="!sessionMenu.sessionId || isSessionStreaming(sessionMenu.sessionId)"
              @click="deleteFromSessionMenu"
            >
              <Trash2 :size="15" />
              <span>删除</span>
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>

    <Transition name="fade">
      <div v-if="deleteCandidate" class="modal-overlay session-modal" @click.self="deleteCandidateId = null">
        <section class="modal-panel delete-session-panel" aria-label="删除会话">
          <header class="modal-header">
            <span>删除会话</span>
            <button v-motion="'button'" v-ripple class="icon-button" type="button" aria-label="关闭" @click="deleteCandidateId = null">
              <X :size="17" />
            </button>
          </header>
          <div class="modal-body">
            <p>确定删除“{{ deleteCandidate.title }}”吗？</p>
            <span class="modal-muted">该会话的本地消息和会话记忆都会移除。</span>
          </div>
          <footer class="modal-actions">
            <button v-motion="'button'" v-ripple class="secondary-button" type="button" @click="deleteCandidateId = null">取消</button>
            <button v-motion="'buttonDanger'" v-ripple class="primary-button danger-button" type="button" :disabled="sessionOperationPending" @click="confirmDeleteSession">
              删除
            </button>
          </footer>
        </section>
      </div>
    </Transition>

    <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" />
    <ToastHost />
  </main>
</template>

<script setup lang="ts">
import { Plus, SendHorizontal, Settings, Trash2, X } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import MessageContent from './components/MessageContent.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import ToastHost from './components/ToastHost.vue';
import { useSettingsStore } from './stores/settings';
import { useToastStore } from './stores/toast';
import type { ChatMessage, ChatSession, SessionSummary, StoredChatMessage } from './env';
import { runLocalCommand } from './utils/localCommands';
import { installOverlayScrollbars } from './utils/overlayScrollbars';

interface UiMessage extends ChatMessage {
  id: string;
  reasoning?: string;
  isThinking?: boolean;
  pendingThoughtToken?: string;
  transient?: boolean;
  createdAt?: string;
}

interface SessionStreamState {
  streamId: string;
  assistantMessageId: string;
}

interface StreamRoute {
  sessionId: string;
  assistantMessageId: string;
}

const settings = useSettingsStore();
const toast = useToastStore();
const settingsOpen = ref(false);
const input = ref('');
const sessionsLoading = ref(true);
const sessionOperationPending = ref(false);
const sessionPanelOpen = ref(false);
const sessionId = ref('');
const sessionSummaries = ref<SessionSummary[]>([]);
const deleteCandidateId = ref<string | null>(null);
const sessionMenu = ref({
  open: false,
  sessionId: '',
  x: 0,
  y: 0
});
const scrollEl = ref<HTMLElement | null>(null);
const composerInputEl = ref<HTMLTextAreaElement | null>(null);
const sessionMessages = ref<Record<string, UiMessage[]>>({});
const sessionStreams = ref<Record<string, SessionStreamState>>({});
const streamRoutes = new Map<string, StreamRoute>();
const initialMessages = ref<UiMessage[]>([createStarterMessage()]);

const messages = computed(() => (sessionId.value ? (sessionMessages.value[sessionId.value] ?? initialMessages.value) : initialMessages.value));
const visibleMessages = computed(() => messages.value.filter((message) => message.role !== 'system'));
const activeSession = computed(() => sessionSummaries.value.find((session) => session.id === sessionId.value));
const activeSessionTitle = computed(() => activeSession.value?.title || '新的会话');
const activeSessionSubtitle = computed(() => {
  const session = activeSession.value;
  if (!session) return '';
  return `${formatSessionTime(session.lastMessageAt)} · ${formatMessageCount(session.messageCount)}`;
});
const deleteCandidate = computed(() => sessionSummaries.value.find((session) => session.id === deleteCandidateId.value) ?? null);
const sessionMenuStyle = computed(() => ({
  left: `${sessionMenu.value.x}px`,
  top: `${sessionMenu.value.y}px`
}));
const activeStream = computed(() => (sessionId.value ? sessionStreams.value[sessionId.value] : undefined));
const activeStreamingMessageId = computed(() => activeStream.value?.assistantMessageId ?? null);
const activeSessionStreaming = computed(() => Boolean(activeStream.value));
const sessionControlDisabled = computed(() => sessionsLoading.value || sessionOperationPending.value);

function createStarterMessage(): UiMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '准备好了。',
    transient: true,
    createdAt: new Date().toISOString()
  };
}

function scrollToBottom() {
  void nextTick(() => {
    if (!scrollEl.value) return;
    scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
  });
}

function getMaxComposerInputHeight() {
  const chatHeight = scrollEl.value?.clientHeight ?? window.innerHeight * 0.62;
  return Math.max(84, Math.floor(chatHeight * 0.5));
}

function resizeComposerInput() {
  void nextTick(() => {
    const element = composerInputEl.value;
    if (!element) return;

    element.style.height = 'auto';
    const nextHeight = Math.min(element.scrollHeight, getMaxComposerInputHeight());
    element.style.height = `${nextHeight}px`;
    element.style.overflowY = element.scrollHeight > nextHeight ? 'overlay' : 'hidden';
  });
}

function openSessionPanel() {
  sessionPanelOpen.value = true;
}

function closeSessionPanel() {
  sessionPanelOpen.value = false;
}

function handleComposerInput() {
  closeSessionPanel();
  resizeComposerInput();
}

function focusComposer() {
  composerInputEl.value?.focus();
}

function shouldFocusComposer(event: KeyboardEvent) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (settingsOpen.value || deleteCandidateId.value || sessionMenu.value.open || sessionOperationPending.value) return false;
  if (event.key.length !== 1) return false;

  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  if (target === composerInputEl.value) return false;

  return !target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="button"]');
}

function focusComposerForTyping(event: KeyboardEvent) {
  if (event.key === 'Escape' && sessionMenu.value.open) {
    closeSessionMenu();
    return;
  }
  if (!shouldFocusComposer(event)) return;
  closeSessionPanel();
  composerInputEl.value?.focus();
}

function closeSessionMenu() {
  sessionMenu.value = {
    ...sessionMenu.value,
    open: false
  };
}

function openSessionMenu(event: MouseEvent, targetSessionId: string) {
  const menuWidth = 144;
  const menuHeight = 42;
  const padding = 8;
  const x = Math.min(event.clientX, window.innerWidth - menuWidth - padding);
  const y = Math.min(event.clientY, window.innerHeight - menuHeight - padding);

  sessionMenu.value = {
    open: true,
    sessionId: targetSessionId,
    x: Math.max(padding, x),
    y: Math.max(padding, y)
  };
}

function deleteFromSessionMenu() {
  const targetSessionId = sessionMenu.value.sessionId;
  closeSessionMenu();
  if (!targetSessionId) return;
  askDeleteSession(targetSessionId);
}

function handleGlobalPointerDown(event: PointerEvent) {
  if (!sessionPanelOpen.value) return;

  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest('.session-sidebar, .session-context-menu')) return;

  closeSessionPanel();
  closeSessionMenu();
}

function isSessionStreaming(targetSessionId: string) {
  return Boolean(sessionStreams.value[targetSessionId]);
}

function getSessionMessages(targetSessionId: string) {
  return sessionMessages.value[targetSessionId] ?? [];
}

function setSessionMessages(targetSessionId: string, nextMessages: UiMessage[]) {
  sessionMessages.value = {
    ...sessionMessages.value,
    [targetSessionId]: nextMessages
  };
}

function patchSessionStream(targetSessionId: string, nextState: SessionStreamState | null) {
  const nextStreams = { ...sessionStreams.value };
  if (nextState) {
    nextStreams[targetSessionId] = nextState;
  } else {
    delete nextStreams[targetSessionId];
  }
  sessionStreams.value = nextStreams;
}

function toModelMessages(targetSessionId = sessionId.value): ChatMessage[] {
  return getSessionMessages(targetSessionId)
    .filter((message) => message.content.trim() && !message.transient)
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
}

function toStoredMessages(targetSessionId = sessionId.value): StoredChatMessage[] {
  return getSessionMessages(targetSessionId)
    .filter((message) => !message.transient && (message.content.trim() || message.reasoning?.trim()))
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      reasoning: message.reasoning,
      createdAt: message.createdAt ?? new Date().toISOString(),
      ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls }),
      ...(message.tool_call_id === undefined ? {} : { tool_call_id: message.tool_call_id })
    }));
}

function applySession(session: ChatSession) {
  sessionId.value = session.id;
  setSessionMessages(
    session.id,
    session.messages.length > 0
      ? session.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          reasoning: message.reasoning,
          createdAt: message.createdAt
        }))
      : [createStarterMessage()]
  );
  input.value = '';
  resizeComposerInput();
  scrollToBottom();
}

function updateSessionSummaries(sessions: SessionSummary[], currentSessionId: string) {
  sessionSummaries.value = sessions;
  sessionId.value = currentSessionId;
}

async function loadSessions() {
  sessionsLoading.value = true;
  try {
    const result = await window.littleSecretary.sessions.list();
    updateSessionSummaries(result.sessions, result.currentSessionId);
    const currentSession = await window.littleSecretary.sessions.get(result.currentSessionId);
    if (currentSession) applySession(currentSession);
  } catch (error) {
    toast.show(`会话加载失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    sessionsLoading.value = false;
    resizeComposerInput();
    scrollToBottom();
  }
}

async function ensureActiveSession() {
  if (sessionId.value) return sessionId.value;

  const result = await window.littleSecretary.sessions.create();
  updateSessionSummaries(result.sessions, result.currentSessionId);
  sessionId.value = result.session.id;
  applySession(result.session);
  return result.session.id;
}

async function saveSession(targetSessionId: string, options: { activate?: boolean } = {}) {
  if (!targetSessionId) return null;

  const result = await window.littleSecretary.sessions.save({
    id: targetSessionId,
    messages: toStoredMessages(targetSessionId),
    activate: options.activate
  });
  if (options.activate) {
    updateSessionSummaries(result.sessions, result.currentSessionId);
  } else {
    sessionSummaries.value = result.sessions;
  }
  return result.session;
}

async function saveCurrentSession(options: { activate?: boolean } = {}) {
  return saveSession(sessionId.value, options);
}

async function createSession() {
  if (sessionControlDisabled.value) return;
  closeSessionMenu();
  sessionOperationPending.value = true;
  try {
    await saveCurrentSession();
    const result = await window.littleSecretary.sessions.create();
    updateSessionSummaries(result.sessions, result.currentSessionId);
    applySession(result.session);
    sessionPanelOpen.value = true;
  } catch (error) {
    toast.show(`新建会话失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    sessionOperationPending.value = false;
  }
}

async function switchSession(targetSessionId: string) {
  if (targetSessionId === sessionId.value || sessionControlDisabled.value) return;
  closeSessionMenu();
  sessionOperationPending.value = true;
  try {
    await saveCurrentSession();
    const result = await window.littleSecretary.sessions.switch(targetSessionId);
    updateSessionSummaries(result.sessions, result.currentSessionId);
    if (sessionMessages.value[targetSessionId]) {
      sessionId.value = targetSessionId;
      input.value = '';
      resizeComposerInput();
      scrollToBottom();
    } else {
      applySession(result.session);
    }
  } catch (error) {
    toast.show(`切换会话失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    sessionOperationPending.value = false;
  }
}

function askDeleteSession(targetSessionId: string) {
  if (sessionControlDisabled.value || isSessionStreaming(targetSessionId)) return;
  closeSessionMenu();
  deleteCandidateId.value = targetSessionId;
}

async function confirmDeleteSession() {
  const targetSessionId = deleteCandidateId.value;
  if (!targetSessionId || sessionOperationPending.value) return;
  if (isSessionStreaming(targetSessionId)) {
    toast.show('该会话正在生成，结束后再删除。', 'error');
    deleteCandidateId.value = null;
    return;
  }

  const deletingCurrentSession = targetSessionId === sessionId.value;
  sessionOperationPending.value = true;
  try {
    if (!deletingCurrentSession) {
      await saveCurrentSession();
    }

    const result = await window.littleSecretary.sessions.delete(targetSessionId);
    updateSessionSummaries(result.sessions, result.currentSessionId);
    const nextMessages = { ...sessionMessages.value };
    delete nextMessages[targetSessionId];
    sessionMessages.value = nextMessages;
    if (deletingCurrentSession) {
      applySession(result.session);
    }
    deleteCandidateId.value = null;
  } catch (error) {
    toast.show(`删除会话失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    sessionOperationPending.value = false;
  }
}

function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatMessageCount(count: number) {
  return count > 0 ? `${count} 条` : '空会话';
}

function saveSessionQuietly(targetSessionId: string) {
  void saveSession(targetSessionId, { activate: false }).catch((error) => {
    toast.show(`会话保存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  });
}

function saveCurrentSessionQuietly() {
  if (!sessionId.value) return;
  saveSessionQuietly(sessionId.value);
}

async function sendMessage() {
  const content = input.value.trim();
  if (!content || activeSessionStreaming.value || sessionsLoading.value) return;
  closeSessionMenu();

  let targetSessionId = sessionId.value;
  try {
    targetSessionId = await ensureActiveSession();
  } catch (error) {
    toast.show(`会话初始化失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    return;
  }

  const now = new Date().toISOString();
  const userMessage: UiMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content,
    createdAt: now
  };
  const assistantMessage: UiMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    reasoning: '',
    createdAt: now
  };

  setSessionMessages(targetSessionId, [...getSessionMessages(targetSessionId), userMessage, assistantMessage]);
  input.value = '';
  resizeComposerInput();
  scrollToBottom();

  try {
    await saveSession(targetSessionId, { activate: targetSessionId === sessionId.value });
    const localResult = await runLocalCommand(content);
    if (localResult.handled) {
      assistantMessage.content = localResult.content;
      await saveSession(targetSessionId);
      scrollToBottom();
      return;
    }

    patchSessionStream(targetSessionId, {
      streamId: '',
      assistantMessageId: assistantMessage.id
    });
    const streamId = await window.littleSecretary.chat.startStream({
      messages: toModelMessages(targetSessionId),
      systemPrompt: settings.appSettings.systemPrompt,
      sessionId: targetSessionId
    });
    streamRoutes.set(streamId, {
      sessionId: targetSessionId,
      assistantMessageId: assistantMessage.id
    });
    patchSessionStream(targetSessionId, {
      streamId,
      assistantMessageId: assistantMessage.id
    });
  } catch (error) {
    assistantMessage.content = error instanceof Error ? error.message : String(error);
    patchSessionStream(targetSessionId, null);
    await saveSession(targetSessionId);
  }
}

function getStreamRoute(streamId: string) {
  return streamRoutes.get(streamId) ?? null;
}

function findMessageInSession(targetSessionId: string, messageId: string) {
  return getSessionMessages(targetSessionId).find((message) => message.id === messageId);
}

function shouldScrollForSession(targetSessionId: string) {
  return targetSessionId === sessionId.value;
}

function getTrailingTokenPrefixLength(value: string, token: string) {
  const lowerValue = value.toLowerCase();
  const maxLength = Math.min(token.length - 1, lowerValue.length);

  for (let length = maxLength; length > 0; length -= 1) {
    if (token.startsWith(lowerValue.slice(-length))) return length;
  }

  return 0;
}

function appendThoughtAwareContent(message: UiMessage, text: string) {
  const openToken = '<think>';
  const closeToken = '</think>';
  let buffer = `${message.pendingThoughtToken ?? ''}${text}`;
  message.pendingThoughtToken = '';

  while (buffer) {
    const token = message.isThinking ? closeToken : openToken;
    const index = buffer.toLowerCase().indexOf(token);

    if (index >= 0) {
      const fragment = buffer.slice(0, index);
      if (message.isThinking) {
        message.reasoning = `${message.reasoning ?? ''}${fragment}`;
      } else {
        message.content += fragment;
      }
      message.isThinking = !message.isThinking;
      buffer = buffer.slice(index + token.length);
      continue;
    }

    const keepLength = getTrailingTokenPrefixLength(buffer, token);
    const fragment = buffer.slice(0, buffer.length - keepLength);
    message.pendingThoughtToken = buffer.slice(buffer.length - keepLength);

    if (message.isThinking) {
      message.reasoning = `${message.reasoning ?? ''}${fragment}`;
    } else {
      message.content += fragment;
    }
    break;
  }
}

function flushPendingThoughtToken(message: UiMessage) {
  if (!message.pendingThoughtToken) return;

  if (message.isThinking) {
    message.reasoning = `${message.reasoning ?? ''}${message.pendingThoughtToken}`;
  } else {
    message.content += message.pendingThoughtToken;
  }

  message.pendingThoughtToken = '';
}

function finishSessionStream(streamId: string) {
  const route = getStreamRoute(streamId);
  if (!route) return null;

  const streamState = sessionStreams.value[route.sessionId];
  if (streamState?.streamId === streamId || streamState?.assistantMessageId === route.assistantMessageId) {
    patchSessionStream(route.sessionId, null);
  }
  streamRoutes.delete(streamId);
  return route;
}

let offDelta: (() => void) | null = null;
let offEnd: (() => void) | null = null;
let offError: (() => void) | null = null;
let offMcpTools: (() => void) | null = null;
let disposeOverlayScrollbars: (() => void) | null = null;

onMounted(async () => {
  disposeOverlayScrollbars = installOverlayScrollbars();
  resizeComposerInput();
  window.addEventListener('resize', resizeComposerInput);
  window.addEventListener('keydown', focusComposerForTyping, true);
  window.addEventListener('pointerdown', handleGlobalPointerDown, true);

  try {
    await settings.load();
    offMcpTools = settings.subscribeMcpToolUpdates();
  } catch (error) {
    initialMessages.value = [
      ...initialMessages.value,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `启动配置加载失败：${error instanceof Error ? error.message : String(error)}`,
        transient: true,
        createdAt: new Date().toISOString()
      }
    ];
  }

  await loadSessions();

  offDelta = window.littleSecretary.chat.onDelta((payload) => {
    const route = getStreamRoute(payload.streamId);
    if (!route) return;
    const target = findMessageInSession(route.sessionId, route.assistantMessageId);
    if (!target) return;

    if (payload.type === 'reasoning') {
      target.reasoning = `${target.reasoning ?? ''}${payload.text}`;
    } else {
      appendThoughtAwareContent(target, payload.text);
    }
    if (shouldScrollForSession(route.sessionId)) scrollToBottom();
  });

  offEnd = window.littleSecretary.chat.onEnd((payload) => {
    const route = finishSessionStream(payload.streamId);
    if (!route) return;
    const target = findMessageInSession(route.sessionId, route.assistantMessageId);
    if (target) flushPendingThoughtToken(target);
    saveSessionQuietly(route.sessionId);
    if (shouldScrollForSession(route.sessionId)) scrollToBottom();
  });

  offError = window.littleSecretary.chat.onError((payload) => {
    const route = finishSessionStream(payload.streamId);
    if (!route) return;
    const target = findMessageInSession(route.sessionId, route.assistantMessageId);
    if (target) target.content = `请求失败：${payload.message}`;
    saveSessionQuietly(route.sessionId);
    if (shouldScrollForSession(route.sessionId)) scrollToBottom();
  });
});

onBeforeUnmount(() => {
  saveCurrentSessionQuietly();
  window.removeEventListener('resize', resizeComposerInput);
  window.removeEventListener('keydown', focusComposerForTyping, true);
  window.removeEventListener('pointerdown', handleGlobalPointerDown, true);
  for (const streamId of streamRoutes.keys()) {
    void window.littleSecretary.chat.stopStream(streamId);
  }
  offDelta?.();
  offEnd?.();
  offError?.();
  offMcpTools?.();
  disposeOverlayScrollbars?.();
});
</script>
