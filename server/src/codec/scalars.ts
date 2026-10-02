import { CellError } from '../errors';

const STRING_TYPES = new Set(['string', 'text', 'richtext', 'email', 'uid', 'enumeration']);
const EXCEL_HINT = 'Excel may have reformatted it - keep the column as text';

export const isEmpty = (value: unknown): boolean => value === null || value === undefined || value === '';

const toNumber = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || (typeof value === 'string' && value.trim() === '')) {
    throw new CellError(`"${String(value)}" is not a number`);
  }
  return n === 0 ? 0 : n; // never -0: it is not deep-equal to 0
};

/** "0012.500" -> "12.5", "-0.0" -> "0"; null when the text is not plain decimal notation. */
const canonicalDecimal = (value: string): string | null => {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match || (!match[2] && !match[3])) return null;
  const whole = match[2].replace(/^0+(?=\d)/, '') || '0';
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  const digits = fraction ? `${whole}.${fraction}` : whole;
  return match[1] === '-' && /[1-9]/.test(digits) ? `-${digits}` : digits;
};

/** ISO 8601 with milliseconds, or null when the value is empty or not a date. */
export const toIso = (value: unknown): string | null => {
  if (isEmpty(value)) return null;

  // Date instance
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }

  // Epoch milliseconds (finite number)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return new Date(value).toISOString();
  }

  // String: only accept ISO 8601 format with timezone
  if (typeof value === 'string') {
    const text = value.trim();
    const isoWithZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(text);
    if (!isoWithZone) return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  return null;
};

export const sameInstant = (a: unknown, b: unknown): boolean => {
  const left = toIso(a);
  return left !== null && left === toIso(b);
};

/** Converts a cell or a stored value to the canonical native form of a scalar attribute. */
export function normalizeScalar(type: string, value: unknown): string | number | boolean | null {
  if (isEmpty(value)) return null;
  if (typeof value === 'object' && !(value instanceof Date)) {
    throw new CellError('expected a plain value, got a list or object');
  }

  if (STRING_TYPES.has(type)) return String(value).replace(/\r\n/g, '\n');

  switch (type) {
    case 'biginteger': {
      // A JS number beyond 2^53 was already rounded by whoever parsed it (JSON.parse, a spreadsheet).
      if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        throw new CellError(`${value} is too large for a number - write it as text ("123…")`);
      }
      const text = String(value).trim();
      if (!/^-?\d+$/.test(text)) throw new CellError(`"${text}" is not an integer`);
      return text;
    }
    case 'integer': {
      const n = toNumber(value);
      if (!Number.isSafeInteger(n)) throw new CellError(`"${String(value)}" is not an integer`);
      return n;
    }
    case 'float':
      return toNumber(value);
    case 'decimal': {
      const n = toNumber(value);
      if (typeof value !== 'string') return n;
      // A decimal with more digits than a double holds stays text, so nothing is rounded on the way.
      const exact = canonicalDecimal(value);
      return exact !== null && exact !== canonicalDecimal(String(n)) ? exact : n;
    }
    case 'boolean': {
      const text = String(value).trim().toLowerCase();
      if (text === 'true' || text === '1') return true;
      if (text === 'false' || text === '0') return false;
      throw new CellError(`"${String(value)}" is not true or false`);
    }
    case 'date': {
      let text: string;
      if (value instanceof Date) {
        const ms = value.getTime();
        if (Number.isNaN(ms)) throw new CellError(`invalid date`);
        text = new Date(ms).toISOString();
      } else {
        text = String(value).trim();
      }
      const match = /^(\d{4}-\d{2}-\d{2})(T.*)?$/.exec(text);
      if (!match) throw new CellError(`"${text}" is not a date in YYYY-MM-DD form (${EXCEL_HINT})`);
      return match[1];
    }
    case 'time': {
      const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(String(value).trim());
      if (!match) throw new CellError(`"${String(value)}" is not a time in HH:mm:ss form`);
      return `${match[1]}:${match[2]}:${match[3] ?? '00'}.${(match[4] ?? '').padEnd(3, '0')}`;
    }
    case 'datetime':
    case 'timestamp': {
      const iso = toIso(value);
      if (!iso) throw new CellError(`"${String(value)}" is not an ISO 8601 date-time (${EXCEL_HINT})`);
      return iso;
    }
    default:
      throw new CellError(`unsupported attribute type "${type}"`);
  }
}
