export function nullableString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
