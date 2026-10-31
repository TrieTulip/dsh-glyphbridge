import type { Evidence } from './evidence.js';
/** Observable counters for one cache instance, used by diagnostics only. */
export interface CacheStats {
    /** Settled evidence records currently retained. */
    size: number;
    /** Lookups answered from a settled record or an in-flight production. */
    hits: number;
    /** Lookups that had to run an engine chain. */
    misses: number;
    /** Engine chains currently running, keyed but not yet settled. */
    inflight: number;
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
export declare class EvidenceCache {
    private readonly enabled;
    private readonly maxEntries;
    private readonly settled;
    private readonly inflight;
    private hits;
    private misses;
    /**
     * @param enabled - whether lookups may answer from the memo at all.
     * @param maxEntries - hard ceiling on retained records; `0` disables retention.
     */
    constructor(enabled: boolean, maxEntries: number);
    /** Whether this instance retains anything. */
    private get active();
    /** Current counters, detached. */
    get stats(): CacheStats;
    /** Remember one record, evicting the least recently used key when full. */
    private store;
    /** Mark one key as most recently used. */
    private touch;
    /**
     * Answer one lookup, producing the record at most once per key.
     *
     * @param key - image identity combined with engine-chain identity.
     * @param produce - runs the engine chain; called only on a miss.
     * @returns the record plus whether it was answered from the memo.
     */
    remember(key: string, produce: () => Promise<Evidence>): Promise<{
        evidence: Evidence;
        cached: boolean;
    }>;
    /** Drop every retained record; counters are kept for the session's diagnostics. */
    clear(): void;
}
