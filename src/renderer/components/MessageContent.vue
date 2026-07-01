<template>
  <div class="message-render" ref="container" v-html="renderedHtml"></div>
</template>

<script setup lang="ts">
import type { Chart as ChartInstance, ChartConfiguration, ChartData, ChartOptions, ChartType } from 'chart.js';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { extractChartBlocks, extractMermaidBlocks, renderMarkdown } from '../utils/markdown';

const props = defineProps<{
  content: string;
  streaming?: boolean;
}>();

const container = ref<HTMLElement | null>(null);
const charts: ChartInstance[] = [];
let renderVersion = 0;

let chartLoader: Promise<typeof import('chart.js/auto').Chart> | null = null;
let mermaidLoader: Promise<typeof import('mermaid').default> | null = null;

function getChartConstructor() {
  chartLoader ??= import('chart.js/auto').then((module) => module.Chart);
  return chartLoader;
}

function getMermaid() {
  mermaidLoader ??= import('mermaid').then((module) => {
    const mermaid = module.default;
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      themeVariables: {
        background: '#101412',
        primaryColor: '#18211e',
        primaryTextColor: '#eef3f8',
        primaryBorderColor: '#4a5752',
        lineColor: '#8a928d',
        secondaryColor: '#13251f',
        tertiaryColor: '#241c22'
      }
    });
    return mermaid;
  });
  return mermaidLoader;
}

const prepared = computed(() => {
  const chartPass = extractChartBlocks(props.content);
  const mermaidPass = extractMermaidBlocks(chartPass.normalized);
  return {
    content: mermaidPass.normalized,
    charts: chartPass.blocks,
    mermaid: mermaidPass.blocks
  };
});

const streamingIndicatorHtml =
  '<span class="streaming-dots" aria-label="内容生成中"><span></span><span></span><span></span></span>';

const html = computed(() => renderMarkdown(prepared.value.content));
const renderedHtml = computed(() => (props.streaming ? `${html.value}${streamingIndicatorHtml}` : html.value));

function destroyCharts() {
  while (charts.length) {
    charts.pop()?.destroy();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clonePlainValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sanitizeChartValue(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeChartValue(item, parentKey));

  if (!isRecord(value)) return value;

  if (parentKey === 'callbacks') return {};

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeChartValue(item, key)]));
}

function normalizeTitleOptions(value: unknown) {
  if (!isRecord(value)) return value;

  const normalized = { ...value };
  if (typeof normalized.fontSize === 'number' && !normalized.font) {
    normalized.font = { size: normalized.fontSize };
  }
  delete normalized.fontSize;

  return normalized;
}

function normalizeChartOptions(options: unknown): ChartOptions {
  const normalized = isRecord(options) ? (sanitizeChartValue(clonePlainValue(options)) as Record<string, unknown>) : {};

  if (isRecord(normalized.title)) {
    normalized.plugins = {
      ...(isRecord(normalized.plugins) ? normalized.plugins : {}),
      title: normalizeTitleOptions(normalized.title)
    };
    delete normalized.title;
  }

  if (isRecord(normalized.subtitle)) {
    normalized.plugins = {
      ...(isRecord(normalized.plugins) ? normalized.plugins : {}),
      subtitle: normalizeTitleOptions(normalized.subtitle)
    };
    delete normalized.subtitle;
  }

  return normalized as ChartOptions;
}

function mergeChartOptions(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };

  for (const [key, value] of Object.entries(overrides)) {
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = mergeChartOptions(merged[key] as Record<string, unknown>, value);
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

function getDefaultChartOptions(type: ChartType): ChartOptions {
  const cartesianTypes: ChartType[] = ['bar', 'line', 'scatter', 'bubble'];
  const radialTypes: ChartType[] = ['radar', 'polarArea'];

  return {
    responsive: true,
    maintainAspectRatio: false,
    color: '#d7dee8',
    plugins: {
      legend: {
        labels: {
          color: '#d7dee8',
          boxWidth: 10
        }
      },
      title: {
        color: '#e8eef6',
        font: {
          size: 15,
          weight: 'bold'
        }
      },
      subtitle: {
        color: '#a7b0bf'
      },
      tooltip: {
        titleColor: '#eef3f8',
        bodyColor: '#d7dee8',
        backgroundColor: 'rgba(10, 14, 20, 0.92)',
        borderColor: 'rgba(88, 199, 180, 0.24)',
        borderWidth: 1
      }
    },
    scales: cartesianTypes.includes(type)
      ? {
          x: {
            ticks: { color: '#a7b0bf' },
            grid: { color: 'rgba(123, 132, 148, 0.18)' }
          },
          y: {
            ticks: { color: '#a7b0bf' },
            grid: { color: 'rgba(123, 132, 148, 0.18)' }
          }
        }
      : radialTypes.includes(type)
        ? {
            r: {
              ticks: { color: '#a7b0bf', backdropColor: 'transparent' },
              grid: { color: 'rgba(123, 132, 148, 0.18)' },
              angleLines: { color: 'rgba(123, 132, 148, 0.18)' },
              pointLabels: { color: '#a7b0bf' }
            }
          }
        : undefined
  } as unknown as ChartOptions;
}

function renderChartError(target: HTMLElement, message: string) {
  target.textContent = message;
  target.classList.add('render-error');
}

async function renderEnhancements() {
  const version = ++renderVersion;
  try {
    await nextTick();
    const root = container.value;
    const snapshot = prepared.value;
    if (!root) return;

    destroyCharts();

    const chartTargets = root.querySelectorAll<HTMLElement>('.chart-placeholder');
    const Chart = chartTargets.length ? await getChartConstructor() : null;
    if (version !== renderVersion || !container.value || !root.isConnected) return;

    chartTargets.forEach((target) => {
      if (!root.contains(target) || !target.isConnected) return;

      const index = Number(target.dataset.chartIndex);
      const chartConfig = snapshot.charts[index];
      if (!Chart || !chartConfig) return;

      if (chartConfig.pending) {
        target.textContent = '图表生成中...';
        return;
      }

      if (chartConfig.error) {
        renderChartError(target, chartConfig.error);
        return;
      }

      if (!chartConfig.type || !chartConfig.data) {
        renderChartError(target, '图表配置缺少 type 或 data 字段。');
        return;
      }

      try {
        const type = chartConfig.type as ChartType;
        const canvas = document.createElement('canvas');
        canvas.height = 260;
        target.classList.remove('render-error');
        target.replaceChildren(canvas);

        const config: ChartConfiguration = {
          type,
          data: clonePlainValue(chartConfig.data) as ChartData,
          options: mergeChartOptions(
            getDefaultChartOptions(type) as Record<string, unknown>,
            normalizeChartOptions(chartConfig.options) as Record<string, unknown>
          ) as ChartOptions
        };

        charts.push(new Chart(canvas, config));
      } catch (error) {
        renderChartError(target, `图表渲染失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });

    const mermaidTargets = root.querySelectorAll<HTMLElement>('.mermaid-placeholder');
    const mermaid = mermaidTargets.length ? await getMermaid() : null;
    if (version !== renderVersion || !container.value || !root.isConnected) return;

    for (const target of mermaidTargets) {
      if (!root.contains(target) || !target.isConnected) continue;

      const index = Number(target.dataset.mermaidIndex);
      const graph = snapshot.mermaid[index];
      if (!mermaid || !graph) continue;

      try {
        const id = `mermaid-${crypto.randomUUID()}`;
        const result = await mermaid.render(id, graph);
        target.innerHTML = result.svg;
      } catch (error) {
        renderChartError(target, error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    console.error('Message enhancement render failed:', error);
  }
}

onMounted(() => {
  void renderEnhancements();
});
watch(
  () => [props.content, props.streaming],
  () => {
    void renderEnhancements();
  },
  { flush: 'post' }
);
onBeforeUnmount(destroyCharts);
</script>
