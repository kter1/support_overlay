/**
 * @iisl/api — Freshness Service
 * VALIDATION: [STATIC-CONSISTENT] — no external dependencies; pure computation
 *
 * Time-based freshness is ALWAYS computed at read time from timestamps.
 * It is NEVER stored as a flag.
 *
 * is_source_unavailable is a SEPARATE persisted boolean flag set by tombstone
 * logic (source deleted, merged, archived, permanently unreachable).
 * It is NOT a freshness indicator.
 *
 * Spec reference: Section 4.4, Section 1.5 staleness semantics
 */

export interface FreshnessInput {
  fetchedAt: Date | null;
  freshnessWindowSeconds: number;
  isSourceUnavailable: boolean;
}

export interface FreshnessResult {
  isFresh: boolean;
  ageSeconds: number;
  freshnessWindowSeconds: number;
  /** True if age < 3x freshness window — evidence is usable with soft warning */
  isUsableDespiteStale: boolean;
  /**
   * Persisted source-unavailability flag. Set by tombstone/archival logic.
   * NOT time-based. A source can be recent but unavailable (e.g., just deleted).
   * A source can be stale but still available.
   */
  isSourceUnavailable: boolean;
}

export function computeFreshness(input: FreshnessInput): FreshnessResult {
  const now = Date.now();

  if (!input.fetchedAt) {
    // Evidence has never been fetched
    return {
      isFresh: false,
      ageSeconds: Infinity,
      freshnessWindowSeconds: input.freshnessWindowSeconds,
      isUsableDespiteStale: false,
      isSourceUnavailable: input.isSourceUnavailable,
    };
  }

  const ageSeconds = Math.floor((now - input.fetchedAt.getTime()) / 1000);
  const isFresh = ageSeconds <= input.freshnessWindowSeconds;
  // Usable if age is within 3x the freshness window (soft warning range)
  const isUsableDespiteStale =
    !isFresh && ageSeconds <= input.freshnessWindowSeconds * 3;

  return {
    isFresh,
    ageSeconds,
    freshnessWindowSeconds: input.freshnessWindowSeconds,
    isUsableDespiteStale,
    isSourceUnavailable: input.isSourceUnavailable,
  };
}

/**
 * Derive the UI-visible evidence freshness label.
 * No accusation language. Source-unavailability shown as neutral system state.
 */
export function freshnessLabel(result: FreshnessResult): string {
  if (result.isSourceUnavailable) {
    return "Unable to verify — source unavailable";
  }
  if (result.isFresh) {
    return "Verified";
  }
  if (result.isUsableDespiteStale) {
    return "Verified (evidence aging — refresh recommended)";
  }
  return "Evidence outdated — refresh required before action";
}
