// The frame a chart of type "code" runs in (public/chartframe.js, loaded by
// /chart-frame). The frame is sandboxed: an origin of its own, no network, no
// way to the app or the reader's session. It is given the chart's text and
// data by the page around it (a message), or in its address (after #, on a
// published page), runs the code, and shows what it draws.
//
// The code is the body of a function (data, echarts, el, theme):
//   data    { columns: [...], rows: [[...], ...] } from the chart's rows or its spreadsheet range (or null)
//   echarts the whole ECharts library
//   el      the element to draw into
//   theme   { name: 'light' | 'dark', text, muted, rule, faint, surface, colors: [...] }
// It may return ECharts options (drawn for it), or draw into el itself; it may be async.

import * as echarts from 'echarts';
import { CHART_COLORS, CHART_INK, chartOption, parseChart, tableOf, type Table, type Theme } from '../src/chart';

interface Payload { text: string; table?: Table | null; theme?: Theme; error?: string }
const el = document.getElementById('chart')!;
let chart: echarts.ECharts | null = null;
const say = (message: string) => { const p = document.createElement('p'); p.className = 'note'; p.textContent = message; el.replaceChildren(p); };

async function show(p: Payload) {
  chart?.dispose();
  chart = null;
  el.replaceChildren();
  const theme: Theme = p.theme === 'dark' ? 'dark' : 'light';
  const ink = CHART_INK[theme];
  document.documentElement.style.colorScheme = theme;
  document.body.style.background = ink.surface;
  document.body.style.color = ink.text;
  if (p.error) return say(p.error);
  const spec = parseChart(p.text);
  const table = p.table ?? (spec.rows.length ? tableOf(spec.rows) : null);
  try {
    let option: unknown;
    if (spec.type === 'code') {
      // An async function, so the code may wait for what it computes.
      const AsyncFunction = (async () => undefined).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
      option = await new AsyncFunction('data', 'echarts', 'el', 'theme', `"use strict";\n${spec.code}`)(table, echarts, el, { name: theme, ...ink, colors: CHART_COLORS[theme] });
    } else {
      const drawn = chartOption(spec, table ?? { columns: [], rows: [] }, theme);
      if ('error' in drawn) return say(drawn.error);
      option = drawn.option;
    }
    if (option && typeof option === 'object' && !(option instanceof Node)) {
      chart = echarts.init(el, null, { renderer: 'svg' });
      chart.setOption(option as echarts.EChartsCoreOption);
    }
  } catch (e) { say(`This chart's code failed: ${e instanceof Error ? e.message : String(e)}`); }
}

addEventListener('resize', () => chart?.resize());
addEventListener('message', (e) => { if (e.source === parent && e.data && e.data.anima === 'chart') void show(e.data as Payload); });
if (location.hash.length > 1) {
  try { void show(JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/'))))) as Payload); } catch { say('This chart could not be read.'); }
}
parent.postMessage({ anima: 'chart-ready' }, '*');
