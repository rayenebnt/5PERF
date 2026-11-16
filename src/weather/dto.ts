import { z } from 'zod';

export const WeatherDataSchema = z.object({
  location: z.string(),
  date: z.coerce.date(),
  temperature: z.coerce.number(),
  humidity: z.coerce.number(),
});

export type WeatherData = z.infer<typeof WeatherDataSchema>;

/** Mesure telle que l'API la restitue : la date est déjà au format ISO 8601. */
export interface WeatherMeasure {
  location: string;
  date: string;
  temperature: number;
  humidity: number;
}

export const WeatherFilterSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type WeatherFilter = z.infer<typeof WeatherFilterSchema>;

// Taille de page maximale de GET /weather/data/:location.
export const MAX_DATA_LIMIT = 100_000;

// La consultation des mesures accepte en plus `limit`, qui borne le nombre de
// lignes renvoyées. Comme `from` est exclu, la date de la dernière mesure reçue
// sert de curseur pour demander la page suivante.
export const WeatherDataFilterSchema = WeatherFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(MAX_DATA_LIMIT).optional(),
});

export type WeatherDataFilter = z.infer<typeof WeatherDataFilterSchema>;
