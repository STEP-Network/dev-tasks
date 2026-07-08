import * as path from "node:path";

import {
  downloadMondayAsset,
  fetchTaskAssets,
  resolveDownloadDir,
} from "../monday-client.ts";
import {
  buildSafeAssetFileName,
  selectAssetDownloadUrl,
  type NormalizedAsset,
} from "../monday-assets.ts";
import type {
  DownloadTaskAttachmentsInput,
  ListTaskAttachmentsInput,
} from "../schemas.ts";
import { formatError } from "./utils.ts";

/**
 * MCP tools for the DOWN direction of Monday attachments: enumerate + download
 * the files on a task (file columns) and inside its Updates, so the agent can
 * Read them (image-aware Read for screenshots, plus PDFs/text/logs). Pairs with
 * appendTaskVisualSnapshots (the UP direction — pushing images to a task).
 *
 * Neither tool prints the assets' signed download URLs: `public_url` is a
 * short-lived signed URL and the authenticated `url` needs the API token — so
 * only non-sensitive metadata (id/name/ext/size/source) is surfaced.
 */

function humanSize(bytes?: number): string {
  if (bytes == null) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeAsset(asset: NormalizedAsset): string {
  const ext = asset.fileExtension ? `.${asset.fileExtension}` : "(no ext)";
  const downloadable = selectAssetDownloadUrl(asset) ? "" : " — ⚠️ no download URL";
  return `- **${asset.name}** — ${ext} · ${humanSize(asset.fileSizeBytes)} · source: ${asset.source} · id: ${asset.assetId}${downloadable}`;
}

export async function listTaskAttachments(args: ListTaskAttachmentsInput): Promise<string> {
  try {
    const { itemId } = args;
    const includeUpdates = args.includeUpdates ?? true;

    const { found, itemName, assets, warning } = await fetchTaskAssets(itemId, { includeUpdates });
    if (!found) {
      return formatError(`Item #${itemId} not found.`);
    }

    const lines: string[] = [];
    lines.push(`# Attachments for ${itemName ?? `#${itemId}`} (#${itemId})`);
    lines.push("");
    if (warning) {
      lines.push(`> ⚠️ ${warning}`);
      lines.push("");
    }

    if (assets.length === 0) {
      lines.push(
        includeUpdates
          ? "No files attached to this item or its updates."
          : "No files attached to this item (updates not scanned — pass includeUpdates=true to include them).",
      );
      return lines.join("\n").trim();
    }

    lines.push(
      `${assets.length} attachment(s)${includeUpdates ? " (item + updates)" : " (item file columns only)"}:`,
    );
    lines.push("");
    for (const asset of assets) {
      lines.push(describeAsset(asset));
    }
    lines.push("");
    lines.push(
      "Download with `downloadTaskAttachments` (pass `assetIds` to select specific ones), then Read the returned local paths.",
    );
    return lines.join("\n").trim();
  } catch (error) {
    return formatError(
      `Failed to list attachments: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function downloadTaskAttachments(
  args: DownloadTaskAttachmentsInput,
): Promise<string> {
  try {
    const { itemId } = args;
    const includeUpdates = args.includeUpdates ?? true;

    const { found, itemName, assets, warning } = await fetchTaskAssets(itemId, { includeUpdates });
    if (!found) {
      return formatError(`Item #${itemId} not found.`);
    }

    // Optional filter to specific asset ids.
    let selected = assets;
    const missingIds: string[] = [];
    if (args.assetIds && args.assetIds.length > 0) {
      const want = new Set(args.assetIds.map(String));
      selected = assets.filter((a) => want.has(a.assetId));
      const have = new Set(selected.map((a) => a.assetId));
      for (const id of want) {
        if (!have.has(id)) missingIds.push(id);
      }
    }

    if (selected.length === 0) {
      const lines = [`# Attachments for ${itemName ?? `#${itemId}`} (#${itemId})`, ""];
      lines.push(
        args.assetIds && args.assetIds.length > 0
          ? `No matching attachments for the requested asset id(s): ${args.assetIds.join(", ")}.`
          : includeUpdates
            ? "No files attached to this item or its updates."
            : "No files attached to this item (pass includeUpdates=true to include update files).",
      );
      return lines.join("\n").trim();
    }

    const destDir = await resolveDownloadDir(args.destDir, { defaultLeaf: String(itemId) });
    const maxBytes =
      args.maxFileSizeMb != null ? Math.round(args.maxFileSizeMb * 1024 * 1024) : undefined;
    const timeoutMs = args.timeoutMs;

    const taken = new Set<string>();
    const downloaded: Array<{ name: string; source: string; path: string; bytes: number }> = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    for (const asset of selected) {
      if (!selectAssetDownloadUrl(asset)) {
        skipped.push({ name: asset.name, reason: "no download URL on the asset" });
        continue;
      }
      const fileName = buildSafeAssetFileName(asset, taken);
      const filePath = path.join(destDir, fileName);
      // Defense-in-depth: the sanitized name is a single segment, but re-verify
      // the resolved file stayed directly inside destDir.
      if (path.dirname(filePath) !== destDir) {
        skipped.push({ name: asset.name, reason: "unsafe resolved path" });
        continue;
      }
      try {
        const result = await downloadMondayAsset(asset, filePath, { maxBytes, timeoutMs });
        downloaded.push({
          name: result.name,
          source: result.source,
          path: result.path,
          bytes: result.bytes,
        });
      } catch (err) {
        skipped.push({
          name: asset.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const lines: string[] = [];
    lines.push(`# Downloaded attachments for ${itemName ?? `#${itemId}`} (#${itemId})`);
    lines.push("");
    if (warning) {
      lines.push(`> ⚠️ ${warning}`);
      lines.push("");
    }
    lines.push(`**Destination:** ${destDir}`);
    lines.push(`**Downloaded:** ${downloaded.length} · **Skipped:** ${skipped.length}`);
    lines.push("");
    if (downloaded.length > 0) {
      lines.push("## Local files (Read these paths)");
      for (const d of downloaded) {
        lines.push(`- ${d.path}  _(${humanSize(d.bytes)}, source: ${d.source})_`);
      }
      lines.push("");
    }
    if (skipped.length > 0) {
      lines.push(`## Skipped (${skipped.length})`);
      for (const s of skipped) {
        lines.push(`- **${s.name}**: ${s.reason}`);
      }
      lines.push("");
    }
    if (missingIds.length > 0) {
      lines.push(`## Requested asset id(s) not found: ${missingIds.join(", ")}`);
    }
    return lines.join("\n").trim();
  } catch (error) {
    return formatError(
      `Failed to download attachments: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
