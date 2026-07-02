import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const opts = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2020",
  platform: "browser", // ignis runs Obsidian in the browser — no Node builtins
  external: ["obsidian", "electron"],
  sourcemap: "inline",
  logLevel: "info",
  outfile: "main.js",
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log("watching…");
} else {
  await esbuild.build(opts);
}
