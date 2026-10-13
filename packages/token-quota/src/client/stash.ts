/**
 * Per-session stash of snippets ("临存"): text the user picked out of the
 * conversation and wants to keep at hand until it is dropped into the composer.
 *
 * This handle is registered ONLY on the session-scoped composer entry, so the
 * renderer builds one instance per session and the engine suffixes the persist
 * key with that session's id (`defineStore` does this in `create(scopeKey)`).
 * Two consequences fall out for free, which is exactly what was asked for:
 *
 * - snippets follow their own session and can never leak into another one;
 * - they survive a page reload, because localStorage holds them per session.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** One stashed snippet. */
export interface TokenQuotaStashItem {
  /** Stable id: the React key and the removal handle. */
  id: string
  /** The captured text, inserted verbatim into the composer. */
  text: string
}

/** Stash state for one session. */
export interface TokenQuotaStashState {
  items: TokenQuotaStashItem[]
}

/** Declared write surface. */
export type TokenQuotaStashActions = {
  add: (d: TokenQuotaStashState, text: string) => void
  remove: (d: TokenQuotaStashState, id: string) => void
}

/** Most snippets held per session; single-digit badges stay tidy. */
export const TOKEN_QUOTA_STASH_MAX = 9

/** Base persist key; the engine appends `.<sessionId>` for scoped instances. */
const STASH_PERSIST_KEY = 'dsh-token-quota:stash'

let sequence = 0

/**
 * Declares the per-session stash state and write surface.
 * @returns the store handle, to be registered on a session-scoped slot entry.
 */
export function createTokenQuotaStashStore(): EngineStoreHandle<TokenQuotaStashState, TokenQuotaStashActions> {
  return defineStore({
    init: (): TokenQuotaStashState => ({ items: [] }),
    persist: STASH_PERSIST_KEY,
    actions: {
      add: (d, text) => {
        const trimmed = text.trim()
        if (trimmed === '') return
        // Re-stashing the same snippet is a no-op rather than a duplicate.
        if (d.items.some(item => item.text === trimmed)) return
        sequence += 1
        const id = `${Date.now().toString(36)}-${sequence.toString(36)}`
        const next = [...d.items, { id, text: trimmed }]
        // Oldest out once the cap is reached.
        d.items = next.length > TOKEN_QUOTA_STASH_MAX
          ? next.slice(next.length - TOKEN_QUOTA_STASH_MAX)
          : next
      },
      remove: (d, id) => { d.items = d.items.filter(item => item.id !== id) },
    },
  })
}
