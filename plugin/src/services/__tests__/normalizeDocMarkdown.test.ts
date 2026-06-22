/**
 * Tests for normalizeDocMarkdown (v0.27.0) — the defensive normalization
 * applied at the addContentToDocOrThrow choke point before every Monday doc
 * write. Guards against the "doc renders as one raw-markdown paragraph"
 * failure mode caused by double-escaped tool args (literal \n, no real
 * newlines).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../monday-client.ts", () => ({
  executeMondayQuery: vi.fn(),
  DOC_API_VERSION: "2026-01",
  DOC_BLOCKS_API_VERSION: "2026-07",
}));

import { normalizeDocMarkdown } from "../doc-utils.ts";

describe("normalizeDocMarkdown", () => {
  it("is a no-op on healthy multi-line markdown", () => {
    const md = "# Title\n\n- bullet\n\n**bold** text\n";
    expect(normalizeDocMarkdown(md)).toBe(md);
  });

  it("normalizes CRLF to LF", () => {
    expect(normalizeDocMarkdown("# Title\r\n\r\n- bullet\r\n")).toBe(
      "# Title\n\n- bullet\n",
    );
  });

  it("rescues a double-escaped payload (literal \\n, zero real newlines)", () => {
    const escaped = "# Title\\n\\n- bullet one\\n- bullet two";
    expect(normalizeDocMarkdown(escaped)).toBe(
      "# Title\n\n- bullet one\n- bullet two",
    );
  });

  it("rescues literal \\r\\n and \\t in the same pass", () => {
    expect(normalizeDocMarkdown("a\\r\\nb\\tc")).toBe("a\nb\tc");
  });

  it("leaves literal \\n untouched when real newlines exist (code-fence safety)", () => {
    const md = '# Title\n\n```bash\nprintf "a\\nb"\n```\n';
    expect(normalizeDocMarkdown(md)).toBe(md);
  });

  it("leaves a plain single-line string without escapes untouched", () => {
    expect(normalizeDocMarkdown("just one line")).toBe("just one line");
  });

  it("handles mixed CRLF + literal-\\n payloads (CRLF first makes it multi-line, rescue skipped)", () => {
    const md = "# Title\r\nliteral \\n stays";
    expect(normalizeDocMarkdown(md)).toBe("# Title\nliteral \\n stays");
  });
});
