import { executeMondayQuery } from "../monday-client";
import type { GetUpdatesInput } from "../schemas";
import { formatError } from "./utils";

interface UpdateCreator {
  id: string;
  name: string;
}

interface UpdateReply {
  id: string;
  text_body: string;
  created_at: string;
  creator: UpdateCreator;
}

interface Update {
  id: string;
  text_body: string;
  created_at: string;
  creator: UpdateCreator;
  replies: UpdateReply[];
}

export async function getUpdates(args: GetUpdatesInput): Promise<string> {
  try {
    const { itemId, limit = 25, page = 1 } = args;

    const query = `
      query {
        items(ids: [${itemId}]) {
          name
          updates(limit: ${Math.min(limit, 100)}, page: ${page}) {
            id
            text_body
            created_at
            creator { id name }
            replies {
              id
              text_body
              created_at
              creator { id name }
            }
          }
        }
      }
    `;

    const response = await executeMondayQuery<any>(query);
    const item = response.items?.[0];

    if (!item) {
      return formatError(`Item #${itemId} not found.`);
    }

    const updates: Update[] = item.updates || [];
    const lines: string[] = [];

    lines.push(`# Updates for ${item.name} (#${itemId})`);
    lines.push("");

    if (updates.length === 0) {
      lines.push("No updates found.");
      if (page > 1) {
        lines.push(`(Page ${page} — try a lower page number)`);
      }
      return lines.join("\n").trim();
    }

    lines.push(`Page ${page} | Showing ${updates.length} update(s)`);
    lines.push("");

    for (const update of updates) {
      const date = new Date(update.created_at).toISOString().replace("T", " ").slice(0, 16);
      const author = update.creator?.name || "Unknown";

      lines.push(`---`);
      lines.push(`**${author}** — ${date} (ID: ${update.id})`);
      lines.push("");
      lines.push(update.text_body || "(empty)");
      lines.push("");

      if (update.replies && update.replies.length > 0) {
        lines.push(`> **${update.replies.length} reply/replies:**`);
        for (const reply of update.replies) {
          const replyDate = new Date(reply.created_at).toISOString().replace("T", " ").slice(0, 16);
          const replyAuthor = reply.creator?.name || "Unknown";
          lines.push(`>`);
          lines.push(`> **${replyAuthor}** — ${replyDate} (ID: ${reply.id})`);
          lines.push(`> ${reply.text_body || "(empty)"}`);
        }
        lines.push("");
      }
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to get updates: ${error instanceof Error ? error.message : String(error)}`);
  }
}
