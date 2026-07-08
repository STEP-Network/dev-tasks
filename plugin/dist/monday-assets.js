// =============================================================================
// Monday asset helpers — PURE (no network, no filesystem).
// =============================================================================
//
// The network + filesystem side of downloading task attachments lives in
// monday-client.ts (`fetchTaskAssets` + `downloadMondayAsset` + the download-dir
// realpath jail), which imports the pure helpers below. Keeping normalization,
// URL selection, the SSRF host allowlist, and filename safety in this pure
// module makes them unit-testable without mocking fetch or `node:fs`.
//
// This is the DOWN direction (pull + read attachments); the UP direction
// (uploadFileToMonday, embedding screenshots in docs) already lives in
// monday-client.ts + tools/taskVisualDiff.ts.
/** GraphQL selection set for a Monday `Asset` — shared by the item + updates query. */
export const ASSET_FIELDS = "id name url public_url file_extension file_size";
/** Default per-file download timeout (ms). Downloads can be larger/slower than
 *  a JSON API call, so this is more generous than the GraphQL request. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
/** Default per-file size cap (bytes). Screenshots, PDFs, and logs sit well under
 *  this; anything larger is skipped rather than buffered. */
export const DEFAULT_MAX_ASSET_BYTES = 25 * 1024 * 1024; // 25 MB
function toStr(value) {
    return value == null ? "" : String(value);
}
function normalizeExtension(ext) {
    const s = toStr(ext).trim().toLowerCase();
    return s.startsWith(".") ? s.slice(1) : s;
}
function toBytes(value) {
    if (value == null)
        return undefined;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}
/** An asset is usable only if it carries a non-empty id we can reference/download. */
function hasUsableId(raw) {
    return !!raw && raw.id != null && String(raw.id).trim() !== "";
}
function normalizeOne(raw, source) {
    const id = toStr(raw.id);
    return {
        assetId: id,
        name: toStr(raw.name).trim() || `asset-${id}`,
        url: toStr(raw.url),
        publicUrl: toStr(raw.public_url),
        fileExtension: normalizeExtension(raw.file_extension),
        fileSizeBytes: toBytes(raw.file_size),
        source,
    };
}
/**
 * Flatten a Monday item's file-column assets + (optionally) each Update's assets
 * into a single source-tagged list. Order: item file-column assets first, then
 * updates in Monday's returned order. Items/updates with no assets are handled
 * (an item with nothing attached yields []). Entries with no `id` are skipped.
 */
export function normalizeItemAssetsPayload(item, opts) {
    if (!item)
        return [];
    const out = [];
    for (const a of item.assets ?? []) {
        if (hasUsableId(a))
            out.push(normalizeOne(a, "task-file-column"));
    }
    if (opts.includeUpdates) {
        for (const u of item.updates ?? []) {
            if (!u)
                continue;
            const source = `update-${toStr(u.id)}`;
            for (const a of u.assets ?? []) {
                if (hasUsableId(a))
                    out.push(normalizeOne(a, source));
            }
        }
    }
    return out;
}
/**
 * Choose the URL to download an asset from:
 *  - prefer `public_url` (Monday's short-lived signed URL — no auth header);
 *  - else fall back to the authenticated `url` (needs `Authorization: <token>`);
 *  - else null (asset has neither — nothing to download).
 */
export function selectAssetDownloadUrl(asset) {
    const publicUrl = asset.publicUrl?.trim();
    if (publicUrl)
        return { url: publicUrl, needsAuth: false };
    const url = asset.url?.trim();
    if (url)
        return { url, needsAuth: true };
    return null;
}
/**
 * SSRF defense-in-depth (Corridor CWE-918): only download from a Monday-owned
 * asset host. Asset URLs come from Monday's own GraphQL response — a caller
 * cannot point this at an internal host — but per the project's SSRF guardrail
 * we still require an https Monday / Monday-CDN / Monday-S3 host before the
 * fetch. If Monday adds a new asset host, extend the allowlist here.
 */
export function isAllowedMondayAssetUrl(urlString) {
    let parsed;
    try {
        parsed = new URL(urlString);
    }
    catch {
        return false;
    }
    if (parsed.protocol !== "https:")
        return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "monday.com" || host.endsWith(".monday.com"))
        return true;
    if (host.endsWith(".mondaycdn.com"))
        return true;
    // Monday stores binary assets in S3; `public_url` is a signed S3 URL. The
    // Monday bucket is `files-monday-com`, so require the "monday-com" token in
    // the host (bucket-subdomain style) or path (path-style bucket) — tighter
    // than a bare "monday" substring so a decoy like `hackmonday.s3.amazonaws.com`
    // can't slip through.
    if (host.endsWith(".amazonaws.com")) {
        return /monday-com/.test(host) || /monday-com/.test(parsed.pathname);
    }
    return false;
}
const MAX_FILENAME_LENGTH = 120;
/** Reduce a name to a safe single path segment (no separators/traversal/control). */
function sanitizeBaseName(name) {
    // Take the last path segment — defeats "../../etc/passwd" and "a/b.png".
    const lastSegment = name.split(/[\\/]/).pop() ?? "";
    return lastSegment
        .replace(/[\x00-\x1f\x7f]/g, "") // control chars
        .replace(/[^a-zA-Z0-9._-]/g, "-") // anything unusual → dash
        .replace(/^\.+/, "") // no leading dots (blocks ".", "..", hidden files)
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
}
/**
 * Build a collision-safe, traversal-safe local filename for an asset. Sanitizes
 * the Monday-supplied name to a single safe basename, guarantees an extension
 * (from `file_extension` when the name lacks one), caps the length, and dedupes
 * against `taken` with `-1`, `-2`, … inserted before the extension. Records the
 * chosen name in `taken` so repeated calls stay collision-free.
 */
export function buildSafeAssetFileName(asset, taken) {
    let base = sanitizeBaseName(asset.name || "");
    const ext = asset.fileExtension ? `.${asset.fileExtension.replace(/^\.+/, "")}` : "";
    const hasExt = /\.[a-zA-Z0-9]+$/.test(base);
    if (!hasExt && ext)
        base = `${base || `asset-${asset.assetId}`}${ext}`;
    if (!base)
        base = `asset-${asset.assetId}${ext}`;
    // Cap length while preserving the extension.
    if (base.length > MAX_FILENAME_LENGTH) {
        const m = base.match(/(\.[a-zA-Z0-9]+)$/);
        const tail = m ? m[1] : "";
        base = base.slice(0, MAX_FILENAME_LENGTH - tail.length) + tail;
    }
    if (!taken.has(base)) {
        taken.add(base);
        return base;
    }
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const tail = dot > 0 ? base.slice(dot) : "";
    let n = 1;
    let candidate = `${stem}-${n}${tail}`;
    while (taken.has(candidate)) {
        n += 1;
        candidate = `${stem}-${n}${tail}`;
    }
    taken.add(candidate);
    return candidate;
}
