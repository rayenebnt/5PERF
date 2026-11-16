// Tests d'intégration : l'API complète (Express + PostgreSQL réel).
//
// Les réponses attendues sont celles de l'application d'ORIGINE, relevées sur
// le code fourni avant toute modification : ces tests garantissent que les
// optimisations n'ont pas changé le contrat de l'API. Les seuls écarts voulus
// sont signalés par la mention « correction ».
//
// Prérequis : un PostgreSQL joignable avec la configuration de config/ (voir
// le readme). Les tests travaillent dans le schéma `weathertrack_test`.

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import config from 'config';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import server from '../../src/server.js';
import repository from '../../src/weather/repository.js';

const SCHEMA = 'weathertrack_test';
const FRESH_SCHEMA = 'weathertrack_test_fresh';
const databaseConfig = config.get<pg.ClientConfig>('database');

let admin: pg.Client;
let httpServer: Server;
let baseUrl: string;

const get = (path: string, headers?: Record<string, string>) =>
  fetch(`${baseUrl}${path}`, { headers });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getJson = async (path: string): Promise<any> => (await get(path)).json();
const post = (body: unknown) =>
  fetch(`${baseUrl}/weather/data`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const measure = (day: string, temperature: number, humidity: number) => ({
  location: 'Lyon',
  date: `${day}T00:00:00.000Z`,
  temperature,
  humidity,
});

beforeAll(async () => {
  admin = new pg.Client({ ...databaseConfig, options: undefined });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS ${FRESH_SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.query(`CREATE SCHEMA ${FRESH_SCHEMA}`);

  // Une base « de production » telle que l'application d'origine l'a créée
  // et remplie : la migration doit la faire évoluer sans rien perdre.
  await admin.query(`
    CREATE TABLE ${SCHEMA}.weather (
        location VARCHAR(256),
        date DATE,
        temperature DECIMAL,
        humidity DECIMAL,
        PRIMARY KEY(location, date)
    )
  `);
  await admin.query(`
    INSERT INTO ${SCHEMA}.weather (location, date, temperature, humidity) VALUES
        ('Lyon', '2023-12-22', 27, 40),
        ('Lyon', '2023-12-24', 25, 40),
        ('Lyon', '2023-12-21', 23.5, 41.25),
        ('Lyon', '2023-12-25', -3.2, 90)
  `);

  await migrate();

  httpServer = server.listen(0);
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  await repository.close();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS ${FRESH_SCHEMA} CASCADE`);
  await admin.end();
});

describe('migrations', () => {
  const primaryKeyColumns = async (schema: string) => {
    const { rows } = await admin.query(
      `SELECT i.indnkeyatts AS key_columns, i.indnatts AS all_columns
       FROM pg_index i
       WHERE i.indrelid = $1::regclass AND i.indisprimary`,
      [`${schema}.weather`]
    );
    return rows[0];
  };

  test("une base existante reçoit la clé primaire couvrante sans perte de données", async () => {
    expect(await primaryKeyColumns(SCHEMA)).toEqual({
      key_columns: 2,
      all_columns: 4,
    });
    const { rows } = await admin.query(
      `SELECT count(*)::int AS count FROM ${SCHEMA}.weather`
    );
    expect(rows[0].count).toBe(4);
  });

  test("la clé primaire refuse toujours les doublons (lieu, date)", async () => {
    await expect(
      admin.query(
        `INSERT INTO ${SCHEMA}.weather VALUES ('Lyon', '2023-12-22', 1, 1)`
      )
    ).rejects.toMatchObject({ code: '23505' });
  });

  test("l'autovacuum est réglé pour une table alimentée par insertions", async () => {
    const { rows } = await admin.query(
      `SELECT reloptions FROM pg_class WHERE oid = $1::regclass`,
      [`${SCHEMA}.weather`]
    );
    expect(rows[0].reloptions).toEqual(
      expect.arrayContaining([
        'autovacuum_vacuum_insert_scale_factor=0.001',
        'autovacuum_vacuum_insert_threshold=1000',
      ])
    );
  });

  test('chaque migration est enregistrée et jamais rejouée', async () => {
    const { rows } = await admin.query(
      `SELECT id FROM ${SCHEMA}.schema_migrations ORDER BY id`
    );
    expect(rows.map((row) => row.id)).toEqual([
      '001-create-weather-table',
      '002-covering-primary-key',
    ]);
    expect(await migrate()).toEqual([]);
  });

  test('une base vide est créée directement dans son état final', async () => {
    const applied = await migrate({
      ...databaseConfig,
      options: `-c search_path=${FRESH_SCHEMA}`,
    });
    expect(applied).toEqual([
      '001-create-weather-table',
      '002-covering-primary-key',
    ]);
    expect(await primaryKeyColumns(FRESH_SCHEMA)).toEqual({
      key_columns: 2,
      all_columns: 4,
    });
  });
});

describe('GET /weather/data/:location', () => {
  test("renvoie tout l'historique du lieu, trié par date", async () => {
    expect(await getJson('/weather/data/Lyon')).toEqual([
      measure('2023-12-21', 23.5, 41.25),
      measure('2023-12-22', 27, 40),
      measure('2023-12-24', 25, 40),
      measure('2023-12-25', -3.2, 90),
    ]);
  });

  test('`from` est exclu et `to` est inclus', async () => {
    expect(
      await getJson('/weather/data/Lyon?from=2023-12-22&to=2023-12-25')
    ).toEqual([measure('2023-12-24', 25, 40), measure('2023-12-25', -3.2, 90)]);
  });

  test('`from` seul', async () => {
    expect(await getJson('/weather/data/Lyon?from=2023-12-21')).toEqual([
      measure('2023-12-22', 27, 40),
      measure('2023-12-24', 25, 40),
      measure('2023-12-25', -3.2, 90),
    ]);
  });

  test('`to` seul', async () => {
    expect(await getJson('/weather/data/Lyon?to=2023-12-22')).toEqual([
      measure('2023-12-21', 23.5, 41.25),
      measure('2023-12-22', 27, 40),
    ]);
  });

  test("une borne date-heure est ramenée au jour où tombe l'instant", async () => {
    const expected = [
      measure('2023-12-24', 25, 40),
      measure('2023-12-25', -3.2, 90),
    ];
    expect(
      await getJson('/weather/data/Lyon?from=2023-12-22T00:00:00Z')
    ).toEqual(expected);
    expect(
      await getJson('/weather/data/Lyon?from=2023-12-22T10:00:00Z')
    ).toEqual(expected);
  });

  test('renvoie [] pour un lieu connu sans mesure sur la période', async () => {
    expect(await getJson('/weather/data/Lyon?from=2030-01-01')).toEqual([]);
  });

  test('renvoie null pour un lieu inconnu, avec ou sans période', async () => {
    expect(await getJson('/weather/data/Inconnu')).toBeNull();
    expect(await getJson('/weather/data/Inconnu?from=2023-01-01')).toBeNull();
  });

  test('`limit` borne la réponse et `from` sert de curseur de pagination', async () => {
    const firstPage = await getJson('/weather/data/Lyon?limit=3');
    expect(firstPage).toEqual([
      measure('2023-12-21', 23.5, 41.25),
      measure('2023-12-22', 27, 40),
      measure('2023-12-24', 25, 40),
    ]);
    const cursor = encodeURIComponent(firstPage[2].date);
    expect(await getJson(`/weather/data/Lyon?limit=3&from=${cursor}`)).toEqual([
      measure('2023-12-25', -3.2, 90),
    ]);
    expect(await getJson('/weather/data/Inconnu?limit=3')).toBeNull();
  });

  test('rejette une taille de page invalide', async () => {
    for (const limit of ['0', '-5', '2.5', 'abc', '', '100001']) {
      const response = await get(`/weather/data/Lyon?limit=${limit}`);
      expect(response.status).toBe(400);
    }
  });

  test("le nom du lieu n'est jamais interprété comme du SQL", async () => {
    const path = `/weather/data/${encodeURIComponent("Lyon' OR '1'='1")}`;
    expect(await getJson(path)).toBeNull();
  });

  test('rejette une date invalide avec le détail de la validation', async () => {
    const response = await get('/weather/data/Lyon?from=nimportequoi');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual([
      {
        type: 'Query',
        errors: {
          issues: [
            { code: 'invalid_date', path: ['from'], message: 'Invalid date' },
          ],
          name: 'ZodError',
        },
      },
    ]);
  });
});

describe('analyses de température', () => {
  test('moyenne, maximum et minimum sur tout l’historique', async () => {
    expect(await getJson('/weather/avg/Lyon')).toEqual({ avg: 18.075 });
    expect(await getJson('/weather/max/Lyon')).toEqual({ max: 27 });
    expect(await getJson('/weather/min/Lyon')).toEqual({ min: -3.2 });
  });

  test('les bornes `from` (exclue) et `to` (incluse) s’appliquent', async () => {
    expect(
      await getJson('/weather/avg/Lyon?from=2023-12-22&to=2023-12-25')
    ).toEqual({ avg: 10.9 });
    expect(await getJson('/weather/max/Lyon?from=2023-12-22')).toEqual({
      max: 25,
    });
    expect(await getJson('/weather/min/Lyon?to=2023-12-24')).toEqual({
      min: 23.5,
    });
  });

  test('un lieu inconnu donne null', async () => {
    expect(await getJson('/weather/avg/Inconnu')).toEqual({ avg: null });
    expect(await getJson('/weather/max/Inconnu')).toEqual({ max: null });
    expect(await getJson('/weather/min/Inconnu')).toEqual({ min: null });
  });

  test('une période sans mesure donne null pour la moyenne', async () => {
    expect(await getJson('/weather/avg/Lyon?from=2030-01-01')).toEqual({
      avg: null,
    });
  });

  test('correction : une période sans mesure ne fait plus planter max et min', async () => {
    // L'application d'origine répondait HTTP 500 (lecture de data[0] sur un
    // tableau vide). Le comportement est aligné sur celui de la moyenne.
    const max = await get('/weather/max/Lyon?from=2030-01-01');
    const min = await get('/weather/min/Lyon?from=2030-01-01');
    expect(max.status).toBe(200);
    expect(await max.json()).toEqual({ max: null });
    expect(min.status).toBe(200);
    expect(await min.json()).toEqual({ min: null });
  });
});

describe('POST /weather/data', () => {
  test('enregistre une mesure : le jour retenu est celui écrit dans la date', async () => {
    const response = await post({
      location: 'Nantes',
      date: '2024-03-10T23:00:00.000Z',
      temperature: '12.5',
      humidity: 71,
    });
    expect(response.status).toBe(200);
    expect(await getJson('/weather/data/Nantes')).toEqual([
      {
        location: 'Nantes',
        date: '2024-03-10T00:00:00.000Z',
        temperature: 12.5,
        humidity: 71,
      },
    ]);
  });

  test('refuse un doublon (lieu, date) comme à l’origine', async () => {
    const body = {
      location: 'Brest',
      date: '2024-03-10',
      temperature: 9,
      humidity: 80,
    };
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(500);
  });

  test('rejette un corps invalide', async () => {
    expect((await post({ location: 'Brest', temperature: 9 })).status).toBe(400);
    expect(
      (
        await post({
          location: 'Brest',
          date: 'pas une date',
          temperature: 9,
          humidity: 80,
        })
      ).status
    ).toBe(400);
  });

  test('une mesure sans valeur (null) reste restituée comme 0', async () => {
    // Comportement historique : la validation accepte `null`, la base stocke
    // NULL et la lecture le restituait comme 0 (voir les recommandations).
    for (const [day, temperature] of [
      ['2024-01-01', 10],
      ['2024-01-02', null],
    ] as const) {
      const response = await post({
        location: 'Pau',
        date: day,
        temperature,
        humidity: null,
      });
      expect(response.status).toBe(200);
    }
    expect(await getJson('/weather/data/Pau')).toEqual([
      {
        location: 'Pau',
        date: '2024-01-01T00:00:00.000Z',
        temperature: 10,
        humidity: 0,
      },
      {
        location: 'Pau',
        date: '2024-01-02T00:00:00.000Z',
        temperature: 0,
        humidity: 0,
      },
    ]);
    expect(await getJson('/weather/avg/Pau')).toEqual({ avg: 5 });
    expect(await getJson('/weather/min/Pau')).toEqual({ min: 0 });
  });
});

describe('transport HTTP', () => {
  test('les lectures réussies sont mises en cache 60 secondes', async () => {
    for (const path of ['/weather/data/Lyon', '/weather/avg/Lyon']) {
      const response = await get(path);
      expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    }
  });

  test('les erreurs ne sont pas mises en cache', async () => {
    const response = await get('/weather/data/Lyon?from=nimportequoi');
    expect(response.headers.get('cache-control')).toBeNull();
  });

  test('une réponse volumineuse est compressée, une petite ne l’est pas', async () => {
    const DAYS = 90; // environ 8 ko de JSON, au-delà du seuil de 4 ko
    for (let offset = 0; offset < DAYS; offset += 1) {
      const day = new Date(Date.UTC(2024, 0, 1 + offset));
      await post({
        location: 'Toulouse',
        date: day.toISOString().slice(0, 10),
        temperature: offset,
        humidity: 50,
      });
    }
    const large = await get('/weather/data/Toulouse', {
      'accept-encoding': 'gzip',
    });
    expect(large.headers.get('content-encoding')).toBe('gzip');
    expect(await large.json()).toHaveLength(DAYS);

    const page = await get('/weather/data/Toulouse?limit=30', {
      'accept-encoding': 'gzip',
    });
    expect(page.headers.get('content-encoding')).toBeNull();
    expect(await page.json()).toHaveLength(30);
  });

  test('une route inconnue répond 404', async () => {
    expect((await get('/weather/inconnu/Lyon')).status).toBe(404);
  });
});
