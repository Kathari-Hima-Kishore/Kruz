import type { Observation, ObservationCacheKey } from "../types/observation.js";

function cacheKeyToString(key: ObservationCacheKey): string {
  return `${key.page_id}:${key.url}:${key.revision}:${key.scope}:${key.detail}`;
}

/**
 * LRU observation cache. Stores observations keyed by page, URL, revision, scope, and detail level.
 */
export class ObservationCache {
  private cache: Map<string, Observation> = new Map();
  private maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  get(key: ObservationCacheKey): Observation | null {
    const strKey = cacheKeyToString(key);
    const obs = this.cache.get(strKey);
    if (obs) {
      // Move to end (most recently used)
      this.cache.delete(strKey);
      this.cache.set(strKey, obs);
      return obs;
    }
    return null;
  }

  set(key: ObservationCacheKey, observation: Observation): void {
    const strKey = cacheKeyToString(key);

    // If already exists, update it
    if (this.cache.has(strKey)) {
      this.cache.delete(strKey);
      this.cache.set(strKey, observation);
      return;
    }

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(strKey, observation);
  }

  /**
   * Invalidate all observations for a given page (e.g. after navigation).
   */
  invalidatePage(pageId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${pageId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Invalidate all observations for a given URL.
   */
  invalidateUrl(url: string): void {
    for (const [key] of this.cache) {
      if (key.includes(`:${url}:`)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
