export interface ParsedCli {
  command: string
  rest: string[]
  flags: Record<string, string | true>
}

/** `job submit --issue STEP-7` -> command job, rest [submit], flags { issue }. A flag with no value is true. */
export function parseCli(argv: string[]): ParsedCli {
  const [command = "", ...tail] = argv
  const rest: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < tail.length; i++) {
    const token = tail[i]
    if (!token.startsWith("--")) {
      rest.push(token)
      continue
    }
    const next = tail[i + 1]
    if (next !== undefined && !next.startsWith("--")) {
      flags[token.slice(2)] = next
      i++
    } else {
      flags[token.slice(2)] = true
    }
  }
  return { command, rest, flags }
}

export class UsageError extends Error {}
