import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { agentManifest, TEMPLATE_PATH } from "../manifest.ts"

const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"))

describe("agentManifest", () => {
  it("names the app and its bot after the agent, and changes nothing else", () => {
    const eve = agentManifest("eve")
    expect(eve.display_information.name).toBe("PolAds Eve")
    expect(eve.features.bot_user.display_name).toBe("eve")
    const unnamed = (m: typeof template) => ({
      ...m,
      display_information: { ...m.display_information, name: null },
      features: { ...m.features, bot_user: { ...m.features.bot_user, display_name: null } },
    })
    expect(unnamed(eve)).toEqual(unnamed(template))
    expect(JSON.stringify(eve)).not.toContain("{{")
  })

  it("keeps the plan's scopes and events, over Socket Mode", () => {
    const eve = agentManifest("eve")
    expect(eve.oauth_config).toEqual({
      scopes: {
        bot: ["app_mentions:read", "channels:history", "channels:read", "chat:write", "reactions:read", "reactions:write", "users:read", "files:read", "files:write"],
      },
    })
    expect(eve.settings).toMatchObject({
      event_subscriptions: { bot_events: ["app_mention", "message.channels", "reaction_added"] },
      socket_mode_enabled: true,
    })
  })

  it("refuses a name that is not a mini's, or that Slack would cut", () => {
    for (const name of ["", "Eve", "eve mini", "3eve"]) expect(() => agentManifest(name)).toThrow(/not a mini's name/)
    expect(() => agentManifest("a".repeat(29))).toThrow(/35 characters/)
    expect(agentManifest("a".repeat(28)).display_information.name).toHaveLength(35)
  })

  it("leaves the template itself without any agent's name", () => {
    expect(template.display_information.name).toBe("PolAds {{Mini}}")
    expect(template.features.bot_user.display_name).toBe("{{mini}}")
  })
})
