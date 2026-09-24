import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/__tests__/**/*.test.ts"],
    // An AGENTD_HOME exported in the shell would point every test's queues at
    // that directory, a live mini's included. Each test makes its own.
    env: { AGENTD_HOME: "" },
  },
})
