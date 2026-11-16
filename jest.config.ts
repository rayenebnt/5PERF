import type { Config } from 'jest';

// Le découpage d'une date-heure en jour dépend du fuseau du processus : les
// tests tournent en UTC pour donner le même résultat sur toutes les machines.
process.env.TZ = 'UTC';

const config: Config = {
  verbose: true,
  // Le projet est en modules ES et en TypeScript.
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  // Les imports portent l'extension .js (résolution ESM) : on la retire pour
  // que Jest retrouve les sources .ts.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
};

export default config;
