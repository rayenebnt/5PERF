// Scénarios de charge : chaque scénario fabrique une requête à partir d'un
// générateur pseudo-aléatoire, pour que deux exécutions soient identiques.

import {
  DEFAULTS,
  DEPTH_STATIONS,
  addDays,
  daysBetween,
  locationNames,
} from './dataset.mjs';

const LOCATIONS = locationNames(DEFAULTS.locations);
const TOTAL_DAYS = daysBetween(DEFAULTS.start, DEFAULTS.end);

function pickLocation(rng) {
  return LOCATIONS[Math.floor(rng() * LOCATIONS.length)];
}

// Fenêtre de `days` jours tirée au hasard dans l'historique. `from` est
// exclusif et `to` inclusif dans l'API : la fenêtre contient `days` mesures.
function pickWindow(rng, days) {
  const offset = Math.floor(rng() * (TOTAL_DAYS - days));
  const from = addDays(DEFAULTS.start, offset);
  return { from, to: addDays(from, days) };
}

function get(route, location, window) {
  const query = window ? `?from=${window.from}&to=${window.to}` : '';
  return {
    method: 'GET',
    path: `/weather/${route}/${encodeURIComponent(location)}${query}`,
  };
}

// Dernier mois de l'historique : présent pour toutes les stations de l'étude
// de scalabilité, quelle que soit leur profondeur.
const LAST_MONTH = { from: addDays(DEFAULTS.end, -30), to: DEFAULTS.end };

const base = {
  // Consultation d'un mois de mesures (30 lignes renvoyées).
  'data-30d': (rng) => get('data', pickLocation(rng), pickWindow(rng, 30)),
  // Consultation d'une année de mesures (365 lignes renvoyées).
  'data-1y': (rng) => get('data', pickLocation(rng), pickWindow(rng, 365)),
  // Export de tout l'historique d'un lieu (14 610 lignes renvoyées).
  'data-full': (rng) => get('data', pickLocation(rng)),
  // Même export, mais paginé : première page de 1 000 mesures (`limit`).
  'data-page': (rng) => {
    const request = get('data', pickLocation(rng));
    return { ...request, path: `${request.path}?limit=1000` };
  },
  // Température moyenne sur une année.
  'avg-1y': (rng) => get('avg', pickLocation(rng), pickWindow(rng, 365)),
  // Température moyenne sur tout l'historique.
  'avg-full': (rng) => get('avg', pickLocation(rng)),
  // Record de chaleur sur tout l'historique.
  'max-full': (rng) => get('max', pickLocation(rng)),
  // Record de froid sur dix ans.
  'min-10y': (rng) => get('min', pickLocation(rng), pickWindow(rng, 3652)),
};

// Trafic mixte : surtout des consultations sur des fenêtres courtes et des
// analyses, plus quelques exports complets.
const MIX = [
  ['data-30d', 0.35],
  ['data-1y', 0.15],
  ['data-full', 0.05],
  ['avg-1y', 0.2],
  ['avg-full', 0.05],
  ['max-full', 0.1],
  ['min-10y', 0.1],
];

function mixed(rng) {
  let draw = rng();
  for (const [name, weight] of MIX) {
    if (draw < weight) {
      return base[name](rng);
    }
    draw -= weight;
  }
  return base[MIX[0][0]](rng);
}

// Étude de scalabilité : même requête (30 derniers jours) sur des stations
// dont seul le volume d'historique change.
const depth = {};
for (const { name } of DEPTH_STATIONS) {
  const suffix = name.replace('Bench-', '');
  depth[`depth-avg-${suffix}`] = () => get('avg', name, LAST_MONTH);
  depth[`depth-data-${suffix}`] = () => get('data', name, LAST_MONTH);
}

// Ingestion : chaque requête insère une mesure inédite (lieu propre au tir,
// dates croissantes), pour ne jamais heurter la clé primaire.
function createIngest() {
  const runId = Date.now().toString(36);
  let counter = 0;
  return () => {
    counter += 1;
    const location = `Ingest-${runId}-${counter % 50}`;
    const date = addDays('1900-01-01', Math.floor(counter / 50));
    return {
      method: 'POST',
      path: '/weather/data',
      body: JSON.stringify({
        location,
        date: `${date}T00:00:00.000Z`,
        temperature: 20 + (counter % 100) / 10,
        humidity: 40 + (counter % 50),
      }),
    };
  };
}

export const SCENARIO_NAMES = [
  ...Object.keys(base),
  'mixed',
  ...Object.keys(depth),
  'ingest',
];

export function createScenario(name) {
  if (name === 'ingest') {
    return createIngest();
  }
  if (name === 'mixed') {
    return mixed;
  }
  const scenario = base[name] ?? depth[name];
  if (!scenario) {
    throw new Error(
      `Scénario inconnu : ${name} (disponibles : ${SCENARIO_NAMES.join(', ')})`
    );
  }
  return scenario;
}
