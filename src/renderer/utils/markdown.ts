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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createMarkdownRenderer(highlightCode: boolean) {
  const renderer = new Marked({
    async: false,
    gfm: true,
    breaks: true
  });

  renderer.use({
    renderer: {
      code({ text, lang }) {
        const requestedLanguage = lang?.trim().toLowerCase();
        const language = requestedLanguage && hljs.getLanguage(requestedLanguage) ? requestedLanguage : 'plaintext';
        const highlighted =
          highlightCode && language !== 'plaintext'
            ? hljs.highlight(text, { language, ignoreIllegals: true }).value
            : escapeHtml(text);
        return `<pre class="code-block"><code class="hljs language-${language}">${highlighted}</code></pre>`;
      },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(href)}"${titleAttribute} target="_blank" rel="noopener noreferrer">${label}</a>`;
      }
    }
  });

  return renderer;
}

const staticMarkdown = createMarkdownRenderer(true);
const streamingMarkdown = createMarkdownRenderer(false);

export function renderMarkdown(content: string, options: { highlightCode?: boolean } = {}) {
  const renderer = options.highlightCode === false ? streamingMarkdown : staticMarkdown;
  let html: string;
  try {
    html = renderer.parse(content) as string;
  } catch (error) {
    console.error('Markdown render failed:', error);
    html = `<pre class="code-block"><code class="hljs language-plaintext">${escapeHtml(content)}</code></pre>`;
  }

  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['canvas'],
    ADD_ATTR: ['data-chart', 'data-mermaid', 'target', 'rel']
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

function isWhitespace(char: string) {
  return /\s/.test(char);
}

function isIdentifierStart(char: string) {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string) {
  return /[\w$]/.test(char);
}

function isWordAt(source: string, index: number, word: string) {
  if (source.slice(index, index + word.length) !== word) return false;
  const before = source[index - 1] ?? '';
  const after = source[index + word.length] ?? '';
  return !isIdentifierPart(before) && !isIdentifierPart(after);
}

function skipWhitespace(source: string, index: number) {
  let cursor = index;
  while (cursor < source.length && isWhitespace(source[cursor])) cursor += 1;
  return cursor;
}

function skipQuoted(source: string, index: number) {
  const quote = source[index];
  let cursor = index + 1;

  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (char === quote) return cursor + 1;
    cursor += 1;
  }

  return cursor;
}

function skipComment(source: string, index: number) {
  if (source[index] !== '/') return index;

  if (source[index + 1] === '/') {
    const lineEnd = source.indexOf('\n', index + 2);
    return lineEnd < 0 ? source.length : lineEnd + 1;
  }

  if (source[index + 1] === '*') {
    const blockEnd = source.indexOf('*/', index + 2);
    return blockEnd < 0 ? source.length : blockEnd + 2;
  }

  return index;
}

function findMatchingBracket(source: string, index: number, open: string, close: string) {
  let cursor = index;
  let depth = 0;

  while (cursor < source.length) {
    const char = source[cursor];

    if (char === '"' || char === "'" || char === '`') {
      cursor = skipQuoted(source, cursor);
      continue;
    }

    const commentEnd = skipComment(source, cursor);
    if (commentEnd !== cursor) {
      cursor = commentEnd;
      continue;
    }

    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }

    cursor += 1;
  }

  return -1;
}

function findFunctionExpressionEnd(source: string, index: number) {
  let cursor = index;
  if (isWordAt(source, cursor, 'async')) cursor = skipWhitespace(source, cursor + 'async'.length);
  if (!isWordAt(source, cursor, 'function')) return -1;

  const bodyStart = source.indexOf('{', cursor + 'function'.length);
  return bodyStart < 0 ? -1 : findMatchingBracket(source, bodyStart, '{', '}');
}

function findExpressionEnd(source: string, index: number) {
  let cursor = index;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  while (cursor < source.length) {
    const char = source[cursor];

    if (char === '"' || char === "'" || char === '`') {
      cursor = skipQuoted(source, cursor);
      continue;
    }

    const commentEnd = skipComment(source, cursor);
    if (commentEnd !== cursor) {
      cursor = commentEnd;
      continue;
    }

    if (char === '(') parenDepth += 1;
    if (char === ')') parenDepth -= 1;
    if (char === '[') bracketDepth += 1;
    if (char === ']') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return cursor;
      bracketDepth -= 1;
    }
    if (char === '{') braceDepth += 1;
    if (char === '}') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return cursor;
      braceDepth -= 1;
    }
    if (char === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return cursor;

    cursor += 1;
  }

  return cursor;
}

function findArrowExpressionEnd(source: string, index: number) {
  let cursor = index;
  if (isWordAt(source, cursor, 'async')) cursor = skipWhitespace(source, cursor + 'async'.length);

  if (source[cursor] === '(') {
    const paramsEnd = findMatchingBracket(source, cursor, '(', ')');
    if (paramsEnd < 0) return -1;
    cursor = skipWhitespace(source, paramsEnd);
  } else if (isIdentifierStart(source[cursor])) {
    cursor += 1;
    while (cursor < source.length && isIdentifierPart(source[cursor])) cursor += 1;
    cursor = skipWhitespace(source, cursor);
  } else {
    return -1;
  }

  if (source.slice(cursor, cursor + 2) !== '=>') return -1;
  const bodyStart = skipWhitespace(source, cursor + 2);
  return source[bodyStart] === '{' ? findMatchingBracket(source, bodyStart, '{', '}') : findExpressionEnd(source, bodyStart);
}

function findUnsupportedJavascriptValueEnd(source: string, index: number) {
  const functionEnd = findFunctionExpressionEnd(source, index);
  if (functionEnd > index) return functionEnd;

  const arrowEnd = findArrowExpressionEnd(source, index);
  if (arrowEnd > index) return arrowEnd;

  return -1;
}

function stripUnsupportedJavascriptValues(raw: string) {
  let output = '';
  let lastEmitIndex = 0;
  let cursor = 0;

  while (cursor < raw.length) {
    const char = raw[cursor];

    if (char === '"' || char === "'" || char === '`') {
      cursor = skipQuoted(raw, cursor);
      continue;
    }

    const commentEnd = skipComment(raw, cursor);
    if (commentEnd !== cursor) {
      cursor = commentEnd;
      continue;
    }

    if (char !== ':') {
      cursor += 1;
      continue;
    }

    const valueStart = skipWhitespace(raw, cursor + 1);
    const valueEnd = findUnsupportedJavascriptValueEnd(raw, valueStart);
    if (valueEnd > valueStart) {
      output += `${raw.slice(lastEmitIndex, valueStart)}null`;
      lastEmitIndex = valueEnd;
      cursor = valueEnd;
      continue;
    }

    cursor = valueStart;
  }

  return `${output}${raw.slice(lastEmitIndex)}`;
}

function parseChartJson(raw: string) {
  const trimmed = raw.trim();

  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    const repaired = stripUnsupportedJavascriptValues(trimmed);
    if (repaired !== trimmed) {
      try {
        return JSON.parse(repaired) as unknown;
      } catch {
        // Fall through to the original parse error so the message points at the user's chart block.
      }
    }

    throw error;
  }
}

function formatChartParseError(raw: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/\bfunction\b|=>/.test(raw)) {
    return `图表 JSON 解析失败：chart 代码块只能包含纯 JSON，不能包含 function 或 => 回调。原始错误：${message}`;
  }

  return `图表 JSON 解析失败：${message}`;
}

function createChartPlaceholder(index: number, hasError = false) {
  const className = hasError ? 'chart-placeholder render-error' : 'chart-placeholder';
  return `<div class="${className}" data-chart-index="${index}"></div>`;
}

function parseChartBlock(raw: string): ExtractedChartBlock {
  try {
    const parsed = parseChartJson(raw);
    return isRecord(parsed)
      ? (parsed as ExtractedChartBlock)
      : {
          error: 'chart 代码块必须是 Chart.js JSON 对象。'
        };
  } catch (error) {
    return {
      error: formatChartParseError(raw, error)
    };
  }
}

function parseTrailingChartBlock(raw: string): ExtractedChartBlock {
  const trimmed = raw.trim();
  if (!trimmed) return { pending: true };

  try {
    const parsed = parseChartJson(trimmed);
    return isRecord(parsed) ? (parsed as ExtractedChartBlock) : { pending: true };
  } catch {
    return { pending: true };
  }
}

function looksLikeChartConfig(raw: string) {
  try {
    const parsed = parseChartJson(raw);
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

  const chartFencePattern = /(^|\n)[ \t]*```(?:chart|chartjs|chart\.js)[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?[ \t]*```(?=\s*(?:\n|$))/gi;
  const jsonFencePattern = /(^|\n)[ \t]*```json[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?[ \t]*```(?=\s*(?:\n|$))/gi;
  const trailingChartFencePattern = /(^|\n)[ \t]*```(?:chart|chartjs|chart\.js)[ \t]*\r?\n([\s\S]*)$/i;

  const withChartFences = content.replace(chartFencePattern, (match, prefix, raw) => {
    const replacement = pushChartBlock(parseChartBlock(raw));
    return `${prefix}${replacement}`;
  });

  const withJsonChartFences = withChartFences.replace(jsonFencePattern, (match, prefix, raw) => {
    const chartConfig = looksLikeChartConfig(raw);
    return chartConfig ? `${prefix}${pushChartBlock(chartConfig)}` : match;
  });

  const normalized = withJsonChartFences.replace(trailingChartFencePattern, (_match, prefix, raw) => {
    const replacement = pushChartBlock(parseTrailingChartBlock(raw));
    return `${prefix}${replacement}`;
  });

  return { normalized, blocks };
}
