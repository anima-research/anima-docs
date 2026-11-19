// Drawing a chart in the page: a bundle of its own (public/charts.js), fetched
// the first time a page shows a chart. Charts of type "code" are not drawn
// here: they run in a sandboxed frame (chartframe.ts).

import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { chartOption, type ChartSpec, type Table, type Theme } from '../src/chart';

echarts.use([BarChart, LineChart, PieChart, ScatterChart, GridComponent, LegendComponent, TitleComponent, TooltipComponent, SVGRenderer]);

/** Draw `spec` over `table` into `el`. Returns what removes it. */
export function draw(el: HTMLElement, spec: ChartSpec, table: Table, theme: Theme): () => void {
  const drawn = chartOption(spec, table, theme);
  if ('error' in drawn) { el.replaceChildren(Object.assign(document.createElement('div'), { className: 'md-chart-note', textContent: drawn.error })); return () => undefined; }
  const plot = document.createElement('div');
  plot.className = 'md-chart-plot';
  plot.style.height = `${spec.height}px`;
  el.replaceChildren(plot);
  if (drawn.note) el.append(Object.assign(document.createElement('div'), { className: 'md-chart-note', textContent: drawn.note }));
  const chart = echarts.init(plot, null, { renderer: 'svg' });
  // Tooltips are drawn as text, never as HTML: nothing a cell holds is markup here.
  chart.setOption({ ...drawn.option, tooltip: { ...(drawn.option.tooltip as object), renderMode: 'richText' } });
  const resize = new ResizeObserver(() => chart.resize());
  resize.observe(plot);
  return () => { resize.disconnect(); chart.dispose(); };
}
