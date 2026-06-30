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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

marked.use({
  renderer: {
    code({ text, lang }) {
      const requestedLanguage = lang?.trim().toLowerCase();
      const language = requestedLanguage && hljs.getLanguage(requestedLanguage) ? requestedLanguage : 'plaintext';
      const highlighted =
        language === 'plaintext' ? escapeHtml(text) : hljs.highlight(text, { language, ignoreIllegals: true }).value;
      return `<pre class="code-block"><code class="hljs language-${language}">${highlighted}</code></pre>`;
    }
  }
});

export function renderMarkdown(content: string) {
  let html: string;
  try {
    html = marked.parse(content) as string;
  } catch (error) {
    console.error('Markdown render failed:', error);
    html = `<pre class="code-block"><code class="hljs language-plaintext">${escapeHtml(content)}</code></pre>`;
  }

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
  pending?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createChartPlaceholder(index: number, hasError = false) {
  const className = hasError ? 'chart-placeholder render-error' : 'chart-placeholder';
  return `<div class="${className}" data-chart-index="${index}"></div>`;
}

function parseChartBlock(raw: string): ExtractedChartBlock {
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    return isRecord(parsed)
      ? (parsed as ExtractedChartBlock)
      : {
          error: 'chart 代码块必须是 Chart.js JSON 对象。'
        };
  } catch (error) {
    return {
      error: `图表 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function parseTrailingChartBlock(raw: string): ExtractedChartBlock {
  const trimmed = raw.trim();
  if (!trimmed) return { pending: true };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? (parsed as ExtractedChartBlock) : { pending: true };
  } catch {
    return { pending: true };
  }
}

function looksLikeChartConfig(raw: string) {
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    return isRecord(parsed) && typeof parsed.type === 'string' && 'data' in parsed ? (parsed as ExtractedChartBlock) : null;
  } catch {
    return null;
  }
}

export function extractChartBlocks(content: string) {
  const blocks: ExtractedChartBlock[] = [];
  const pushChartBlock = (block: ExtractedChartBlock) => {
    blocks.push(block);
    return createChartPlaceholder(blocks.length - 1, Boolean(block.error));
  };

  const withChartFences = content.replace(/```(?:chart|chartjs|chart\.js)\s*([\s\S]*?)```/gi, (_match, raw) =>
    pushChartBlock(parseChartBlock(raw))
  );

  const withJsonChartFences = withChartFences.replace(/```json\s*([\s\S]*?)```/gi, (match, raw) => {
    const chartConfig = looksLikeChartConfig(raw);
    return chartConfig ? pushChartBlock(chartConfig) : match;
  });

  const normalized = withJsonChartFences.replace(/```(?:chart|chartjs|chart\.js)\s*([\s\S]*)$/i, (_match, raw) =>
    pushChartBlock(parseTrailingChartBlock(raw))
  );

  return { normalized, blocks };
}
