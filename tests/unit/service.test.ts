import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { WeatherDataRepository } from '../../src/weather/repository.js';
import type { WeatherMeasure } from '../../src/weather/dto.js';

// Le module du dépôt ouvre un pool PostgreSQL à l'import : on le remplace pour
// que ces tests unitaires tournent sans base de données.
jest.unstable_mockModule('../../src/weather/repository.js', () => ({
  default: {},
  WeatherDataRepository: class {},
}));
const { WeatherService } = await import('../../src/weather/service.js');

const measure = (day: string, temperature: number): WeatherMeasure => ({
  location: 'Lyon',
  date: `${day}T00:00:00.000Z`,
  temperature,
  humidity: 40,
});

function createRepository() {
  return {
    insertWeatherData: jest.fn<WeatherDataRepository['insertWeatherData']>(),
    getWeatherData: jest.fn<WeatherDataRepository['getWeatherData']>(),
    getTemperatureAggregate:
      jest.fn<WeatherDataRepository['getTemperatureAggregate']>(),
    locationExists: jest.fn<WeatherDataRepository['locationExists']>(),
  };
}

// Paramètres tels que les reçoit réellement le service : des chaînes.
const filter = (from?: string, to?: string) =>
  ({ from, to }) as unknown as { from?: Date; to?: Date };

describe('WeatherService', () => {
  let repository: ReturnType<typeof createRepository>;
  let service: InstanceType<typeof WeatherService>;

  beforeEach(() => {
    repository = createRepository();
    service = new WeatherService(
      repository as unknown as WeatherDataRepository
    );
  });

  describe('getData', () => {
    test('délègue le filtrage par période à la base', async () => {
      const rows = [measure('2023-12-23', 27), measure('2023-12-25', 25)];
      repository.getWeatherData.mockResolvedValue(rows);

      const data = await service.getData('Lyon', filter('2023-12-22', '2023-12-25'));

      expect(data).toBe(rows);
      expect(repository.getWeatherData).toHaveBeenCalledWith(
        'Lyon',
        { after: '2023-12-22', until: '2023-12-25' },
        null
      );
      expect(repository.locationExists).not.toHaveBeenCalled();
    });

    test('transmet la taille de page demandée', async () => {
      repository.getWeatherData.mockResolvedValue([measure('2023-12-23', 27)]);

      await service.getData('Lyon', {
        limit: '500',
      } as unknown as { limit?: number });

      expect(repository.getWeatherData).toHaveBeenCalledWith(
        'Lyon',
        { after: null, until: null },
        500
      );
    });

    test('renvoie null pour un lieu inconnu, sans requête supplémentaire', async () => {
      repository.getWeatherData.mockResolvedValue([]);

      expect(await service.getData('Inconnu', filter())).toBeNull();
      expect(repository.locationExists).not.toHaveBeenCalled();
    });

    test('renvoie null pour un lieu inconnu interrogé sur une période', async () => {
      repository.getWeatherData.mockResolvedValue([]);
      repository.locationExists.mockResolvedValue(false);

      expect(await service.getData('Inconnu', filter('2023-01-01'))).toBeNull();
      expect(repository.locationExists).toHaveBeenCalledWith('Inconnu');
    });

    test('renvoie [] pour un lieu connu sans mesure sur la période', async () => {
      repository.getWeatherData.mockResolvedValue([]);
      repository.locationExists.mockResolvedValue(true);

      expect(await service.getData('Lyon', filter('2030-01-01'))).toEqual([]);
    });
  });

  describe('agrégats', () => {
    const AGGREGATES = [
      { method: 'getMean', aggregate: 'avg' },
      { method: 'getMax', aggregate: 'max' },
      { method: 'getMin', aggregate: 'min' },
    ] as const;

    test.each(AGGREGATES)(
      '$method demande l’agrégat $aggregate à la base',
      async ({ method, aggregate }) => {
        repository.getTemperatureAggregate.mockResolvedValue(24.5);

        const value = await service[method](
          'Lyon',
          filter(undefined, '2023-12-25')
        );

        expect(value).toBe(24.5);
        expect(repository.getTemperatureAggregate).toHaveBeenCalledWith(
          aggregate,
          'Lyon',
          { after: null, until: '2023-12-25' }
        );
      }
    );

    test('renvoient null quand la période ne contient aucune mesure', async () => {
      repository.getTemperatureAggregate.mockResolvedValue(null);

      expect(await service.getMax('Lyon', filter('2030-01-01'))).toBeNull();
      expect(await service.getMin('Lyon', filter('2030-01-01'))).toBeNull();
      expect(await service.getMean('Lyon', filter('2030-01-01'))).toBeNull();
    });
  });

  test('addData transmet la mesure au dépôt', async () => {
    const data = {
      location: 'Lyon',
      date: new Date('2023-12-24T23:00:00.000Z'),
      temperature: 25,
      humidity: 40,
    };
    await service.addData(data);
    expect(repository.insertWeatherData).toHaveBeenCalledWith(data);
  });
});
