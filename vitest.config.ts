import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    // `tests/` is not shipped with every checkout (it is excluded from the npm
    // tarball), so `npm test` on a fresh install exited 1 with "No test files
    // found" — indistinguishable from a genuinely failing suite, which is the
    // worst possible default for CI. Absent suite must be distinguishable from
    // a BROKEN one.
    passWithNoTests: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
