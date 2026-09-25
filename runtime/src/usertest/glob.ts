/**
 * Glob matching for changed paths: `**` across folders, `*` and `?` within
 * one, and nothing else. Brackets are literal, because the projects' routes
 * are spelt with them (`app/[locale]/...`) and a character class would match
 * nothing there. The same rules as PolAds's lib/ci/screenshot-routes.ts.
 */
export function globToRegExp(glob: string): RegExp {
  let out = ""
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?"
        i += 2
      } else {
        out += ".*"
        i += 1
      }
    } else if (ch === "*") out += "[^/]*"
    else if (ch === "?") out += "[^/]"
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${out}$`)
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path))
}
