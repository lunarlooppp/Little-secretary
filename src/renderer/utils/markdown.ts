import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import javascript from 'highlight.js/lib/languages/javascript';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import { Marked } from 'marked';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('ps1', powershell);
hljs.registerLanguage('svg', xml);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('vue', xml);

const marked = new Marked({
  async: false,
  gfm: true,
  breaks: true
});

marked.use({
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      const highlighted = hljs.highlight(text, { language }).value;
      return `<pre class="code-block"><code class="hljs language-${language}">${highlighted}</code></pre>`;
    }
  }
});

export function renderMarkdown(content: string) {
  const html = marked.parse(content) as string;
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['canvas'],
    ADD_ATTR: ['data-chart', 'data-mermaid', 'target']
  });
}

export function extractMermaidBlocks(content: string) {
  const blocks: string[] = [];
  const normalized = content.replace(/```mermaid\s*([\s\S]*?)```/gi, (_match, graph) => {
    blocks.push(graph.trim());
    return `<div class="mermaid-placeholder" data-mermaid-index="${blocks.length - 1}"></div>`;
  });

  return { normalized, blocks };
}

export interface ExtractedChartBlock {
  type?: string;
  data?: unknown;
  options?: unknown;
  error?: string;
}

export function extractChartBlocks(content: string) {
  const blocks: ExtractedChartBlock[] = [];
  const normalized = content.replace(/```chart\s*([\s\S]*?)```/gi, (_match, raw) => {
    try {
      const parsed = JSON.parse(raw.trim()) as ExtractedChartBlock;
      blocks.push(
        parsed && typeof parsed === 'object'
          ? parsed
          : {
              error: 'chart 代码块必须是 Chart.js JSON 对象。'
            }
      );
      return `<div class="chart-placeholder" data-chart-index="${blocks.length - 1}"></div>`;
    } catch (error) {
      blocks.push({
        error: `图表 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`
      });
      return `<div class="chart-placeholder render-error" data-chart-index="${blocks.length - 1}"></div>`;
    }
  });

  return { normalized, blocks };
}
