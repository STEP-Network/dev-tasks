import { executeMondayQuery } from "../monday-client.ts";

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
 *   1. email local-part (before `@`)  — naref@stepnetwork.dk → "naref"
 *   2. `person` column display name   — "Nate"
 *   3. `name` column first word       — "Nathaniel"
 *
 * Records with status `Past` are excluded.
 */

const DEFAULT_PEOPLE_BOARD_ID = 1612664689;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface PersonRecord {
  itemId: string;
  fullName: string;
  displayName: string;
  email: string | null;
  personId: number;
  status: string;
}

interface PeopleCache {
  boardId: number;
  records: PersonRecord[];
  fetchedAt: number;
}

let cache: PeopleCache | null = null;

export function clearPeopleCache(): void {
  cache = null;
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

  for (const r of records) {
    if (r.email && r.email.split("@")[0].toLowerCase() === lower) {
      return r.personId;
    }
  }
  for (const r of records) {
    if (r.displayName.toLowerCase() === lower) {
      return r.personId;
    }
  }
  for (const r of records) {
    const firstWord = r.fullName.split(/\s+/)[0]?.toLowerCase();
    if (firstWord === lower) {
      return r.personId;
    }
  }

  throw new Error(
    `No Monday user found for username '${username}' on People board ${boardId}. ` +
    `Add them to the board or update their email so its local-part matches.`,
  );
}

async function loadPeople(boardId: number): Promise<PersonRecord[]> {
  if (cache && cache.boardId === boardId && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.records;
  }

  const query = `
    query {
      boards(ids: [${boardId}]) {
        items_page(limit: 500) {
          items {
            id
            name
            column_values(ids: ["person", "email__1", "text6__1", "status"]) {
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

    records.push({
      itemId: String(item.id),
      fullName: String(item.name ?? ""),
      displayName: String(cols.get("person")?.text ?? ""),
      email: cols.get("email__1")?.text || null,
      personId,
      status,
    });
  }

  cache = { boardId, records, fetchedAt: Date.now() };
  return records;
}
