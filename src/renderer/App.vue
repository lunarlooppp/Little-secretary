<template>
  <main :class="['app-shell', { 'sessions-open': sessionPanelOpen }]">
    <aside
      class="session-sidebar"
      aria-label="会话列表"
    >
      <div class="session-hover-zone" aria-hidden="true" @mouseenter="openSessionPanel"></div>

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

    <section ref="chatAreaEl" class="chat-area" :style="chatAreaStyle">
      <header ref="topbarEl" :class="['topbar', { opaque: headerOpaque }]">
        <div ref="titleStackEl" class="title-stack">
          <h1>{{ activeSessionTitle }}</h1>
          <span v-if="activeSessionSubtitle">{{ activeSessionSubtitle }}</span>
        </div>
        <div class="topbar-actions">
          <button
            v-motion="'button'"
            v-ripple
            class="icon-button theme-toggle-button"
            type="button"
            :aria-label="themeToggleLabel"
            :title="themeToggleLabel"
            :disabled="!settings.loaded"
            @click="toggleThemeMode"
          >
            <Sun v-if="settings.appSettings.themeMode === 'night'" :size="18" />
            <Moon v-else :size="18" />
          </button>
          <button
            v-motion="'button'"
            v-ripple
            class="icon-button"
            type="button"
            aria-label="打开设置"
            title="打开设置"
            @click="settingsOpen = true"
          >
            <Settings :size="18" />
          </button>
        </div>
      </header>

      <section ref="scrollEl" class="chat-scroll" aria-live="polite" @scroll.passive="handleChatScroll">
        <div v-if="hiddenMessageCount > 0" class="message-history-control">
          <button type="button" class="secondary-button" @click="loadEarlierMessages">
            显示更早的 {{ Math.min(MESSAGE_RENDER_BATCH, hiddenMessageCount) }} 条消息
          </button>
          <span>还有 {{ hiddenMessageCount }} 条未渲染</span>
        </div>
        <article
          v-for="message in renderedMessages"
          :key="message.id"
          :class="['message', message.role]"
          :data-message-id="message.id"
        >
          <section
            v-if="message.reasoning"
            :class="['reasoning', { open: isReasoningOpen(message.id) }]"
            aria-label="思考内容"
          >
            <button
              v-ripple
              class="reasoning-toggle"
              type="button"
              :aria-expanded="isReasoningOpen(message.id)"
              @click="toggleReasoning(message.id)"
            >
              <ChevronRight :size="15" class="reasoning-toggle-icon" aria-hidden="true" />
              <span>思考内容</span>
            </button>
            <div v-if="isReasoningOpen(message.id)" class="reasoning-body">
              <MessageContent
                :content="message.reasoning"
                :streaming="message.id === activeStreamingMessageId"
              />
            </div>
          </section>
          <MessageContent
            :content="message.content || (message.role === 'assistant' && message.id !== activeStreamingMessageId ? '...' : '')"
            :streaming="message.id === activeStreamingMessageId"
          />
        </article>
      </section>

      <Transition name="fade">
        <div v-if="showScrollToBottom" class="scroll-bottom-layer">
          <button
            v-motion="'button'"
            v-ripple
            class="scroll-bottom-button"
            type="button"
            aria-label="回到底部"
            title="回到底部"
            @click="handleScrollToBottomClick"
          >
            <ArrowDownToLine :size="15" />
          </button>
        </div>
      </Transition>

      <form ref="composerEl" class="composer" @submit.prevent="sendMessage">
        <div class="composer-surface" @pointerdown.self="focusComposer">
          <div class="composer-input-region" @pointerdown.self="focusComposer">
            <textarea
              ref="composerInputEl"
              v-model="input"
              class="composer-input"
              rows="1"
              spellcheck="false"
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
import { ArrowDownToLine, ChevronRight, Moon, Plus, SendHorizontal, Settings, Sun, Trash2, X } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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

interface PendingStreamDelta {
  chunks: Array<{ type: 'content' | 'reasoning'; text: string }>;
}

interface ScrollAnchor {
  messageId: string;
  offset: number;
  path: number[];
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
const chatAreaEl = ref<HTMLElement | null>(null);
const topbarEl = ref<HTMLElement | null>(null);
const titleStackEl = ref<HTMLElement | null>(null);
const composerEl = ref<HTMLElement | null>(null);
const composerInputEl = ref<HTMLTextAreaElement | null>(null);
const composerHeight = ref(0);
const stickToBottom = ref(true);
const showScrollToBottom = ref(false);
const headerOpaque = ref(false);
const openReasoningMessages = ref<Set<string>>(new Set());
const sessionMessages = ref<Record<string, UiMessage[]>>({});
const sessionStreams = ref<Record<string, SessionStreamState>>({});
const streamRoutes = new Map<string, StreamRoute>();
const pendingStreamDeltas = new Map<string, PendingStreamDelta>();
const initialMessages = ref<UiMessage[]>([createStarterMessage()]);
const MESSAGE_RENDER_BATCH = 50;
const renderedMessageLimit = ref(MESSAGE_RENDER_BATCH);

const messages = computed(() => (sessionId.value ? (sessionMessages.value[sessionId.value] ?? initialMessages.value) : initialMessages.value));
const visibleMessages = computed(() => messages.value.filter((message) => message.role !== 'system'));
const hiddenMessageCount = computed(() => Math.max(0, visibleMessages.value.length - renderedMessageLimit.value));
const renderedMessages = computed(() => visibleMessages.value.slice(-renderedMessageLimit.value));
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
const chatAreaStyle = computed(() => ({
  '--composer-height': `${Math.max(0, composerHeight.value)}px`
}));
const themeToggleLabel = computed(() => (settings.appSettings.themeMode === 'night' ? '切换到白天模式' : '切换到黑夜模式'));

function createStarterMessage(): UiMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '准备好了。',
    transient: true,
    createdAt: new Date().toISOString()
  };
}

function getDistanceFromBottom() {
  const element = scrollEl.value;
  if (!element) return 0;
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function isNearBottom(threshold = 72) {
  return getDistanceFromBottom() <= threshold;
}

let lastScrollAnchor: ScrollAnchor | null = null;
let layoutRestoreFrame = 0;
let headerOverlapFrame = 0;
let layoutResizeObserver: ResizeObserver | null = null;
let messageMutationObserver: MutationObserver | null = null;

function syncScrollState() {
  const nearBottom = isNearBottom();
  stickToBottom.value = nearBottom;
  showScrollToBottom.value = !nearBottom;
  lastScrollAnchor = nearBottom ? null : getScrollAnchor();
  scheduleHeaderOverlapCheck();
}

function handleChatScroll() {
  syncScrollState();
}

function updateHeaderOverlapState() {
  headerOverlapFrame = 0;
  const titleElement = titleStackEl.value;
  const scrollElement = scrollEl.value;
  if (!titleElement || !scrollElement) {
    headerOpaque.value = false;
    return;
  }

  const titleRect = titleElement.getBoundingClientRect();
  const samplePoints = [
    [titleRect.left + 1, titleRect.top + 1],
    [titleRect.right - 1, titleRect.top + 1],
    [titleRect.left + titleRect.width / 2, titleRect.top + titleRect.height / 2],
    [titleRect.left + 1, titleRect.bottom - 1],
    [titleRect.right - 1, titleRect.bottom - 1]
  ];
  const overlapsMessage = samplePoints.some(([x, y]) =>
    document.elementsFromPoint(x, y).some((element) => {
      const message = element.closest('.message');
      return Boolean(message && scrollElement.contains(message));
    })
  );

  headerOpaque.value = overlapsMessage;
}

function scheduleHeaderOverlapCheck() {
  if (headerOverlapFrame) return;
  headerOverlapFrame = window.requestAnimationFrame(updateHeaderOverlapState);
}

function setScrollToBottom(behavior: ScrollBehavior = 'auto') {
  const element = scrollEl.value;
  if (!element) return;
  element.scrollTo({
    top: element.scrollHeight,
    behavior
  });
  if (behavior === 'auto') syncScrollState();
}

function scrollToBottom(behavior: ScrollBehavior = 'auto') {
  void nextTick(() => {
    setScrollToBottom(behavior);
  });
}

function getOpenReasoningBody(messageId: string) {
  const element = scrollEl.value;
  if (!element) return null;
  return element.querySelector<HTMLElement>(
    `.message[data-message-id="${CSS.escape(messageId)}"] .reasoning.open .reasoning-body`
  );
}

function setReasoningScrollToBottom(messageId: string) {
  const reasoningBody = getOpenReasoningBody(messageId);
  if (!reasoningBody) return;
  reasoningBody.scrollTop = reasoningBody.scrollHeight;
}

function scrollReasoningToBottom(messageId: string) {
  void nextTick(() => {
    setReasoningScrollToBottom(messageId);
    window.requestAnimationFrame(() => setReasoningScrollToBottom(messageId));
  });
}

function handleScrollToBottomClick() {
  stickToBottom.value = true;
  scrollToBottom('smooth');
}

async function loadEarlierMessages() {
  const element = scrollEl.value;
  if (!element || hiddenMessageCount.value <= 0) return;

  const previousHeight = element.scrollHeight;
  const previousTop = element.scrollTop;
  renderedMessageLimit.value += MESSAGE_RENDER_BATCH;
  await nextTick();
  element.scrollTop = previousTop + element.scrollHeight - previousHeight;
  syncScrollState();
}

async function toggleThemeMode() {
  try {
    await settings.toggleThemeMode();
  } catch (error) {
    toast.show(`主题切换失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function isReasoningOpen(messageId: string) {
  return openReasoningMessages.value.has(messageId);
}

function toggleReasoning(messageId: string) {
  const next = new Set(openReasoningMessages.value);
  const shouldOpen = !next.has(messageId);
  if (shouldOpen) {
    next.add(messageId);
  } else {
    next.delete(messageId);
  }
  openReasoningMessages.value = next;
  if (shouldOpen) scrollReasoningToBottom(messageId);
  scheduleHeaderOverlapCheck();
}

function getElementPath(root: HTMLElement, target: HTMLElement) {
  const path: number[] = [];
  let current: HTMLElement | null = target;

  while (current && current !== root) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) return [];
    path.unshift(Array.from(parent.children).indexOf(current));
    current = parent;
  }

  return current === root ? path : [];
}

function resolveElementPath(root: HTMLElement, path: number[]) {
  let current: Element = root;

  for (const index of path) {
    const next = current.children.item(index);
    if (!(next instanceof HTMLElement)) return root;
    current = next;
  }

  return current instanceof HTMLElement ? current : root;
}

function getAnchorTarget(message: HTMLElement, containerTop: number, containerBottom: number) {
  const candidates = [
    ...message.querySelectorAll<HTMLElement>(
      '.reasoning, .message-render > p, .message-render > ul, .message-render > ol, .message-render > blockquote, .message-render > pre, .message-render > table, .message-render > .chart-placeholder, .message-render > .mermaid-placeholder'
    ),
    message
  ];
  let fallback: HTMLElement | null = null;

  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect();
    if (rect.bottom < containerTop || rect.top > containerBottom) continue;
    if (!fallback && rect.bottom >= containerTop) fallback = candidate;
    if (rect.top >= containerTop) return candidate;
  }

  return fallback ?? message;
}

function getScrollAnchor(): ScrollAnchor | null {
  const element = scrollEl.value;
  if (!element) return null;

  const containerRect = element.getBoundingClientRect();
  const containerTop = containerRect.top;
  const containerBottom = containerRect.bottom;
  const messages = Array.from(element.querySelectorAll<HTMLElement>('.message[data-message-id]'));

  for (const message of messages) {
    const messageId = message.dataset.messageId;
    if (!messageId) continue;

    const rect = message.getBoundingClientRect();
    if (rect.bottom < containerTop) continue;
    if (rect.top > containerBottom) break;

    const target = getAnchorTarget(message, containerTop, containerBottom);
    const offset = target.getBoundingClientRect().top - containerTop;
    return {
      messageId,
      offset,
      path: getElementPath(message, target)
    };
  }

  return null;
}

function restoreScrollAnchor(anchor: ScrollAnchor | null) {
  const element = scrollEl.value;
  if (!element || !anchor) return;

  const target = element.querySelector<HTMLElement>(`.message[data-message-id="${CSS.escape(anchor.messageId)}"]`);
  if (!target) return;

  const containerTop = element.getBoundingClientRect().top;
  const anchorTarget = resolveElementPath(target, anchor.path);
  const nextOffset = anchorTarget.getBoundingClientRect().top - containerTop;
  element.scrollTop += nextOffset - anchor.offset;
  syncScrollState();
}

function updateLayoutMetrics() {
  composerHeight.value = Math.round(composerEl.value?.getBoundingClientRect().height ?? 0);
}

function prepareForLayoutChange() {
  syncScrollState();
}

function scheduleLayoutScrollRestore() {
  updateLayoutMetrics();

  const shouldStickToBottom = stickToBottom.value;
  const anchor = shouldStickToBottom ? null : lastScrollAnchor;

  if (layoutRestoreFrame) {
    window.cancelAnimationFrame(layoutRestoreFrame);
  }

  layoutRestoreFrame = window.requestAnimationFrame(() => {
    layoutRestoreFrame = 0;
    updateLayoutMetrics();

    if (shouldStickToBottom) {
      setScrollToBottom();
      return;
    }

    restoreScrollAnchor(anchor);
  });
}

function handleObservedLayoutResize() {
  scheduleLayoutScrollRestore();
}

function getMaxComposerInputHeight() {
  const chatHeight = scrollEl.value?.clientHeight ?? window.innerHeight * 0.62;
  return Math.max(84, Math.floor(chatHeight * 0.5));
}

function resizeComposerInput() {
  const anchor = stickToBottom.value ? null : getScrollAnchor();

  void nextTick(() => {
    const element = composerInputEl.value;
    if (!element) return;

    element.style.height = 'auto';
    const nextHeight = Math.min(element.scrollHeight, getMaxComposerInputHeight());
    element.style.height = `${nextHeight}px`;
    element.style.overflowY = element.scrollHeight > nextHeight ? 'overlay' : 'hidden';

    void nextTick(() => {
      updateLayoutMetrics();
      if (stickToBottom.value) {
        setScrollToBottom();
        return;
      }
      restoreScrollAnchor(anchor);
    });
  });
}

function openSessionPanel() {
  prepareForLayoutChange();
  sessionPanelOpen.value = true;
}

function closeSessionPanel() {
  prepareForLayoutChange();
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
  renderedMessageLimit.value = MESSAGE_RENDER_BATCH;
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
      renderedMessageLimit.value = MESSAGE_RENDER_BATCH;
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

  if (hiddenMessageCount.value > 0) renderedMessageLimit.value += 2;
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
  return targetSessionId === sessionId.value && stickToBottom.value;
}

function isActiveOpenReasoningMessage(messageId: string, targetSessionId: string) {
  return targetSessionId === sessionId.value && openReasoningMessages.value.has(messageId);
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

function appendThoughtAwareContentAndDetectReasoning(message: UiMessage, text: string) {
  const previousReasoning = message.reasoning ?? '';
  appendThoughtAwareContent(message, text);
  return (message.reasoning ?? '') !== previousReasoning;
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

let streamFlushTimer = 0;

function getStreamFlushDelay() {
  const activeLength = messages.value.at(-1)?.content.length ?? 0;
  if (activeLength > 120_000) return 240;
  if (activeLength > 40_000) return 120;
  return 60;
}

function flushStreamDelta(streamId: string) {
  const pending = pendingStreamDeltas.get(streamId);
  pendingStreamDeltas.delete(streamId);
  if (!pending) return;

  const route = getStreamRoute(streamId);
  if (!route) return;
  const target = findMessageInSession(route.sessionId, route.assistantMessageId);
  if (!target) return;

  let reasoningChanged = false;
  for (const chunk of pending.chunks) {
    if (chunk.type === 'reasoning') {
      target.reasoning = `${target.reasoning ?? ''}${chunk.text}`;
      reasoningChanged = true;
    } else {
      reasoningChanged = appendThoughtAwareContentAndDetectReasoning(target, chunk.text) || reasoningChanged;
    }
  }

  if (reasoningChanged && isActiveOpenReasoningMessage(route.assistantMessageId, route.sessionId)) {
    scrollReasoningToBottom(route.assistantMessageId);
  }
  if (shouldScrollForSession(route.sessionId)) scrollToBottom();
}

function flushPendingStreamDeltas() {
  streamFlushTimer = 0;
  for (const streamId of [...pendingStreamDeltas.keys()]) flushStreamDelta(streamId);
}

function enqueueStreamDelta(streamId: string, type: 'content' | 'reasoning', chunk: string) {
  if (!chunk) return;
  const pending = pendingStreamDeltas.get(streamId) ?? { chunks: [] };
  const lastChunk = pending.chunks.at(-1);
  if (lastChunk?.type === type) {
    lastChunk.text += chunk;
  } else {
    pending.chunks.push({ type, text: chunk });
  }
  pendingStreamDeltas.set(streamId, pending);
  if (!streamFlushTimer) {
    streamFlushTimer = window.setTimeout(flushPendingStreamDeltas, getStreamFlushDelay());
  }
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

watch(sessionPanelOpen, () => {
  scheduleLayoutScrollRestore();
  scheduleHeaderOverlapCheck();
});

watch(visibleMessages, () => {
  scheduleHeaderOverlapCheck();
});

let offDelta: (() => void) | null = null;
let offEnd: (() => void) | null = null;
let offError: (() => void) | null = null;
let offMcpTools: (() => void) | null = null;
let offMcpServers: (() => void) | null = null;
let offSkills: (() => void) | null = null;
let disposeOverlayScrollbars: (() => void) | null = null;

onMounted(async () => {
  disposeOverlayScrollbars = installOverlayScrollbars();
  resizeComposerInput();
  updateLayoutMetrics();
  syncScrollState();
  scheduleHeaderOverlapCheck();
  layoutResizeObserver = new ResizeObserver(handleObservedLayoutResize);
  if (chatAreaEl.value) layoutResizeObserver.observe(chatAreaEl.value);
  if (scrollEl.value) layoutResizeObserver.observe(scrollEl.value);
  if (topbarEl.value) layoutResizeObserver.observe(topbarEl.value);
  if (titleStackEl.value) layoutResizeObserver.observe(titleStackEl.value);
  if (composerEl.value) layoutResizeObserver.observe(composerEl.value);
  messageMutationObserver = new MutationObserver(() => {
    scheduleHeaderOverlapCheck();
    if (stickToBottom.value) setScrollToBottom();
  });
  if (scrollEl.value) {
    messageMutationObserver.observe(scrollEl.value, {
      childList: true,
      subtree: true
    });
  }
  window.addEventListener('resize', prepareForLayoutChange);
  window.addEventListener('resize', resizeComposerInput);
  window.addEventListener('resize', scheduleHeaderOverlapCheck);
  window.addEventListener('keydown', focusComposerForTyping, true);
  window.addEventListener('pointerdown', handleGlobalPointerDown, true);

  try {
    await settings.load();
    offMcpTools = settings.subscribeMcpToolUpdates();
    offMcpServers = settings.subscribeMcpServerUpdates();
    offSkills = settings.subscribeSkillUpdates();
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
    if (!getStreamRoute(payload.streamId)) return;
    enqueueStreamDelta(payload.streamId, payload.type, payload.text);
  });

  offEnd = window.littleSecretary.chat.onEnd((payload) => {
    flushStreamDelta(payload.streamId);
    const route = finishSessionStream(payload.streamId);
    if (!route) return;
    const target = findMessageInSession(route.sessionId, route.assistantMessageId);
    if (target) flushPendingThoughtToken(target);
    saveSessionQuietly(route.sessionId);
    if (shouldScrollForSession(route.sessionId)) scrollToBottom();
  });

  offError = window.littleSecretary.chat.onError((payload) => {
    pendingStreamDeltas.delete(payload.streamId);
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
  if (layoutRestoreFrame) {
    window.cancelAnimationFrame(layoutRestoreFrame);
    layoutRestoreFrame = 0;
  }
  if (headerOverlapFrame) {
    window.cancelAnimationFrame(headerOverlapFrame);
    headerOverlapFrame = 0;
  }
  if (streamFlushTimer) {
    window.clearTimeout(streamFlushTimer);
    streamFlushTimer = 0;
  }
  pendingStreamDeltas.clear();
  layoutResizeObserver?.disconnect();
  messageMutationObserver?.disconnect();
  window.removeEventListener('resize', prepareForLayoutChange);
  window.removeEventListener('resize', resizeComposerInput);
  window.removeEventListener('resize', scheduleHeaderOverlapCheck);
  window.removeEventListener('keydown', focusComposerForTyping, true);
  window.removeEventListener('pointerdown', handleGlobalPointerDown, true);
  for (const streamId of streamRoutes.keys()) {
    void window.littleSecretary.chat.stopStream(streamId);
  }
  offDelta?.();
  offEnd?.();
  offError?.();
  offMcpTools?.();
  offMcpServers?.();
  offSkills?.();
  disposeOverlayScrollbars?.();
});
</script>
