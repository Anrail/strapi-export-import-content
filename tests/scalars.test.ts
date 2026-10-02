import { describe, expect, it } from 'vitest';

import { normalizeScalar, sameInstant, toIso } from '../server/src/codec/scalars';
import { CellError } from '../server/src/errors';

describe('normalizeScalar', () => {
  it.each([null, undefined, ''])('maps %s to null for every type', (value) => {
    for (const type of ['string', 'integer', 'boolean', 'date', 'datetime']) {
      expect(normalizeScalar(type, value)).toBeNull();
    }
  });

  it('keeps strings and normalizes CRLF', () => {
    expect(normalizeScalar('richtext', '<p>a</p>\r\n<p>b</p>')).toBe('<p>a</p>\n<p>b</p>');
    expect(normalizeScalar('string', ' padded ')).toBe(' padded ');
    expect(normalizeScalar('string', 42)).toBe('42');
  });

  it('parses numbers', () => {
    expect(normalizeScalar('integer', '42')).toBe(42);
    expect(normalizeScalar('integer', 42)).toBe(42);
    expect(normalizeScalar('float', '1.5')).toBe(1.5);
    expect(normalizeScalar('decimal', '10.20')).toBe(10.2);
    expect(normalizeScalar('biginteger', ' 9007199254740993 ')).toBe('9007199254740993');
  });

  it('rejects bad numbers with the value in the message', () => {
    expect(() => normalizeScalar('integer', '1.5')).toThrow(CellError);
    expect(() => normalizeScalar('float', '1,5')).toThrow(/"1,5" is not a number/);
    expect(() => normalizeScalar('biginteger', '12a')).toThrow(CellError);
  });

  it('parses booleans the way Excel writes them', () => {
    for (const yes of [true, 'true', 'TRUE', '1', 1]) expect(normalizeScalar('boolean', yes)).toBe(true);
    for (const no of [false, 'false', 'FALSE', '0', 0]) expect(normalizeScalar('boolean', no)).toBe(false);
    expect(() => normalizeScalar('boolean', 'yes')).toThrow(CellError);
  });

  it('parses dates and explains an Excel-reformatted one', () => {
    expect(normalizeScalar('date', '2026-09-01')).toBe('2026-09-01');
    expect(normalizeScalar('date', '2026-09-01T00:00:00.000Z')).toBe('2026-09-01');
    expect(() => normalizeScalar('date', '01.09.2026')).toThrow(/YYYY-MM-DD.*Excel/);
  });

  it('parses times and datetimes', () => {
    expect(normalizeScalar('time', '10:30')).toBe('10:30:00.000');
    expect(normalizeScalar('time', '10:30:15.5')).toBe('10:30:15.500');
    expect(normalizeScalar('datetime', '2026-09-01T17:36:00.000Z')).toBe('2026-09-01T17:36:00.000Z');
    expect(normalizeScalar('datetime', new Date('2026-09-01T17:36:00.000Z'))).toBe('2026-09-01T17:36:00.000Z');
    expect(() => normalizeScalar('datetime', '01.09.2026 17:36')).toThrow(/ISO.*Excel/);
    expect(() => normalizeScalar('time', '25 o clock')).toThrow(CellError);
  });

  it('rejects a list or an object instead of stringifying it', () => {
    for (const type of ['string', 'integer', 'boolean', 'date']) {
      for (const value of [{ a: 1 }, ['x']]) {
        expect(() => normalizeScalar(type, value)).toThrow(CellError);
        expect(() => normalizeScalar(type, value)).toThrow('expected a plain value, got a list or object');
      }
    }
    expect(normalizeScalar('date', new Date('2026-09-01T00:00:00.000Z'))).toBe('2026-09-01');
  });

  it('rejects an unknown type', () => {
    expect(() => normalizeScalar('hologram', 'x')).toThrow(/unsupported/);
  });
});

describe('toIso / sameInstant', () => {
  it('converts dates and strings, tolerates garbage', () => {
    expect(toIso(new Date('2026-09-01T17:36:00.000Z'))).toBe('2026-09-01T17:36:00.000Z');
    expect(toIso('2026-09-01T17:36:00.000Z')).toBe('2026-09-01T17:36:00.000Z');
    expect(toIso(null)).toBeNull();
    expect(toIso('nonsense')).toBeNull();
  });

  it('compares instants, not text', () => {
    expect(sameInstant('2026-09-01T17:36:00.000Z', new Date('2026-09-01T17:36:00.000Z'))).toBe(true);
    expect(sameInstant('2026-09-01T17:36:00.000Z', '2026-09-01T17:36:00.001Z')).toBe(false);
    expect(sameInstant(null, '2026-09-01T17:36:00.000Z')).toBe(false);
    expect(sameInstant('01.09.2026', '2026-09-01T17:36:00.000Z')).toBe(false);
  });

  it('rejects lenient date parsing: only ISO 8601 with zone', () => {
    expect(toIso('01.09.2026')).toBeNull();
    expect(toIso('2026')).toBeNull();
    expect(toIso('5')).toBeNull();
    expect(toIso('Sep 1 2026')).toBeNull();
    expect(toIso('2026-09-01 17:36')).toBeNull(); // space instead of T
    expect(toIso('2026-09-01T17:36:00')).toBeNull(); // no timezone
  });

  it('accepts ISO 8601 with timezone offset', () => {
    expect(toIso('2026-09-01T19:36:00.000+02:00')).toBe('2026-09-01T17:36:00.000Z');
  });

  it('converts epoch milliseconds to ISO', () => {
    const epochMs = 1788284160000;
    expect(toIso(epochMs)).toBe(new Date(epochMs).toISOString());
  });

  it('guards invalid Date objects', () => {
    expect(() => normalizeScalar('date', new Date('invalid'))).toThrow(CellError);
  });

  it('rejects zoneless datetime strings', () => {
    expect(() => normalizeScalar('datetime', '2026-09-01T17:36:00')).toThrow(CellError);
  });
});

describe('numbers that a double cannot hold', () => {
  it('rejects an already-rounded biginteger and an unsafe integer', () => {
    expect(() => normalizeScalar('biginteger', 9007199254740993)).toThrow(/too large for a number/);
    expect(normalizeScalar('biginteger', 9007199254740991)).toBe('9007199254740991');
    expect(normalizeScalar('biginteger', '9007199254740993')).toBe('9007199254740993');
    expect(() => normalizeScalar('integer', '9007199254740993')).toThrow(CellError);
  });

  it('keeps a decimal with more digits than a double as canonical text', () => {
    expect(normalizeScalar('decimal', '10.50')).toBe(10.5);
    expect(normalizeScalar('decimal', 10.5)).toBe(10.5);
    expect(normalizeScalar('decimal', '1234567890.123456789')).toBe('1234567890.123456789');
    expect(normalizeScalar('decimal', '001234567890.1234567890')).toBe('1234567890.123456789');
    expect(normalizeScalar('decimal', '-0.0')).toBe(0);
    expect(normalizeScalar('decimal', '1e3')).toBe(1000);
  });
});
