#!/usr/bin/env node
// Génère le jeu de données synthétique de référence dans la table `weather`.
//
//   node bench/seed.mjs [--locations 1000] [--start 1984-01-01] [--end 2023-12-31] [--reset]
//
// ATTENTION : le script recrée la table `weather`. Il refuse de s'exécuter en
// production, et n'écrase une table déjà remplie que si `--reset` est fourni.
//
// La base ciblée est celle de la configuration (`config/*.yaml`, surchargeable
// avec NODE_CONFIG). Le script crée le schéma *d'origine* de l'application
// (celui du code fourni) : les migrations s'appliquent ensuite par-dessus,
// exactement comme elles le feraient sur la base de production.
//
// Les lignes sont insérées dans l'ordre chronologique (toutes les stations
// pour le jour J, puis le jour J+1…), ce qui reproduit le fonctionnement des
// robots d'ingestion : l'historique d'un lieu se retrouve dispersé dans toute
// la table, comme en production.

import config from 'config';
import pg from 'pg';
import {
  DEFAULTS,
  DEPTH_STATIONS,
  addDays,
  addYears,
  locationNames,
} from './lib/dataset.mjs';

function parseArgs(argv) {
  const options = { ...DEFAULTS, reset: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'reset') {
      options.reset = true;
    } else if (key in DEFAULTS) {
      i += 1;
      options[key] = key === 'locations' ? Number(argv[i]) : argv[i];
    } else {
      throw new Error(`Option inconnue : ${argv[i]}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (process.env.NODE_ENV === 'production') {
  throw new Error('bench/seed.mjs ne doit jamais être lancé en production.');
}

const client = new pg.Client(config.get('database'));
await client.connect();

const existing = await client.query(`SELECT to_regclass('weather') AS oid`);
if (existing.rows[0].oid !== null && !options.reset) {
  const { rows } = await client.query('SELECT EXISTS (SELECT 1 FROM weather) AS filled');
  if (rows[0].filled) {
    await client.end();
    throw new Error(
      'La table weather contient déjà des données : relancer avec --reset pour la recréer.'
    );
  }
}

const startedAt = Date.now();
const log = (message) =>
  console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);

// Schéma d'origine, copié à l'identique depuis src/weather/repository.ts.
await client.query('DROP TABLE IF EXISTS weather');
await client.query(`
  CREATE TABLE weather (
      location VARCHAR(256),
      date DATE,
      temperature DECIMAL,
      humidity DECIMAL,
      PRIMARY KEY(location, date)
  )
`);

// Table temporaire des lieux avec un climat propre à chacun.
await client.query(`
  CREATE TEMP TABLE bench_locations (
      id INT PRIMARY KEY,
      name VARCHAR(256) NOT NULL,
      first_date DATE NOT NULL,
      base_temp DOUBLE PRECISION NOT NULL,
      amplitude DOUBLE PRECISION NOT NULL,
      base_humidity DOUBLE PRECISION NOT NULL
  )
`);

const stations = [
  ...locationNames(options.locations).map((name) => ({
    name,
    firstDate: options.start,
  })),
  ...DEPTH_STATIONS.map(({ name, years }) => ({
    name,
    firstDate: addDays(addYears(options.end, -years), 1),
  })),
];

await client.query(
  `
  INSERT INTO bench_locations
  SELECT id,
         name,
         first_date::date,
         4 + (abs(hashint4(id)) % 220) / 10.0,
         5 + (abs(hashint4(id + 7919)) % 120) / 10.0,
         45 + (abs(hashint4(id + 104729)) % 35)
  FROM (
    SELECT ordinality::int AS id, name, first_date
    FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(name, first_date, ordinality)
  ) AS numbered
  `,
  [stations.map((s) => s.name), stations.map((s) => s.firstDate)]
);
await client.query('ANALYZE bench_locations');
log(`${stations.length} lieux préparés`);

// Une requête d'insertion par année, triée par (jour, lieu).
const firstYear = Number(options.start.slice(0, 4));
const lastYear = Number(options.end.slice(0, 4));
let total = 0;
for (let year = firstYear; year <= lastYear; year += 1) {
  const from = year === firstYear ? options.start : `${year}-01-01`;
  const to = year === lastYear ? options.end : `${year}-12-31`;
  const result = await client.query(
    `
    INSERT INTO weather (location, date, temperature, humidity)
    SELECT l.name,
           d.day,
           round((l.base_temp
                  + l.amplitude * sin(2 * pi() * (extract(doy FROM d.day) - 110) / 365.25)
                  + (hashint8(l.id::bigint * 100003 + (d.day - DATE '1900-01-01')) % 600) / 100.0
                 )::numeric, 1),
           round(least(100, greatest(5,
                  l.base_humidity
                  - 12 * sin(2 * pi() * (extract(doy FROM d.day) - 110) / 365.25)
                  + (hashint8(l.id::bigint * 200003 + (d.day - DATE '1900-01-01')) % 1500) / 100.0
                 ))::numeric, 0)
    FROM (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day) d
    JOIN bench_locations l ON d.day >= l.first_date
    ORDER BY d.day, l.id
    `,
    [from, to]
  );
  total += result.rowCount;
  log(`année ${year} : ${result.rowCount} lignes (total ${total})`);
}

// En production l'autovacuum maintient statistiques et « visibility map » à
// jour ; après un chargement en masse on le fait explicitement pour mesurer
// un état stable.
log('VACUUM ANALYZE…');
await client.query('VACUUM (ANALYZE) weather');

const { rows } = await client.query(`
  SELECT pg_size_pretty(pg_table_size('weather')) AS table_size,
         pg_size_pretty(pg_indexes_size('weather')) AS index_size
`);
log(
  `terminé : ${total} lignes, ${stations.length} lieux, ` +
    `table ${rows[0].table_size}, index ${rows[0].index_size}`
);
await client.end();
