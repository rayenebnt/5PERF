import repositoryInstance, { WeatherDataRepository } from './repository.js';
import { WeatherData, WeatherDataFilter, WeatherFilter } from './dto.js';
import { toDayRange } from './dayRange.js';

export class WeatherService {
  private weatherRepository: WeatherDataRepository;
  constructor(weatherRepository: WeatherDataRepository = repositoryInstance) {
    this.weatherRepository = weatherRepository;
  }

  async addData(data: WeatherData) {
    return this.weatherRepository.insertWeatherData(data);
  }

  async getData(location: string, options: WeatherDataFilter) {
    const range = toDayRange(options);
    // Comme les dates, `limit` arrive sous forme de chaîne déjà validée.
    const limit = options.limit === undefined ? null : Number(options.limit);
    const data = await this.weatherRepository.getWeatherData(
      location,
      range,
      limit
    );
    if (data.length > 0) {
      return data;
    }
    // Contrat historique de l'API : `null` pour un lieu inconnu, `[]` pour un
    // lieu connu sans mesure sur la période. Sans borne, « aucune ligne » veut
    // déjà dire « lieu inconnu » ; sinon on le vérifie par une lecture d'index.
    const unbounded = range.after === null && range.until === null;
    if (unbounded || !(await this.weatherRepository.locationExists(location))) {
      return null;
    }
    return data;
  }

  async getMean(location: string, options: WeatherFilter) {
    return this.weatherRepository.getTemperatureAggregate(
      'avg',
      location,
      toDayRange(options)
    );
  }

  async getMax(location: string, options: WeatherFilter) {
    return this.weatherRepository.getTemperatureAggregate(
      'max',
      location,
      toDayRange(options)
    );
  }

  async getMin(location: string, options: WeatherFilter) {
    return this.weatherRepository.getTemperatureAggregate(
      'min',
      location,
      toDayRange(options)
    );
  }
}

export default new WeatherService();
