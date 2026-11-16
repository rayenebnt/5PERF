// Point d'entrée de `npm run migrate` : applique les migrations en attente.
import logger from '../logger.js';
import { migrate } from './migrate.js';

try {
  const applied = await migrate();
  logger.info(
    applied.length > 0
      ? `Migrations applied: ${applied.join(', ')}`
      : 'Database schema is up to date'
  );
} catch (error) {
  logger.error('Migration failed', error);
  process.exitCode = 1;
}
