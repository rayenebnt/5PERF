import pg from 'pg';

export interface Migration {
  /** Identifiant stable, enregistré dans `schema_migrations`. */
  id: string;
  description: string;
  /**
   * `false` pour les migrations qui ne peuvent pas s'exécuter dans une
   * transaction (CREATE INDEX CONCURRENTLY, VACUUM). Elles doivent alors être
   * rejouables sans risque après une interruption.
   */
  transactional: boolean;
  up(client: pg.ClientBase): Promise<void>;
}

const COVERING_INDEX = 'weather_location_date_covering_idx';

const createWeatherTable: Migration = {
  id: '001-create-weather-table',
  description: "Table weather telle que la créait l'application d'origine",
  transactional: true,
  async up(client) {
    // Sans effet sur une base existante : la définition est celle du code
    // d'origine, les migrations suivantes la font évoluer.
    await client.query(`
      CREATE TABLE IF NOT EXISTS weather (
          location VARCHAR(256),
          date DATE,
          temperature DECIMAL,
          humidity DECIMAL,
          PRIMARY KEY(location, date)
      )
    `);
  },
};

const coveringPrimaryKey: Migration = {
  id: '002-covering-primary-key',
  description:
    'Clé primaire couvrante (location, date) INCLUDE (temperature, humidity)',
  transactional: false,
  async up(client) {
    // Les mesures arrivent jour après jour pour tous les lieux : l'historique
    // d'un lieu est donc éparpillé dans la table, à raison d'une page de 8 ko
    // par mesure. En incluant température et humidité dans l'index de la clé
    // primaire, PostgreSQL répond aux lectures par un « index-only scan » :
    // les mesures d'un lieu y sont contiguës et la table n'est plus visitée.
    const primaryKey = await client.query<{
      constraint_name: string;
      columns: number;
    }>(`
      SELECT c.conname AS constraint_name, i.indnatts AS columns
      FROM pg_constraint c
      JOIN pg_index i ON i.indexrelid = c.conindid
      WHERE c.conrelid = 'weather'::regclass AND c.contype = 'p'
    `);
    const alreadyCovering = primaryKey.rows[0]?.columns === 4;

    if (!alreadyCovering) {
      // Un index laissé invalide par une exécution interrompue est reconstruit.
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${COVERING_INDEX}`);
      // CONCURRENTLY : la construction ne bloque ni les lectures ni les
      // écritures de l'application.
      await client.query(`
        CREATE UNIQUE INDEX CONCURRENTLY ${COVERING_INDEX}
            ON weather (location, date) INCLUDE (temperature, humidity)
      `);
      // Bascule de la clé primaire sur le nouvel index : opération purement
      // catalogue (les colonnes sont déjà NOT NULL), donc quasi instantanée.
      // lock_timeout évite de bloquer le trafic si le verrou tarde à venir :
      // la migration échoue alors proprement et peut être relancée.
      await client.query(`SET lock_timeout = '10s'`);
      const dropFormerKey = primaryKey.rows[0]
        ? `DROP CONSTRAINT ${client.escapeIdentifier(primaryKey.rows[0].constraint_name)},`
        : '';
      await client.query(`
        ALTER TABLE weather
            ${dropFormerKey}
            ADD CONSTRAINT weather_pkey PRIMARY KEY USING INDEX ${COVERING_INDEX}
      `);
      await client.query(`RESET lock_timeout`);
    }

    // Un index-only scan n'évite la table que pour les pages marquées
    // « entièrement visibles » par VACUUM. Par défaut l'autovacuum d'une table
    // alimentée uniquement par insertions ne passe qu'après 20 % de croissance,
    // soit des années ici : on le déclenche dès 0,1 % de nouvelles lignes.
    await client.query(`
      ALTER TABLE weather SET (
          autovacuum_vacuum_insert_scale_factor = 0.001,
          autovacuum_vacuum_insert_threshold = 1000
      )
    `);
    await client.query(`VACUUM (ANALYZE) weather`);
  },
};

export const MIGRATIONS: Migration[] = [createWeatherTable, coveringPrimaryKey];
