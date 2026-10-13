import { defineConfig } from "vitest/config";

// Several tests run the full 24h solver many times (brute-force comparisons, agent what-ifs), and test files run
// in parallel, so the 5s default is too tight on a busy machine. These are CPU-bound, not waiting on I/O.
export default defineConfig({ test: { testTimeout: 30_000 } });
