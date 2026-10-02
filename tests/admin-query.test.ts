import { describe, expect, it } from 'vitest';

import { stringifyQuery } from '../admin/src/utils/query';

const parse = (query: string) => Object.fromEntries(new URLSearchParams(query).entries());

describe('stringifyQuery', () => {
  it('serialises flat params', () => {
    expect(parse(stringifyQuery({ page: 1, pageSize: 100, sort: 'title:ASC', flag: true }))).toEqual({
      page: '1',
      pageSize: '100',
      sort: 'title:ASC',
      flag: 'true',
    });
  });

  it('keeps awkward characters in nested filters intact', () => {
    const result = stringifyQuery({
      filters: { $and: [{ title: { $contains: 'R&D #1 +50%=x' } }] },
      _q: 'a&b#c',
      sort: 'title:ASC',
      locale: 'en',
      page: 2,
    });
    expect(result.startsWith('?')).toBe(false);
    expect(parse(result)).toEqual({
      'filters[$and][0][title][$contains]': 'R&D #1 +50%=x',
      _q: 'a&b#c',
      sort: 'title:ASC',
      locale: 'en',
      page: '2',
    });
  });

  it('skips undefined and renders null as an empty value', () => {
    expect(parse(stringifyQuery({ a: undefined, b: null, c: 'x' }))).toEqual({ b: '', c: 'x' });
  });

  it('round-trips Cyrillic values', () => {
    expect(parse(stringifyQuery({ _q: 'Привіт & світ' }))).toEqual({ _q: 'Привіт & світ' });
  });
});
