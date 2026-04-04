import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli/index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node20",
  splitting: false,
  outDir: "dist",
  // tsx uses CJS require("fs") internally — must stay external to avoid
  // "Dynamic require of fs is not supported" in the ESM bundle.
  external: ["tsx"],
});
