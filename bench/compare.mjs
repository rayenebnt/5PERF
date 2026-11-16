#!/usr/bin/env node
// Test de non-régression différentiel : envoie les mêmes requêtes à
// l'application d'origine (référence) et à la version optimisée (candidate),
// branchées sur des bases au contenu identique, puis compare les réponses.
//
//   node bench/compare.mjs --reference http://localhost:3000 \
//                          --candidate http://localhost:3001 [--requests 400] [--seed 1]
//
// Les réponses doivent être identiques (code HTTP et corps JSON). Deux écarts
// sont attendus et comptés à part :
//  - /max et /min sur une période sans mesure : l'origine plante (HTTP 500),
//    la version optimisée répond 200 avec `null`, comme le fait déjà /avg ;
//  - /avg : PostgreSQL calcule la moyenne en décimal exact alors que l'origine
//    additionnait des flottants ; l'écart toléré est de 1e-9 en relatif.

import {
  DEFAULTS,
  DEPTH_STATIONS,
  addDays,
  createRng,
  daysBetween,
  locationNames,
} from './lib/dataset.mjs';

function parseArgs(argv) {
  const args = { reference: null, candidate: null, requests: '400', seed: '1' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args)) {
      throw new Error(`Option inconnue : ${argv[i]}`);
    }
    args[key] = argv[i + 1];
  }
  if (!args.reference || !args.candidate) {
    throw new Error('--reference et --candidate sont obligatoires');
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const rng = createRng(Number(args.seed));
const pick = (items) => items[Math.floor(rng() * items.length)];

const LOCATIONS = [
  ...locationNames(DEFAULTS.locations),
  ...DEPTH_STATIONS.map((station) => station.name),
];
const ROUTES = ['data', 'avg', 'max', 'min'];
const TOTAL_DAYS = daysBetween(DEFAULTS.start, DEFAULTS.end);

function randomDay() {
  // Déborde volontairement de l'historique, avant comme après.
  return addDays(DEFAULTS.start, Math.floor(rng() * (TOTAL_DAYS + 800)) - 400);
}

// Différentes écritures d'une même borne, toutes acceptées par l'API.
function formatBound(day) {
  return pick([
    () => day,
    () => day,
    () => day,
    () => `${day}T00:00:00Z`,
    () => `${day}T13:45:10.250Z`,
    () => `${day}T08:30:00+02:00`,
    () => `${day}T23:59:59`,
    () => `${day} 06:15`,
    () => day.replaceAll('-', '/'),
  ])();
}

function randomQuery() {
  const shape = pick(['none', 'from', 'to', 'both', 'both', 'both', 'short', 'inverted']);
  const params = new URLSearchParams();
  if (shape === 'from' || shape === 'both') {
    params.set('from', formatBound(randomDay()));
  }
  if (shape === 'to' || shape === 'both') {
    params.set('to', formatBound(randomDay()));
  }
  if (shape === 'short') {
    const from = randomDay();
    params.set('from', formatBound(from));
    params.set('to', formatBound(addDays(from, pick([0, 1, 2, 7, 30, 365]))));
  }
  if (shape === 'inverted') {
    const to = randomDay();
    params.set('from', formatBound(addDays(to, pick([1, 30, 400]))));
    params.set('to', formatBound(to));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

const paths = [];
for (let i = 0; i < Number(args.requests); i += 1) {
  paths.push(
    `/weather/${pick(ROUTES)}/${encodeURIComponent(pick(LOCATIONS))}${randomQuery()}`
  );
}

// Cas limites fixes : bornes exactes de l'historique, lieux inconnus,
// caractères spéciaux, paramètres invalides, routes inexistantes.
for (const route of ROUTES) {
  paths.push(
    `/weather/${route}/Lyon`,
    `/weather/${route}/Lyon?from=${DEFAULTS.start}`,
    `/weather/${route}/Lyon?to=${DEFAULTS.start}`,
    `/weather/${route}/Lyon?from=${DEFAULTS.end}`,
    `/weather/${route}/Lyon?to=${DEFAULTS.end}`,
    `/weather/${route}/Lyon?from=${addDays(DEFAULTS.end, -1)}&to=${DEFAULTS.end}`,
    `/weather/${route}/Lyon?from=2030-01-01`,
    `/weather/${route}/Lyon?to=1900-01-01`,
    `/weather/${route}/Lyon?from=2001-02-03&to=2001-02-03`,
    `/weather/${route}/Lyon?from=2023`,
    `/weather/${route}/Lyon?from=2010-06&to=2010-07`,
    `/weather/${route}/Lyon?from[]=2015-01-01`,
    `/weather/${route}/Lyon?from=`,
    `/weather/${route}/Lyon?from=hier`,
    `/weather/${route}/Lyon?from=2015-01-01&from=2016-01-01`,
    `/weather/${route}/Lyon?to=2015-02-30`,
    `/weather/${route}/Lyon?inconnu=1&to=2015-03-01`,
    `/weather/${route}/Lieu-Inconnu`,
    `/weather/${route}/Lieu-Inconnu?from=2015-01-01&to=2015-12-31`,
    `/weather/${route}/lyon`,
    `/weather/${route}/${encodeURIComponent('Saint-Étienne')}?from=2020-01-01&to=2020-01-31`,
    `/weather/${route}/${encodeURIComponent('Le Havre')}?from=2020-01-01&to=2020-01-31`,
    `/weather/${route}/${encodeURIComponent("Lyon' OR '1'='1")}`,
    `/weather/${route}/Bench-01y?to=2023-06-30`,
    `/weather/${route}/Bench-01y?to=2022-06-30`
  );
}
paths.push('/weather/inconnu/Lyon', '/weather/data', '/autre', '/');

async function call(base, path) {
  const response = await fetch(new URL(path, base));
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Corps non JSON (« Not Found », « Internal Server Error »…).
  }
  return { status: response.status, body };
}

function equal(a, b, tolerance) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) {
      return true;
    }
    return Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b), 1);
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a === b;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  // L'ordre des clés et des lignes fait partie de la comparaison.
  return (
    keysA.length === keysB.length &&
    keysA.every((key, index) => key === keysB[index] && equal(a[key], b[key], tolerance))
  );
}

const stats = { identical: 0, withinTolerance: 0, fixedCrash: 0, unexpected: [] };
const statusCount = {};
let largestAverageGap = 0;

for (const path of paths) {
  const [reference, candidate] = await Promise.all([
    call(args.reference, path),
    call(args.candidate, path),
  ]);
  statusCount[reference.status] = (statusCount[reference.status] ?? 0) + 1;
  const isAverage = path.startsWith('/weather/avg/');
  const isExtremum = /^\/weather\/(max|min)\//.test(path);

  if (reference.status === candidate.status && equal(reference.body, candidate.body, 0)) {
    stats.identical += 1;
  } else if (
    isAverage &&
    reference.status === candidate.status &&
    equal(reference.body, candidate.body, 1e-9)
  ) {
    stats.withinTolerance += 1;
    const [a, b] = [reference.body.avg, candidate.body.avg];
    largestAverageGap = Math.max(
      largestAverageGap,
      Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1)
    );
  } else if (
    isExtremum &&
    reference.status === 500 &&
    candidate.status === 200 &&
    Object.values(candidate.body).every((value) => value === null)
  ) {
    stats.fixedCrash += 1;
  } else {
    stats.unexpected.push({ path, reference, candidate });
  }
}

console.log(`Requêtes comparées            : ${paths.length}`);
console.log(`Codes HTTP de la référence    : ${JSON.stringify(statusCount)}`);
console.log(`Réponses strictement égales   : ${stats.identical}`);
console.log(`Moyennes égales à 1e-9 près   : ${stats.withinTolerance}`);
console.log(`  dont écart relatif maximal  : ${largestAverageGap.toExponential(1)}`);
console.log(`Plantages corrigés (500->200) : ${stats.fixedCrash}`);
console.log(`Écarts inattendus             : ${stats.unexpected.length}`);
for (const { path, reference, candidate } of stats.unexpected.slice(0, 10)) {
  const shorten = (value) => JSON.stringify(value).slice(0, 200);
  console.log(`\n  ${path}`);
  console.log(`    référence : ${reference.status} ${shorten(reference.body)}`);
  console.log(`    candidate : ${candidate.status} ${shorten(candidate.body)}`);
}
process.exit(stats.unexpected.length === 0 ? 0 : 1);
