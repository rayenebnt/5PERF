# WeatherTrack Pro — Fil conducteur de la présentation

Support : [04-presentation.pdf](04-presentation.pdf) (17 diapositives, environ 15 minutes).
Ce document donne, pour chaque diapositive, le message à faire passer et la transition vers la
suivante. Tous les chiffres viennent du [rapport de performance](01-rapport-de-performance.md).

| # | Diapositive | Durée | Message à faire passer |
|---:|---|---:|---|
| 1 | Couverture | 0:20 | Se présenter ; annoncer le plan : le problème, la mesure, les causes, les corrections, le résultat, la suite. |
| 2 | Le contexte | 0:45 | WeatherTrack Pro ralentit à mesure que son historique grossit : consultation lente, analyses lentes, clients qui partent. La question : pourquoi, et que faire en premier. |
| 3 | La démarche | 0:45 | Quatre temps : mesurer, diagnostiquer, corriger par ordre d'impact, vérifier. Règle tenue tout au long du projet : aucune correction sans mesure avant et après. |
| 4 | Le banc de mesure | 1:00 | Pas d'accès aux données réelles : on construit une base réaliste de 14,6 millions de mesures (1 006 lieux, 40 ans), insérées dans le même ordre que les robots. Insister sur ce dernier point, il compte pour l'étape 2. |
| 5 | L'état initial | 1:00 | Trois chiffres : 169 ms pour renvoyer 30 mesures ; 8 requêtes par seconde au maximum ; 5,6 secondes d'attente dès 10 requêtes par seconde. Seul, un utilisateur ne voit rien d'anormal ; à plusieurs, le service s'effondre. |
| 6 | Le diagnostic | 1:15 | Lire le code avec le jury : la requête SQL ignore la période et renvoie tout l'historique ; le filtre se fait ensuite en mémoire, avec 3 à 10 objets dayjs par ligne. Conclusion : le coût dépend du stock, pas de la réponse. |
| 7 | Le profil CPU | 0:45 | La preuve par le profil : plus de 80 % du temps du serveur sert à décoder, valider et filtrer des lignes qui ne seront pas renvoyées. |
| 8 | L'effet du volume | 1:00 | La même question coûte 3 ms sur un lieu d'un an et 83 ms sur un lieu de 40 ans : 2 ms de plus par année d'historique. C'est l'explication du ralentissement progressif — et la courbe bleue annonce le résultat. |
| 9 | Les causes | 1:00 | Six causes, classées par impact, chacune avec sa preuve. Deux changements suffisent à les lever : c'est le pragmatisme de la démarche. |
| 10 | Étape 1, le code | 1:15 | Le filtre et les calculs passent en SQL. Résultat : 0,9 ms au lieu de 169 pour un mois, 230 requêtes par seconde au lieu de 8. Mais une moyenne sur 40 ans reste à 55 ms : la base est lente à son tour. |
| 11 | Étape 2, la migration | 1:15 | Pourquoi : les mesures d'un lieu sont éparpillées, une page sur sept. L'index couvrant les regroupe : 96 pages lues au lieu de 14 700, 3,1 ms au lieu de 55. Migration en ligne, 16 secondes, sans interruption. |
| 12 | Étape 3, les réglages | 1:00 | Quatre réglages mesurés. Et deux pistes écartées, elles aussi sur mesure : savoir s'arrêter fait partie de l'optimisation. |
| 13 | L'avant / après | 1:00 | Temps de réponse divisés par 6 à 250. Être honnête sur l'export complet : il renvoie réellement 14 610 mesures. |
| 14 | La tenue en charge | 1:00 | Le point de saturation passe de moins de 10 à 400 requêtes par seconde, et chaque requête consomme 66 fois moins de processeur, base comprise. |
| 15 | La non-régression | 0:45 | Aller vite ne vaut rien si les réponses changent : 1 104 requêtes comparées à l'origine, 47 tests, 4 fuseaux horaires. Un seul écart, voulu : une erreur 500 corrigée. |
| 16 | Les recommandations | 1:00 | Ce qui reste, par horizon. Citer un point par colonne : la qualité des données, la mise à l'échelle, les agrégats pré-calculés. |
| 17 | La conclusion | 0:40 | Trois enseignements : le problème était dans le code ; deux corrections font l'essentiel ; le gain est vérifiable par le banc et les tests livrés. |

## Questions probables et éléments de réponse

- **« Vos données sont synthétiques : les résultats tiennent-ils en production ? »** Les valeurs
  absolues, non. Les rapports, oui : la cause est structurelle (un travail proportionnel à
  l'historique), et la courbe de la diapositive 8 le montre pour six volumes différents. Le banc est
  livré : il se rejoue sur une copie des données réelles.
- **« Pourquoi ne pas avoir simplement ajouté un cache ? »** Un cache masque le problème pour les
  requêtes répétées et le laisse entier pour les autres. Une fois la requête ramenée à moins d'une
  milliseconde, le cache devient un complément (en-tête `Cache-Control` déjà émis, cache partagé en
  recommandation), pas une béquille.
- **« Pourquoi ne pas avoir ajouté des serveurs ? »** À 190 ms de processeur par requête, il aurait
  fallu une vingtaine de cœurs pour 100 requêtes par seconde, et le coût aurait continué de croître
  avec l'historique. Aujourd'hui un seul processus en tient 300, et l'application se met à l'échelle
  sans modification (866 requêtes par seconde avec deux processus).
- **« La migration est-elle risquée ? »** Elle se fait en ligne, se rejoue après un échec, et
  l'ancien code fonctionne sur la base migrée — vérifié. Le retour arrière est documenté.
- **« Pourquoi garder des comportements discutables (null lu comme 0, doublon en erreur 500) ? »**
  Parce qu'ils touchent aux données et au contrat de l'API : les changer n'est pas une décision
  d'optimisation. Ils sont documentés, testés, et placés en tête des recommandations.
- **« Que reste-t-il de lent ? »** L'export complet (22 ms, 1,4 Mo) : il est lourd par nature. La
  pagination est disponible, la compression le divise par 11 sur le réseau, et l'export en flux est
  recommandé pour une future version de l'API.
