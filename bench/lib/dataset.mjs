// Description du jeu de données synthétique utilisé pour les mesures.
//
// Le projet ne donne pas accès aux données réelles : on génère donc un jeu de
// données déterministe dont la forme (nombre de lieux, profondeur d'historique,
// ordre d'insertion) reproduit ce que produit le flux d'ingestion de
// l'application (`POST /weather/data`, une mesure par lieu et par jour).

export const DEFAULTS = {
  locations: 1000,
  start: '1984-01-01',
  end: '2023-12-31',
};

// Les 50 premiers lieux portent un vrai nom (les exemples du readme, comme
// « Lyon », fonctionnent donc tels quels) ; les suivants sont numérotés.
const CITY_NAMES = [
  'Paris', 'Lyon', 'Marseille', 'Toulouse', 'Nice', 'Nantes', 'Strasbourg',
  'Montpellier', 'Bordeaux', 'Lille', 'Rennes', 'Reims', 'Le Havre',
  'Saint-Étienne', 'Toulon', 'Grenoble', 'Dijon', 'Angers', 'Nîmes',
  'Villeurbanne', 'Clermont-Ferrand', 'Le Mans', 'Aix-en-Provence', 'Brest',
  'Tours', 'Amiens', 'Limoges', 'Annecy', 'Perpignan', 'Metz', 'Besançon',
  'Orléans', 'Rouen', 'Mulhouse', 'Caen', 'Nancy', 'Avignon', 'Poitiers',
  'La Rochelle', 'Pau', 'Calais', 'Ajaccio', 'Bastia', 'Bruxelles', 'Genève',
  'Londres', 'Berlin', 'Madrid', 'Rome', 'Lisbonne',
];

export function locationName(index) {
  if (index < CITY_NAMES.length) {
    return CITY_NAMES[index];
  }
  return `Station-${String(index + 1).padStart(4, '0')}`;
}

export function locationNames(count) {
  return Array.from({ length: count }, (_, index) => locationName(index));
}

// Stations dédiées à l'étude de scalabilité : même climat, mais une profondeur
// d'historique différente (1 à 40 ans). Elles permettent de mesurer la latence
// en fonction du volume de données d'un lieu, sur une seule et même base.
export const DEPTH_STATIONS = [
  { name: 'Bench-01y', years: 1 },
  { name: 'Bench-02y', years: 2 },
  { name: 'Bench-05y', years: 5 },
  { name: 'Bench-10y', years: 10 },
  { name: 'Bench-20y', years: 20 },
  { name: 'Bench-40y', years: 40 },
];

export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(isoDay, days) {
  const date = new Date(`${isoDay}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

export function addYears(isoDay, years) {
  const date = new Date(`${isoDay}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return isoDate(date);
}

export function daysBetween(fromIsoDay, toIsoDay) {
  const from = Date.parse(`${fromIsoDay}T00:00:00Z`);
  const to = Date.parse(`${toIsoDay}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

// Générateur pseudo-aléatoire déterministe (mulberry32) : deux exécutions du
// banc avec la même graine envoient exactement la même suite de requêtes.
export function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
