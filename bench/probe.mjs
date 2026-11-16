// Sonde à précharger dans le serveur testé :
//
//   BENCH_PROBE_FILE=/tmp/probe.json node --import ./bench/probe.mjs dist/index.js
//
// Elle n'altère pas l'application : elle observe le retard de la boucle
// d'événements, l'activité du ramasse-miettes et le pic de mémoire, puis écrit
// ces mesures dans BENCH_PROBE_FILE à chaque signal SIGUSR2 (avant de repartir
// de zéro). La même sonde sert pour l'application d'origine et pour la version
// optimisée, ce qui rend les deux mesures comparables.

import { writeFileSync } from 'node:fs';
import { PerformanceObserver, monitorEventLoopDelay } from 'node:perf_hooks';

const file = process.env.BENCH_PROBE_FILE;

if (file) {
  const RESOLUTION_MS = 1;
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();

  let gcCount = 0;
  let gcPauseMs = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount += 1;
      gcPauseMs += entry.duration;
    }
  }).observe({ entryTypes: ['gc'] });

  let peakHeapUsed = 0;
  let peakRss = 0;
  const sampler = setInterval(() => {
    const usage = process.memoryUsage();
    peakHeapUsed = Math.max(peakHeapUsed, usage.heapUsed);
    peakRss = Math.max(peakRss, usage.rss);
  }, 50);
  sampler.unref();

  // Le minuteur de la sonde se déclenche toutes les RESOLUTION_MS : on retire
  // cet intervalle pour ne garder que le retard pris par la boucle.
  const lagMs = (nanoseconds) =>
    Number(Math.max(0, nanoseconds / 1e6 - RESOLUTION_MS).toFixed(3));
  const megabytes = (bytes) => Number((bytes / 1024 / 1024).toFixed(1));

  process.on('SIGUSR2', () => {
    writeFileSync(
      file,
      JSON.stringify({
        eventLoopLagMs: {
          mean: lagMs(histogram.mean),
          p50: lagMs(histogram.percentile(50)),
          p99: lagMs(histogram.percentile(99)),
          max: lagMs(histogram.max),
        },
        gc: { count: gcCount, pauseMs: Number(gcPauseMs.toFixed(1)) },
        peakHeapUsedMb: megabytes(peakHeapUsed),
        peakRssMb: megabytes(peakRss),
      })
    );
    histogram.reset();
    gcCount = 0;
    gcPauseMs = 0;
    peakHeapUsed = 0;
    peakRss = 0;
  });
}
