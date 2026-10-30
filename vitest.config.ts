import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Worktrees under .worktrees/ are separate checkouts with their own tests.
  test: { exclude: [...configDefaults.exclude, ".worktrees/**"] },
});
