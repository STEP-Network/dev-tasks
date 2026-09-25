/**
 * Where the weekly retro's summary goes besides Slack: Monday, where the
 * people live, once its bridge exists (STEP-3289). Until then nothing, and
 * the retro calls this all the same, so wiring Monday in is one change here.
 */

export interface FyiNote {
  /** One line: what the week came to. */
  title: string
  /** The plain-English summary, as Slack gets it. */
  text: string
  /** The retro's PR, when it opened one. */
  url: string | null
}

export interface FyiChannel {
  post(note: FyiNote): Promise<void>
}

export const noFyi: FyiChannel = { post: async () => {} }

/** The channel this mini has: none until the Monday bridge provides one. */
export function fyiChannel(): FyiChannel {
  return noFyi
}
