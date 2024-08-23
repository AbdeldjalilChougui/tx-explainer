import { build } from "esbuild";
await build({
  entryPoints: ["src/web.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "web/app.js",
  minify: true,
});
console.log("built web/app.js");
