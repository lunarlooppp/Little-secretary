import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer', import.meta.url))
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/chart.js')) return 'chart';
          if (id.includes('node_modules/mermaid') || id.includes('node_modules/d3') || id.includes('node_modules/cytoscape')) {
            return 'diagram';
          }
          if (id.includes('node_modules/highlight.js')) return 'highlight';
          if (id.includes('node_modules/marked') || id.includes('node_modules/dompurify')) return 'markdown';
          if (id.includes('node_modules/vue') || id.includes('node_modules/pinia')) return 'vue';
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
