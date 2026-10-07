/**
 * The OpenTelemetry instrumentations compare string URLs for strict equality, which never matches a full
 * request URL. Strings are therefore turned into prefix matchers; RegExps are passed through unchanged.
 */
export function toUrlMatchers(entries: readonly (string | RegExp)[] = []): RegExp[] {
  return entries.map(entry => (typeof entry === 'string' ? new RegExp(`^${escapeRegExp(entry)}`) : entry));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
