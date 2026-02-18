import { executeMondayQuery } from "@/lib/monday-client";

// Registry of items to clean up after tests
const cleanupItems: Array<{ boardId: number; itemId: number }> = [];

export function registerCleanup(boardId: number, itemId: number) {
  cleanupItems.push({ boardId, itemId });
}

export async function cleanupAll() {
  for (const { itemId } of cleanupItems) {
    try {
      await executeMondayQuery(`mutation { delete_item(item_id: ${itemId}) { id } }`);
    } catch {
      // ignore cleanup errors
    }
  }
  cleanupItems.length = 0;
}

// Extract item ID from tool output (tools return markdown strings)
// Matches patterns like:
//   - "**Name** (#1234567890)"  — from createTask, createBug, convertBugToTask
//   - "**ID:** #1234567890"     — from getTask
//   - "#1234567890"             — generic fallback
export function extractItemId(output: string): number {
  const match = output.match(/\(#(\d{9,})\)|(?:ID|id)[:\s]*#?(\d{9,})|#(\d{9,})/);
  if (!match) throw new Error(`Could not extract item ID from output: ${output.substring(0, 200)}`);
  const id = match[1] || match[2] || match[3];
  return parseInt(id, 10);
}

// Extract multiple item IDs
export function extractItemIds(output: string): number[] {
  const matches = output.matchAll(/\(#(\d{9,})\)|(?:ID|id)[:\s]*#?(\d{9,})|#(\d{9,})/g);
  return [...matches].map(m => {
    const id = m[1] || m[2] || m[3];
    return parseInt(id, 10);
  });
}
