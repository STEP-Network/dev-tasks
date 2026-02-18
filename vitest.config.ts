import { defineConfig } from "vitest/config";
import path from "path";
import { config } from "dotenv";

// Load .env.local for integration tests
config({ path: path.resolve(__dirname, ".env.local") });

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
