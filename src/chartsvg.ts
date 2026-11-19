// Charts drawn in the server: SVG for published pages, PNG for the Excel file.
// (ECharts renders to a string of SVG without a browser.)

import * as echarts from 'echarts';
import sharp from 'sharp';
import { CHART_INK, chartOption, type ChartSpec, type Table, type Theme } from './chart.js';

const escapeXml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** A picture saying why there is no chart (no data, an unknown column, data that may not be read). */
export function messageSvg(title: string, message: string, opts: { theme?: Theme; width?: number; background?: boolean } = {}): string {
  const ink = CHART_INK[opts.theme ?? 'light'], width = opts.width ?? 720;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="96" viewBox="0 0 ${width} 96">${opts.background ? `<rect width="100%" height="100%" fill="${ink.surface}"/>` : ''}<rect x="0.5" y="0.5" width="${width - 1}" height="95" rx="8" fill="none" stroke="${ink.rule}" stroke-dasharray="4 4"/><text x="16" y="${title ? 40 : 52}" font-family="sans-serif" font-size="13" font-weight="600" fill="${ink.text}">${escapeXml(title)}</text><text x="16" y="${title ? 62 : 52}" font-family="sans-serif" font-size="13" fill="${ink.muted}">${escapeXml(message.slice(0, 110))}</text></svg>`;
}

/** A chart as SVG. What cannot be drawn (no data, an unknown column, a chart that is code) is a picture of the reason. */
export function chartSvg(spec: ChartSpec, table: Table, opts: { theme?: Theme; width?: number; background?: boolean } = {}): string {
  const theme = opts.theme ?? 'light', width = opts.width ?? 720, height = spec.height;
  const drawn = spec.type === 'code' ? { error: 'This chart is drawn by code, in the reader’s browser: open the document to see it.' } : chartOption(spec, table, theme, { still: true, noteInside: true });
  if ('error' in drawn) return messageSvg(spec.title, drawn.error, opts);
  const ink = CHART_INK[theme];
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
  try {
    chart.setOption({ ...drawn.option, backgroundColor: opts.background ? ink.surface : 'transparent' });
    return chart.renderToSVGString();
  } finally { chart.dispose(); }
}

/** A chart as a PNG, twice the size it is shown at (for the Excel file, which takes pictures). */
export async function chartPng(spec: ChartSpec, table: Table, width: number): Promise<Buffer> {
  return sharp(Buffer.from(chartSvg(spec, table, { width, background: true })), { density: 144 }).png().toBuffer();
}
