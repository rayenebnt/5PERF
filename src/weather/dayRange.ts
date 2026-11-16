import dayjs from 'dayjs';
import { WeatherFilter } from './dto.js';

/**
 * Bornes d'une recherche, exprimées en jours calendaires (`YYYY-MM-DD`) :
 * `after` est exclue, `until` est incluse. `null` signifie « pas de borne ».
 */
export interface DayRange {
  after: string | null;
  until: string | null;
}

/**
 * Convertit un paramètre `from` / `to` en jour calendaire.
 *
 * Le code d'origine comparait `dayjs(from)` à chaque mesure, une mesure étant
 * datée à minuit (heure locale) de son jour. Comparer des instants revenait
 * donc à comparer des jours : celui de la mesure et celui où tombe la borne.
 * On calcule ce jour une seule fois par requête, avec le même appel à dayjs
 * (les règles d'interprétation des dates restent strictement les mêmes), et
 * c'est PostgreSQL qui applique ensuite le filtre grâce à son index.
 *
 * À l'exécution la valeur est la chaîne brute de l'URL : le middleware de
 * validation vérifie le format mais ne convertit pas `req.query`.
 */
function toDay(value: Date | string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const day = dayjs(value);
  // PostgreSQL ne lit pas les années négatives sous cette forme ; aucune
  // mesure n'étant antérieure à l'an 1, « -infinity » filtre à l'identique.
  return day.year() < 1 ? '-infinity' : day.format('YYYY-MM-DD');
}

export function toDayRange(filter: WeatherFilter): DayRange {
  return { after: toDay(filter.from), until: toDay(filter.to) };
}
