/** Static SVG precision-recall chart. Light and dark mode, legend, hover titles on markers. */

const SERIES = [
  { light: '#2a78d6', dark: '#3987e5' }, // blue
  { light: '#eb6834', dark: '#d95926' }, // orange
  { light: '#1baf7a', dark: '#199e70' }, // aqua
  { light: '#eda100', dark: '#c98500' }, // yellow
];
// Fixed slot per system so a system keeps its colour across charts.
const SLOT: Record<string, number> = { openai: 0, jev: 1, gemini: 2, moderation: 3 };

interface Curve {
  system: string;
  label: string;
  points: { recall: number; precision: number }[];
  marker?: { recall: number; precision: number; t: number };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function prChart(question: string, curves: Curve[]): string {
  const W = 640;
  const H = 420;
  const m = { l: 56, r: 24, t: 56, b: 52 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const x = (r: number) => m.l + r * pw;
  const y = (p: number) => m.t + (1 - p) * ph;

  const vars = (mode: 'light' | 'dark') =>
    curves.map((c) => `--s-${c.system}: ${SERIES[SLOT[c.system] ?? 0]![mode]};`).join(' ');

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (v) => `
    <line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>
    <text class="tick" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(2)}</text>
    <text class="tick" x="${x(v)}" y="${H - m.b + 18}" text-anchor="middle">${v.toFixed(2)}</text>`,
    )
    .join('');

  const lines = curves
    .map((c) => {
      // Step curve, ordered by recall.
      const pts = [...c.points].sort((a, b) => a.recall - b.recall || b.precision - a.precision);
      let d = '';
      let prev: { recall: number; precision: number } | undefined;
      for (const p of pts) {
        if (!prev) d += `M${x(0).toFixed(1)},${y(p.precision).toFixed(1)} L${x(p.recall).toFixed(1)},${y(p.precision).toFixed(1)}`;
        else d += ` L${x(p.recall).toFixed(1)},${y(prev.precision).toFixed(1)} L${x(p.recall).toFixed(1)},${y(p.precision).toFixed(1)}`;
        prev = p;
      }
      const mk = c.marker
        ? `<g class="mk"><circle cx="${x(c.marker.recall)}" cy="${y(c.marker.precision)}" r="6" fill="var(--s-${c.system})" stroke="var(--surface)" stroke-width="2"/>
           <circle cx="${x(c.marker.recall)}" cy="${y(c.marker.precision)}" r="14" fill="transparent"><title>${esc(c.label)}
threshold ${c.marker.t.toFixed(3)} (≤1% false positives)
recall ${(c.marker.recall * 100).toFixed(1)}%, precision ${(c.marker.precision * 100).toFixed(1)}%</title></circle></g>`
        : '';
      return `<path d="${d}" fill="none" stroke="var(--s-${c.system})" stroke-width="2" stroke-linejoin="round"/>${mk}`;
    })
    .join('\n');

  // One series: the title names it, so no legend box. Two or more: a legend row.
  const legend = (curves.length < 2 ? [] : curves)
    .map(
      (c, i) =>
        `<g transform="translate(${m.l + i * 200}, 36)"><rect width="12" height="12" rx="3" y="-10" fill="var(--s-${c.system})"/><text class="legend" x="18" y="0">${esc(c.label)}</text></g>`,
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" role="img" aria-label="Precision-recall curve for ${question}">
<style>
  svg { --surface: #fcfcfb; --ink: #0b0b0b; --ink2: #52514e; --grid: #e4e3df; ${vars('light')} }
  @media (prefers-color-scheme: dark) {
    svg { --surface: #1a1a19; --ink: #f0efec; --ink2: #c3c2b7; --grid: #3a3936; ${vars('dark')} }
  }
  .bg { fill: var(--surface); }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .tick { fill: var(--ink2); font-size: 11px; }
  .title { fill: var(--ink); font-size: 15px; font-weight: 600; }
  .legend, .axis { fill: var(--ink2); font-size: 12px; }
</style>
<rect class="bg" width="${W}" height="${H}" rx="8"/>
<text class="title" x="${m.l}" y="20">Precision vs recall: ${esc(question)}${curves.length === 1 ? `, ${esc(curves[0]!.label)}` : ''}</text>
<text class="legend" x="${W - m.r}" y="20" text-anchor="end">dot = threshold for ≤1% false positives</text>
${legend}
${grid}
<text class="axis" x="${m.l + pw / 2}" y="${H - 10}" text-anchor="middle">Recall</text>
<text class="axis" transform="translate(14 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle">Precision</text>
${lines}
</svg>
`;
}
