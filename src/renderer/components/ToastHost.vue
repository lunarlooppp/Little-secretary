<template>
  <Teleport to="body">
    <TransitionGroup name="toast" tag="div" class="toast-host" aria-live="polite" aria-atomic="true">
      <div v-for="message in toast.messages" :key="message.id" :class="['toast-card', message.type]">
        <CheckCircle2 v-if="message.type === 'success'" :size="17" />
        <CircleAlert v-else :size="17" />
        <span>{{ message.text }}</span>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script setup lang="ts">
import { CheckCircle2, CircleAlert } from 'lucide-vue-next';
import { useToastStore } from '../stores/toast';

const toast = useToastStore();
</script>
