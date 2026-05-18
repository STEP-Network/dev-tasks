import { executeMondayQuery } from "../monday-client.ts";
import { mondayAuthContext } from "../auth-context.ts";

/**
 * Username → Monday person ID resolution via the STEP Network *People board.
 *
 * The People board holds one row per employee with their Monday user ID in a
 * dedicated text column (`text6__1`), their email, display name, and status.
 * We treat that board as the directory and look up `whoami`-style usernames
 * against it at runtime, instead of a hardcoded map in code.
 *
 * Why a board: new team members get auto-added the moment they join — no
 * plugin code change, no per-project config edit.
 *
 * Match priority (most specific first):
 *   1. `text_mm3ffcjd` whoami column  — authoritative; exact-match against
 *      a per-person registered system username (set explicitly by the team
 *      on the People board). This is the canonical mapping — when present,
 *      always wins over the fuzzier fallbacks below.
 *   2. email local-part (before `@`)  — naref@stepnetwork.dk → "naref"
 *   3. `person` column display name   — "Nate"
 *   4. `name` column first word       — "Nathaniel"
 *
 * Records with status `Past` are excluded.
 *
 * Caching: keyed by `(boardId, apiKey)` so a long-lived process (HTTP transport
 * serving multiple users on warm starts, or stdio with env-fallback) doesn't
 * leak one user's directory view to another. The apiKey suffix scopes per
 * Monday auth token; same key → cache hit, different key → cache miss.
 */

const DEFAULT_PEOPLE_BOARD_ID = 1612664689;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface PersonRecord {
  itemId: string;
  fullName: string;
  displayName: string;
  email: string | null;
  whoamiUsername: string | null;
  personId: number;
  status: string;
}

interface PeopleCacheEntry {
  records: PersonRecord[];
  fetchedAt: number;
}

const cache = new Map<string, PeopleCacheEntry>();

export function clearPeopleCache(): void {
  cache.clear();
}

export async function getPersonByUsername(
  username: string,
  options?: { boardId?: number },
): Promise<number> {
  if (!username || !username.trim()) {
    throw new Error("getPersonByUsername: username must be a non-empty string");
  }

  const boardId = options?.boardId ?? DEFAULT_PEOPLE_BOARD_ID;
  const input = username.trim();
  const lower = input.toLowerCase();

  if (/^\d+$/.test(lower)) {
    return Number(lower);
  }

  const records = await loadPeople(boardId);

  // 1. text_mm3ffcjd — registered whoami username. Authoritative when present.
  for (const r of records) {
    if (r.whoamiUsername && r.whoamiUsername.toLowerCase() === lower) {
      return r.personId;
    }
  }
  // 2. Email local-part fallback.
  for (const r of records) {
    if (r.email && r.email.split("@")[0].toLowerCase() === lower) {
      return r.personId;
    }
  }
  // 3. `person` column display name.
  for (const r of records) {
    if (r.displayName && r.displayName.toLowerCase() === lower) {
      return r.personId;
    }
  }
  // 4. Full-name first word.
  for (const r of records) {
    const firstWord = r.fullName.split(/\s+/)[0]?.toLowerCase();
    if (firstWord && firstWord === lower) {
      return r.personId;
    }
  }

  throw new Error(
    `No Monday user found for username '${username}' on People board ${boardId}. ` +
    `Add them to the board, set their whoami username in column 'text_mm3ffcjd', ` +
    `or ensure their email local-part matches.`,
  );
}

function getCacheKey(boardId: number): string {
  // Per-request token (HTTP transport via ALS) wins; env fallback for stdio.
  const apiKey = mondayAuthContext.getStore()?.apiKey ?? process.env.MONDAY_API_KEY ?? "";
  return `${boardId}:${apiKey}`;
}

async function loadPeople(boardId: number): Promise<PersonRecord[]> {
  const key = getCacheKey(boardId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.records;
  }

  const query = `
    query {
      boards(ids: [${boardId}]) {
        items_page(limit: 500) {
          items {
            id
            name
            column_values(ids: ["person", "email__1", "text6__1", "text_mm3ffcjd", "status"]) {
              id
              text
              value
            }
          }
        }
      }
    }
  `;

  const response = await executeMondayQuery<any>(query);
  const items = response.boards?.[0]?.items_page?.items ?? [];

  const records: PersonRecord[] = [];
  for (const item of items) {
    const cols = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) ?? []);
    const status = cols.get("status")?.text ?? "";
    if (status === "Past") continue;

    const peopleIdText = cols.get("text6__1")?.text;
    const personId = peopleIdText && /^\d+$/.test(peopleIdText) ? Number(peopleIdText) : null;
    if (!personId) continue;

    const rawWhoami = cols.get("text_mm3ffcjd")?.text;
    const whoamiUsername = rawWhoami && String(rawWhoami).trim() ? String(rawWhoami).trim() : null;

    records.push({
      itemId: String(item.id),
      fullName: String(item.name ?? ""),
      displayName: String(cols.get("person")?.text ?? ""),
      email: cols.get("email__1")?.text || null,
      whoamiUsername,
      personId,
      status,
    });
  }

  cache.set(key, { records, fetchedAt: Date.now() });
  return records;
}
