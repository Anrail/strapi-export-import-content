const collect = (path: string[], value: unknown, pairs: string[]): void => {
  if (value === undefined) return;
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) collect([...path, key], child, pairs);
    return;
  }
  const [head, ...rest] = path.map(encodeURIComponent);
  const key = head + rest.map((segment) => `[${segment}]`).join('');
  pairs.push(`${key}=${value === null ? '' : encodeURIComponent(String(value))}`);
};

/** qs-style bracket serialisation with every key and value percent-encoded. */
export function stringifyQuery(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) collect([key], value, pairs);
  return pairs.join('&');
}
