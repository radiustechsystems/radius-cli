/** Stringify with bigints as decimal strings — viem returns lots of bigints. */
export function jsonStringify(value: unknown, indent = 2): string {
  return JSON.stringify(
    value,
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    indent,
  );
}

export function printResult(value: unknown, json: boolean): void {
  if (json) {
    console.log(jsonStringify(value));
    return;
  }
  if (value === undefined || value === null) {
    console.log('');
    return;
  }
  if (typeof value === 'bigint') {
    console.log(value.toString());
    return;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    console.log(String(value));
    return;
  }
  console.log(jsonStringify(value));
}
