/**
 * Polyfills for @colyseus/sdk in Decentraland SDK7's sandboxed Unity JS runtime.
 *
 * DCL SDK7 uses lib:["ES2020"] — no DOM types at all. The Unity-embedded JS
 * runtime also does not expose standard Web APIs globally.
 *
 * MUST be the very first import in index.ts — before ANY @colyseus/sdk import.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any

// ── 1. Node.js globals ───────────────────────────────────────────────────────

if (typeof g.global === 'undefined') g.global = globalThis
if (typeof g.window === 'undefined') g.window = globalThis
if (typeof g.process === 'undefined') {
  g.process = { env: {}, browser: true, versions: {}, version: '' }
}

// ── 2. URLSearchParams ───────────────────────────────────────────────────────

if (typeof g.URLSearchParams === 'undefined') {
  g.URLSearchParams = class URLSearchParams {
    private _p: [string, string][] = []

    constructor(init?: string | Record<string, string>) {
      if (!init) return
      if (typeof init === 'object') {
        for (const k of Object.keys(init)) this._p.push([k, (init as Record<string, string>)[k]])
        return
      }
      const qs = (init as string).replace(/^\?/, '')
      for (const part of qs.split('&')) {
        if (!part) continue
        const eq = part.indexOf('=')
        this._p.push([
          decodeURIComponent(eq < 0 ? part : part.slice(0, eq)),
          eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1))
        ])
      }
    }

    append(key: string, value: string) { this._p.push([key, value]) }
    get(key: string): string | null { return this._p.find(([k]) => k === key)?.[1] ?? null }
    getAll(key: string): string[] { return this._p.filter(([k]) => k === key).map(([, v]) => v) }
    has(key: string): boolean { return this._p.some(([k]) => k === key) }
    delete(key: string) { this._p = this._p.filter(([k]) => k !== key) }
    set(key: string, value: string) {
      const i = this._p.findIndex(([k]) => k === key)
      this._p = this._p.filter(([k]) => k !== key)
      this._p.splice(i < 0 ? this._p.length : i, 0, [key, value])
    }
    toString(): string {
      return this._p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    }
    forEach(cb: (v: string, k: string) => void) { this._p.forEach(([k, v]) => cb(v, k)) }
    *entries(): IterableIterator<[string, string]> { yield* this._p }
    *keys(): IterableIterator<string> { for (const [k] of this._p) yield k }
    *values(): IterableIterator<string> { for (const [, v] of this._p) yield v }
    [Symbol.iterator](): IterableIterator<[string, string]> { return this.entries() }
  }
}

// ── 3. URL ───────────────────────────────────────────────────────────────────

if (typeof g.URL === 'undefined') {
  const RE = /^([a-z][a-z0-9+\-.]*:)\/\/(?:[^@/?#]*@)?([^/:?#]+)(?::(\d+))?(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i

  g.URL = class URL {
    protocol = ''; hostname = ''; port = ''; pathname = '/'
    search = ''; hash = ''; host = ''; origin = ''; href = ''
    username = ''; password = ''
    searchParams: any

    constructor(url: string, base?: string) {
      let full = url
      if (base && !/^[a-z][a-z0-9+\-.]*:/i.test(url)) {
        const b = new g.URL(base)
        full = url.startsWith('//')
          ? `${b.protocol}${url}`
          : url.startsWith('/')
            ? `${b.protocol}//${b.host}${url}`
            : `${b.protocol}//${b.host}${b.pathname.replace(/[^/]*$/, '')}${url}`
      }
      const m = full.match(RE)
      if (!m) throw new TypeError(`Invalid URL: "${url}"`)
      this.protocol = m[1].toLowerCase()
      this.hostname = m[2].toLowerCase()
      this.port = m[3] ?? ''
      this.pathname = m[4] ?? '/'
      this.search = m[5] ?? ''
      this.hash = m[6] ?? ''
      this.host = this.port ? `${this.hostname}:${this.port}` : this.hostname
      this.origin = `${this.protocol}//${this.host}`
      this.href = full
      this.searchParams = new g.URLSearchParams(this.search)
    }

    toString() { return this.href }
    toJSON() { return this.href }
  }
}

// ── 4. Headers ───────────────────────────────────────────────────────────────
// HTTP.cjs line 141: `new Headers(this.options.headers)` on every matchmaking call.

if (typeof g.Headers === 'undefined') {
  g.Headers = class Headers {
    private _m: Map<string, string> = new Map()

    constructor(init?: any) {
      if (!init) return
      if (init && typeof init.forEach === 'function') {
        init.forEach((v: string, k: string) => this.set(k, v))
      } else if (Array.isArray(init)) {
        for (const [k, v] of init) this.set(k, v)
      } else if (typeof init === 'object') {
        for (const k of Object.keys(init)) this.set(k, init[k])
      }
    }

    private _k(k: string) { return k.toLowerCase() }
    get(key: string): string | null { return this._m.get(this._k(key)) ?? null }
    has(key: string): boolean { return this._m.has(this._k(key)) }
    set(key: string, value: string) { this._m.set(this._k(key), String(value)) }
    delete(key: string) { this._m.delete(this._k(key)) }
    append(key: string, value: string) {
      const k = this._k(key)
      const prev = this._m.get(k)
      this._m.set(k, prev !== undefined ? `${prev}, ${value}` : String(value))
    }
    forEach(cb: (v: string, k: string, parent: any) => void) {
      this._m.forEach((v, k) => cb(v, k, this))
    }
    *entries(): IterableIterator<[string, string]> { yield* this._m.entries() }
    *keys(): IterableIterator<string> { yield* this._m.keys() }
    *values(): IterableIterator<string> { yield* this._m.values() }
    [Symbol.iterator](): IterableIterator<[string, string]> { return this.entries() }
  }
}

// ── 5. Blob ──────────────────────────────────────────────────────────────────
// fetchXHR.cjs (XHR fallback) response .blob() method.

if (typeof g.Blob === 'undefined') {
  const enc = (): { encode(s: string): Uint8Array } => new (g.TextEncoder ?? class { encode(s: string) { return new Uint8Array(Array.from(s).map(c => c.charCodeAt(0))) } })()
  const dec = (): { decode(b: ArrayBuffer): string } => new (g.TextDecoder ?? class { decode(b: ArrayBuffer) { return String.fromCharCode(...new Uint8Array(b)) } })()

  g.Blob = class Blob {
    private _parts: (string | ArrayBuffer | ArrayBufferView)[]
    readonly type: string
    readonly size: number

    constructor(parts: (string | ArrayBuffer | ArrayBufferView)[] = [], opts: { type?: string } = {}) {
      this._parts = parts
      this.type = opts.type ?? ''
      this.size = parts.reduce((n: number, p: any) => {
        if (typeof p === 'string') return n + enc().encode(p).byteLength
        return n + (p.byteLength ?? 0)
      }, 0)
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
      const chunks: Uint8Array[] = []
      for (const p of this._parts) {
        if (typeof p === 'string') chunks.push(enc().encode(p))
        else if (p instanceof ArrayBuffer) chunks.push(new Uint8Array(p))
        else chunks.push(new Uint8Array((p as any).buffer, (p as any).byteOffset, (p as any).byteLength))
      }
      const total = chunks.reduce((n, c) => n + c.byteLength, 0)
      const out = new Uint8Array(total)
      let off = 0; for (const c of chunks) { out.set(c, off); off += c.byteLength }
      return out.buffer
    }

    async text(): Promise<string> { return dec().decode(await this.arrayBuffer()) }
  }
}

// ── 6. WebSocket fix for DCL Creator Hub / mobile ────────────────────────────
// The embedded WebSocket exposes non-W3C readyState constants (OPEN === 4,
// and instance readyState defaults to 3) and the static constants are frozen.
// Colyseus's `ws.readyState === WebSocket.OPEN` check therefore never matches,
// every outbound message is dropped into an unflushed enqueue buffer, and the
// connection looks alive but is broken client → server.
//
// Fix: wrap the constructor so we own a fresh class on globalThis whose
// constants we can rewrite, and lie about each instance's readyState until a
// real close event fires. send() also copies any TypedArray view to a
// standalone ArrayBuffer in case the runtime mis-handles shared-buffer views.
// All a no-op on standards-compliant runtimes.

function _toStandaloneAb(data: any): any {
  if (data && typeof data === 'object' && data.buffer instanceof ArrayBuffer && typeof data.byteLength === 'number') {
    const out = new ArrayBuffer(data.byteLength)
    new Uint8Array(out).set(new Uint8Array(data.buffer, data.byteOffset ?? 0, data.byteLength))
    return out
  }
  return data
}

if (typeof g.WebSocket !== 'undefined' && !g.__wsSendPatched) {
  const OrigWS: any = g.WebSocket
  let prototypePatched = false
  try {
    if (OrigWS.prototype && typeof OrigWS.prototype.send === 'function') {
      const origSend = OrigWS.prototype.send
      OrigWS.prototype.send = function (data: any) {
        return origSend.call(this, _toStandaloneAb(data))
      }
      prototypePatched = true
    }
  } catch (e) {
    console.log('[polyfills] WebSocket.prototype.send patch failed:', e)
  }

  g.WebSocket = function PatchedWebSocket(...args: any[]) {
    const ws: any = new OrigWS(...args)
    let closedSeen = false
    try {
      Object.defineProperty(ws, 'readyState', {
        configurable: true,
        get() { return closedSeen ? 3 : 1 }
      })
    } catch (_) { /* sealed readyState — leave as-is */ }
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('close', () => { closedSeen = true })
    }
    if (!prototypePatched) {
      const origSend = ws.send.bind(ws)
      ws.send = (data: any) => origSend(_toStandaloneAb(data))
    }
    return ws
  } as any
  for (const k of Object.keys(OrigWS)) g.WebSocket[k] = OrigWS[k]
  g.WebSocket.CONNECTING = 0
  g.WebSocket.OPEN       = 1
  g.WebSocket.CLOSING    = 2
  g.WebSocket.CLOSED     = 3
  g.WebSocket.prototype  = OrigWS.prototype

  g.__wsSendPatched = true
}
