// Mesures côté serveur lues dans /proc (Linux) : temps CPU consommé par le
// processus Node testé et par PostgreSQL, pic de mémoire résidente. Elles
// permettent de chiffrer le coût CPU d'une requête sans instrumenter le code.

import { readFileSync, readdirSync } from 'node:fs';

const CLOCK_TICKS_PER_SECOND = 100; // sysconf(_SC_CLK_TCK) sous Linux

function readStat(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Le nom du processus est entre parenthèses et peut contenir des espaces.
    const comm = raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')'));
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return {
      pid: Number(pid),
      comm,
      ppid: Number(fields[1]),
      utime: Number(fields[11]),
      stime: Number(fields[12]),
      cutime: Number(fields[13]),
      cstime: Number(fields[14]),
    };
  } catch {
    return null;
  }
}

function allProcesses() {
  return readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .map(readStat)
    .filter(Boolean);
}

const ticksToMs = (ticks) => (ticks * 1000) / CLOCK_TICKS_PER_SECOND;

// Temps CPU (ms) du processus `pid` et de ses descendants (mode cluster).
export function processTreeCpuMs(pid) {
  const processes = allProcesses();
  const tree = new Set([Number(pid)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const proc of processes) {
      if (tree.has(proc.ppid) && !tree.has(proc.pid)) {
        tree.add(proc.pid);
        grew = true;
      }
    }
  }
  let ticks = 0;
  for (const proc of processes) {
    if (tree.has(proc.pid)) {
      ticks += proc.utime + proc.stime;
    }
  }
  return ticksToMs(ticks);
}

// Temps CPU (ms) cumulé de l'instance PostgreSQL : processus vivants, plus les
// processus terminés dont le temps est reporté sur leur parent.
export function postgresCpuMs() {
  let ticks = 0;
  for (const proc of allProcesses()) {
    if (proc.comm === 'postgres') {
      ticks += proc.utime + proc.stime + proc.cutime + proc.cstime;
    }
  }
  return ticksToMs(ticks);
}

// Pic de mémoire résidente (Mo) du processus depuis son démarrage.
export function peakRssMb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/VmHWM:\s+(\d+) kB/);
    return match ? Number((Number(match[1]) / 1024).toFixed(1)) : null;
  } catch {
    return null;
  }
}
