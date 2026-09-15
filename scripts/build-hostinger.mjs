import { build } from "esbuild";

await build({
  entryPoints: ["server/hostinger.ts"],
  platform: "node",
  packages: "external",
  bundle: true,
  format: "esm",
  outfile: "dist/hostinger.js",
});
