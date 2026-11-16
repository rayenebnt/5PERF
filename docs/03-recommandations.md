# WeatherTrack Pro — Recommandations

Ce document complète le [rapport de performance](01-rapport-de-performance.md) et la
[documentation des modifications](02-modifications-du-code.md). Il répond à deux questions :

1. **Que reste-t-il à traiter ?** Les points repérés pendant l'audit mais volontairement laissés en
   l'état, soit parce qu'ils touchent au contrat de l'API ou aux données (la décision ne nous
   appartient pas), soit parce que leur gain mesuré ne justifiait pas le risque.
2. **Comment éviter que le problème ne revienne ?** Les stratégies de moyen et long terme, et les
   pratiques de développement et de gestion des données à installer.

Chaque recommandation indique son **horizon** (court terme : semaines ; moyen terme : trimestre ; long
terme : au-delà) et, quand c'est possible, le **signal** qui doit déclencher l'action. Les chiffres cités
proviennent des mesures du rapport (jeu de données synthétique de 14,6 millions de mesures).

## 1. Synthèse

| # | Recommandation | Horizon | Effort | Ce que l'on y gagne |
|---|---|---|---|---|
| A1 | Refuser les mesures `null` à l'ingestion, nettoyer l'existant | Court | Faible | Des moyennes justes (aujourd'hui un `null` compte pour 0 °C) |
| A2 | Répondre 409 (ou accepter la réécriture) sur un doublon | Court | Faible | Fin des erreurs 500 « normales », journaux lisibles |
| A3 | Figer et documenter la sémantique des dates, fuseau UTC en production | Court | Faible | Des résultats identiques quel que soit le serveur |
| A4 | Mettre à jour Node.js et les dépendances | Court | Moyen | Correctifs de sécurité, support éditeur |
| B1 | Tests de charge automatisés avec seuils (budget de performance) | Court | Faible | Une régression est détectée avant la mise en production |
| B2 | Observabilité : métriques, requêtes lentes, alertes | Court | Moyen | Le prochain ralentissement se voit avant les clients |
| C1 | Plusieurs processus ou réplicas de l'API | Moyen | Faible | Débit multiplié par le nombre de cœurs |
| C2 | Cache HTTP partagé (CDN ou reverse proxy) | Moyen | Faible | Les lectures répétées ne touchent plus l'application |
| C3 | Pagination obligatoire et export en flux (API v2) | Moyen | Moyen | Plus aucune réponse de taille non bornée |
| C4 | Ingestion par lot | Moyen | Moyen | Chargements d'historique plus rapides |
| D1 | Agrégats pré-calculés (synthèses mensuelles) | Long | Moyen | Analyses longues en temps constant, prêt pour des données horaires |
| D2 | Table des lieux et clé entière | Long | Élevé | Index deux à trois fois plus compact, métadonnées de lieu |
| D3 | Partitionnement par date, réplicas de lecture | Long | Élevé | Maintenance et croissance au-delà de la centaine de millions de lignes |

## 2. Points non résolus

### A1 — Qualité des données : une mesure `null` est lue comme 0

**Constat.** La validation de `POST /weather/data` utilise `z.coerce.number()`, qui convertit `null`
en `0` et accepte donc la requête ; mais c'est la valeur brute (`null`) qui est enregistrée. À la
lecture, l'application d'origine reconvertissait ce `NULL` en `0` : une station dont le capteur est
en panne apparaît à 0 °C, et ses moyennes, minima et maxima sont faussés.

**Ce qui a été fait.** Rien n'a été changé : la version optimisée reproduit exactement ce comportement
(`COALESCE(temperature, 0)` dans les requêtes, test d'intégration à l'appui), parce que modifier des
résultats d'analyse n'est pas une décision d'optimisation.

**Recommandation (court terme).**

1. Compter les lignes concernées : `SELECT count(*) FROM weather WHERE temperature IS NULL OR humidity IS NULL;`
2. Décider avec le métier du traitement : suppression, ou conservation comme « mesure manquante ».
3. Refuser `null` à l'ingestion (`z.number()` après une conversion explicite des chaînes) et, si les
   mesures manquantes sont supprimées, ajouter `NOT NULL` sur les deux colonnes. Dans ce cas les
   `COALESCE` des requêtes de lecture deviennent inutiles et peuvent être retirés.

### A2 — Un doublon (lieu, date) provoque une erreur 500

**Constat.** Réémettre une mesure déjà enregistrée viole la clé primaire ; l'application répond
`500 Internal Server Error` et journalise une pile d'appels complète. Un robot qui rejoue un envoi
après une coupure réseau produit donc des « erreurs serveur » qui n'en sont pas.

**Recommandation (court terme).** Choisir avec les équipes des robots entre `409 Conflict` (le doublon
est signalé) et une écriture idempotente (`INSERT … ON CONFLICT (location, date) DO UPDATE`, la
dernière valeur gagne), puis ne plus journaliser ce cas au niveau `error`. Le comportement a été
conservé tel quel faute de pouvoir consulter ces équipes.

### A3 — Sémantique des dates implicite

Trois comportements hérités sont désormais documentés dans le readme et couverts par des tests, mais
méritent une décision explicite :

- **`from` est exclu, `to` est inclus.** `?from=2023-12-22&to=2023-12-25` renvoie les 23, 24 et 25.
  C'est contre-intuitif mais des clients peuvent en dépendre (et cela permet d'utiliser `from` comme
  curseur de pagination).
- **Une borne date-heure est ramenée au jour local du serveur.** `from=2023-12-22T23:30:00-05:00`
  désigne le 23 décembre sur un serveur en UTC, le 22 sur un serveur réglé à New York.
- **À l'ingestion, seul le jour écrit dans la chaîne est retenu**, sans conversion de fuseau :
  `2023-12-24T23:00:00.000Z` est rangé au 24 décembre, alors que cet instant est déjà le 25 à Paris.

**Recommandation (court terme).** Exécuter tous les serveurs avec `TZ=UTC` ; demander aux robots
d'envoyer des dates calendaires (`YYYY-MM-DD`) et le valider. **À moyen terme**, une version 2 de
l'API devrait n'accepter que des dates calendaires et annoncer clairement ses bornes.

### A4 — Socle technique vieillissant

- **Node.js 20.10** est figé par `engines` et `.nvmrc`. La branche 20 n'est plus maintenue depuis
  avril 2026 : passer à une version LTS courante (22 ou 24), en rejouant les tests et le banc de mesure.
- **Dépendances.** `npm audit` signale 15 paquets vulnérables parmi les dépendances d'exécution du projet
  d'origine, dont 2 critiques et 6 de gravité élevée. Retirer `axios`, jamais utilisé, en a supprimé
  trois. Les douze restants (Express 4.18, body-parser, path-to-regexp, qs, zod…) se corrigent par des
  montées de version que nous n'avons pas faites : elles sortent du périmètre de l'optimisation et
  auraient brouillé la comparaison avant/après. L'audit doit entrer dans l'intégration continue
  (`npm audit`, Dependabot ou Renovate).
- **Secrets.** `config/default.yaml` contient un mot de passe de base de données. Il ne sert qu'au
  développement, mais les secrets de production doivent venir de l'environnement (`NODE_CONFIG`,
  variables d'environnement, coffre-fort), jamais du dépôt.
- **Route d'ingestion.** Le readme la dit « non exposée publiquement », mais rien dans le code ne
  l'impose : elle est servie par le même serveur, sans authentification. Cette isolation doit être
  garantie par l'infrastructure (réseau privé, règle de proxy) ou par une authentification des robots.
- **Outillage qualité.** La configuration ESLint fournie (`eslint:recommended` seul) ne sait pas lire
  le TypeScript : aucun fichier n'est réellement analysé. Ajouter `typescript-eslint`.

### A5 — Pistes évaluées puis écartées

Ces optimisations ont été mesurées et volontairement **non** retenues. Elles sont consignées pour
éviter de refaire le travail.

| Piste | Mesure | Décision |
|---|---|---|
| Passer `temperature` et `humidity` de `DECIMAL` à `REAL` | Moyenne sur 40 ans : 3,8 ms → 2,5 ms côté base. Aucun gain de stockage (table 838 Mo dans les deux cas, index 688 Mo contre 690 Mo). | Écartée : réécriture complète de la table sous verrou exclusif pour 1,3 ms sur la requête la plus lourde. À reconsidérer lors d'une refonte du schéma (D2). |
| Faire construire le JSON par PostgreSQL (`json_agg`) | Non mesurée. | Écartée : le format de date de l'API dépend du fuseau du serveur Node ; le reproduire en SQL serait fragile. |
| Supprimer le journal d'accès | Débit à saturation : 2 725 → 3 704 req/s sur les requêtes courtes ; le journal coûte de 23 à 28 % du CPU du serveur. | Écartée : l'observabilité vaut plus que ce gain. Voir B2 pour une journalisation moins coûteuse. |
| Cache en mémoire dans l'application | Non mesurée. | Écartée : état local à chaque processus, invalidation à gérer. Le cache HTTP (C2) rend le même service sans état. |

## 3. Stratégies de moyen et long terme

### C1 — Mise à l'échelle horizontale de l'API

L'application ne conserve aucun état : on peut en lancer plusieurs exemplaires derrière le même port
ou derrière un répartiteur de charge. Le script `bench/cluster.mjs` le démontre sans modifier le code
(équivalent de `pm2 start dist/index.js -i N`) :

| Scénario, 20 utilisateurs | 1 processus | 2 processus | 3 processus |
|:---|---:|---:|---:|
| Consultation de 30 jours (req/s) | 2 334 | 3 701 | 4 764 |
| Export complet (req/s) | 33,0 | 62,1 | 87,3 |
| Trafic mixte (req/s) | 489 | 866 | 1 082 |
| Trafic mixte, 95ᵉ centile (ms) | 94,6 | 62,8 | 56,5 |

Sur la machine de mesure (4 cœurs partagés avec PostgreSQL et l'injecteur de charge), le gain plafonne
vite ; sur des serveurs dédiés il suit le nombre de cœurs.

**Dimensionnement du pool.** Chaque processus ouvre jusqu'à `database.max` connexions (10 par défaut).
La règle à respecter : `processus × max ≤ max_connections` de PostgreSQL (100 par défaut), en gardant
une marge pour l'administration. Au-delà d'une dizaine de processus, placer **PgBouncer** devant la
base. Les lectures utilisent des requêtes préparées nommées : en mode « transaction », PgBouncer doit
être en version 1.21 ou plus récente (`max_prepared_statements`).

**Connexions persistantes.** Node.js ferme une connexion inactive au bout de cinq secondes. Derrière
un répartiteur de charge qui garde les siennes plus longtemps, cela provoque des coupures sporadiques
(`ECONNRESET` ; le phénomène a été observé puis reproduit pendant les mesures, voir le rapport,
section 7.5). Régler `server.keepAliveTimeout` au-dessus du délai d'inactivité du répartiteur.

**Signal de déclenchement :** CPU d'un processus Node au-dessus de 70 % en pointe, ou retard de la
boucle d'événements (p99) au-dessus de 50 ms.

### C2 — Cache HTTP partagé

Les réponses `GET` portent désormais `Cache-Control: public, max-age=60`, en plus de l'`ETag`
qu'Express émettait déjà. Un CDN ou un reverse proxy (nginx, Varnish) placé devant l'API sert alors
les requêtes répétées sans solliciter ni Node ni PostgreSQL. Les relevés historiques ne changeant qu'une fois par jour, la durée peut être
allongée pour les périodes entièrement passées (`api.cacheMaxAgeSeconds`). Ce proxy peut aussi
reprendre la compression (`api.compression: false` côté application).

### C3 — Pagination obligatoire et export en flux

`GET /weather/data/:location` accepte maintenant `limit`, mais reste **non borné par défaut** pour ne
pas casser les clients existants : un export de 40 ans pèse 1,4 Mo et occupe le processus pendant
une trentaine de millisecondes, pendant lesquelles aucune autre requête n'avance.

- **Moyen terme :** dans une version 2 de l'API, plafonner `limit` par défaut (par exemple 1 000) et
  renvoyer le curseur de la page suivante dans la réponse.
- **Pour les vrais exports :** diffuser la réponse en flux (curseur PostgreSQL et écriture
  progressive, en JSON ou en CSV) afin que la mémoire et le temps de blocage ne dépendent plus de la
  taille de l'export.

### C4 — Ingestion par lot

Chaque mesure coûte aujourd'hui une requête HTTP et une transaction (environ 700 mesures par seconde avec un robot, 2 500 avec dix). Un point d'entrée
acceptant un tableau de mesures (`INSERT` multi-lignes, ou `COPY` pour les reprises d'historique)
diviserait le nombre d'allers-retours. Ce n'est pas un point de douleur actuel, mais cela le
deviendra si le nombre de lieux ou la fréquence des mesures augmente.

### D1 — Agrégats pré-calculés

Après migration, une analyse sur 40 ans lit 14 610 entrées d'index contiguës en quelques
millisecondes : c'est suffisant pour des données quotidiennes. Ce ne le serait plus avec des données
**horaires** (350 000 mesures par lieu sur 40 ans). La parade est une table de synthèse — par
exemple `weather_monthly(location, month, count, sum, min, max)` — maintenue à l'ingestion ou par
une tâche nocturne : une moyenne sur 40 ans devient une lecture de 480 lignes, complétée par les
jours des deux mois partiels en bordure de période.

**Signal de déclenchement :** temps d'exécution moyen des requêtes d'agrégat au-dessus de 20 ms dans
`pg_stat_statements`, ou passage à une granularité plus fine que le jour.

### D2 — Table des lieux et clé entière

Le nom du lieu (`VARCHAR(256)`) est répété dans chacune des 14,6 millions de lignes et autant de fois
dans l'index. Une table `locations(id, name, …)` et une clé `(location_id, date)` réduiraient
nettement la taille de la table et de l'index, donc la mémoire nécessaire pour les garder en cache,
et ouvriraient la voie à des métadonnées (coordonnées, pays) et à un point d'entrée listant les lieux.
C'est une migration lourde (réécriture de la table, double écriture pendant la bascule) : à planifier
avec D1, et à combiner avec la révision des types de colonnes.

### D3 — Partitionnement et réplicas de lecture

- **Partitionnement par plage de dates** (une partition par année ou par décennie) : utile à partir de
  quelques centaines de millions de lignes, pour archiver ou supprimer les données anciennes et
  limiter le coût de maintenance (`VACUUM`, reconstruction d'index) aux partitions actives. À valider
  par un test de charge, car une requête sur tout l'historique d'un lieu parcourt alors une portion
  d'index par partition.
- **Réplicas de lecture** : le trafic est presque entièrement en lecture. Un ou plusieurs réplicas en
  réplication continue peuvent servir les `GET`, le serveur principal ne gardant que l'ingestion.

### D4 — Exploitation de PostgreSQL

La migration règle l'autovacuum de la table, mais trois points d'exploitation demandent un suivi :

- **Efficacité des lectures par index seul.** Surveiller `n_ins_since_vacuum` et `last_autovacuum`
  dans `pg_stat_user_tables`. Si l'autovacuum ne passe plus, les lectures retournent consulter la
  table et le gain de la migration s'érode.
- **Gonflement de l'index.** Les insertions arrivent au milieu de l'index (à la fin de la plage de
  chaque lieu) : les pages se scindent en deux moitiés qui ne se remplissent plus. C'est ainsi que
  l'index d'origine occupait 998 Mo pour 14,6 millions d'entrées, contre 690 Mo une fois reconstruit
  avec deux colonnes de plus. Mesurer périodiquement (`pgstatindex`) et prévoir un
  `REINDEX INDEX CONCURRENTLY weather_pkey` quand la densité des feuilles passe sous 60 %.
- **Paramètres du serveur.** Les mesures ont été faites avec la configuration par défaut de
  PostgreSQL (128 Mo de `shared_buffers`), celle de l'image Docker du readme. En production, régler au
  minimum `shared_buffers` (environ un quart de la mémoire), `effective_cache_size`, et
  `random_page_cost` (1,1 sur SSD), et activer `pg_stat_statements`.

## 4. Bonnes pratiques pour éviter la récidive

Le problème d'origine n'est pas une erreur isolée : c'est un code correct sur dix lignes de test qui
devient inutilisable sur quatorze mille. Les pratiques suivantes visent cette classe de défauts.

### B1 — Un budget de performance, vérifié automatiquement

L'outillage de mesure est livré dans `bench/` et réutilisable tel quel. Recommandation : exécuter en
intégration continue, sur une base chargée par `bench/seed.mjs`, la suite « latence » et un tir
mixte, avec des seuils qui font échouer la construction. Seuils de départ proposés, à partir des
mesures de l'état final :

| Mesure, sur la base de référence | État final | Seuil d'alerte proposé |
|:---|---:|---:|
| Consultation de 30 jours, un utilisateur, médiane | 0,73 ms | 5 ms |
| Moyenne sur un an, un utilisateur, médiane | 0,60 ms | 5 ms |
| Moyenne sur 40 ans, un utilisateur, médiane | 3,1 ms | 15 ms |
| Export complet, un utilisateur, médiane | 22 ms | 75 ms |
| Trafic mixte, 20 utilisateurs, 95ᵉ centile | 86 ms | 250 ms |
| Rapport des temps de réponse entre une station de 40 ans et une station de 1 an | 0,9 | 2 |

La dernière ligne est la plus précieuse : elle détecte le retour du défaut d'origine (ce rapport y
valait 27) quelle que soit la machine qui exécute le test.

Le test différentiel `bench/compare.mjs` garde son utilité au-delà de ce projet : toute future
réécriture d'une requête peut être comparée, réponse par réponse, à la version en production.

### B2 — Observabilité

L'audit a dû tout mesurer de l'extérieur : l'application n'expose aucun indicateur. À mettre en place :

- **Métriques** par route (débit, temps de réponse p50/p95/p99, taux d'erreur), retard de la boucle
  d'événements, connexions du pool utilisées et en attente — par exemple avec `prom-client` ou
  OpenTelemetry.
- **Côté base :** `pg_stat_statements` et `log_min_duration_statement` (journal des requêtes de plus
  de 100 ms, par exemple).
- **Alertes** sur le p95 et sur le taux d'erreurs 5xx, plutôt que sur des moyennes.
- **Journalisation asynchrone.** Le journal d'accès actuel (morgan vers winston, écriture synchrone)
  consomme une part visible du CPU à fort débit. Un journaliseur asynchrone tel que pino lèverait ce
  coût si le débit par processus venait à compter. Ajouter au passage une route de contrôle de santé
  (`/health`) pour les sondes de l'orchestrateur.

### B3 — Règles de revue de code

1. **La base filtre, trie et agrège ; l'application met en forme.** Tout `filter`, `sort` ou `reduce`
   appliqué en mémoire à un résultat SQL doit être justifié.
2. **Pas de `SELECT *`, pas de requête sans borne.** Toute lecture indique ses colonnes et possède une
   limite, explicite ou garantie par le modèle.
3. **Un plan d'exécution par requête.** Une requête nouvelle ou modifiée est accompagnée de son
   `EXPLAIN (ANALYZE, BUFFERS)` sur un volume réaliste. Le nombre de blocs lus est l'indicateur à
   regarder : il annonce le comportement sous charge mieux que le temps mesuré sur un poste.
4. **On valide aux frontières, pas à l'intérieur.** Les entrées de l'API sont validées ; les données
   relues depuis sa propre base ne le sont pas ligne par ligne.
5. **Aucun traitement long sur le fil principal.** Une boucle sur des milliers d'éléments dans un
   gestionnaire de requête bloque tous les utilisateurs à la fois.

### B4 — Tester avec des volumes réalistes

Aucun des défauts corrigés n'est visible avec une base de développement de quelques lignes : la
requête d'origine y répond en 6 ms. `bench/seed.mjs` génère en deux minutes une base à l'échelle de la
production. Elle doit servir aux tests de recette et à toute évolution du modèle de données.

### B5 — Gérer le schéma par migrations

Le schéma évolue désormais par migrations versionnées (`src/db/migrations.ts`, `npm run migrate`).
Les règles suivies pour la première migration valent pour les suivantes : opérations **en ligne**
(`CREATE INDEX CONCURRENTLY`), verrous bornés par `lock_timeout`, migration rejouable après un échec,
et application avant le déploiement du code qui en dépend. Si le rythme des migrations augmente,
remplacer l'exécuteur maison par un outil établi (node-pg-migrate, Flyway).

### B6 — Gestion des données

- **Contraintes d'intégrité** dans la base, pas seulement dans le code : `NOT NULL`, bornes plausibles
  (`CHECK (humidity BETWEEN 0 AND 100)`).
- **Politique de conservation** : décider jusqu'à quand le détail quotidien doit rester en ligne, et
  archiver le reste (le partitionnement D3 rend l'opération triviale).
- **Sauvegardes testées** et procédure de restauration chronométrée : la base a grossi, sa
  restauration aussi.

## 5. Feuille de route proposée

| Échéance | Actions | Indicateur de réussite |
|---|---|---|
| Sous un mois | A1, A2, A3, A4 · B1 en intégration continue · métriques de base (B2) | Plus aucune erreur 500 sur doublon ; budget de performance vérifié à chaque fusion |
| Sous un trimestre | C1 et C2 selon le trafic observé · C3 (API v2 paginée) · alertes (B2) | p95 du trafic réel sous 100 ms ; aucune réponse de plus de 1 Mo |
| Au-delà | D1 avant toute granularité horaire · D2 et D3 selon la croissance · C4 | Temps de réponse indépendant du volume d'historique, vérifié par la courbe de scalabilité du banc |
