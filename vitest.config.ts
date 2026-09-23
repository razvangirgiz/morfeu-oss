import { defineConfig } from "vitest/config";

// Every test sees fake providers and never the user's config file: the
// config loader only reads a file for the real process environment.
const env = {
  MORFEU_LLM_PROVIDER: "fake",
  MORFEU_EMBEDDING_PROVIDER: "fake",
  MORFEU_USER_ID: "alex",
  MORFEU_LOG_LEVEL: "error",
  MORFEU_CONFIG_FILE: "",
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          env,
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          globalSetup: ["test/support/global-setup.ts"],
          setupFiles: ["test/support/setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          env,
        },
      },
    ],
  },
});
