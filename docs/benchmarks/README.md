# Résultats de mesure

> Fichier généré par `node bench/report.mjs` à partir des fichiers JSON de ce dossier.
> Ne pas modifier à la main : relancer la campagne puis la commande.

Machine de mesure : Intel(R) Xeon(R) Processor @ 2.10GHz, 4 cœurs, 16 Go de mémoire. Campagne du 2026-11-16.

## Temps de réponse, un utilisateur

Requêtes envoyées en série par un seul utilisateur (8 s de mesure après 2 s d’échauffement). Temps en millisecondes.

| Scénario | Lignes renvoyées | Origine — médiane | p95 | Code optimisé seul — médiane | p95 | Code optimisé + migration — médiane | p95 | Gain (médiane) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Consultation, fenêtre de 30 jours | 30 | 169 | 245 | 0,92 | 1,36 | 0,73 | 1,12 | × 230 |
| Consultation, fenêtre d’un an | 365 | 177 | 255 | 2,46 | 3,14 | 1,42 | 2,17 | × 124 |
| Export de tout l’historique (40 ans) | 14 610 | 127 | 155 | 61,8 | 81,8 | 21,9 | 34,1 | × 5,8 |
| Moyenne sur un an | 1 | 155 | 206 | 2,26 | 2,80 | 0,60 | 0,98 | × 257 |
| Moyenne sur tout l’historique | 1 | 89,2 | 106 | 55,1 | 63,4 | 3,08 | 4,72 | × 29 |
| Maximum sur tout l’historique | 1 | 99,5 | 119 | 53,8 | 61,6 | 3,06 | 4,21 | × 33 |
| Minimum sur dix ans | 1 | 166 | 218 | 13,9 | 17,0 | 1,31 | 1,94 | × 126 |

## Charge : 20 utilisateurs simultanés

Vingt utilisateurs enchaînent les requêtes sans pause (15 s de mesure après 3 s d’échauffement). Débit en requêtes par seconde, temps en millisecondes.

| Scénario | Origine — débit | médiane | p95 | Code optimisé seul — débit | médiane | p95 | Code optimisé + migration — débit | médiane | p95 | Gain (débit) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Consultation, fenêtre de 30 jours | 5,73 | 2 255 | 6 786 | 2 191 | 8,39 | 14,8 | 2 616 | 7,30 | 11,3 | × 457 |
| Consultation, fenêtre d’un an | 6,00 | 2 324 | 5 421 | 786 | 24,0 | 39,4 | 998 | 19,5 | 29,3 | × 166 |
| Export de tout l’historique (40 ans) | 11,1 | 1 455 | 3 032 | 29,9 | 614 | 845 | 37,3 | 509 | 695 | × 3,4 |
| Moyenne sur un an | 5,87 | 2 463 | 3 525 | 1 569 | 12,4 | 19,2 | 3 083 | 5,96 | 10,3 | × 525 |
| Moyenne sur tout l’historique | 17,3 | 1 062 | 1 367 | 64,2 | 305 | 363 | 1 239 | 15,2 | 25,0 | × 71 |
| Maximum sur tout l’historique | 17,1 | 1 061 | 1 369 | 65,9 | 295 | 367 | 1 280 | 14,8 | 24,5 | × 75 |
| Minimum sur dix ans | 6,27 | 2 559 | 3 554 | 269 | 73,1 | 97,1 | 2 623 | 7,15 | 12,6 | × 418 |
| Trafic mixte | 8,47 | 2 057 | 2 517 | 230 | 65,1 | 215 | 532 | 34,2 | 86,0 | × 63 |

## Coût CPU d’une requête

Temps processeur consommé par requête pendant les tirs à 20 utilisateurs, mesuré dans `/proc` : processus Node.js d’une part, ensemble des processus PostgreSQL d’autre part. En millisecondes de CPU.

| Scénario | Origine — Node.js | PostgreSQL | Code optimisé seul — Node.js | PostgreSQL | Code optimisé + migration — Node.js | PostgreSQL |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| Consultation, fenêtre de 30 jours | 183 | 69,7 | 0,49 | 0,21 | 0,42 | 0,09 |
| Consultation, fenêtre d’un an | 174 | 71,6 | 1,27 | 1,44 | 1,04 | 0,26 |
| Export de tout l’historique (40 ans) | 105 | 66,7 | 32,5 | 50,5 | 29,4 | 6,64 |
| Moyenne sur un an | 172 | 72,6 | 0,48 | 1,50 | 0,35 | 0,14 |
| Moyenne sur tout l’historique | 67,6 | 66,1 | 1,18 | 58,1 | 0,42 | 2,49 |
| Maximum sur tout l’historique | 66,3 | 61,8 | 1,23 | 56,1 | 0,42 | 2,43 |
| Minimum sur dix ans | 162 | 66,4 | 0,70 | 13,5 | 0,38 | 0,69 |
| Trafic mixte | 128 | 59,3 | 2,46 | 13,4 | 1,89 | 0,95 |

## Boucle d’événements et mémoire

Mesures de la sonde `bench/probe.mjs` pendant le tir « trafic mixte, 20 utilisateurs ».

| Indicateur | Origine | Code optimisé seul | Code optimisé + migration |
| :--- | ---: | ---: | ---: |
| Retard maximal de la boucle d’événements (ms) | 1 065 | 102 | 86,9 |
| Retard de la boucle d’événements, p99 (ms) | 1 065 | 54,1 | 61,1 |
| Temps passé en ramasse-miettes pendant le tir (ms) | 1 867 | 1 406 | 563 |
| Pic de tas JavaScript (Mo) | 238 | 82,6 | 77,1 |
| Pic de mémoire résidente du processus (Mo) | 453 | 185 | 187 |

## Scalabilité : effet de la profondeur d’historique

Même requête (30 derniers jours) sur des lieux dont seul le volume d’historique change. Temps de réponse médian en millisecondes, un utilisateur.

| Historique du lieu | Mesures stockées | Origine — moyenne | consultation | Code optimisé seul — moyenne | consultation | Code optimisé + migration — moyenne | consultation |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 an | 365 | 3,12 | 3,19 | 0,63 | 0,74 | 0,56 | 0,67 |
| 2 ans | 730 | 5,23 | 5,03 | 0,62 | 0,75 | 0,55 | 0,60 |
| 5 ans | 1 826 | 10,5 | 12,7 | 0,65 | 0,78 | 0,50 | 0,59 |
| 10 ans | 3 652 | 23,6 | 22,2 | 0,62 | 0,73 | 0,51 | 0,57 |
| 20 ans | 7 305 | 45,2 | 42,6 | 0,71 | 0,75 | 0,54 | 0,62 |
| 40 ans | 14 610 | 83,3 | 91,8 | 0,65 | 0,70 | 0,52 | 0,62 |

## Tenue en charge à débit imposé

Trafic mixte envoyé à cadence fixe pendant 20 s, que le serveur suive ou non (boucle ouverte) : le temps de réponse est compté depuis l’instant d’envoi prévu. « Servi » : débit réellement traité pendant la fenêtre. Une case vide signifie que le palier n’a pas été mesuré pour cet état.

| Débit imposé (req/s) | Origine — servi | médiane (ms) | p95 (ms) | Code optimisé seul — servi | médiane (ms) | p95 (ms) | Code optimisé + migration — servi | médiane (ms) | p95 (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | 2,00 | 157 | 244 | 2,00 | 4,02 | 70,5 | 2,00 | 3,22 | 9,96 |
| 5 | 5,00 | 173 | 257 | 5,00 | 3,34 | 64,5 | 5,00 | 2,78 | 8,02 |
| 10 | 8,25 | 2 725 | 5 646 | 10,0 | 3,29 | 69,4 | 10,0 | 2,46 | 7,28 |
| 20 | 7,15 | 26 629 | 33 732 | 20,0 | 3,42 | 64,0 | 20,0 | 2,27 | 6,01 |
| 50 |  |  |  | 49,9 | 2,72 | 67,7 | 50,0 | 1,68 | 25,2 |
| 100 |  |  |  | 100 | 3,03 | 78,0 | 100 | 1,74 | 31,9 |
| 200 |  |  |  |  |  |  | 200 | 2,61 | 53,3 |
| 300 |  |  |  |  |  |  | 299 | 11,8 | 90,2 |
| 400 |  |  |  |  |  |  | 393 | 38,3 | 260 |
| 600 |  |  |  |  |  |  | 402 | 4 187 | 20 534 |

## Écriture : ingestion des mesures

`POST /weather/data`, une mesure par requête. Vérifie que la clé primaire couvrante ne pénalise pas les robots d’ingestion.

| Robots simultanés | Origine — débit | médiane (ms) | p95 (ms) | Code optimisé seul — débit | médiane (ms) | p95 (ms) | Code optimisé + migration — débit | médiane (ms) | p95 (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 698 | 1,38 | 1,89 | 730 | 1,32 | 1,83 | 794 | 1,20 | 1,75 |
| 10 | 2 502 | 3,61 | 7,00 | 2 266 | 4,12 | 7,46 | 2 413 | 3,78 | 6,84 |

## Requêtes SQL exécutées — Origine

Statistiques `pg_stat_statements` cumulées sur toute la campagne de cet état. Temps en millisecondes ; « blocs » : pages de 8 ko lues par appel.

| Requête | Appels | Exécution moyenne | Lignes par appel | Blocs par appel |
| :--- | ---: | ---: | ---: | ---: |
| `SELECT * FROM weather WHERE location = $1` | 10 336 | 24,5 | 5 359 | 5 406 |
| `INSERT INTO weather (location, date, temperature, humidity) VALUES ($1, $2, $3, $4)` | 28 767 | 0,02 | 1,00 | 5,00 |

## Requêtes SQL exécutées — Code optimisé seul

Statistiques `pg_stat_statements` cumulées sur toute la campagne de cet état. Temps en millisecondes ; « blocs » : pages de 8 ko lues par appel.

| Requête | Appels | Exécution moyenne | Lignes par appel | Blocs par appel |
| :--- | ---: | ---: | ---: | ---: |
| `SELECT avg(COALESCE(temperature, 0)) AS value FROM weather WHERE location = $1 AND date >…` | 86 797 | 3,35 | 1,00 | 481 |
| `SELECT max(COALESCE(temperature, 0)) AS value FROM weather WHERE location = $1 AND date >…` | 2 228 | 117 | 1,00 | 14 740 |
| `SELECT min(COALESCE(temperature, 0)) AS value FROM weather WHERE location = $1 AND date >…` | 6 417 | 29,8 | 1,00 | 3 688 |
| `SELECT location, date, COALESCE(temperature, 0) AS temperature, COALESCE(humidity, 0) AS …` | 116 821 | 1,03 | 229 | 235 |
| `INSERT INTO weather (location, date, temperature, humidity) VALUES ($1, $2, $3, $4)` | 26 572 | 0,02 | 1,00 | 5,00 |

## Requêtes SQL exécutées — Code optimisé + migration

Statistiques `pg_stat_statements` cumulées sur toute la campagne de cet état. Temps en millisecondes ; « blocs » : pages de 8 ko lues par appel.

| Requête | Appels | Exécution moyenne | Lignes par appel | Blocs par appel |
| :--- | ---: | ---: | ---: | ---: |
| `SELECT avg(COALESCE(temperature, 0)) AS value FROM weather WHERE location = $1 AND date >…` | 168 637 | 0,61 | 1,00 | 21,0 |
| `SELECT max(COALESCE(temperature, 0)) AS value FROM weather WHERE location = $1 AND date >…` | 30 937 | 3,30 | 1,00 | 95,6 |
| `SELECT min(COALESCE(temperature, 0)) AS value FROM weather WHERE location = $1 AND date >…` | 59 841 | 0,73 | 1,00 | 27,7 |
| `SELECT location, date, COALESCE(temperature, 0) AS temperature, COALESCE(humidity, 0) AS …` | 164 054 | 0,23 | 418 | 7,60 |
| `INSERT INTO weather (location, date, temperature, humidity) VALUES ($1, $2, $3, $4)` | 28 747 | 0,02 | 1,00 | 5,10 |

## Profil CPU du processus Node.js

Trafic mixte, un utilisateur, 25 s (profil V8 `--cpu-prof`, résumé par `bench/profile-summary.mjs`). Part du temps CPU actif.

| Famille de code | Origine | Code optimisé + migration |
| :--- | ---: | ---: |
| Filtrage des dates en mémoire (dayjs) | 49,3 % | 0,9 % |
| Pilote PostgreSQL (décodage des lignes reçues) | 18,8 % | 41,0 % |
| Validation Zod de chaque ligne | 14,5 % | 0,4 % |
| Ramasse-miettes (GC) | 9,7 % | 3,6 % |
| Code applicatif (service / contrôleur) | 2,8 % | 7,6 % |
| Framework HTTP (express et middlewares) | 2,6 % | 36,8 % |
| Runtime Node.js (réseau, flux, divers) | 1,8 % | 5,5 % |
| Journalisation (morgan / winston) | 0,4 % | 4,3 % |

Temps CPU actif sur la durée du profil : 21 476 ms à l’origine, 19 219 ms après optimisation (pour un nombre de requêtes servies très supérieur).

## Autres fichiers de ce dossier

| Fichier | Contenu |
| :--- | :--- |
| `original.json`, `optimized-code-only.json`, `optimized.json` | Résultats détaillés de chaque tir pour les trois états (centiles, CPU, mémoire, boucle d’événements) |
| `sql-*.json` | Statistiques `pg_stat_statements` de chaque état |
| `profile-*.json` | Résumés des profils CPU (`bench/profile-summary.mjs`) |
| `explain.txt` | Plans d’exécution de référence, avant et après migration |
| `compare.txt`, `compare-timezones.txt` | Comparaisons différentielles origine / optimisé (`bench/compare.mjs`) |
| `secondary.txt` | État final : compression, pagination, mise à l’échelle sur 1 à 3 processus |
| `secondary-variants.txt` | Comparaisons A/B : requêtes préparées, journal d’accès |
| `recheck-300.json`, `recheck-300-injecteur-corrige.json` | Palier à 300 req/s rejoué, avant et après correction de l’injecteur (connexions inactives) |
| `migration-sous-trafic.txt` | Migration 002 rejouée pendant que l’application sert des lectures et des écritures |

