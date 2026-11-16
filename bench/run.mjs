#!/usr/bin/env node
// Exécute les suites de mesure contre un serveur déjà démarré et enregistre
// les résultats au format JSON.
//
//   node bench/run.mjs --label original --url http://localhost:3000 \
//        [--suites latency,load,depth,ingest] [--rates 5,10,20] \
//        [--pid <pid du serveur>] [--probe-file <fichier de bench/probe.mjs>] \
//        [--out bench/results/original.json]
//
// --pid active les mesures côté serveur (CPU Node et PostgreSQL par requête,
// pic mémoire) ; --probe-file y ajoute le retard de la boucle d'événements et
// l'activité du ramasse-miettes (le serveur doit avoir préchargé la sonde).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname } from 'node:path';
import { DEPTH_STATIONS } from './lib/dataset.mjs';
import { runLoad } from './lib/load.mjs';
import { peakRssMb, postgresCpuMs, processTreeCpuMs } from './lib/procstat.mjs';

const READ_SCENARIOS = [
  'data-30d',
  'data-1y',
  'data-full',
  'avg-1y',
  'avg-full',
  'max-full',
  'min-10y',
];

const SUITES = {
  // Latence « à vide » : un seul utilisateur, requêtes en série.
  latency: READ_SCENARIOS.map((scenario) => ({
    scenario,
    connections: 1,
    duration: 8,
    warmup: 2,
  })),
  // Charge : 20 utilisateurs simultanés.
  load: [...READ_SCENARIOS, 'mixed'].map((scenario) => ({
    scenario,
    connections: 20,
    duration: 15,
    warmup: 3,
  })),
  // Scalabilité : même requête, profondeur d'historique croissante.
  depth: DEPTH_STATIONS.flatMap(({ name }) => {
    const suffix = name.replace('Bench-', '');
    return [`depth-avg-${suffix}`, `depth-data-${suffix}`].map((scenario) => ({
      scenario,
      connections: 1,
      duration: 5,
      warmup: 1,
    }));
  }),
  // Écriture : vérifie que l'ingestion par les robots n'est pas dégradée.
  ingest: [1, 10].map((connections) => ({
    scenario: 'ingest',
    connections,
    duration: 8,
    warmup: 1,
  })),
};

function parseArgs(argv) {
  const args = {
    label: 'run',
    url: 'http://localhost:3000',
    suites: 'latency,load,depth,ingest',
    rates: '',
    pid: null,
    'probe-file': null,
    out: null,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args)) {
      throw new Error(`Option inconnue : ${argv[i]}`);
    }
    args[key] = argv[i + 1];
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = parseArgs(process.argv.slice(2));
const pid = args.pid ? Number(args.pid) : null;
const probeFile = args['probe-file'];

async function flushProbe() {
  if (!pid || !probeFile) {
    return null;
  }
  process.kill(pid, 'SIGUSR2');
  await sleep(150);
  try {
    return JSON.parse(readFileSync(probeFile, 'utf8'));
  } catch {
    return null;
  }
}

async function measure(suite, plan) {
  let before = null;
  const result = await runLoad({
    url: args.url,
    ...plan,
    onWindowStart: async () => {
      before = { node: pid ? processTreeCpuMs(pid) : null, pg: postgresCpuMs() };
      if (pid && probeFile) {
        process.kill(pid, 'SIGUSR2'); // remet la sonde à zéro
      }
    },
  });
  const probe = await flushProbe();
  const perRequest = (deltaMs) =>
    result.requests ? Number((deltaMs / result.requests).toFixed(3)) : null;
  const server = {
    nodeCpuMsPerRequest: pid ? perRequest(processTreeCpuMs(pid) - before.node) : null,
    postgresCpuMsPerRequest: perRequest(postgresCpuMs() - before.pg),
    processPeakRssMb: pid ? peakRssMb(pid) : null,
    ...(probe ?? {}),
  };
  return { suite, ...result, server };
}

function describe(run) {
  const load = run.rate ? `${run.rate} req/s` : `${run.connections} conn.`;
  const l = run.latencyMs;
  return (
    `${run.suite.padEnd(8)} ${run.scenario.padEnd(15)} ${load.padEnd(10)} ` +
    `débit ${String(run.throughputRps).padStart(8)} req/s  ` +
    `p50 ${String(l.p50).padStart(9)} ms  p95 ${String(l.p95).padStart(9)} ms  ` +
    `p99 ${String(l.p99).padStart(9)} ms  échecs ${run.failures}`
  );
}

const plans = [];
for (const suite of args.suites.split(',').filter(Boolean)) {
  if (!SUITES[suite]) {
    throw new Error(`Suite inconnue : ${suite}`);
  }
  plans.push(...SUITES[suite].map((plan) => [suite, plan]));
}
// Paliers de charge à débit imposé (boucle ouverte) sur le trafic mixte.
for (const rate of args.rates.split(',').filter(Boolean).map(Number)) {
  plans.push(['rate', { scenario: 'mixed', rate, duration: 20, warmup: 3 }]);
}

const report = {
  label: args.label,
  url: args.url,
  startedAt: new Date().toISOString(),
  machine: {
    cpu: os.cpus()[0]?.model ?? 'inconnu',
    cores: os.cpus().length,
    memoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    injectorNode: process.version,
  },
  runs: [],
};

for (const [suite, plan] of plans) {
  const run = await measure(suite, plan);
  report.runs.push(run);
  console.log(describe(run));
  await sleep(500);
}

if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Résultats enregistrés dans ${args.out}`);
}
