#!/usr/bin/env node
// Met en forme les résultats de mesure (JSON) en tableaux Markdown.
//
//   node bench/report.mjs [dossier des résultats] > docs/benchmarks/README.md
//
// Les tableaux du rapport de performance sont copiés depuis cette sortie :
// aucun chiffre n'y est saisi à la main.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'docs/benchmarks';
const load = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

const STATES = [
  { key: 'original', label: 'Origine', report: load('original.json') },
  { key: 'optimized-code-only', label: 'Code optimisé seul', report: load('optimized-code-only.json') },
  { key: 'optimized', label: 'Code optimisé + migration', report: load('optimized.json') },
];
const [before, , after] = STATES;

const SCENARIOS = {
  'data-30d': ['Consultation, fenêtre de 30 jours', '30'],
  'data-1y': ['Consultation, fenêtre d’un an', '365'],
  'data-full': ['Export de tout l’historique (40 ans)', '14 610'],
  'avg-1y': ['Moyenne sur un an', '1'],
  'avg-full': ['Moyenne sur tout l’historique', '1'],
  'max-full': ['Maximum sur tout l’historique', '1'],
  'min-10y': ['Minimum sur dix ans', '1'],
  mixed: ['Trafic mixte', '—'],
};

const number = (value, digits) =>
  new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
// À l'unité à partir de 100, trois chiffres significatifs en dessous :
// 2 255 · 177 · 68,6 · 1,77 · 0,42.
function compact(raw) {
  if (raw === null || raw === undefined) return '—';
  if (raw >= 99.95) return number(raw, 0);
  const value = Number(raw.toPrecision(3));
  return value >= 10 ? number(value, 1) : number(value, 2);
}
const ratio = (a, b) => {
  const r = a / b;
  return r >= 10 ? `× ${number(r, 0)}` : `× ${number(r, 1)}`;
};
const find = (report, suite, scenario, key, value) =>
  report.runs.find((r) => r.suite === suite && r.scenario === scenario && r[key] === value);

function table(headers, rows, align) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  const rule = headers.map((_, i) => ((align?.[i] ?? 'r') === 'l' ? ':---' : '---:'));
  return [line(headers), line(rule), ...rows.map(line)].join('\n');
}

const out = [];
// Une ligne vide sépare chaque paragraphe et chaque tableau.
const section = (title, ...blocks) =>
  out.push(`## ${title}`, '', ...blocks.filter(Boolean).flatMap((block) => [block, '']));

out.push(
  '# Résultats de mesure',
  '',
  '> Fichier généré par `node bench/report.mjs` à partir des fichiers JSON de ce dossier.',
  '> Ne pas modifier à la main : relancer la campagne puis la commande.',
  '',
  `Machine de mesure : ${before.report.machine.cpu}, ${before.report.machine.cores} cœurs, ` +
    `${number(before.report.machine.memoryGb, 0)} Go de mémoire. Campagne du ${before.report.startedAt.slice(0, 10)}.`,
  ''
);

// ------------------------------------------------------------ latence à vide
section(
  'Temps de réponse, un utilisateur',
  'Requêtes envoyées en série par un seul utilisateur (8 s de mesure après 2 s d’échauffement). Temps en millisecondes.',
  table(
    ['Scénario', 'Lignes renvoyées', ...STATES.flatMap((s) => [`${s.label} — médiane`, 'p95']), 'Gain (médiane)'],
    Object.keys(SCENARIOS)
      .filter((key) => key !== 'mixed')
      .map((key) => {
        const runs = STATES.map((s) => find(s.report, 'latency', key, 'connections', 1));
        return [
          SCENARIOS[key][0],
          SCENARIOS[key][1],
          ...runs.flatMap((r) => [compact(r.latencyMs.p50), compact(r.latencyMs.p95)]),
          ratio(runs[0].latencyMs.p50, runs[2].latencyMs.p50),
        ];
      }),
    ['l']
  )
);

// ------------------------------------------------------------------- charge
section(
  'Charge : 20 utilisateurs simultanés',
  'Vingt utilisateurs enchaînent les requêtes sans pause (15 s de mesure après 3 s d’échauffement). Débit en requêtes par seconde, temps en millisecondes.',
  table(
    ['Scénario', ...STATES.flatMap((s) => [`${s.label} — débit`, 'médiane', 'p95']), 'Gain (débit)'],
    Object.keys(SCENARIOS).map((key) => {
      const runs = STATES.map((s) => find(s.report, 'load', key, 'connections', 20));
      return [
        SCENARIOS[key][0],
        ...runs.flatMap((r) => [compact(r.throughputRps), compact(r.latencyMs.p50), compact(r.latencyMs.p95)]),
        ratio(runs[2].throughputRps, runs[0].throughputRps),
      ];
    }),
    ['l']
  )
);

// ------------------------------------------------------- coût par requête
section(
  'Coût CPU d’une requête',
  'Temps processeur consommé par requête pendant les tirs à 20 utilisateurs, mesuré dans `/proc` : processus Node.js d’une part, ensemble des processus PostgreSQL d’autre part. En millisecondes de CPU.',
  table(
    ['Scénario', ...STATES.flatMap((s) => [`${s.label} — Node.js`, 'PostgreSQL'])],
    Object.keys(SCENARIOS).map((key) => [
      SCENARIOS[key][0],
      ...STATES.flatMap((s) => {
        const r = find(s.report, 'load', key, 'connections', 20);
        return [compact(r.server.nodeCpuMsPerRequest), compact(r.server.postgresCpuMsPerRequest)];
      }),
    ]),
    ['l']
  )
);

// -------------------------------------------- boucle d'événements, mémoire
section(
  'Boucle d’événements et mémoire',
  'Mesures de la sonde `bench/probe.mjs` pendant le tir « trafic mixte, 20 utilisateurs ».',
  table(
    ['Indicateur', ...STATES.map((s) => s.label)],
    [
      ['Retard maximal de la boucle d’événements (ms)', (r) => compact(r.server.eventLoopLagMs?.max)],
      ['Retard de la boucle d’événements, p99 (ms)', (r) => compact(r.server.eventLoopLagMs?.p99)],
      ['Temps passé en ramasse-miettes pendant le tir (ms)', (r) => compact(r.server.gc?.pauseMs)],
      ['Pic de tas JavaScript (Mo)', (r) => compact(r.server.peakHeapUsedMb)],
      ['Pic de mémoire résidente du processus (Mo)', (r) => compact(r.server.peakRssMb)],
    ].map(([label, pick]) => [
      label,
      ...STATES.map((s) => pick(find(s.report, 'load', 'mixed', 'connections', 20))),
    ]),
    ['l']
  )
);

// ------------------------------------------------------------- profondeur
section(
  'Scalabilité : effet de la profondeur d’historique',
  'Même requête (30 derniers jours) sur des lieux dont seul le volume d’historique change. Temps de réponse médian en millisecondes, un utilisateur.',
  table(
    ['Historique du lieu', 'Mesures stockées', ...STATES.flatMap((s) => [`${s.label} — moyenne`, 'consultation'])],
    [1, 2, 5, 10, 20, 40].map((years) => {
      const suffix = `${String(years).padStart(2, '0')}y`;
      return [
        years === 1 ? '1 an' : `${years} ans`,
        number({ 1: 365, 2: 730, 5: 1826, 10: 3652, 20: 7305, 40: 14610 }[years], 0),
        ...STATES.flatMap((s) => [
          compact(find(s.report, 'depth', `depth-avg-${suffix}`, 'connections', 1).latencyMs.p50),
          compact(find(s.report, 'depth', `depth-data-${suffix}`, 'connections', 1).latencyMs.p50),
        ]),
      ];
    }),
    ['l']
  )
);

// ----------------------------------------------------------- débit imposé
{
  const rates = [...new Set(STATES.flatMap((s) => s.report.runs.filter((r) => r.suite === 'rate').map((r) => r.rate)))].sort((a, b) => a - b);
  section(
    'Tenue en charge à débit imposé',
    'Trafic mixte envoyé à cadence fixe pendant 20 s, que le serveur suive ou non (boucle ouverte) : le temps de réponse est compté depuis l’instant d’envoi prévu. « Servi » : débit réellement traité pendant la fenêtre. Une case vide signifie que le palier n’a pas été mesuré pour cet état.',
    table(
      ['Débit imposé (req/s)', ...STATES.flatMap((s) => [`${s.label} — servi`, 'médiane (ms)', 'p95 (ms)'])],
      rates.map((rate) => [
        number(rate, 0),
        ...STATES.flatMap((s) => {
          const r = find(s.report, 'rate', 'mixed', 'rate', rate);
          return r ? [compact(r.throughputRps), compact(r.latencyMs.p50), compact(r.latencyMs.p95)] : ['', '', ''];
        }),
      ])
    )
  );
}

// --------------------------------------------------------------- écriture
section(
  'Écriture : ingestion des mesures',
  '`POST /weather/data`, une mesure par requête. Vérifie que la clé primaire couvrante ne pénalise pas les robots d’ingestion.',
  table(
    ['Robots simultanés', ...STATES.flatMap((s) => [`${s.label} — débit`, 'médiane (ms)', 'p95 (ms)'])],
    [1, 10].map((connections) => [
      String(connections),
      ...STATES.flatMap((s) => {
        const r = find(s.report, 'ingest', 'ingest', 'connections', connections);
        return [compact(r.throughputRps), compact(r.latencyMs.p50), compact(r.latencyMs.p95)];
      }),
    ])
  )
);

// -------------------------------------------------------------------- SQL
for (const state of STATES) {
  const file = `sql-${state.key}.json`;
  if (!existsSync(join(dir, file))) continue;
  section(
    `Requêtes SQL exécutées — ${state.label}`,
    'Statistiques `pg_stat_statements` cumulées sur toute la campagne de cet état. Temps en millisecondes ; « blocs » : pages de 8 ko lues par appel.',
    table(
      ['Requête', 'Appels', 'Exécution moyenne', 'Lignes par appel', 'Blocs par appel'],
      load(file).map((row) => [
        `\`${row.query.length > 92 ? `${row.query.slice(0, 89)}…` : row.query}\``,
        number(row.calls, 0),
        compact(Number(row.mean_exec_ms)),
        compact(Number(row.rows_per_call)),
        compact(Number(row.blocks_per_call)),
      ]),
      ['l']
    )
  );
}

// ------------------------------------------------------------- profil CPU
if (existsSync(join(dir, 'profile-original.json')) && existsSync(join(dir, 'profile-optimized.json'))) {
  const profiles = [load('profile-original.json'), load('profile-optimized.json')];
  const names = [...new Set(profiles.flatMap((p) => p.categories.map((c) => c.name)))];
  const share = (p, name) => {
    const category = p.categories.find((c) => c.name === name);
    return category ? `${number(category.share * 100, 1)} %` : '—';
  };
  section(
    'Profil CPU du processus Node.js',
    'Trafic mixte, un utilisateur, 25 s (profil V8 `--cpu-prof`, résumé par `bench/profile-summary.mjs`). Part du temps CPU actif.',
    table(
      ['Famille de code', 'Origine', 'Code optimisé + migration'],
      names.map((name) => [name, share(profiles[0], name), share(profiles[1], name)]),
      ['l']
    ),
    '',
    `Temps CPU actif sur la durée du profil : ${number(profiles[0].activeCpuMs, 0)} ms à l’origine, ${number(profiles[1].activeCpuMs, 0)} ms après optimisation (pour un nombre de requêtes servies très supérieur).`
  );
}

section(
  'Autres fichiers de ce dossier',
  table(
    ['Fichier', 'Contenu'],
    [
      ['`original.json`, `optimized-code-only.json`, `optimized.json`', 'Résultats détaillés de chaque tir pour les trois états (centiles, CPU, mémoire, boucle d’événements)'],
      ['`sql-*.json`', 'Statistiques `pg_stat_statements` de chaque état'],
      ['`profile-*.json`', 'Résumés des profils CPU (`bench/profile-summary.mjs`)'],
      ['`explain.txt`', 'Plans d’exécution de référence, avant et après migration'],
      ['`compare.txt`, `compare-timezones.txt`', 'Comparaisons différentielles origine / optimisé (`bench/compare.mjs`)'],
      ['`secondary.txt`', 'État final : compression, pagination, mise à l’échelle sur 1 à 3 processus'],
      ['`secondary-variants.txt`', 'Comparaisons A/B : requêtes préparées, journal d’accès'],
      ['`recheck-300.json`, `recheck-300-injecteur-corrige.json`', 'Palier à 300 req/s rejoué, avant et après correction de l’injecteur (connexions inactives)'],
    ],
    ['l', 'l']
  )
);

console.log(out.join('\n'));
