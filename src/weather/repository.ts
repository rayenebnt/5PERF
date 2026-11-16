import pg from 'pg';
import config from 'config';
import { WeatherData, WeatherMeasure } from './dto.js';
import { DayRange } from './dayRange.js';

const poolConfig = config.get<pg.PoolConfig>('database');

export type TemperatureAggregate = 'avg' | 'max' | 'min';

// PostgreSQL transmet les DECIMAL sous forme de texte. On les convertit en
// nombres dès le décodage de la réponse : il n'est plus nécessaire de
// revalider chaque ligne avec Zod pour obtenir des nombres JavaScript.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, parseFloat);

// Par défaut le pilote crée un objet Date par ligne (minuit, heure locale),
// que JSON.stringify reconvertit ensuite en texte ISO : ces deux conversions
// représentaient l'essentiel du coût d'un export. Une base ne contient que
// quelques dizaines de milliers de jours distincts : on mémorise le texte ISO
// de chacun, calculé avec le décodeur d'origine pour un résultat identique.
const parseDefaultDate = pg.types.getTypeParser(pg.types.builtins.DATE);
const MAX_MEMOIZED_DAYS = 100_000;
const isoByDay = new Map<string, string | null>();

function toIsoDate(day: string): string | null {
  let iso = isoByDay.get(day);
  if (iso === undefined) {
    iso = JSON.parse(JSON.stringify(parseDefaultDate(day))) as string | null;
    if (isoByDay.size >= MAX_MEMOIZED_DAYS) {
      isoByDay.clear();
    }
    isoByDay.set(day, iso);
  }
  return iso;
}
pg.types.setTypeParser(pg.types.builtins.DATE, toIsoDate);

// Filtre commun à toutes les lectures. Les trois conditions portent sur la clé
// primaire (location, date) : PostgreSQL ne parcourt que la portion d'index
// correspondant au lieu et à la période demandés, au lieu de renvoyer tout
// l'historique du lieu à l'application. COALESCE rend les bornes facultatives
// tout en gardant un texte de requête unique.
const RANGE_FILTER = `
  WHERE location = $1
    AND date > COALESCE($2::date, '-infinity')
    AND date <= COALESCE($3::date, 'infinity')
`;

// Une mesure enregistrée sans température ou sans humidité (NULL) a toujours
// été restituée comme valant 0 par l'API, moyennes comprises : COALESCE
// conserve ce comportement (voir docs/03-recommandations.md, « Qualité des
// données »).
//
// Les colonnes sont nommées (pas de SELECT *) et le tri suit l'ordre de
// l'index : l'ordre des mesures est garanti sans coût supplémentaire.
const SELECT_DATA = `
  SELECT location,
         date,
         COALESCE(temperature, 0) AS temperature,
         COALESCE(humidity, 0) AS humidity
  FROM weather
  ${RANGE_FILTER}
  ORDER BY date
  LIMIT $4::int
`;

// Les agrégats sont calculés par la base : une seule ligne transite sur le
// réseau, quel que soit le nombre de mesures de la période.
//
// Ces lectures sont envoyées comme requêtes préparées nommées : PostgreSQL les
// analyse et les planifie une fois par connexion au lieu d'une fois par appel,
// ce qui divise par deux son temps CPU sur les requêtes courtes.
const SELECT_AGGREGATE: Record<TemperatureAggregate, string> = {
  avg: `SELECT avg(COALESCE(temperature, 0)) AS value FROM weather ${RANGE_FILTER}`,
  max: `SELECT max(COALESCE(temperature, 0)) AS value FROM weather ${RANGE_FILTER}`,
  min: `SELECT min(COALESCE(temperature, 0)) AS value FROM weather ${RANGE_FILTER}`,
};

const SELECT_LOCATION_EXISTS = `
  SELECT EXISTS (SELECT 1 FROM weather WHERE location = $1) AS found
`;

export class WeatherDataRepository {
  private pool: pg.Pool;

  constructor() {
    this.pool = new pg.Pool(poolConfig);
  }

  async insertWeatherData(weatherData: WeatherData): Promise<void> {
    const query = `
            INSERT INTO weather (location, date, temperature, humidity)
            VALUES ($1, $2, $3, $4)
        `;

    const values = [
      weatherData.location,
      weatherData.date,
      weatherData.temperature,
      weatherData.humidity,
    ];
    await this.pool.query(query, values);
  }

  /**
   * Mesures d'un lieu sur une période, triées par date. `limit` borne le
   * nombre de lignes (`null` : pas de limite, LIMIT NULL en SQL).
   */
  async getWeatherData(
    location: string,
    range: DayRange,
    limit: number | null = null
  ): Promise<WeatherMeasure[]> {
    const result = await this.pool.query<WeatherMeasure>({
      name: 'weather-data',
      text: SELECT_DATA,
      values: [location, range.after, range.until, limit],
    });
    return result.rows;
  }

  /** Agrégat de température d'un lieu sur une période (`null` sans mesure). */
  async getTemperatureAggregate(
    aggregate: TemperatureAggregate,
    location: string,
    range: DayRange
  ): Promise<number | null> {
    const result = await this.pool.query<{ value: number | null }>({
      name: `weather-${aggregate}`,
      text: SELECT_AGGREGATE[aggregate],
      values: [location, range.after, range.until],
    });
    return result.rows[0].value;
  }

  async locationExists(location: string): Promise<boolean> {
    const result = await this.pool.query<{ found: boolean }>(
      SELECT_LOCATION_EXISTS,
      [location]
    );
    return result.rows[0].found;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default new WeatherDataRepository();
