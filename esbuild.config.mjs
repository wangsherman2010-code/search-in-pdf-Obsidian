import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const mode = process.argv[2];

if (mode === "test") {
  await esbuild.build({
    entryPoints: ["src/search.test.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outdir: "test-dist",
    logLevel: "info",
  });
  process.exit(0);
}

const prod = mode === "production";
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian", "electron",
    "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands",
    "@codemirror/language", "@codemirror/lint", "@codemirror/search",
    "@codemirror/state", "@codemirror/view",
    "@lezer/common", "@lezer/highlight", "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
