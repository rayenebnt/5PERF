#!/usr/bin/env node
// Démonstration de mise à l'échelle horizontale : lance N processus de
// l'application compilée derrière un même port (module `cluster` de Node),
// sans modifier l'application. Équivalent à `pm2 start dist/index.js -i N`
// ou à N réplicas derrière un répartiteur de charge.
//
//   npm run build && node bench/cluster.mjs [N]
//
// C'est possible parce que l'application ne garde aucun état en mémoire :
// chaque processus possède simplement son propre pool de connexions.

import cluster from 'node:cluster';
import os from 'node:os';

const workers = Number(process.argv[2] ?? os.availableParallelism());

if (cluster.isPrimary) {
  let stopping = false;
  for (let i = 0; i < workers; i += 1) {
    cluster.fork();
  }
  cluster.on('exit', (worker, code) => {
    if (!stopping) {
      console.error(`Processus ${worker.process.pid} arrêté (code ${code}) : relance.`);
      cluster.fork();
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopping = true;
      for (const worker of Object.values(cluster.workers)) {
        worker.process.kill(signal);
      }
    });
  }
} else {
  await import('../dist/index.js');
}
