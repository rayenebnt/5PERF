#!/usr/bin/env node
// Génère les graphiques du rapport (SVG statiques) à partir des résultats de
// mesure enregistrés dans docs/benchmarks/.
//
//   node bench/charts.mjs [dossier des résultats] [dossier de sortie]
//
// Chaque valeur tracée figure aussi dans les tableaux du rapport : les
// graphiques illustrent, ils ne sont jamais la seule source d'un chiffre.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const resultsDir = process.argv[2] ?? 'docs/benchmarks';
const outDir = process.argv[3] ?? 'docs/img';
mkdirSync(outDir, { recursive: true });

const load = (name) => JSON.parse(readFileSync(join(resultsDir, name), 'utf8'));
const original = load('original.json');
const codeOnly = load('optimized-code-only.json');
const optimized = load('optimized.json');
const profile = load('profile-original.json');

// ---------------------------------------------------------------- charte
// Une couleur par état, la même sur tous les graphiques : gris pour l'état
// d'origine (le contexte), deux pas du même bleu pour les étapes d'optimisation.
// Couleurs vérifiées avec le validateur de palette (séparation sous
// daltonisme simulé >= 18, vision normale >= 18,9) ; le bleu clair étant peu
// contrasté sur le fond, chaque marque porte aussi sa valeur en clair.
const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781' };
const SURFACE = '#fcfcfb';
const GRID = '#e1e0d9';
const BASELINE = '#c3c2b7';
const STATE = {
  original: { label: 'Origine', color: '#7b7974' },
  codeOnly: { label: 'Code optimisé, base inchangée', color: '#6da7ec' },
  optimized: { label: 'Code optimisé + migration', color: '#1c5cab' },
};
const FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;

const SCENARIOS = [
  ['data-30d', 'Consultation · 30 jours'],
  ['data-1y', 'Consultation · 1 an'],
  ['data-full', 'Export complet · 40 ans'],
  ['avg-1y', 'Moyenne · 1 an'],
  ['avg-full', 'Moyenne · 40 ans'],
  ['max-full', 'Maximum · 40 ans'],
  ['min-10y', 'Minimum · 10 ans'],
];

// ------------------------------------------------------------- utilitaires
const number = (value, digits) =>
  new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

// Trois chiffres significatifs au plus : 177 · 68,6 · 1,77 · 0,42.
function compact(raw) {
  if (raw >= 99.95) return number(raw, 0);
  const value = Number(raw.toPrecision(3));
  return value >= 10 ? number(value, 1) : number(value, 2);
}
const ms = (value) => `${compact(value)} ms`;
const factor = (before, after) => `÷ ${number(before / after, before / after >= 10 ? 0 : 1)}`;

const escapeXml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function text(x, y, content, options = {}) {
  const {
    size = 13,
    fill = INK.secondary,
    anchor = 'start',
    weight = 400,
    numeric = false,
  } = options;
  const numericStyle = numeric ? ' style="font-variant-numeric: tabular-nums"' : '';
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}"${numericStyle}>${escapeXml(content)}</text>`;
}

// Barre horizontale : extrémité « donnée » arrondie, base carrée.
function horizontalBar(x, y, width, height, color) {
  const w = Math.max(width, 2);
  const r = Math.min(4, w, height / 2);
  return `<path d="M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + height - r} Q${x + w},${y + height} ${x + w - r},${y + height} H${x} Z" fill="${color}"/>`;
}

// Colonne verticale : sommet arrondi, base carrée posée sur la ligne de base.
function column(x, baseline, width, height, color) {
  const h = Math.max(height, 2);
  const r = Math.min(4, h, width / 2);
  const top = baseline - h;
  return `<path d="M${x},${baseline} V${top + r} Q${x},${top} ${x + r},${top} H${x + width - r} Q${x + width},${top} ${x + width},${top + r} V${baseline} Z" fill="${color}"/>`;
}

function legend(x, y, states) {
  let cursor = x;
  const parts = [];
  for (const state of states) {
    parts.push(`<rect x="${cursor}" y="${y - 10}" width="12" height="12" rx="2" fill="${state.color}"/>`);
    parts.push(text(cursor + 18, y, state.label, { size: 13 }));
    cursor += 18 + state.label.length * 7.1 + 24;
  }
  return parts.join('\n');
}

function svg(width, height, title, description, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="t d" font-family="${FONT}">
<title id="t">${escapeXml(title)}</title>
<desc id="d">${escapeXml(description)}</desc>
<rect width="${width}" height="${height}" rx="8" fill="${SURFACE}"/>
${body}
</svg>
`;
}

function save(name, content) {
  writeFileSync(join(outDir, name), content);
  console.log(`écrit : ${join(outDir, name)}`);
}

// Graduations « rondes » couvrant [0, max].
function niceTicks(max, count = 4) {
  const rawStep = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep);
  const ticks = [];
  for (let value = 0; value <= max + step * 0.999; value += step) {
    ticks.push(Number(value.toPrecision(10)));
  }
  return ticks;
}

const run = (report, suite, scenario, connections = 1) =>
  report.runs.find(
    (r) => r.suite === suite && r.scenario === scenario && r.connections === connections
  );

// ------------------------------------------- 1. latence avant / après
{
  const width = 860;
  const labelWidth = 190;
  const plotLeft = 28 + labelWidth;
  const plotRight = width - 150;
  const rowHeight = 58;
  const top = 116;
  const height = top + SCENARIOS.length * rowHeight + 44;
  const rows = SCENARIOS.map(([key, label]) => ({
    label,
    before: run(original, 'latency', key).latencyMs.p50,
    after: run(optimized, 'latency', key).latencyMs.p50,
  }));
  const ticks = niceTicks(Math.max(...rows.map((row) => row.before)));
  const max = ticks.at(-1);
  const scale = (value) => plotLeft + (value / max) * (plotRight - plotLeft);
  const bottom = top + SCENARIOS.length * rowHeight;

  const body = [
    text(28, 34, 'Temps de réponse médian, un utilisateur', { size: 16, fill: INK.primary, weight: 600 }),
    text(28, 56, 'Millisecondes · plus court = mieux', { size: 13, fill: INK.muted }),
    legend(28, 84, [STATE.original, STATE.optimized]),
  ];
  for (const tick of ticks) {
    body.push(`<line x1="${scale(tick)}" y1="${top - 8}" x2="${scale(tick)}" y2="${bottom}" stroke="${tick === 0 ? BASELINE : GRID}" stroke-width="1"/>`);
    body.push(text(scale(tick), bottom + 20, number(tick, 0), { size: 12, fill: INK.muted, anchor: 'middle', numeric: true }));
  }
  rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    body.push(text(plotLeft - 12, y + 27, row.label, { anchor: 'end', fill: INK.primary }));
    body.push(horizontalBar(plotLeft, y + 4, scale(row.before) - plotLeft, 18, STATE.original.color));
    body.push(text(scale(row.before) + 8, y + 18, ms(row.before), { size: 12, numeric: true }));
    // 2 px de surface séparent les deux barres d'un même groupe.
    body.push(horizontalBar(plotLeft, y + 24, scale(row.after) - plotLeft, 18, STATE.optimized.color));
    body.push(
      text(Math.max(scale(row.after), plotLeft + 2) + 8, y + 38, `${ms(row.after)}  (${factor(row.before, row.after)})`, {
        size: 12,
        fill: INK.primary,
        weight: 600,
        numeric: true,
      })
    );
  });
  save(
    'latence-avant-apres.svg',
    svg(
      width,
      height,
      'Temps de réponse médian avant et après optimisation',
      rows.map((row) => `${row.label} : ${ms(row.before)} puis ${ms(row.after)}`).join(' ; '),
      body.join('\n')
    )
  );
}

// ------------------------------- 2. latence selon la profondeur d'historique
{
  const width = 860;
  const height = 420;
  const plot = { left: 64, right: width - 190, top: 96, bottom: height - 62 };
  const depths = [1, 2, 5, 10, 20, 40];
  const series = [
    { state: STATE.original, report: original },
    { state: STATE.optimized, report: optimized },
  ].map(({ state, report }) => ({
    state,
    points: depths.map((years) => ({
      years,
      value: run(report, 'depth', `depth-avg-${String(years).padStart(2, '0')}y`).latencyMs.p50,
    })),
  }));
  const ticks = niceTicks(Math.max(...series[0].points.map((p) => p.value)));
  const max = ticks.at(-1);
  const x = (years) => plot.left + (years / 40) * (plot.right - plot.left);
  const y = (value) => plot.bottom - (value / max) * (plot.bottom - plot.top);

  const body = [
    text(28, 34, "La même requête coûte d'autant plus cher que l'historique du lieu est long", { size: 16, fill: INK.primary, weight: 600 }),
    text(28, 56, 'Moyenne des 30 derniers jours · temps de réponse médian (ms), un utilisateur', { size: 13, fill: INK.muted }),
    legend(plot.left, 78, series.map((s) => s.state)),
  ];
  for (const tick of ticks) {
    body.push(`<line x1="${plot.left}" y1="${y(tick)}" x2="${plot.right}" y2="${y(tick)}" stroke="${tick === 0 ? BASELINE : GRID}" stroke-width="1"/>`);
    body.push(text(plot.left - 10, y(tick) + 4, number(tick, 0), { size: 12, fill: INK.muted, anchor: 'end', numeric: true }));
  }
  for (const years of depths) {
    // « 1 » et « 2 » se touchent presque : on n'écrit que les repères lisibles.
    if (years !== 2) {
      body.push(text(x(years), plot.bottom + 22, years === 1 ? '1 an' : `${years} ans`, { size: 12, fill: INK.muted, anchor: 'middle', numeric: true }));
    }
    body.push(`<line x1="${x(years)}" y1="${plot.bottom}" x2="${x(years)}" y2="${plot.bottom + 5}" stroke="${BASELINE}" stroke-width="1"/>`);
  }
  body.push(text((plot.left + plot.right) / 2, height - 16, "Profondeur d'historique du lieu interrogé (14 610 mesures pour 40 ans)", { size: 12, fill: INK.muted, anchor: 'middle' }));
  for (const { state, points } of series) {
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.years).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    body.push(`<path d="${path}" fill="none" stroke="${state.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    for (const p of points) {
      body.push(`<circle cx="${x(p.years).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="5" fill="${state.color}" stroke="${SURFACE}" stroke-width="2"/>`);
    }
    const last = points.at(-1);
    body.push(text(x(last.years) + 14, y(last.value) + 4, `${ms(last.value)} à 40 ans`, { size: 13, fill: INK.primary, weight: 600, numeric: true }));
  }
  save(
    'scalabilite-profondeur.svg',
    svg(
      width,
      height,
      "Temps de réponse selon la profondeur d'historique",
      series.map((s) => `${s.state.label} : ${s.points.map((p) => `${p.years} an(s) ${ms(p.value)}`).join(', ')}`).join(' ; '),
      body.join('\n')
    )
  );
}

// --------------------------------- 3. où part le temps CPU à l'origine
{
  const width = 860;
  const rowHeight = 38;
  const top = 82;
  const labelWidth = 330;
  const plotLeft = 28 + labelWidth;
  const plotRight = width - 90;
  const rows = profile.categories;
  const height = top + rows.length * rowHeight + 20;
  const max = Math.max(...rows.map((row) => row.share));
  const scale = (share) => plotLeft + (share / max) * (plotRight - plotLeft);

  const body = [
    text(28, 34, "Application d'origine : où part le temps de calcul du serveur", { size: 16, fill: INK.primary, weight: 600 }),
    text(28, 56, 'Part du temps CPU du processus Node.js, trafic mixte (profil V8)', { size: 13, fill: INK.muted }),
    `<line x1="${plotLeft}" y1="${top - 6}" x2="${plotLeft}" y2="${top + rows.length * rowHeight - 6}" stroke="${BASELINE}" stroke-width="1"/>`,
  ];
  rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    body.push(text(plotLeft - 12, y + 17, row.name, { anchor: 'end', fill: INK.primary }));
    body.push(horizontalBar(plotLeft, y + 2, scale(row.share) - plotLeft, 20, STATE.original.color));
    body.push(text(scale(row.share) + 8, y + 17, `${number(row.share * 100, 1)} %`, { size: 12, fill: INK.primary, weight: 600, numeric: true }));
  });
  save(
    'profil-cpu-origine.svg',
    svg(
      width,
      height,
      "Répartition du temps CPU de l'application d'origine",
      rows.map((row) => `${row.name} : ${number(row.share * 100, 1)} %`).join(' ; '),
      body.join('\n')
    )
  );
}

// ------------------------------------------ 4. apport de chaque étape
{
  const panels = [
    ['data-30d', 'Consultation · 30 jours'],
    ['avg-full', 'Moyenne · 40 ans'],
    ['data-full', 'Export complet · 40 ans'],
  ];
  const states = [
    [STATE.original, original],
    [STATE.codeOnly, codeOnly],
    [STATE.optimized, optimized],
  ];
  const width = 860;
  const height = 400;
  const panelWidth = (width - 56) / panels.length;
  const baseline = height - 58;
  const plotTop = 150;
  const body = [
    text(28, 34, 'Ce que chaque étape apporte', { size: 16, fill: INK.primary, weight: 600 }),
    text(28, 56, 'Temps de réponse médian (ms), un utilisateur · chaque panneau a sa propre échelle', { size: 13, fill: INK.muted }),
    legend(28, 84, states.map(([state]) => state)),
  ];
  panels.forEach(([key, label], panelIndex) => {
    const left = 28 + panelIndex * panelWidth;
    const values = states.map(([, report]) => run(report, 'latency', key).latencyMs.p50);
    const max = Math.max(...values);
    body.push(text(left + 8, 122, label, { size: 14, fill: INK.primary, weight: 600 }));
    body.push(`<line x1="${left + 8}" y1="${baseline}" x2="${left + panelWidth - 16}" y2="${baseline}" stroke="${BASELINE}" stroke-width="1"/>`);
    const slot = (panelWidth - 24) / states.length;
    states.forEach(([state], index) => {
      const columnWidth = 24;
      const x = left + 8 + index * slot + (slot - columnWidth) / 2;
      const columnHeight = (values[index] / max) * (baseline - plotTop - 24);
      body.push(column(x, baseline, columnWidth, columnHeight, state.color));
      body.push(text(x + columnWidth / 2, baseline - Math.max(columnHeight, 2) - 8, ms(values[index]), { size: 12, fill: INK.primary, weight: 600, anchor: 'middle', numeric: true }));
      body.push(text(x + columnWidth / 2, baseline + 20, ['Origine', 'Code', 'Code + migration'][index], { size: 12, fill: INK.muted, anchor: 'middle' }));
    });
  });
  save(
    'etapes-optimisation.svg',
    svg(
      width,
      height,
      'Temps de réponse médian à chaque étape de l’optimisation',
      panels
        .map(([key, label]) => `${label} : ${states.map(([state, report]) => `${state.label} ${ms(run(report, 'latency', key).latencyMs.p50)}`).join(', ')}`)
        .join(' ; '),
      body.join('\n')
    )
  );
}

// ------------------------- 5. tenue en charge (débit imposé, trafic mixte)
{
  const width = 860;
  const height = 440;
  const plot = { left: 76, right: width - 200, top: 104, bottom: height - 64 };
  const series = [
    [STATE.original, original],
    [STATE.codeOnly, codeOnly],
    [STATE.optimized, optimized],
  ].map(([state, report]) => ({
    state,
    points: report.runs
      .filter((r) => r.suite === 'rate')
      .map((r) => ({ rate: r.rate, value: r.latencyMs.p95 })),
  }));
  const rates = [...new Set(series.flatMap((s) => s.points.map((p) => p.rate)))].sort((a, b) => a - b);
  const minRate = rates[0];
  const maxRate = rates.at(-1);
  const yTicks = [1, 10, 100, 1000, 10000, 100000];
  const logScale = (value, min, max, from, to) =>
    from + ((Math.log10(value) - Math.log10(min)) / (Math.log10(max) - Math.log10(min))) * (to - from);
  const x = (rate) => logScale(rate, minRate, maxRate, plot.left, plot.right);
  const y = (value) => logScale(Math.max(value, 1), yTicks[0], yTicks.at(-1), plot.bottom, plot.top);
  const yLabel = (value) => (value >= 1000 ? `${number(value / 1000, 0)} s` : `${number(value, 0)} ms`);

  const body = [
    text(28, 34, 'Tenue en charge : le point de saturation recule de 5 à plusieurs centaines de requêtes par seconde', { size: 16, fill: INK.primary, weight: 600 }),
    text(28, 56, 'Trafic mixte à débit imposé · 95ᵉ centile du temps de réponse · échelles logarithmiques', { size: 13, fill: INK.muted }),
    legend(plot.left, 82, series.map((s) => s.state)),
  ];
  for (const tick of yTicks) {
    body.push(`<line x1="${plot.left}" y1="${y(tick)}" x2="${plot.right}" y2="${y(tick)}" stroke="${GRID}" stroke-width="1"/>`);
    body.push(text(plot.left - 10, y(tick) + 4, yLabel(tick), { size: 12, fill: INK.muted, anchor: 'end', numeric: true }));
  }
  body.push(`<line x1="${plot.left}" y1="${plot.bottom}" x2="${plot.right}" y2="${plot.bottom}" stroke="${BASELINE}" stroke-width="1"/>`);
  for (const rate of rates) {
    body.push(`<line x1="${x(rate)}" y1="${plot.bottom}" x2="${x(rate)}" y2="${plot.bottom + 5}" stroke="${BASELINE}" stroke-width="1"/>`);
    body.push(text(x(rate), plot.bottom + 22, number(rate, 0), { size: 12, fill: INK.muted, anchor: 'middle', numeric: true }));
  }
  body.push(text((plot.left + plot.right) / 2, height - 14, 'Débit imposé (requêtes par seconde)', { size: 12, fill: INK.muted, anchor: 'middle' }));
  for (const { state, points } of series) {
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.rate).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    body.push(`<path d="${path}" fill="none" stroke="${state.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    for (const p of points) {
      body.push(`<circle cx="${x(p.rate).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="5" fill="${state.color}" stroke="${SURFACE}" stroke-width="2"/>`);
    }
    const last = points.at(-1);
    const label = `${yLabel(last.value)} à ${number(last.rate, 0)} req/s`;
    if (state === STATE.codeOnly) {
      // Cette série s'arrête au milieu du graphique : à droite, son étiquette
      // croiserait la courbe de l'état final.
      body.push(text(x(last.rate) + 6, y(last.value) - 14, label, { size: 12, fill: INK.primary, weight: 600, anchor: 'end', numeric: true }));
    } else {
      body.push(text(x(last.rate) + 14, y(last.value) + 4, label, { size: 12, fill: INK.primary, weight: 600, numeric: true }));
    }
  }
  save(
    'tenue-en-charge.svg',
    svg(
      width,
      height,
      'Temps de réponse au 95ᵉ centile selon le débit imposé',
      series.map((s) => `${s.state.label} : ${s.points.map((p) => `${p.rate} req/s ${ms(p.value)}`).join(', ')}`).join(' ; '),
      body.join('\n')
    )
  );
}
