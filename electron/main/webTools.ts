import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as cheerio from 'cheerio';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) LittleSecretary/0.1 Safari/537.36';

function text(value: string) {
  return [{ type: 'text' as const, text: value }];
}

function trimText(value: string, maxLength = 12000) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}\n\n[内容过长，已截断]` : compact;
}

async function fetchHtml(url: string) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`请求失败：${response.status} ${response.statusText}`);
  }

  return response.text();
}

function normalizeDuckDuckGoUrl(url: string) {
  try {
    const parsed = new URL(url, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : parsed.toString();
  } catch {
    return url;
  }
}

function parseDuckDuckGo(html: string) {
  const $ = cheerio.load(html);
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  $('.result').each((_index, element) => {
    const title = trimText($(element).find('.result__title a').text(), 160);
    const href = $(element).find('.result__title a').attr('href');
    const snippet = trimText($(element).find('.result__snippet').text(), 360);

    if (title && href) {
      results.push({
        title,
        url: normalizeDuckDuckGoUrl(href),
        snippet
      });
    }
  });

  return results;
}

async function webSearch(args: Record<string, unknown>) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const maxResults = Math.max(1, Math.min(10, Number(args.max_results ?? 5)));

  if (!query) {
    throw new Error('query 不能为空');
  }

  const html = await fetchHtml(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  return {
    query,
    results: parseDuckDuckGo(html).slice(0, maxResults)
  };
}

async function fetchPage(args: Record<string, unknown>) {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) {
    throw new Error('url 不能为空');
  }

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, canvas, iframe').remove();

  return {
    url,
    title: trimText($('title').first().text(), 180),
    description: trimText($('meta[name="description"]').attr('content') ?? '', 300),
    content: trimText($('body').text(), Math.max(1000, Math.min(20000, Number(args.max_chars ?? 8000))))
  };
}

function formatDateInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getCurrentTime(args: Record<string, unknown> = {}) {
  const now = new Date();
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const requestedTimeZone =
    typeof args.time_zone === 'string' && args.time_zone.trim() ? args.time_zone.trim() : localTimeZone;
  const locale = typeof args.locale === 'string' && args.locale.trim() ? args.locale.trim() : 'zh-CN';
  let effectiveTimeZone = requestedTimeZone;

  let formatted: string;

  try {
    formatted = new Intl.DateTimeFormat(locale, {
      timeZone: effectiveTimeZone,
      dateStyle: 'full',
      timeStyle: 'long'
    }).format(now);
  } catch {
    effectiveTimeZone = localTimeZone;
    formatted = new Intl.DateTimeFormat('zh-CN', {
      timeZone: effectiveTimeZone,
      dateStyle: 'full',
      timeStyle: 'long'
    }).format(now);
  }

  return {
    iso: now.toISOString(),
    unix_ms: now.getTime(),
    local_time_zone: localTimeZone,
    requested_time_zone: requestedTimeZone,
    effective_time_zone: effectiveTimeZone,
    formatted,
    current_date: formatDateInTimeZone(now, effectiveTimeZone),
    note: 'Use this tool whenever the user says now, today, current, latest time, or asks for date/time-sensitive reasoning.'
  };
}

export function createWebToolsServer() {
  const server = new Server(
    {
      name: 'little-secretary-built-in-tools',
      version: '0.1.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'web_search',
        description: 'Search current web information by keyword and return title, URL and snippet results.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search keywords.'
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of results, 1-10.'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'fetch_page',
        description: 'Fetch a web page URL and extract readable title, description and text content.',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'URL to fetch.'
            },
            max_chars: {
              type: 'number',
              description: 'Maximum text length to return.'
            }
          },
          required: ['url']
        }
      },
      {
        name: 'get_current_time',
        description: 'Get the current date and time. Use this for relative time words such as now, today, current, yesterday or tomorrow.',
        inputSchema: {
          type: 'object',
          properties: {
            time_zone: {
              type: 'string',
              description: 'Optional IANA time zone, for example Asia/Shanghai or America/New_York. Defaults to the local system time zone.'
            },
            locale: {
              type: 'string',
              description: 'Optional locale for formatted output, for example zh-CN or en-US.'
            }
          }
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const input = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};

    if (name === 'web_search') {
      return { content: text(JSON.stringify(await webSearch(input), null, 2)) };
    }

    if (name === 'fetch_page') {
      return { content: text(JSON.stringify(await fetchPage(input), null, 2)) };
    }

    if (name === 'get_current_time') {
      return { content: text(JSON.stringify(getCurrentTime(input), null, 2)) };
    }

    throw new Error(`未知工具：${name}`);
  });

  return server;
}
