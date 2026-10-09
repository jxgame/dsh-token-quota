/**
 * Client-half load smoke test.
 *
 * Loads the built `lib/client.js` bundle in Node with framework-shaped stubs
 * (module loader, Cordis ctx, slot registry) and runs `apply()`. This catches
 * load-time failures that `tsc` cannot see — temporal dead zones, bad slot
 * registration, missing options — which is exactly the class of bug that
 * shipped in 0.1.42 / 0.1.43.
 *
 * Usage: node tools/smoke-client.mjs [path/to/client.js]
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = resolve(here, '..', process.argv[2] ?? 'lib/client.js')

// ---------------------------------------------------------------- browser stubs
const listeners = new Map()
globalThis.window = {
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(fn)
  },
  removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn) },
  location: { href: 'http://127.0.0.1:3080/' },
}
globalThis.EventSource = class {
  addEventListener() {}
  close() {}
}
// Never-resolving fetch: apply() kicks a poll whose promise must not reject.
globalThis.fetch = () => new Promise(() => {})
// No document: the CSS-module injector guards on `typeof document !== 'undefined'`.

// ------------------------------------------------------------- module loader
let factory
globalThis.window.__ModuleLoader__ = {
  load: ({ id, factory: f }) => { factory = { id, f } },
}

const code = readFileSync(bundlePath, 'utf8')
// The bundle is a CJS closure-factory artifact; run it with a module shim.
const moduleObj = { exports: {} }
// eslint-disable-next-line no-new-func
new Function('module', 'exports', 'window', code)(moduleObj, moduleObj.exports, globalThis.window)

if (factory === undefined) {
  console.error('FAIL: the bundle never called window.__ModuleLoader__.load')
  process.exit(1)
}

// ------------------------------------------------------------- external stubs
/** A callable proxy: every property is itself a callable proxy. */
function anyProxy(name) {
  const fn = function () { return anyProxy(name) }
  return new Proxy(fn, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => name
      if (prop === 'then') return undefined
      return anyProxy(`${name}.${String(prop)}`)
    },
    apply: () => anyProxy(name),
  })
}

const requireStub = (id) => anyProxy(id)

// --------------------------------------------------------------- fake slot core
/** Slot scopes as declared by ui-layout / ui-conversation. */
const DECLARED = new Map([
  ['shell.overlay', { kind: 'list', scope: 'root' }],
  ['conversation.input.overlay', { kind: 'list', scope: 'session' }],
])
const handleScopes = new Map()
const registrations = []
const pinnedScopes = new Map()

function register(options, component) {
  const spec = DECLARED.get(options.name)
  if (spec === undefined) {
    throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
  }
  const priority = options.priority ?? 0
  if (spec.kind === 'list' && options.id === undefined) {
    throw new Error(`list slot "${options.name}" requires options.id`)
  }
  if (spec.kind === 'single') {
    const occupant = registrations.find(r => r.options.name === options.name && (r.options.priority ?? 0) === priority)
    if (occupant) throw new Error(`single slot "${options.name}" already has a registration`)
  }
  if (options.store !== undefined && typeof options.store !== 'function') {
    const pinned = handleScopes.get(options.store)
    if (pinned && pinned.scope !== spec.scope) {
      throw new Error(
        `store handle mounted under "${options.name}" (scope "${spec.scope}") is already mounted under scope "${pinned.scope}" — one handle, one scope`,
      )
    }
    if (pinned) pinned.count += 1
    else handleScopes.set(options.store, { scope: spec.scope, count: 1 })
  }
  registrations.push({ options, component, scope: spec.scope })
  pinnedScopes.set(options.id ?? options.key ?? options.name, spec.scope)
}

function inject(key, callback) {
  const spec = DECLARED.get(key)
  if (spec === undefined) {
    // Real registry defers until declaration; nothing to do in this test.
    return () => {}
  }
  // The real `reconcile()` runs the callback synchronously when the slot is
  // already declared, and propagates any throw to the caller.
  const dispose = callback()
  return typeof dispose === 'function' ? dispose : () => {}
}

// ------------------------------------------------------------------- fake ctx
const emitted = []
const SETTINGS_DOC = {
  limits: {},
  monitored: [],
  onFull: 'stop',
  checkUpdates: true,
  dimWhenIdle: false,
  order: [],
  notes: [],
  reset: undefined,
  balance: { enabled: true, pollMinutes: 5 },
  music: { enabled: false, volume: 0.5, style: 'pentatonic', onlyCurrentSession: true },
  transcribe: {
    enabled: true,
    baseURL: 'https://api.siliconflow.cn/v1',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    model: 'XingChenAGI/XingChenASR-V3.2-Ultra',
  },
}

const effects = []
const ctx = {
  effect: (fn, label) => {
    // Cordis runs an effect body immediately on registration.
    const dispose = fn()
    effects.push({ label, dispose })
    return () => { if (typeof dispose === 'function') dispose() }
  },
  on: () => () => {},
  get: (name) => {
    switch (name) {
      case 'sessions': return { binding: () => undefined }
      case 'credentials': return { resolve: async () => undefined }
      case 'settings': return { get: () => undefined }
      default: return undefined
    }
  },
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
  },
  settingsScope: {
    bind: () => ({
      getSnapshot: () => ({ value: SETTINGS_DOC }),
      set: async (key, value) => { emitted.push({ key, value }) },
    }),
  },
  remote: {
    session: {
      selectModel: async () => ({ ok: false, error: { code: 'x', message: 'stub' } }),
      modelCatalog: async () => ({ ok: true, value: { groups: [] } }),
    },
  },
  slots: { inject, register },
}

// ------------------------------------------------------------------- run apply
const mod = factory.f(requireStub)
if (typeof mod.apply !== 'function') {
  console.error('FAIL: client module exports no apply()')
  process.exit(1)
}

try {
  mod.apply(ctx)
} catch (error) {
  console.error('FAIL: apply() threw —', error instanceof Error ? error.message : error)
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(1, 6).join('\n'))
  process.exit(1)
}

// ------------------------------------------------------------------- assertions
const byId = new Map(registrations.map(r => [r.options.id, r]))
const problems = []
if (!byId.has('token-quota')) problems.push('panel entry "token-quota" was not registered into shell.overlay')
if (!byId.has('token-quota-mic')) problems.push('mic entry "token-quota-mic" was not registered into conversation.input.overlay')

const panel = byId.get('token-quota')
if (panel !== undefined) {
  if (panel.options.locale === undefined) problems.push('panel entry declares no locale')
  if (panel.options.store === undefined) problems.push('panel entry declares no store')
  if (typeof panel.options.inject !== 'function') problems.push('panel entry declares no inject')
  else {
    const props = panel.options.inject(anyProxy('store'))
    for (const key of ['load', 'setLimit', 'setBalanceSettings', 'refreshBalance', 'setTranscribeSettings', 'checkTranscribeKey', 'saveTranscribeKey']) {
      if (typeof props[key] !== 'function') problems.push(`panel inject is missing "${key}"`)
    }
  }
}

const mic = byId.get('token-quota-mic')
if (mic !== undefined) {
  if (mic.scope !== 'session') problems.push(`mic entry resolved to scope "${mic.scope}", expected "session"`)
  if (mic.options.store !== undefined) problems.push('mic entry must not share the root-scoped panel store')
  if (typeof mic.options.inject !== 'function') problems.push('mic entry declares no inject')
  else {
    const props = mic.options.inject({}, anyProxy('actions'))
    for (const key of ['transcribe', 'setTranscribeSettings', 'subscribeTranscribe', 'getTranscribe', 't']) {
      if (typeof props[key] !== 'function') problems.push(`mic inject is missing "${key}"`)
    }
    if (typeof props.getTranscribe === 'function' && props.getTranscribe().enabled !== true) {
      problems.push('mic observable did not pick up transcribe.enabled=true from the settings document')
    }
  }
}

if (problems.length > 0) {
  console.error('FAIL:')
  for (const p of problems) console.error('  -', p)
  process.exit(1)
}

console.log(`PASS: ${factory.id}`)
console.log(`  entries: ${registrations.map(r => `${r.options.id}@${r.scope}`).join(', ')}`)
console.log(`  effects installed: ${effects.length}`)
// The plugin installs a poll interval, so the event loop never drains on its own.
process.exit(0)
