/**
 * Runtime guards for the token-quota plugin's public boundary.
 *
 * A separate companion module keeps these reachable from both the Host and
 * Client build faces without dragging the service implementation into a
 * browser bundle.
 *
 * @module @jxgame2020/dsh-token-quota/invariant
 */

/** Accept one per-model daily limit: `0` (unlimited) or a positive integer. */
export function assertTokenQuotaLimit(value: unknown, key: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`token-quota: limit for "${key}" must be a non-negative integer, received ${String(value)}`)
  }
}

/** Resolve a model key of the form `provider/model` into its two parts. */
export function splitTokenQuotaKey(key: string): { provider: string; model: string } {
  const slash = key.indexOf('/')
  if (slash <= 0 || slash === key.length - 1) {
    throw new TypeError(`token-quota: invalid model key "${key}" — expected "provider/model"`)
  }
  return { provider: key.slice(0, slash), model: key.slice(slash + 1) }
}
