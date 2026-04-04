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
  // esbuild is dynamically imported at runtime for plugin compilation —
  // it must stay external to avoid bundling its platform-specific binary.
  external: ["esbuild"],
});
