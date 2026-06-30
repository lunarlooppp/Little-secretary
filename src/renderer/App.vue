<template>
  <main class="app-shell">
    <header class="topbar">
      <h1>总结标题</h1>
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
        <MessageContent :content="message.content || (message.role === 'assistant' ? '...' : '')" />
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
            :disabled="isStreaming || !input.trim()"
          >
            <SendHorizontal :size="18" />
          </button>
        </div>
      </div>
    </form>

    <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" />
    <ToastHost />
  </main>
</template>

<script setup lang="ts">
import { SendHorizontal, Settings } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import MessageContent from './components/MessageContent.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import ToastHost from './components/ToastHost.vue';
import { useSettingsStore } from './stores/settings';
import type { ChatMessage } from './env';
import { runLocalCommand } from './utils/localCommands';

interface UiMessage extends ChatMessage {
  id: string;
  reasoning?: string;
  isThinking?: boolean;
  pendingThoughtToken?: string;
  transient?: boolean;
}

const settings = useSettingsStore();
const settingsOpen = ref(false);
const input = ref('');
const isStreaming = ref(false);
const currentStreamId = ref<string | null>(null);
const sessionId = ref(crypto.randomUUID());
const scrollEl = ref<HTMLElement | null>(null);
const composerInputEl = ref<HTMLTextAreaElement | null>(null);
const messages = ref<UiMessage[]>([
  {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '准备好了。',
    transient: true
  }
]);

const visibleMessages = computed(() => messages.value.filter((message) => message.role !== 'system'));

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
  if (settingsOpen.value) return false;
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

async function sendMessage() {
  const content = input.value.trim();
  if (!content || isStreaming.value) return;

  const userMessage: UiMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content
  };
  const assistantMessage: UiMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    reasoning: ''
  };

  messages.value.push(userMessage, assistantMessage);
  input.value = '';
  resizeComposerInput();
  isStreaming.value = true;
  scrollToBottom();

  try {
    const localResult = await runLocalCommand(content);
    if (localResult.handled) {
      assistantMessage.content = localResult.content;
      isStreaming.value = false;
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
  }
}

function findStreamingMessage() {
  return [...messages.value].reverse().find((message) => message.role === 'assistant');
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
      transient: true
    });
  }

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
    scrollToBottom();
  });

  offError = window.littleSecretary.chat.onError((payload) => {
    if (!isActiveStreamPayload(payload.streamId)) return;
    const target = findStreamingMessage();
    if (target) target.content = `请求失败：${payload.message}`;
    currentStreamId.value = null;
    isStreaming.value = false;
    scrollToBottom();
  });
});

onBeforeUnmount(() => {
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
