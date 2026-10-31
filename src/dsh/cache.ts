import type { Evidence } from './evidence.js'

/** Observable counters for one cache instance, used by diagnostics only. */
export interface CacheStats {
  /** Settled evidence records currently retained. */
  size: number
  /** Lookups answered from a settled record or an in-flight production. */
  hits: number
  /** Lookups that had to run an engine chain. */
  misses: number
  /** Engine chains currently running, keyed but not yet settled. */
  inflight: number
}

/**
 * Whether a record is worth remembering.
 *
 * A degraded record is a statement about *this attempt* ("no engine answered"),
 * not about the image, so remembering it would freeze a transient outage into
 * every later turn. Only records an engine actually produced are retained.
 */
function isCacheable(evidence: Evidence): boolean {
  return evidence.ocr.trim().length > 0 || evidence.regions.length > 0 || evidence.tables.length > 0
}

/**
 * Bounded LRU memo of evidence records.
 *
 * A companion route sees the *whole* conversation on every turn, so without a
 * memo the same screenshot is sent to the vision engine again and again — once
 * per turn, for as long as the conversation lives. The memo keys a record by the
 * identity of the image plus the identity of the engine chain that produced it,
 * so a settings change produces different keys instead of stale text, and it
 * coalesces concurrent productions of one key (a request may carry the same
 * image twice) into a single engine call.
 *
 * Recency is insertion order: a hit re-inserts its key, so eviction always
 * removes the least recently used record.
 */
export class EvidenceCache {
  private readonly settled = new Map<string, Evidence>()
  private readonly inflight = new Map<string, Promise<Evidence>>()
  private hits = 0
  private misses = 0

  /**
   * @param enabled - whether lookups may answer from the memo at all.
   * @param maxEntries - hard ceiling on retained records; `0` disables retention.
   */
  constructor(
    private readonly enabled: boolean,
    private readonly maxEntries: number,
  ) {}

  /** Whether this instance retains anything. */
  private get active(): boolean {
    return this.enabled && this.maxEntries > 0
  }

  /** Current counters, detached. */
  get stats(): CacheStats {
    return { size: this.settled.size, hits: this.hits, misses: this.misses, inflight: this.inflight.size }
  }

  /** Remember one record, evicting the least recently used key when full. */
  private store(key: string, evidence: Evidence): void {
    if (this.settled.size >= this.maxEntries) {
      const oldest = this.settled.keys().next()
      if (oldest.done !== true) this.settled.delete(oldest.value)
    }
    this.settled.set(key, evidence)
  }

  /** Mark one key as most recently used. */
  private touch(key: string, evidence: Evidence): void {
    this.settled.delete(key)
    this.settled.set(key, evidence)
  }

  /**
   * Answer one lookup, producing the record at most once per key.
   *
   * @param key - image identity combined with engine-chain identity.
   * @param produce - runs the engine chain; called only on a miss.
   * @returns the record plus whether it was answered from the memo.
   */
  async remember(key: string, produce: () => Promise<Evidence>): Promise<{ evidence: Evidence; cached: boolean }> {
    if (!this.active) return { evidence: await produce(), cached: false }

    const settled = this.settled.get(key)
    if (settled !== undefined) {
      this.hits += 1
      this.touch(key, settled)
      return { evidence: settled, cached: true }
    }

    const running = this.inflight.get(key)
    if (running !== undefined) {
      this.hits += 1
      return { evidence: await running, cached: true }
    }

    this.misses += 1
    const pending = produce()
    this.inflight.set(key, pending)
    try {
      const evidence = await pending
      if (isCacheable(evidence)) this.store(key, evidence)
      return { evidence, cached: false }
    } finally {
      this.inflight.delete(key)
    }
  }

  /** Drop every retained record; counters are kept for the session's diagnostics. */
  clear(): void {
    this.settled.clear()
  }
}
