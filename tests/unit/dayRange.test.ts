import { describe, expect, test } from '@jest/globals';
import { toDayRange } from '../../src/weather/dayRange.js';

// À l'exécution, les bornes sont les chaînes brutes de l'URL : le middleware
// de validation ne convertit pas `req.query`. On reproduit ce cas ici.
const range = (from?: string, to?: string) =>
  toDayRange({
    from: from as unknown as Date | undefined,
    to: to as unknown as Date | undefined,
  });

describe('toDayRange', () => {
  test('sans borne, la recherche est ouverte des deux côtés', () => {
    expect(range()).toEqual({ after: null, until: null });
  });

  test('une date seule désigne ce jour, quel que soit le fuseau du serveur', () => {
    expect(range('2023-12-22', '2023-12-25')).toEqual({
      after: '2023-12-22',
      until: '2023-12-25',
    });
  });

  test('chaque borne est facultative', () => {
    expect(range('2023-12-22')).toEqual({ after: '2023-12-22', until: null });
    expect(range(undefined, '2023-12-25')).toEqual({
      after: null,
      until: '2023-12-25',
    });
  });

  test("une date-heure est ramenée au jour local où tombe l'instant", () => {
    // Les tests tournent avec TZ=UTC (voir jest.config.ts).
    expect(range('2023-12-22T10:00:00Z').after).toBe('2023-12-22');
    expect(range('2023-12-22T23:30:00-05:00').after).toBe('2023-12-23');
    expect(range('2023-12-22T00:30:00+02:00').after).toBe('2023-12-21');
    expect(range('2023-12-22 18:45').after).toBe('2023-12-22');
  });

  test('les écritures abrégées suivent les règles de dayjs', () => {
    expect(range('2023').after).toBe('2023-01-01');
    expect(range('2010-06').after).toBe('2010-06-01');
    expect(range('2023/12/22').after).toBe('2023-12-22');
    expect(range('2015-02-30').after).toBe('2015-03-02');
  });

  test('un objet Date est accepté comme une chaîne', () => {
    expect(
      toDayRange({ from: new Date('2023-12-22T10:00:00Z') }).after
    ).toBe('2023-12-22');
  });

  test('une année antérieure à l’an 1 équivaut à « moins l’infini »', () => {
    expect(range('-000001-01-01T00:00:00Z')).toEqual({
      after: '-infinity',
      until: null,
    });
  });

  test('les années à moins de quatre chiffres sont complétées par des zéros', () => {
    expect(range('0099-03-04T12:00:00Z').after).toBe('0099-03-04');
  });
});
