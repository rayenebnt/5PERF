import express, { Response } from 'express';
import config from 'config';
import { validateRequest } from 'zod-express-middleware';
import {
  WeatherData,
  WeatherDataFilterSchema,
  WeatherDataSchema,
  WeatherFilterSchema,
} from './dto.js';
import WeatherService from './service.js';
import logger from '../logger.js';

const router = express();

// Les relevés historiques changent au plus une fois par jour : on autorise
// navigateurs, CDN et reverse proxy à réutiliser une réponse quelques dizaines
// de secondes (réglable, 0 pour désactiver).
const cacheMaxAge = config.get<number>('api.cacheMaxAgeSeconds');
const cacheControl = cacheMaxAge > 0 ? `public, max-age=${cacheMaxAge}` : null;

function sendCacheable(res: Response, body: unknown) {
  if (cacheControl) {
    res.set('Cache-Control', cacheControl);
  }
  return res.json(body);
}

router.post(
  '/data',
  validateRequest({ body: WeatherDataSchema }),
  async (req, res) => {
    const data: WeatherData = req.body;

    try {
      await WeatherService.addData(data);
    } catch (error) {
      logger.error(error);
      return res.sendStatus(500);
    }
    return res.sendStatus(200);
  }
);

router.get(
  '/data/:location',
  validateRequest({ query: WeatherDataFilterSchema }),
  async (req, res) => {
    const { location } = req.params;
    const options = req.query;
    try {
      const data = await WeatherService.getData(location, options);
      return sendCacheable(res, data);
    } catch (error) {
      logger.error(error);
      return res.sendStatus(500);
    }
  }
);

router.get(
  '/avg/:location',
  validateRequest({ query: WeatherFilterSchema }),
  async (req, res) => {
    const { location } = req.params;
    const options = req.query;
    try {
      const avg = await WeatherService.getMean(location, options);
      return sendCacheable(res, { avg });
    } catch (error) {
      logger.error(error);
      return res.sendStatus(500);
    }
  }
);

router.get(
  '/max/:location',
  validateRequest({ query: WeatherFilterSchema }),
  async (req, res) => {
    const { location } = req.params;
    const options = req.query;
    try {
      const max = await WeatherService.getMax(location, options);
      return sendCacheable(res, { max });
    } catch (error) {
      logger.error(error);
      return res.sendStatus(500);
    }
  }
);

router.get(
  '/min/:location',
  validateRequest({ query: WeatherFilterSchema }),
  async (req, res) => {
    const { location } = req.params;
    const options = req.query;
    try {
      const min = await WeatherService.getMin(location, options);
      return sendCacheable(res, { min });
    } catch (error) {
      logger.error(error);
      return res.sendStatus(500);
    }
  }
);

export default router;
