<template>
  <main :class="['app-shell', { 'sessions-open': sessionPanelOpen }]">
    <aside
      class="session-sidebar"
      aria-label="会话列表"
      @mouseenter="sessionPanelOpen = true"
      @mouseleave="sessionPanelOpen = false"
    >
      <div class="session-hover-zone" aria-hidden="true"></div>
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
            :class="['session-item', { active: session.id === sessionId }]"
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
                <span class="session-item-count">{{ formatMessageCount(session.messageCount) }}</span>
              </span>
            </button>
            <button
              v-motion="'buttonDanger'"
              v-ripple
              class="danger-icon-button session-delete"
              type="button"
              aria-label="删除会话"
              title="删除会话"
              :disabled="sessionControlDisabled"
              @click="askDeleteSession(session.id)"
            >
              <Trash2 :size="15" />
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
            :content="message.content || (message.role === 'assistant' && message.id !== streamingMessageId ? '...' : '')"
            :streaming="message.id === streamingMessageId"
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
              @input="resizeComposerInput"
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
              :disabled="isStreaming || sessionsLoading || !input.trim()"
            >
              <SendHorizontal :size="18" />
            </button>
          </div>
        </div>
      </form>
    </section>

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

interface UiMessage extends ChatMessage {
  id: string;
  reasoning?: string;
  isThinking?: boolean;
  pendingThoughtToken?: string;
  transient?: boolean;
  createdAt?: string;
}

const settings = useSettingsStore();
const toast = useToastStore();
const settingsOpen = ref(false);
const input = ref('');
const isStreaming = ref(false);
const sessionsLoading = ref(true);
const sessionOperationPending = ref(false);
const sessionPanelOpen = ref(false);
const currentStreamId = ref<string | null>(null);
const streamingMessageId = ref<string | null>(null);
const sessionId = ref('');
const sessionSummaries = ref<SessionSummary[]>([]);
const deleteCandidateId = ref<string | null>(null);
const scrollEl = ref<HTMLElement | null>(null);
const composerInputEl = ref<HTMLTextAreaElement | null>(null);
const messages = ref<UiMessage[]>([createStarterMessage()]);

const visibleMessages = computed(() => messages.value.filter((message) => message.role !== 'system'));
const activeSession = computed(() => sessionSummaries.value.find((session) => session.id === sessionId.value));
const activeSessionTitle = computed(() => activeSession.value?.title || '新的会话');
const activeSessionSubtitle = computed(() => {
  const session = activeSession.value;
  if (!session) return '';
  return `${formatSessionTime(session.lastMessageAt)} · ${formatMessageCount(session.messageCount)}`;
});
const deleteCandidate = computed(() => sessionSummaries.value.find((session) => session.id === deleteCandidateId.value) ?? null);
const sessionControlDisabled = computed(() => isStreaming.value || sessionsLoading.value || sessionOperationPending.value);

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
    element.style.overflowY = element.scrollHeight > nextHeight ? 'auto' : 'hidden';
  });
}

function focusComposer() {
  composerInputEl.value?.focus();
}

function shouldFocusComposer(event: KeyboardEvent) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (settingsOpen.value || deleteCandidateId.value || sessionOperationPending.value) return false;
  if (event.key.length !== 1) return false;

  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  if (target === composerInputEl.value) return false;

  return !target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="button"]');
}

function focusComposerForTyping(event: KeyboardEvent) {
  if (!shouldFocusComposer(event)) return;
  composerInputEl.value?.focus();
}

function toModelMessages(): ChatMessage[] {
  return messages.value
    .filter((message) => message.content.trim() && !message.transient)
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
}

function toStoredMessages(): StoredChatMessage[] {
  return messages.value
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
  messages.value =
    session.messages.length > 0
      ? session.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          reasoning: message.reasoning,
          createdAt: message.createdAt
        }))
      : [createStarterMessage()];
  input.value = '';
  currentStreamId.value = null;
  streamingMessageId.value = null;
  isStreaming.value = false;
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
  return result.session.id;
}

async function saveCurrentSession(options: { activate?: boolean } = {}) {
  const activeId = sessionId.value;
  if (!activeId) return null;

  const result = await window.littleSecretary.sessions.save({
    id: activeId,
    messages: toStoredMessages(),
    activate: options.activate
  });
  const stillActive = result.currentSessionId === sessionId.value || result.session.id === sessionId.value;
  if (stillActive || options.activate) {
    updateSessionSummaries(result.sessions, result.currentSessionId);
  } else {
    sessionSummaries.value = result.sessions;
  }
  return result.session;
}

async function createSession() {
  if (sessionControlDisabled.value) return;
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
  sessionOperationPending.value = true;
  try {
    await saveCurrentSession();
    const result = await window.littleSecretary.sessions.switch(targetSessionId);
    updateSessionSummaries(result.sessions, result.currentSessionId);
    applySession(result.session);
  } catch (error) {
    toast.show(`切换会话失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    sessionOperationPending.value = false;
  }
}

function askDeleteSession(targetSessionId: string) {
  if (sessionControlDisabled.value) return;
  deleteCandidateId.value = targetSessionId;
}

async function confirmDeleteSession() {
  const targetSessionId = deleteCandidateId.value;
  if (!targetSessionId || sessionOperationPending.value) return;

  const deletingCurrentSession = targetSessionId === sessionId.value;
  sessionOperationPending.value = true;
  try {
    if (!deletingCurrentSession) {
      await saveCurrentSession();
    }

    const result = await window.littleSecretary.sessions.delete(targetSessionId);
    updateSessionSummaries(result.sessions, result.currentSessionId);
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

function saveCurrentSessionQuietly() {
  void saveCurrentSession({ activate: false }).catch((error) => {
    toast.show(`会话保存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  });
}

async function sendMessage() {
  const content = input.value.trim();
  if (!content || isStreaming.value || sessionsLoading.value) return;

  try {
    await ensureActiveSession();
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

  messages.value.push(userMessage, assistantMessage);
  input.value = '';
  resizeComposerInput();
  isStreaming.value = true;
  streamingMessageId.value = assistantMessage.id;
  scrollToBottom();

  try {
    await saveCurrentSession({ activate: true });
    const localResult = await runLocalCommand(content);
    if (localResult.handled) {
      assistantMessage.content = localResult.content;
      isStreaming.value = false;
      streamingMessageId.value = null;
      await saveCurrentSession();
      scrollToBottom();
      return;
    }

    const streamId = await window.littleSecretary.chat.startStream({
      messages: toModelMessages(),
      systemPrompt: settings.appSettings.systemPrompt,
      sessionId: sessionId.value
    });
    currentStreamId.value = streamId;
  } catch (error) {
    assistantMessage.content = error instanceof Error ? error.message : String(error);
    isStreaming.value = false;
    streamingMessageId.value = null;
    await saveCurrentSession();
  }
}

function findStreamingMessage() {
  return (
    messages.value.find((message) => message.id === streamingMessageId.value) ??
    [...messages.value].reverse().find((message) => message.role === 'assistant')
  );
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

function isActiveStreamPayload(streamId: string) {
  return currentStreamId.value ? streamId === currentStreamId.value : isStreaming.value;
}

let offDelta: (() => void) | null = null;
let offEnd: (() => void) | null = null;
let offError: (() => void) | null = null;
let offMcpTools: (() => void) | null = null;

onMounted(async () => {
  resizeComposerInput();
  window.addEventListener('resize', resizeComposerInput);
  window.addEventListener('keydown', focusComposerForTyping, true);

  try {
    await settings.load();
    offMcpTools = settings.subscribeMcpToolUpdates();
  } catch (error) {
    messages.value.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `启动配置加载失败：${error instanceof Error ? error.message : String(error)}`,
      transient: true,
      createdAt: new Date().toISOString()
    });
  }

  await loadSessions();

  offDelta = window.littleSecretary.chat.onDelta((payload) => {
    if (!isActiveStreamPayload(payload.streamId)) return;
    const target = findStreamingMessage();
    if (!target) return;

    if (payload.type === 'reasoning') {
      target.reasoning = `${target.reasoning ?? ''}${payload.text}`;
    } else {
      appendThoughtAwareContent(target, payload.text);
    }
    scrollToBottom();
  });

  offEnd = window.littleSecretary.chat.onEnd((payload) => {
    if (!isActiveStreamPayload(payload.streamId)) return;
    const target = findStreamingMessage();
    if (target) flushPendingThoughtToken(target);
    currentStreamId.value = null;
    isStreaming.value = false;
    streamingMessageId.value = null;
    saveCurrentSessionQuietly();
    scrollToBottom();
  });

  offError = window.littleSecretary.chat.onError((payload) => {
    if (!isActiveStreamPayload(payload.streamId)) return;
    const target = findStreamingMessage();
    if (target) target.content = `请求失败：${payload.message}`;
    currentStreamId.value = null;
    isStreaming.value = false;
    streamingMessageId.value = null;
    saveCurrentSessionQuietly();
    scrollToBottom();
  });
});

onBeforeUnmount(() => {
  saveCurrentSessionQuietly();
  window.removeEventListener('resize', resizeComposerInput);
  window.removeEventListener('keydown', focusComposerForTyping, true);
  if (currentStreamId.value) {
    void window.littleSecretary.chat.stopStream(currentStreamId.value);
  }
  offDelta?.();
  offEnd?.();
  offError?.();
  offMcpTools?.();
});
</script>
