import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { mondayAuthContext } from "./auth-context.js";
import { ASSET_FIELDS, DEFAULT_DOWNLOAD_TIMEOUT_MS, DEFAULT_MAX_ASSET_BYTES, isAllowedMondayAssetUrl, normalizeItemAssetsPayload, selectAssetDownloadUrl, } from "./monday-assets.js";
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
function resolveMondayApiKey() {
    const apiKey = mondayAuthContext.getStore()?.apiKey ?? process.env.MONDAY_API_KEY;
    if (!apiKey) {
        throw new Error("No Monday auth: pass Authorization: Bearer <token> on the request, " +
            "or set MONDAY_API_KEY in the environment.");
    }
    return apiKey;
}
export async function executeMondayQuery(query, variables, options) {
    const apiKey = resolveMondayApiKey();
    const body = { query };
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
    return result.data;
}
// =============================================================================
// Binary asset upload (multipart) — used to embed images in Monday docs.
// =============================================================================
/** Image extensions the uploader will accept. Anything else is refused. */
const ALLOWED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
/**
 * Roots a screenshot file is permitted to come from. Hardening per the
 * security review: `uploadFileToMonday` accepts a caller-supplied path, so we
 * refuse to read anything outside these roots (defeats `../` traversal and
 * symlink escapes into e.g. /etc). Screenshots legitimately land in the OS temp
 * dir, under the working directory (e.g. `<repo>/.claude/visual-snapshots/...`),
 * or under an explicit `VISUAL_DIFF_SCREENSHOT_DIR` override.
 */
async function allowedUploadRoots() {
    const candidates = [tmpdir(), process.cwd(), process.env.VISUAL_DIFF_SCREENSHOT_DIR].filter((p) => Boolean(p));
    const roots = [];
    for (const base of candidates) {
        try {
            roots.push(await realpath(base));
        }
        catch {
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
async function assertAllowedImagePath(absPath) {
    if (!absPath || !path.isAbsolute(absPath)) {
        throw new Error(`Screenshot path must be an absolute path: ${absPath}`);
    }
    const ext = path.extname(absPath).toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`Refusing to upload non-image file (extension '${ext || "none"}'): ${absPath}`);
    }
    let real;
    try {
        real = await realpath(absPath);
    }
    catch {
        throw new Error(`Screenshot file not found or unreadable: ${absPath}`);
    }
    const roots = await allowedUploadRoots();
    const inside = roots.some((root) => real === root || real.startsWith(root + path.sep));
    if (!inside) {
        throw new Error(`Refusing to upload a file outside allowed roots [${roots.join(", ")}]: ${real}`);
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
export async function uploadFileToMonday(itemId, columnId, absPath, filename) {
    const apiKey = resolveMondayApiKey();
    const safePath = await assertAllowedImagePath(absPath);
    const bytes = await readFile(safePath);
    const name = filename ?? path.basename(safePath);
    // Monday's file endpoint parses a multipart form with two parts: `query`
    // (the mutation referencing $file) and `variables[file]` (the binary).
    const mutation = `mutation ($file: File!) { add_file_to_column(` +
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
        throw new Error(`Monday file upload returned no asset id: ${JSON.stringify(result.data ?? result)}`);
    }
    return { assetId: String(asset.id), publicUrl: String(asset.public_url ?? "") };
}
// =============================================================================
// Asset download (the DOWN direction) — enumerate + pull a task's attachments.
// =============================================================================
//
// Companion to uploadFileToMonday above: reads the FILES attached to a Monday
// item (file columns) and, optionally, the files posted inside its Updates, then
// downloads them locally so the agent can Read them (image-aware Read for
// screenshots; PDFs/text/logs too). Pure normalization + URL-selection + the
// SSRF host allowlist + filename safety live in monday-assets.ts.
/** Max Updates fetched per item (Monday's page cap). */
const UPDATES_PAGE_LIMIT = 100;
/**
 * Enumerate the assets on a Monday item's file columns and (when
 * `includeUpdates`) on each of its Updates. Returns a flat, source-tagged list.
 * Uses the shared JSON GraphQL path (`executeMondayQuery`).
 */
export async function fetchTaskAssets(itemId, opts) {
    const updatesSelection = opts.includeUpdates
        ? `updates(limit: ${UPDATES_PAGE_LIMIT}) { id assets { ${ASSET_FIELDS} } }`
        : "";
    const query = `
    query {
      items(ids: [${itemId}]) {
        name
        assets { ${ASSET_FIELDS} }
        ${updatesSelection}
      }
    }
  `;
    const response = await executeMondayQuery(query);
    const item = response.items?.[0];
    if (!item) {
        return { found: false, assets: [] };
    }
    // Surface a truncation warning: if Updates came back exactly at the page cap,
    // older updates (and their attachments) may not have been scanned.
    const warning = opts.includeUpdates && Array.isArray(item.updates) && item.updates.length >= UPDATES_PAGE_LIMIT
        ? `Only the most recent ${UPDATES_PAGE_LIMIT} updates were scanned — older updates' attachments may be missing.`
        : undefined;
    return {
        found: true,
        itemName: item.name ?? undefined,
        assets: normalizeItemAssetsPayload(item, opts),
        warning,
    };
}
// -----------------------------------------------------------------------------
// Download destination — realpath jail (mirrors allowedUploadRoots above).
// -----------------------------------------------------------------------------
const DOWNLOAD_SUBDIR = "dev-tasks-attachments";
/** Roots a download is permitted to land in. */
async function allowedDownloadRoots() {
    const candidates = [tmpdir(), process.cwd(), process.env.DEV_TASKS_DOWNLOAD_DIR].filter((p) => Boolean(p));
    const roots = [];
    for (const base of candidates) {
        try {
            roots.push(await realpath(base));
        }
        catch {
            // Skip roots that don't resolve (e.g. an unset override dir).
        }
    }
    return roots;
}
/** Nearest existing ancestor of an absolute path, symlink-resolved. */
async function nearestExistingRealAncestor(absPath) {
    let cur = absPath;
    for (;;) {
        try {
            return await realpath(cur);
        }
        catch {
            const parent = path.dirname(cur);
            if (parent === cur)
                return cur; // reached the filesystem root
            cur = parent;
        }
    }
}
/** Reduce a default-dir leaf (e.g. an item id) to a safe single path segment. */
function sanitizeDirLeaf(leaf) {
    return leaf.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "") || "task";
}
/**
 * Resolve (and create) the directory downloads land in. Defaults to a scratchpad
 * dir under the OS temp dir (namespaced by `defaultLeaf`, e.g. the item id, so
 * separate tasks don't overwrite each other's identically-named files). A
 * caller-supplied `destDir` is used as-is (never namespaced) and REQUIRED to sit
 * inside an allowed root (OS temp dir, cwd, or `$DEV_TASKS_DOWNLOAD_DIR`);
 * traversal (`../`) and symlink escapes are defeated by realpath-checking the
 * nearest existing ancestor before creating, then re-checking after mkdir.
 * Returns the real (symlink-resolved) absolute directory path.
 */
export async function resolveDownloadDir(destDir, opts) {
    let target;
    if (destDir && destDir.trim()) {
        target = path.resolve(destDir.trim());
    }
    else if (opts?.defaultLeaf) {
        target = path.join(tmpdir(), DOWNLOAD_SUBDIR, sanitizeDirLeaf(opts.defaultLeaf));
    }
    else {
        target = path.join(tmpdir(), DOWNLOAD_SUBDIR);
    }
    const roots = await allowedDownloadRoots();
    const isInside = (p) => roots.some((r) => p === r || p.startsWith(r + path.sep));
    const realAncestor = await nearestExistingRealAncestor(target);
    if (!isInside(realAncestor)) {
        throw new Error(`Refusing to write downloads outside allowed roots [${roots.join(", ")}]: ${target}`);
    }
    await mkdir(target, { recursive: true });
    const real = await realpath(target);
    if (!isInside(real)) {
        throw new Error(`Refusing to write downloads outside allowed roots [${roots.join(", ")}]: ${real}`);
    }
    return real;
}
/** Read a fetch body into a Buffer, aborting if it exceeds `maxBytes`. */
async function readCappedBody(response, maxBytes, asset) {
    const body = response.body;
    if (body && typeof body[Symbol.asyncIterator] === "function") {
        const chunks = [];
        let total = 0;
        for await (const chunk of body) {
            total += chunk.byteLength;
            if (total > maxBytes) {
                throw new Error(`Asset ${asset.assetId} (${asset.name}) exceeds the ${maxBytes}-byte cap mid-stream.`);
            }
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }
    // Fallback when the body isn't a stream (e.g. a mocked fetch): buffer, then cap.
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) {
        throw new Error(`Asset ${asset.assetId} (${asset.name}) is ${buf.length} bytes, over the ${maxBytes}-byte cap.`);
    }
    return buf;
}
/**
 * Download a single asset to `destPath`. Resolves the download URL via
 * `selectAssetDownloadUrl` (public_url preferred; else the authenticated url),
 * sends `Authorization: <token>` ONLY for the authenticated variant (never for
 * public_url, never logged), enforces an https Monday-host allowlist (SSRF),
 * an AbortController timeout, and a size cap (Monday-reported size + response
 * Content-Length pre-checks, then a streamed byte counter). Writes the bytes and
 * returns the local path + size.
 */
export async function downloadMondayAsset(asset, destPath, opts) {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_ASSET_BYTES;
    const selected = selectAssetDownloadUrl(asset);
    if (!selected) {
        throw new Error(`Asset ${asset.assetId} (${asset.name}) has no downloadable URL.`);
    }
    if (!isAllowedMondayAssetUrl(selected.url)) {
        // Report the host only — never echo the full URL (may carry a signature).
        let host = "unknown";
        try {
            host = new URL(selected.url).host;
        }
        catch {
            /* keep "unknown" */
        }
        throw new Error(`Refusing to download asset ${asset.assetId} from a non-Monday host: ${host}`);
    }
    // Cheap pre-flight guard from Monday's reported size (avoids the fetch).
    if (asset.fileSizeBytes != null && asset.fileSizeBytes > maxBytes) {
        throw new Error(`Asset ${asset.assetId} (${asset.name}) is ${asset.fileSizeBytes} bytes, over the ${maxBytes}-byte cap.`);
    }
    const headers = {};
    if (selected.needsAuth) {
        headers.Authorization = resolveMondayApiKey();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetch(selected.url, { headers, signal: controller.signal });
    }
    catch (err) {
        clearTimeout(timer);
        if (err?.name === "AbortError") {
            throw new Error(`Download of asset ${asset.assetId} timed out after ${timeoutMs}ms.`);
        }
        throw new Error(`Download of asset ${asset.assetId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        if (!response.ok) {
            throw new Error(`Download of asset ${asset.assetId} failed: HTTP ${response.status} ${response.statusText}`);
        }
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
            throw new Error(`Asset ${asset.assetId} (${asset.name}) is ${declared} bytes, over the ${maxBytes}-byte cap.`);
        }
        const bytes = await readCappedBody(response, maxBytes, asset);
        await writeFile(destPath, bytes);
        return {
            assetId: asset.assetId,
            name: asset.name,
            source: asset.source,
            path: destPath,
            bytes: bytes.length,
        };
    }
    catch (err) {
        // A timeout can fire mid-stream (after headers), surfacing as an AbortError
        // from the body read — translate it to the same friendly message as the
        // connect-phase timeout above.
        if (err?.name === "AbortError") {
            throw new Error(`Download of asset ${asset.assetId} timed out after ${timeoutMs}ms.`);
        }
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
}
