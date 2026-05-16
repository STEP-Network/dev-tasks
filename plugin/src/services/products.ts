import { executeMondayQuery } from "../monday-client.ts";
import { mondayAuthContext } from "../auth-context.ts";
import { BOARDS } from "../constants.ts";

/**
 * Product name → Monday item ID resolution via the Products board.
 *
 * Used by server-side flows (e.g. `auto-version.ts`) that need to convert a
 * task's product mirror display value (a string like "PolAds") into the
 * corresponding Monday item ID for downstream queries. Replaces a hardcoded
 * `PRODUCT_IDS` map — new products auto-appear once they're added to the
 * Products board.
 *
 * Cache keyed by `(boardId, apiKey)` to scope per-user under the hosted HTTP
 * transport. Same auth → cache hit; different auth → cache miss.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;

interface ProductRecord {
  itemId: number;
  name: string;
}

interface ProductCacheEntry {
  products: ProductRecord[];
  fetchedAt: number;
}

const cache = new Map<string, ProductCacheEntry>();

export function clearProductsCache(): void {
  cache.clear();
}

export async function getProductIdByName(name: string): Promise<number> {
  if (!name || !name.trim()) {
    throw new Error("getProductIdByName: name must be a non-empty string");
  }
  const trimmed = name.trim();
  const products = await loadProducts();

  let match = products.find((p) => p.name === trimmed);
  if (!match) {
    const lower = trimmed.toLowerCase();
    match = products.find((p) => p.name.toLowerCase() === lower);
  }
  if (!match) {
    throw new Error(
      `No Monday product found with name '${name}' on Products board ${BOARDS.PRODUCTS}. ` +
      `Add the product to the board or check the spelling.`,
    );
  }
  return match.itemId;
}

function getCacheKey(): string {
  const apiKey = mondayAuthContext.getStore()?.apiKey ?? process.env.MONDAY_API_KEY ?? "";
  return `${BOARDS.PRODUCTS}:${apiKey}`;
}

async function loadProducts(): Promise<ProductRecord[]> {
  const key = getCacheKey();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.products;
  }

  const query = `
    query {
      boards(ids: [${BOARDS.PRODUCTS}]) {
        items_page(limit: 100) {
          items { id name }
        }
      }
    }
  `;
  const response = await executeMondayQuery<any>(query);
  const items = response.boards?.[0]?.items_page?.items ?? [];
  const products: ProductRecord[] = items
    .map((i: any) => ({ itemId: Number(i.id), name: String(i.name ?? "") }))
    .filter((p: ProductRecord) => p.itemId);

  cache.set(key, { products, fetchedAt: Date.now() });
  return products;
}
