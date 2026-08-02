export function matchesToolSearch(query: string, ...values: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return values.some(value => value?.toLocaleLowerCase().includes(needle))
}
