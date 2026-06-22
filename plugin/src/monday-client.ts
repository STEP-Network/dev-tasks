import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { mondayAuthContext } from "./auth-context.ts";

const MONDAY_API_URL = "https://api.monday.com/v2";
// Monday's binary-upload endpoint (multipart/form-data). Distinct from the
// JSON GraphQL endpoint above — file uploads cannot go through the JSON path.
const MONDAY_FILE_API_URL = "https://api.monday.com/v2/file";
const DEFAULT_API_VERSION = "2024-10";

// Doc-related GraphQL fields (`add_content_to_doc_from_markdown`,
// `export_markdown_from_doc`) only exist on API 2025-10+. Pass this as
// `apiVersion` when calling those ops; everything else stays on 2024-10
// so other tools aren't exposed to year-old behavior changes.
export const DOC_API_VERSION = "2025-10";

// The TYPED doc-blocks API (`create_doc_blocks` + `CreateBlockInput` /
// `ImageBlockInput`) — needed to embed images in docs by asset id — first
// appears on API 2026-07 (verified by version probe: absent on 2025-10 /
// 2026-01 / 2026-04, present on 2026-07). Older versions only expose the
// legacy `create_doc_block` singular with an opaque JSON `content` blob. Pin
// just the image-block mutation here so the rest of doc ops stay on 2025-10.
export const DOC_BLOCKS_API_VERSION = "2026-07";

/**
 * Resolve the Monday API token for the current call. Per-request token wins
 * (hosted HTTP transport sets it via AsyncLocalStorage); falls back to env var
 * for stdio + single-user/admin deployments. Shared by the JSON GraphQL path
 * and the multipart file-upload path so both authenticate identically.
 */
function resolveMondayApiKey(): string {
  const apiKey = mondayAuthContext.getStore()?.apiKey ?? process.env.MONDAY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No Monday auth: pass Authorization: Bearer <token> on the request, " +
      "or set MONDAY_API_KEY in the environment."
    );
  }
  return apiKey;
}

export async function executeMondayQuery<T>(
  query: string,
  variables?: Record<string, unknown>,
  options?: { apiVersion?: string },
): Promise<T> {
  const apiKey = resolveMondayApiKey();

  const body: Record<string, unknown> = { query };
  if (variables) {
    body.variables = variables;
  }

  const response = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
      "API-Version": options?.apiVersion ?? DEFAULT_API_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Monday API error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();

  if (result.errors && result.errors.length > 0) {
    throw new Error(`Monday API query error: ${JSON.stringify(result.errors)}`);
  }

  return result.data as T;
}

// =============================================================================
// Binary asset upload (multipart) — used to embed images in Monday docs.
// =============================================================================

/** Image extensions the uploader will accept. Anything else is refused. */
const ALLOWED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export interface MondayUploadResult {
  /** Permanent Monday asset id. Embed images via this (Asset.public_url expires in ~1h). */
  assetId: string;
  /** Time-limited public URL (valid ~1h) — informational only; do NOT persist it. */
  publicUrl: string;
}

/**
 * Roots a screenshot file is permitted to come from. Hardening per the
 * security review: `uploadFileToMonday` accepts a caller-supplied path, so we
 * refuse to read anything outside these roots (defeats `../` traversal and
 * symlink escapes into e.g. /etc). Screenshots legitimately land in the OS temp
 * dir, under the working directory (e.g. `<repo>/.claude/visual-snapshots/...`),
 * or under an explicit `VISUAL_DIFF_SCREENSHOT_DIR` override.
 */
async function allowedUploadRoots(): Promise<string[]> {
  const candidates = [tmpdir(), process.cwd(), process.env.VISUAL_DIFF_SCREENSHOT_DIR].filter(
    (p): p is string => Boolean(p),
  );
  const roots: string[] = [];
  for (const base of candidates) {
    try {
      roots.push(await realpath(base));
    } catch {
      // Skip roots that don't resolve (e.g. an unset override dir).
    }
  }
  return roots;
}

/**
 * Validate a caller-supplied screenshot path before reading it: must be an
 * absolute path to an existing image file whose real (symlink-resolved)
 * location sits inside an allowed root. Returns the resolved real path.
 * Throws (never reads) on any violation.
 */
async function assertAllowedImagePath(absPath: string): Promise<string> {
  if (!absPath || !path.isAbsolute(absPath)) {
    throw new Error(`Screenshot path must be an absolute path: ${absPath}`);
  }
  const ext = path.extname(absPath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(
      `Refusing to upload non-image file (extension '${ext || "none"}'): ${absPath}`,
    );
  }
  let real: string;
  try {
    real = await realpath(absPath);
  } catch {
    throw new Error(`Screenshot file not found or unreadable: ${absPath}`);
  }
  const roots = await allowedUploadRoots();
  const inside = roots.some((root) => real === root || real.startsWith(root + path.sep));
  if (!inside) {
    throw new Error(
      `Refusing to upload a file outside allowed roots [${roots.join(", ")}]: ${real}`,
    );
  }
  return real;
}

/**
 * Upload a local image file to a Monday item's file column and return its
 * permanent asset id. Minting an asset is the only way to embed an image in a
 * Monday doc that survives (the asset's public_url expires ~1h, so blocks must
 * reference `asset_id`). Uses Monday's multipart `/v2/file` endpoint — the JSON
 * `executeMondayQuery` path cannot carry binary.
 *
 * SECURITY: `absPath` is validated against an allowlist of roots + image
 * extensions before any read (see `assertAllowedImagePath`).
 */
export async function uploadFileToMonday(
  itemId: number,
  columnId: string,
  absPath: string,
  filename?: string,
): Promise<MondayUploadResult> {
  const apiKey = resolveMondayApiKey();
  const safePath = await assertAllowedImagePath(absPath);
  const bytes = await readFile(safePath);
  const name = filename ?? path.basename(safePath);

  // Monday's file endpoint parses a multipart form with two parts: `query`
  // (the mutation referencing $file) and `variables[file]` (the binary).
  const mutation =
    `mutation ($file: File!) { add_file_to_column(` +
    `item_id: ${itemId}, column_id: ${JSON.stringify(columnId)}, file: $file` +
    `) { id public_url } }`;

  const form = new FormData();
  form.append("query", mutation);
  form.append("variables[file]", new Blob([new Uint8Array(bytes)]), name);

  // NOTE: do not set Content-Type — fetch derives the multipart boundary from
  // the FormData body automatically.
  const response = await fetch(MONDAY_FILE_API_URL, {
    method: "POST",
    headers: { Authorization: apiKey },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Monday file upload error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  if (result.errors && result.errors.length > 0) {
    throw new Error(`Monday file upload query error: ${JSON.stringify(result.errors)}`);
  }

  const asset = result.data?.add_file_to_column;
  if (!asset?.id) {
    throw new Error(
      `Monday file upload returned no asset id: ${JSON.stringify(result.data ?? result)}`,
    );
  }
  return { assetId: String(asset.id), publicUrl: String(asset.public_url ?? "") };
}
