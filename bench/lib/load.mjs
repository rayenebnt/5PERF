// Injecteur de charge HTTP minimal, sans dépendance.
//
// Deux modes :
//  - boucle fermée (`connections`) : N utilisateurs virtuels enchaînent les
//    requêtes ; mesure le débit maximal et la latence sous contention ;
//  - boucle ouverte (`rate`) : les requêtes partent à cadence fixe, que le
//    serveur suive ou non ; la latence est comptée depuis l'instant de départ
//    *prévu*, ce qui évite le biais dit d'« omission coordonnée ».
//
// Les latences sont mesurées à la microseconde (process.hrtime), ce qui reste
// lisible une fois l'application optimisée (réponses de l'ordre de la ms).

import http from 'node:http';
import { createRng } from './dataset.mjs';
import { createScenario } from './scenarios.mjs';

const REQUEST_TIMEOUT_MS = 120_000;
const IDLE_SOCKET_TIMEOUT_MS = 4_000;

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(target, agent, spec, extraHeaders) {
  return new Promise((resolve) => {
    const headers = { ...extraHeaders };
    if (spec.body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(spec.body);
    }
    const request = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: spec.path,
        method: spec.method,
        agent,
        headers,
      },
      (response) => {
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode, bytes })
        );
        response.on('error', (error) =>
          resolve({ status: 0, bytes, error: error.code ?? error.message })
        );
      }
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy());
    // Échec de transport (connexion refusée, coupée…) : statut 0.
    request.on('error', (error) =>
      resolve({ status: 0, bytes: 0, error: error.code ?? error.message })
    );
    request.end(spec.body);
  });
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1
  );
  return sorted[Math.max(0, index)];
}

const round = (value, digits = 3) =>
  value === null ? null : Number(value.toFixed(digits));

function summarize(latencies) {
  const sorted = Float64Array.from(latencies).sort();
  const count = sorted.length;
  const mean = count ? sorted.reduce((a, b) => a + b, 0) / count : null;
  return {
    min: round(count ? sorted[0] : null),
    mean: round(mean),
    p50: round(percentile(sorted, 0.5)),
    p75: round(percentile(sorted, 0.75)),
    p90: round(percentile(sorted, 0.9)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(count ? sorted[count - 1] : null),
  };
}

/**
 * Exécute un tir de charge et renvoie ses statistiques.
 *
 * @param {object} options
 * @param {string} options.url          URL de base du serveur testé
 * @param {string} options.scenario     nom du scénario (voir scenarios.mjs)
 * @param {number} [options.connections] boucle fermée : utilisateurs virtuels
 * @param {number} [options.rate]        boucle ouverte : requêtes par seconde
 * @param {number} [options.duration]    durée de mesure, en secondes
 * @param {number} [options.warmup]      durée d'échauffement, en secondes
 * @param {number} [options.seed]        graine du générateur de requêtes
 * @param {boolean} [options.gzip]       demander une réponse compressée
 * @param {Function} [options.onWindowStart] appelé au début de la mesure
 */
export async function runLoad(options) {
  const {
    url,
    scenario,
    connections = 1,
    rate = null,
    duration = 10,
    warmup = 2,
    seed = 1,
    gzip = false,
    onWindowStart = null,
  } = options;

  const target = new URL(url);
  const nextRequest = createScenario(scenario);
  const rng = createRng(seed);
  const extraHeaders = gzip ? { 'accept-encoding': 'gzip' } : {};
  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: rate ? 2000 : connections,
    // Node.js ferme côté serveur une connexion inactive depuis 5 s. La
    // réutiliser à cet instant précis coupe la requête (ECONNRESET) : on
    // abandonne donc de nous-mêmes toute connexion inactive depuis 4 s.
    timeout: IDLE_SOCKET_TIMEOUT_MS,
  });

  const latencies = [];
  const statuses = {};
  const transportErrors = {};
  let bytes = 0;
  let completedInWindow = 0;
  let failures = 0;

  const start = nowMs();
  const windowStart = start + warmup * 1000;
  const windowEnd = windowStart + duration * 1000;
  let windowStarted = false;

  const record = (startedAt, result) => {
    const finishedAt = nowMs();
    if (startedAt < windowStart) {
      return;
    }
    latencies.push(finishedAt - startedAt);
    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    if (result.error) {
      transportErrors[result.error] = (transportErrors[result.error] ?? 0) + 1;
    }
    bytes += result.bytes;
    if (result.status < 200 || result.status >= 300) {
      failures += 1;
    }
    if (finishedAt <= windowEnd) {
      completedInWindow += 1;
    }
  };

  const markWindow = async () => {
    if (!windowStarted && nowMs() >= windowStart) {
      windowStarted = true;
      if (onWindowStart) {
        await onWindowStart();
      }
    }
  };

  if (rate) {
    // Boucle ouverte : la requête n° i part à l'instant start + i / rate.
    const intervalMs = 1000 / rate;
    const pending = new Set();
    for (let i = 0; ; i += 1) {
      const scheduledAt = start + i * intervalMs;
      if (scheduledAt >= windowEnd) {
        break;
      }
      const wait = scheduledAt - nowMs();
      if (wait > 0) {
        await sleep(wait);
      }
      await markWindow();
      const promise = send(target, agent, nextRequest(rng), extraHeaders).then(
        (result) => {
          record(scheduledAt, result);
          pending.delete(promise);
        }
      );
      pending.add(promise);
    }
    await Promise.all(pending);
  } else {
    // Boucle fermée : chaque utilisateur virtuel attend sa réponse avant
    // d'envoyer la requête suivante.
    const worker = async () => {
      while (nowMs() < windowEnd) {
        await markWindow();
        const startedAt = nowMs();
        const result = await send(target, agent, nextRequest(rng), extraHeaders);
        record(startedAt, result);
      }
    };
    await Promise.all(Array.from({ length: connections }, worker));
  }

  const drainedAt = nowMs();
  agent.destroy();

  const requests = latencies.length;
  return {
    scenario,
    mode: rate ? 'open' : 'closed',
    connections: rate ? null : connections,
    rate,
    durationSeconds: duration,
    requests,
    failures,
    statuses,
    transportErrors,
    // Débit réellement servi pendant la fenêtre de mesure.
    throughputRps: round(completedInWindow / duration, 2),
    // Temps nécessaire pour finir les requêtes encore en vol à la fin de la
    // fenêtre : un grand nombre signale un serveur saturé.
    drainSeconds: round(Math.max(0, drainedAt - windowEnd) / 1000, 2),
    meanResponseBytes: requests ? Math.round(bytes / requests) : null,
    latencyMs: summarize(latencies),
  };
}
