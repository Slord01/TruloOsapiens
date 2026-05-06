/**
 * In-memory product cache for Xentral Category 95000 (Tobacco).
 * Fetches product IDs from Xentral API and caches them for fast webhook filtering.
 */

const TOBACCO_CATEGORY_ID = "95000";

export interface CachedProduct {
  id: string;
  number: string;
  name: string;
  ean?: string;
}

interface ProductCacheState {
  products: Map<string, CachedProduct>; // keyed by product ID
  lastRefreshed: Date | null;
  isLoading: boolean;
  error: string | null;
}

const state: ProductCacheState = {
  products: new Map(),
  lastRefreshed: null,
  isLoading: false,
  error: null,
};

/**
 * Fetch all tobacco products from Xentral API (Category 95000).
 * Requires XENTRAL_BASE_URL and XENTRAL_API_KEY env vars.
 */
export async function refreshProductCache(): Promise<{ count: number; error?: string }> {
  const baseUrl = process.env.XENTRAL_BASE_URL;
  const apiKey = process.env.XENTRAL_API_KEY;

  if (!baseUrl || !apiKey) {
    // In demo/dev mode without credentials, seed with empty cache
    state.lastRefreshed = new Date();
    state.error = null;
    return { count: 0 };
  }

  if (state.isLoading) {
    return { count: state.products.size };
  }

  state.isLoading = true;
  state.error = null;

  try {
    const url = new URL(`${baseUrl}/api/v1/products`);
    url.searchParams.set("filter[0][key]", "categoryId");
    url.searchParams.set("filter[0][op]", "equals");
    url.searchParams.set("filter[0][value]", TOBACCO_CATEGORY_ID);
    url.searchParams.set("limit", "500");

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Xentral API returned ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as { data?: unknown[] };
    const items: unknown[] = data?.data ?? [];

    state.products.clear();
    for (const item of items) {
      const p = item as Record<string, unknown>;
      const id = String(p.id ?? "");
      if (!id) continue;
      state.products.set(id, {
        id,
        number: String(p.number ?? ""),
        name: String(p.name ?? ""),
        ean: p.ean ? String(p.ean) : undefined,
      });
    }

    state.lastRefreshed = new Date();
    return { count: state.products.size };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.error = msg;
    return { count: state.products.size, error: msg };
  } finally {
    state.isLoading = false;
  }
}

/** Check whether a product ID belongs to the tobacco category. */
export function isTobaccoProduct(productId: string): boolean {
  return state.products.has(productId);
}

/** Get cached product details by ID. */
export function getCachedProduct(productId: string): CachedProduct | undefined {
  return state.products.get(productId);
}

export function getCacheStats() {
  return {
    count: state.products.size,
    lastRefreshed: state.lastRefreshed,
    isLoading: state.isLoading,
    error: state.error,
  };
}

/** Seed the cache with known product IDs (for testing / demo). */
export function seedCache(products: CachedProduct[]) {
  state.products.clear();
  for (const p of products) {
    state.products.set(p.id, p);
  }
  state.lastRefreshed = new Date();
}
