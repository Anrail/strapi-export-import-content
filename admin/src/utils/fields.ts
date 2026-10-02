const MAX_NAMES = 12;

/** "sku (500), title (3)": how many error-free rows change each field, most changed first. */
export function changedFields(rows: Array<{ fields: string[]; errors: string[] }>): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.errors.length) continue;
    for (const field of row.fields) counts.set(field, (counts.get(field) ?? 0) + 1);
  }
  if (!counts.size) return null;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const names = sorted.slice(0, MAX_NAMES).map(([field, count]) => `${field} (${count})`);
  return sorted.length > MAX_NAMES ? `${names.join(', ')}, …` : names.join(', ');
}
