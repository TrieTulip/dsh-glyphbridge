import type { EngineConfig } from './config.js';
import type { Evidence } from './evidence.js';
/** Bytes plus the media type the endpoint should be told about. */
export interface ImageInput {
    data: Uint8Array;
    mediaType: string;
}
/** One engine attempt failed for a reason worth reporting to the next slot. */
export declare class EngineError extends Error {
    readonly slot: string;
    readonly reason: string;
    constructor(slot: string, reason: string, options?: {
        cause?: unknown;
    });
}
/** A configured slot: both endpoint and model must be present, otherwise it is skipped. */
export declare function isConfigured(engine: EngineConfig): boolean;
/** Human label for the evidence header. */
export declare function engineLabel(slot: string, engine: EngineConfig): string;
/** Resolve one credential name to its value; `undefined` when nothing has configured it. */
export type SecretResolver = (name: string) => Promise<string | undefined>;
/** The process environment as a credential source, trimmed; an empty value counts as absent. */
export declare function envSecret(name: string): string | undefined;
/**
 * Run one engine attempt.
 *
 * @param slot - `primary` or `fallback`; only used for labeling and diagnostics.
 * @param engine - the configured slot.
 * @param image - request-normalized bytes.
 * @param signal - caller cancellation; combined with the slot's own timeout.
 * @param secret - resolves `apiKeyEnv` through the environment and the harness credential store.
 * @returns evidence attributed to this exact engine.
 * @throws {EngineError} on transport, HTTP, or shape failure so the caller can fall through.
 */
export declare function runEngine(slot: string, engine: EngineConfig, image: ImageInput, signal: AbortSignal | undefined, secret?: SecretResolver): Promise<Evidence>;
