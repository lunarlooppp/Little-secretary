import { defineStore } from 'pinia';

export interface ToastMessage {
  id: string;
  text: string;
  type: 'success' | 'error';
}

export const useToastStore = defineStore('toast', {
  state: () => ({
    messages: [] as ToastMessage[]
  }),
  actions: {
    show(text: string, type: ToastMessage['type'] = 'success') {
      const id = crypto.randomUUID();
      this.messages.push({ id, text, type });
      const duration = type === 'error' ? 7000 : 2400;
      window.setTimeout(() => this.dismiss(id), duration);
    },
    dismiss(id: string) {
      this.messages = this.messages.filter((message) => message.id !== id);
    }
  }
});
