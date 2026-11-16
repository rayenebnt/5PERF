import pg from 'pg';
import config from 'config';
import logger from '../logger.js';
import { MIGRATIONS } from './migrations.js';

// Clé arbitraire du verrou consultatif PostgreSQL : si plusieurs instances
// démarrent en même temps, une seule applique les migrations, les autres
// attendent puis constatent qu'il n'y a plus rien à faire.
const ADVISORY_LOCK_KEY = 5_737_001;

/**
 * Applique, dans l'ordre, les migrations qui ne l'ont pas encore été.
 * Renvoie les identifiants des migrations appliquées par cet appel.
 */
export async function migrate(
  clientConfig: pg.ClientConfig = config.get<pg.ClientConfig>('database')
): Promise<string[]> {
  const client = new pg.Client(clientConfig);
  await client.connect();
  const applied: string[] = [];
  try {
    // Une construction d'index dure plus longtemps qu'une requête applicative.
    await client.query('SET statement_timeout = 0');
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM schema_migrations'
    );
    const done = new Set(rows.map((row) => row.id));

    for (const migration of MIGRATIONS) {
      if (done.has(migration.id)) {
        continue;
      }
      const startedAt = Date.now();
      logger.info('Applying migration', {
        id: migration.id,
        description: migration.description,
      });
      const record = () =>
        client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [
          migration.id,
        ]);
      if (migration.transactional) {
        await client.query('BEGIN');
        try {
          await migration.up(client);
          await record();
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      } else {
        await migration.up(client);
        await record();
      }
      logger.info('Migration applied', {
        id: migration.id,
        durationMs: Date.now() - startedAt,
      });
      applied.push(migration.id);
    }
  } finally {
    // La fin de session libère le verrou consultatif.
    await client.end();
  }
  return applied;
}
