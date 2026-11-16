# WeatherTrack Pro — Documentation des modifications du code

Ce document décrit chaque modification apportée au code fourni : le problème traité, ce qui a changé,
pourquoi le comportement fonctionnel est préservé, et l'effet mesuré. Les mesures détaillées et leur
méthode sont dans le [rapport de performance](01-rapport-de-performance.md).

Le code d'origine — l'archive fournie avec l'énoncé — est conservé dans le premier commit du dépôt
(`0a8852e`). Si l'historique git accompagne le rendu, cette commande affiche l'ensemble des
modifications :

```sh
git diff 0a8852e -- src config package.json tsconfig.json
```

## 1. Vue d'ensemble

Les modifications sont classées par impact mesuré, qui est aussi l'ordre dans lequel elles ont été
réalisées.

| # | Modification | Fichiers | Effet mesuré |
|---|---|---|---|
| 1 | Filtrage par période et agrégats confiés à PostgreSQL | `weather/repository.ts`, `weather/service.ts`, `weather/dayRange.ts` | Consultation d'un mois : 169 ms → 0,92 ms. Trafic mixte : 8 → 230 req/s (base non migrée) |
| 2 | Fin de la validation Zod ligne par ligne ; conversions faites par le pilote | `weather/repository.ts`, `weather/dto.ts` | Validation Zod : 14,5 % → 0,4 % du CPU du serveur. Export complet : 56 ms → 34 ms |
| 3 | Migration : clé primaire couvrante, autovacuum adapté | `db/migrations.ts`, `db/migrate.ts`, `db/migrate-cli.ts` | Moyenne sur 40 ans : 55 ms → 3,1 ms. Export complet : 62 ms → 22 ms. Index : 998 Mo → 690 Mo |
| 4 | Requêtes préparées nommées | `weather/repository.ts` | CPU PostgreSQL des requêtes courtes : − 41 % à − 51 % |
| 5 | Pagination optionnelle (`limit`) | `weather/dto.ts`, `weather/controller.ts`, `weather/service.ts` | Page de 1 000 mesures : 2,4 ms et 94 ko, contre 24 ms et 1,38 Mo pour l'export complet |
| 6 | Compression et en-tête de cache | `server.ts`, `weather/controller.ts` | Export complet : 1,38 Mo → 119 ko sur le réseau |
| 7 | Exécution du code compilé, pool configuré, arrêt propre | `package.json`, `tsconfig*.json`, `config/*.yaml`, `index.ts` | Démarrage : 2,15 s → 0,31 s. Mémoire au repos : 231 Mo → 65 Mo |
| 8 | Nettoyage : code mort, dépendance inutilisée | `weather/repository.ts`, `package.json` | Surface de risque réduite |
| 9 | Tests automatisés et outillage de mesure | `tests/`, `bench/`, `jest.config.ts` | Non-régression vérifiable |

## 2. Détail des modifications

### 2.1 Filtrage par période et agrégats confiés à PostgreSQL

**Problème.** Chaque lecture chargeait tout l'historique du lieu, puis filtrait et calculait en
JavaScript :

```ts
// repository.ts (origine)
const query = `SELECT * FROM weather WHERE location = $1`;

// service.ts (origine)
return data.filter((datum) => {
  if (from && (dayjs(from).isAfter(datum.date) || dayjs(from).isSame(datum.date))) {
    return false;
  }
  if (to && dayjs(to).isBefore(datum.date)) {
    return false;
  }
  return true;
});
```

Pour afficher 30 jours, l'application faisait venir 14 610 lignes de la base, construisait de trois à
dix objets dayjs par ligne, puis jetait 99,8 % du résultat. Les moyennes, minima et maxima étaient
calculés de la même façon, par `map` puis `reduce` sur le tableau filtré.

**Modification.** Le filtre et les calculs sont exprimés en SQL :

```ts
// repository.ts (optimisé)
const RANGE_FILTER = `
  WHERE location = $1
    AND date > COALESCE($2::date, '-infinity')
    AND date <= COALESCE($3::date, 'infinity')
`;

const SELECT_AGGREGATE = {
  avg: `SELECT avg(COALESCE(temperature, 0)) AS value FROM weather ${RANGE_FILTER}`,
  // max et min sur le même modèle
};
```

Les trois conditions portent sur les colonnes de la clé primaire `(location, date)` : PostgreSQL
descend directement dans son index jusqu'au lieu puis parcourt la seule période demandée. `COALESCE`
rend les bornes facultatives en gardant un texte de requête unique (ce qui permet de la préparer, voir
2.4). Un agrégat ne fait plus transiter qu'une ligne.

**Pourquoi le résultat est le même.** L'origine comparait des instants : `dayjs(from)` d'un côté, la
date de la mesure de l'autre — or le pilote restitue une colonne `DATE` à minuit, heure locale. Une
mesure du jour J était donc conservée si et seulement si « minuit de J » était strictement après
l'instant `from`, c'est-à-dire si J est strictement après le jour local où tombe `from` ; et, pour
`to`, si J est au plus le jour local où tombe `to`. La fonction `toDayRange` (`dayRange.ts`) calcule
ces deux jours **une fois par requête**, avec le même appel `dayjs(valeur)` que l'origine (les règles
d'interprétation des chaînes restent donc identiques), et les transmet à la requête. Le filtre
`date > $2 AND date <= $3` est la traduction exacte du filtre d'origine : `from` exclu, `to` inclus.

**Détails de compatibilité préservés.**

- `null` pour un lieu inconnu, `[]` pour un lieu connu sans mesure sur la période. Quand la requête
  filtrée ne renvoie rien et qu'une borne était fournie, une lecture d'index supplémentaire
  (`SELECT EXISTS …`) lève l'ambiguïté. Ce cas est rare et coûte moins d'une milliseconde.
- Une mesure enregistrée avec une valeur `NULL` reste restituée comme 0 et comptée comme 0 dans les
  agrégats (`COALESCE(…, 0)`), comme le faisait la revalidation Zod d'origine. Voir la recommandation
  A1.
- Les années antérieures à l'an 1, que PostgreSQL ne lit pas sous la forme produite par dayjs, sont
  ramenées à `-infinity` : le filtre obtenu est identique.

**Écarts voulus.**

- `/max` et `/min` sur une période sans mesure répondent `200` avec `null`, au lieu de `500`
  (lecture de `data[0]` sur un tableau vide). Le comportement est aligné sur celui de `/avg`.
- Les mesures sont explicitement triées par date (`ORDER BY date`, gratuit car c'est l'ordre de
  l'index). À l'origine l'ordre dépendait du plan choisi par PostgreSQL.
- La moyenne est calculée par PostgreSQL en arithmétique décimale exacte, puis arrondie au flottant
  le plus proche. L'origine additionnait des flottants : les deux résultats peuvent différer sur le
  dernier chiffre significatif (écart relatif maximal observé : 7,9 × 10⁻¹⁵ sur 1 104 requêtes comparées).

**Effet.** Mesuré sur la base **non migrée**, un utilisateur : la consultation d'un mois passe de 169 ms à
0,92 ms, la moyenne sur un an de 155 ms à 2,3 ms. À vingt utilisateurs en trafic mixte, le débit passe
de 8 à 230 requêtes par seconde et le retard maximal de la boucle d'événements de 1 065 ms à 102 ms.
Les analyses sur tout l'historique ne gagnent en revanche qu'un facteur 1,6 (89 ms → 55 ms) : elles
butent sur le problème traité en 2.3.

### 2.2 Fin de la validation ligne par ligne

**Problème.** Chaque ligne lue en base repassait par le schéma Zod de l'API
(`result.rows.map((row) => WeatherDataSchema.parse(row))`). Cette validation n'apportait aucune
garantie — les données viennent de notre propre base — mais elle servait indirectement à convertir
les `DECIMAL`, que le pilote transmet sous forme de texte, en nombres.

**Modification.** La conversion est faite là où elle est nécessaire, au décodage de la réponse :

```ts
pg.types.setTypeParser(pg.types.builtins.NUMERIC, parseFloat);
```

Le second convertisseur concerne les dates. Par défaut le pilote crée un objet `Date` par ligne, que
`JSON.stringify` reconvertit aussitôt en texte ISO ; sur un export, ces deux conversions
représentaient environ 40 % du temps de traitement. Une base ne contient que quelques dizaines de milliers de jours
distincts : `toIsoDate` mémorise le texte ISO de chacun. Il est calculé avec le décodeur d'origine du
pilote, ce qui garantit une sortie identique au caractère près, quel que soit le fuseau du serveur. La
table de mémorisation est bornée à 100 000 entrées.

Conséquence sur les types : une mesure restituée par l'API est décrite par `WeatherMeasure` (date sous
forme de chaîne ISO), distinct de `WeatherData`, le type validé à l'ingestion.

**Effet.** Dans le profil CPU du serveur, la validation Zod passe de 14,5 % à 0,4 % du temps (elle ne
sert plus qu'à contrôler les entrées de l'API) et le ramasse-miettes de 9,7 % à 3,6 %. La mémorisation
des dates a ramené l'export complet de 56 ms à 34 ms lors des essais de développement.

### 2.3 Migration : clé primaire couvrante

**Problème.** Les robots insèrent chaque jour une mesure par lieu. Physiquement, la table est donc
rangée par date : les 14 610 mesures d'un lieu sont réparties sur 14 610 pages de 8 ko différentes.
Même avec un filtre SQL parfait, lire 40 ans d'un lieu obligeait PostgreSQL à visiter 115 Mo de pages
pour en extraire 400 ko de données utiles.

**Modification.** La migration `002-covering-primary-key` remplace l'index de la clé primaire par un
index qui contient aussi les deux colonnes lues :

```sql
CREATE UNIQUE INDEX CONCURRENTLY weather_location_date_covering_idx
    ON weather (location, date) INCLUDE (temperature, humidity);

ALTER TABLE weather
    DROP CONSTRAINT weather_pkey,
    ADD CONSTRAINT weather_pkey PRIMARY KEY USING INDEX weather_location_date_covering_idx;

ALTER TABLE weather SET (
    autovacuum_vacuum_insert_scale_factor = 0.001,
    autovacuum_vacuum_insert_threshold = 1000
);

VACUUM (ANALYZE) weather;
```

Dans l'index, les mesures d'un lieu sont contiguës et triées par date. PostgreSQL répond alors aux
lectures par un *index-only scan* : il ne visite plus la table. La contrainte d'unicité reste portée
par `(location, date)` ; les colonnes incluses ne sont que transportées.

**Points d'attention traités dans la migration.**

- **Aucune interruption de service.** `CREATE INDEX CONCURRENTLY` ne bloque ni lectures ni écritures.
  La bascule de la clé primaire est une opération de catalogue : elle prend un verrou exclusif pendant
  moins d'une seconde, protégé par un `lock_timeout` de 10 s pour ne jamais faire patienter le trafic
  derrière une transaction longue. Vérifié en rejouant la migration sous trafic (8 lecteurs et 2
  robots d'écriture) : 11 974 lectures et 4 903 écritures servies pendant le tir de 45 secondes qui
  englobait la migration, aucun échec, aucune écriture perdue ; la requête la plus lente a attendu
  1,4 s, à l'instant de la bascule. Sous cette charge, la migration a duré 28 secondes.
- **Rejouable.** Une construction interrompue laisse un index invalide : la migration le supprime et
  recommence. Si la clé primaire est déjà couvrante, elle ne refait que les réglages.
- **Pas de place perdue.** Un seul index subsiste. Il est même plus petit que l'ancien (690 Mo contre
  998 Mo), parce que l'ancien, construit au fil de l'eau, n'était rempli qu'à moitié.
- **L'autovacuum.** Un *index-only scan* n'évite la table que pour les pages que `VACUUM` a marquées
  « entièrement visibles ». Or, sur une table alimentée uniquement par insertions, l'autovacuum par
  défaut ne passe qu'après 20 % de croissance — des années ici. Le réglage posé par la migration le
  déclenche dès 0,1 % de nouvelles lignes. Vérifié : après 20 jours d'insertions simulées,
  l'autovacuum est passé de lui-même et les lectures sont revenues à zéro accès à la table.

**L'exécuteur de migrations** (`db/migrate.ts`) applique dans l'ordre les migrations absentes de la
table `schema_migrations`. Un verrou consultatif PostgreSQL empêche deux instances qui démarrent
ensemble d'appliquer la même migration, et le `statement_timeout` applicatif est levé le temps de la
construction d'index. La migration `001-create-weather-table` reprend la création de table que faisait
`createTable()` au démarrage : sur une base existante elle est sans effet.

**Effet.** Mesuré avant puis après migration, avec le même code : la moyenne sur 40 ans passe de 55 ms à
3,1 ms, le minimum sur dix ans de 13,9 ms à 1,3 ms, l'export complet de 62 ms à 22 ms. Pour une analyse
sur 40 ans, PostgreSQL consomme 2,5 ms de processeur au lieu de 50 ms et lit 96 pages au lieu de 14 743.
Le débit d'ingestion est inchangé : 794 requêtes par seconde avec un robot (698 à l'origine), 2 413 avec
dix robots (2 502 à l'origine), dans la marge de variation des mesures. La migration a duré 16 secondes
pendant la campagne officielle et 22 secondes lors d'un premier essai.

### 2.4 Requêtes préparées nommées

**Problème.** Une fois les requêtes ramenées à une fraction de milliseconde, leur analyse et leur
planification par PostgreSQL, refaites à chaque appel, pesaient autant que leur exécution.

**Modification.** Les quatre lectures portent un nom (`weather-data`, `weather-avg`, `weather-max`,
`weather-min`) : le pilote les prépare une fois par connexion et PostgreSQL réutilise leur plan.

```ts
await this.pool.query({
  name: `weather-${aggregate}`,
  text: SELECT_AGGREGATE[aggregate],
  values: [location, range.after, range.until],
});
```

Le plan générique a été vérifié (`EXPLAIN` avec `plan_cache_mode = force_generic_plan`) : les bornes
`COALESCE($2, …)` restent des conditions d'index, que les paramètres soient fournis ou non.

**Effet.** Mesuré en alternant deux fois la version avec et sans requêtes préparées, à vingt utilisateurs :
le temps processeur de PostgreSQL par requête passe de 0,30 ms à 0,18 ms pour une moyenne sur un an
(− 41 %) et de 0,22 ms à 0,11 ms pour une consultation de 30 jours (− 51 %). Les analyses sur 40 ans,
dominées par le parcours de l'index, ne changent pas. Le débit du serveur Node.js varie peu : le gain
est une base de données moins chargée, donc de la marge pour plus d'instances applicatives.

**Point d'attention.** Avec PgBouncer en mode « transaction », les requêtes préparées nommées exigent
la version 1.21 ou plus récente (voir la recommandation C1).

### 2.5 Pagination optionnelle

**Problème.** `GET /weather/data/:location` sans période renvoie tout l'historique : 14 610 mesures et
1,4 Mo de JSON pour 40 ans, sans aucun moyen pour le client de borner la réponse.

**Modification.** Le paramètre facultatif `limit` (entier de 1 à 100 000) borne le nombre de mesures
(`LIMIT $4::int` ; `LIMIT NULL` signifie « pas de limite »). Comme `from` est exclu, la date de la
dernière mesure reçue sert de curseur pour la page suivante : la pagination ne demande aucun autre
mécanisme. Sans `limit`, le comportement est strictement celui d'avant.

**Effet.** Sur un lieu de 40 ans, la première page de 1 000 mesures est servie en 2,4 ms et pèse 94 ko,
contre 24 ms et 1,38 Mo pour l'export complet.

### 2.6 Compression et en-tête de cache

**Compression.** Le middleware `compression` est activé avec trois réglages issus de mesures sur des
réponses réelles de l'API :

| Réglage | Valeur | Justification mesurée |
|---|---|---|
| Niveau gzip | 1 (le plus rapide) | Export de 1,27 Mo : 5,6 ms pour 116 ko, contre 17,8 ms pour 96 ko au niveau 6 par défaut |
| Qualité brotli | 1 | Même export : 2,9 ms pour 110 ko, contre 9,9 ms pour 101 ko en qualité 4 par défaut |
| Seuil | 4 ko | En dessous, la réponse tient dans la première salve TCP : la compresser coûtait jusqu'à 27 % de débit sans gain de transfert |

Désactivable (`api.compression: false`) si un reverse proxy ou un CDN compresse déjà.

**Cache.** Les réponses `GET` réussies portent `Cache-Control: public, max-age=60` : navigateurs et
caches intermédiaires peuvent réutiliser une réponse pendant une minute. Les relevés n'évoluant
qu'une fois par jour, le risque d'obsolescence est négligeable ; la durée est réglable
(`api.cacheMaxAgeSeconds`, 0 pour désactiver). Les réponses d'erreur ne sont pas mises en cache.

**Effet.** Pour un client qui accepte gzip, l'export complet passe de 1,38 Mo à 119 ko (÷ 11,5) pour 5 ms
de temps de réponse en plus sur la machine de mesure, et une consultation d'un an de 34 ko à 3,1 ko pour
6 % de débit en moins. Sur un réseau réel, le temps de transfert économisé dépasse largement ce coût.
L'effet du cache dépend des clients et des intermédiaires : il n'est pas mesuré ici.

### 2.7 Exécution : code compilé, pool configuré, arrêt propre

**Code compilé.** `npm start` lançait le TypeScript à travers `ts-node` (chargeur expérimental), y
compris en production : le compilateur TypeScript était chargé dans le processus serveur. `npm start`
exécute désormais le JavaScript compilé (`npm run build`, sortie dans `dist/`) ; l'ancien mode reste
disponible pour le développement (`npm run start:dev`).

| | `ts-node` (origine) | Code compilé |
|---|---|---|
| Temps de démarrage (médiane de 7 lancements) | 2,15 s | 0,31 s |
| Mémoire résidente au repos | 231 Mo | 65 Mo |

Le débit en régime établi est inchangé (le code exécuté est le même une fois chargé) ; le gain porte
sur le démarrage — donc sur la vitesse de redéploiement et de mise à l'échelle — et sur la mémoire de
chaque instance. Les dépendances de développement ne sont plus nécessaires à l'exécution.

**Pool de connexions.** Le pool était créé sans aucun réglage. `config/default.yaml` fixe désormais :
`max` (10 connexions), `connectionTimeoutMillis` (5 s : en cas de saturation, une requête échoue vite
au lieu de s'empiler sans limite), `statement_timeout` (15 s : aucune requête ne peut monopoliser la
base), `idleTimeoutMillis` et `application_name` (pour reconnaître l'application dans
`pg_stat_activity`).

**Arrêt propre.** Sur `SIGTERM` ou `SIGINT`, le serveur cesse d'accepter des connexions, laisse finir
les requêtes en cours, ferme le pool, puis s'arrête (délai de garde de 10 s). À l'origine, `SIGINT`
coupait net les requêtes en vol et `SIGTERM` n'était pas géré : chaque redéploiement produisait des
erreurs côté client.

**Migrations au démarrage.** `migrations.runOnStart` vaut `true` en développement (le schéma se crée
tout seul, comme avant) et `false` en production, où `npm run migrate` est une étape de déploiement.

### 2.8 Nettoyage

- `getAllWeatherData()` (`SELECT * FROM weather` sans aucune borne) n'était appelée nulle part. Sur la
  base de mesure, elle aurait chargé 14,6 millions de lignes en mémoire : elle est supprimée.
- `createTable()` est remplacée par la migration 001.
- La dépendance `axios`, jamais importée, est retirée.

### 2.9 Tests et outillage

Le projet déclarait Jest sans aucun test. Sont ajoutés :

- **18 tests unitaires** (`npm test`, sans base de données) : conversion des bornes de date,
  contrat `null` / `[]`, délégation des agrégats ;
- **29 tests d'intégration** (`npm run test:integration`, PostgreSQL réel) : les réponses
  attendues sont celles relevées sur l'application d'origine avant toute modification ; migrations
  sur une base existante et sur une base vide ;
- **un test différentiel** (`bench/compare.mjs`) qui envoie les mêmes requêtes à l'origine et à la
  version optimisée et compare les réponses ;
- **l'outillage de mesure** du dossier `bench/` (jeu de données, injecteur de charge, sondes,
  génération des tableaux et graphiques).

## 3. Compatibilité

### Ce qui ne change pas

- Les routes, leurs paramètres et le format des réponses.
- La sémantique des périodes (`from` exclu, `to` inclus, jour local du serveur).
- Les réponses `null` et `[]`, les codes d'erreur de validation (400) et leur corps.
- L'ingestion : validation, stockage, erreur 500 sur un doublon.
- Le schéma logique de la table : mêmes colonnes, mêmes types, même clé primaire.

### Ce qui change

| Changement | Avant | Après |
|---|---|---|
| `/max` et `/min` sur une période sans mesure | `500 Internal Server Error` | `200` avec `{"max": null}` ou `{"min": null}` |
| Ordre des mesures de `/data` | Non garanti | Trié par date |
| Dernier chiffre d'une moyenne | Somme de flottants | Moyenne décimale exacte, arrondie |
| Paramètre `limit` de `/data` | Ignoré | Borne la réponse ; une valeur invalide répond 400 |
| En-têtes des réponses `GET` | — | `Cache-Control`, `Content-Encoding` si le client l'accepte, `Vary: Accept-Encoding` |
| `npm start` | Exécute le TypeScript avec `ts-node` | Exécute `dist/` (après `npm run build`) |
| Création de la table | Au démarrage de l'application | Par migration (au démarrage en développement) |

### Vérification

Trois dispositifs, détaillés dans le rapport de performance (section 8) :

- **Tests automatisés** — 18 tests unitaires et 29 tests d'intégration ; ces derniers attendent les
  réponses relevées sur l'application d'origine avant toute modification.
- **Comparaison différentielle** — 1 104 requêtes envoyées à l'origine et à la version optimisée :
  763 réponses strictement identiques, 162 moyennes identiques à 10⁻⁹ près, 179 erreurs 500 de
  l'origine corrigées, aucun écart inattendu.
- **Fuseaux horaires** — la même comparaison rejouée avec les serveurs réglés sur Paris, New York,
  São Paulo et Calcutta (404 requêtes chacune), sans aucun écart. À New York, l'application d'origine
  tournait sur la base migrée : la migration reste compatible avec l'ancien code.

## 4. Déploiement et retour arrière

### Déploiement

1. `npm ci && npm run build`.
2. `npm run migrate` sur la base cible. La migration est en ligne ; elle peut être lancée avant,
   pendant ou après le déploiement du code, qui fonctionne avec l'ancien index comme avec le nouveau.
   Prévoir de l'espace disque pour l'index en construction (690 Mo pour 14,6 millions de lignes),
   rendu par la suppression de l'ancien.
3. Déployer la nouvelle version (`NODE_ENV=production npm start`), instance par instance : l'arrêt
   propre permet un déploiement sans requête perdue.

### Retour arrière

- **Code.** Redéployer la version précédente : elle fonctionne sans modification sur la base migrée
  (`SELECT *` renvoie les mêmes colonnes, la clé primaire porte le même nom).
- **Base.** Le retour à l'index d'origine n'est normalement pas nécessaire. S'il le fallait :

  ```sql
  CREATE UNIQUE INDEX CONCURRENTLY weather_location_date_idx ON weather (location, date);
  ALTER TABLE weather
      DROP CONSTRAINT weather_pkey,
      ADD CONSTRAINT weather_pkey PRIMARY KEY USING INDEX weather_location_date_idx;
  ALTER TABLE weather RESET (autovacuum_vacuum_insert_scale_factor, autovacuum_vacuum_insert_threshold);
  DELETE FROM schema_migrations WHERE id = '002-covering-primary-key';
  ```

## 5. Inventaire des fichiers

| Fichier | État | Rôle |
|---|---|---|
| `src/weather/repository.ts` | Modifié | Requêtes SQL filtrées, agrégats, conversions, requêtes préparées |
| `src/weather/service.ts` | Modifié | Délègue au dépôt ; contrat `null` / `[]` |
| `src/weather/dayRange.ts` | Ajouté | Conversion des bornes `from` / `to` en jours |
| `src/weather/dto.ts` | Modifié | Type `WeatherMeasure`, schéma avec `limit` |
| `src/weather/controller.ts` | Modifié | En-tête de cache, validation de `limit` |
| `src/server.ts` | Modifié | Compression des réponses |
| `src/index.ts` | Modifié | Migrations au démarrage (développement), arrêt propre |
| `src/db/migrations.ts`, `migrate.ts`, `migrate-cli.ts` | Ajoutés | Migrations du schéma et leur exécuteur |
| `config/default.yaml`, `production.yaml` | Modifiés | Pool, compression, cache, migrations |
| `config/test.yaml` | Ajouté | Schéma PostgreSQL dédié aux tests |
| `package.json`, `package-lock.json` | Modifiés | Scripts ; `compression` ajouté, `axios` retiré, `ts-jest` pour les tests |
| `tsconfig.json`, `tsconfig.build.json` | Modifié, ajouté | Build de production limité à `src/`, sortie `dist/` |
| `jest.config.ts` | Modifié | Tests TypeScript en modules ES |
| `tests/` | Ajouté | Tests unitaires et d'intégration |
| `bench/` | Ajouté | Outillage de mesure |
| `src/apiLogger.ts`, `src/app.ts`, `src/logger.ts` | Inchangés | |
