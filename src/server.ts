import zlib from 'node:zlib';
import express from 'express';
import compression from 'compression';
import config from 'config';
import apiLogger from './apiLogger.js';
import app from './app.js';
import bodyParser from 'body-parser';

const server = express();

server.use(apiLogger);
// Un export complet pèse plus d'un mégaoctet de JSON : compressé, il est
// environ onze fois plus léger à transférer. Le niveau de compression le plus
// rapide suffit (le JSON est très répétitif) et coûte trois fois moins de CPU
// que le niveau par défaut. En dessous de 4 ko une réponse part de toute façon
// dans la première salve TCP : la compresser serait du CPU dépensé pour rien.
// À désactiver si un reverse proxy ou un CDN compresse déjà.
if (config.get<boolean>('api.compression')) {
  server.use(
    compression({
      threshold: 4096,
      level: zlib.constants.Z_BEST_SPEED,
      brotli: {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 },
      },
    })
  );
}
server.use(bodyParser.json());
server.use(app);
app.use((req, res) => {
  return res.sendStatus(404);
});

export default server;
