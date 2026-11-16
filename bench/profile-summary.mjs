#!/usr/bin/env node
// Résume un profil CPU V8 (`node --cpu-prof`) : répartition du temps CPU par
// famille de code, puis fonctions les plus coûteuses.
//
//   node --cpu-prof --cpu-prof-dir=./profils dist/index.js   # puis tir de charge
//   node bench/profile-summary.mjs ./profils/CPU.xxx.cpuprofile [--json sortie.json]
//
// Chaque échantillon est attribué à la bibliothèque la plus proche dans la
// pile d'appels : le temps passé dans une fonction native appelée par dayjs
// (par exemple le constructeur Date) est ainsi bien compté pour dayjs.

import { readFileSync, writeFileSync } from 'node:fs';

const CATEGORIES = [
  ['Filtrage des dates en mémoire (dayjs)', /node_modules\/dayjs\//],
  ['Validation Zod de chaque ligne', /node_modules\/zod\//],
  [
    'Pilote PostgreSQL (décodage des lignes reçues)',
    /node_modules\/(pg|pg-protocol|pg-types|pg-pool|postgres-[a-z]+)\//,
  ],
  ['Journalisation (morgan / winston)', /node_modules\/(morgan|winston|winston-transport|logform|triple-beam|readable-stream|safe-stable-stringify|fecha)\//],
  ['Framework HTTP (express et middlewares)', /node_modules\/(express|body-parser|router|zod-express-middleware|finalhandler|etag|fresh|send|on-finished)\//],
  ['Code applicatif (service / contrôleur)', /\/(src|dist)\/weather\//],
];

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error('Usage : node bench/profile-summary.mjs <fichier.cpuprofile> [--json sortie.json]');
  process.exit(1);
}
const jsonOut = rest[0] === '--json' ? rest[1] : null;

const profile = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parents = new Map();
for (const node of profile.nodes) {
  for (const child of node.children ?? []) {
    parents.set(child, node.id);
  }
}

function leafCategory(node) {
  const { functionName, url } = node.callFrame;
  if (functionName === '(idle)') return 'idle';
  if (functionName === '(garbage collector)') return 'Ramasse-miettes (GC)';
  // Attente du chargeur de modules au démarrage : hors traitement des requêtes.
  if (url.startsWith('node:internal/modules/esm/')) return 'idle';
  return null;
}

const categoryCache = new Map();
function categorize(id) {
  if (categoryCache.has(id)) {
    return categoryCache.get(id);
  }
  const leaf = nodes.get(id);
  let category = leafCategory(leaf);
  // JSON.stringify est une fonction native : on la repère par son nom.
  for (let current = id; category === null && current !== undefined; current = parents.get(current)) {
    const { url, functionName } = nodes.get(current).callFrame;
    if (functionName === 'stringify' && url === '') {
      category = 'Sérialisation JSON de la réponse';
      break;
    }
    const match = CATEGORIES.find(([, pattern]) => pattern.test(url));
    if (match) {
      category = match[0];
    }
  }
  category ??= 'Runtime Node.js (réseau, flux, divers)';
  categoryCache.set(id, category);
  return category;
}

const byCategory = new Map();
const byFunction = new Map();
let total = 0;
for (let i = 0; i < profile.samples.length; i += 1) {
  const delta = profile.timeDeltas[i] / 1000; // µs -> ms
  const id = profile.samples[i];
  const category = categorize(id);
  if (category === 'idle') {
    continue;
  }
  total += delta;
  byCategory.set(category, (byCategory.get(category) ?? 0) + delta);
  const { functionName, url, lineNumber } = nodes.get(id).callFrame;
  const where = url ? `${url.replace(/^.*node_modules\//, '')}:${lineNumber + 1}` : 'natif';
  const key = `${functionName || '(anonyme)'} — ${where}`;
  byFunction.set(key, (byFunction.get(key) ?? 0) + delta);
}

const share = (ms) => `${((ms / total) * 100).toFixed(1)} %`;
const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

console.log(`Temps CPU actif analysé : ${total.toFixed(0)} ms\n`);
console.log('Répartition par famille de code');
for (const [category, ms] of sorted(byCategory)) {
  console.log(`  ${share(ms).padStart(7)}  ${ms.toFixed(0).padStart(7)} ms  ${category}`);
}
console.log('\nFonctions les plus coûteuses (temps propre)');
for (const [name, ms] of sorted(byFunction).slice(0, 15)) {
  console.log(`  ${share(ms).padStart(7)}  ${ms.toFixed(0).padStart(7)} ms  ${name}`);
}

if (jsonOut) {
  writeFileSync(
    jsonOut,
    `${JSON.stringify(
      {
        activeCpuMs: Number(total.toFixed(0)),
        categories: sorted(byCategory).map(([name, ms]) => ({
          name,
          ms: Number(ms.toFixed(0)),
          share: Number((ms / total).toFixed(4)),
        })),
        topFunctions: sorted(byFunction)
          .slice(0, 15)
          .map(([name, ms]) => ({
            name,
            ms: Number(ms.toFixed(0)),
            share: Number((ms / total).toFixed(4)),
          })),
      },
      null,
      2
    )}\n`
  );
}
