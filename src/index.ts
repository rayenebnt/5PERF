import config from 'config';
import logger from './logger.js';
import server from './server.js';
import WeatherDataRepository from './weather/repository.js';
import { migrate } from './db/migrate.js';
logger.info('starting');

process.on('uncaughtException', (error) => {
  logger.error('Got uncaught exception', error);
  process.exit(1);
});
const port = config.get<number>('api.port');

// En développement le schéma est mis à jour au démarrage. En production les
// migrations sont une étape de déploiement à part (`npm run migrate`) : une
// construction d'index ne doit pas retarder le démarrage des instances.
if (config.get<boolean>('migrations.runOnStart')) {
  await migrate();
}

const httpServer = server
  .listen(port, () => {
    logger.info('Server started', { port });
  })
  .on('error', (error) => {
    logger.error('`API server error', error);
    process.exit(1);
  });

// Arrêt propre : on n'accepte plus de connexion, les requêtes en cours se
// terminent, puis les connexions PostgreSQL sont rendues. Un redéploiement ou
// une mise à l'échelle ne coupe ainsi aucune requête en vol.
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info('Exit requested', { signal });
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
  httpServer.close(() => {
    WeatherDataRepository.close().finally(() => process.exit(0));
  });
  httpServer.closeIdleConnections();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
