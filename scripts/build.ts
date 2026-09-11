import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const result = await Bun.build({ entrypoints: ["src/web/client.ts"], outdir: "dist", naming: "client.js", minify: true, target: "browser" });
if (!result.success) { console.error(result.logs); process.exit(1); }
await copyFile("src/web/style.css", "dist/style.css");
await copyFile("src/web/favicon.svg", "dist/favicon.svg");
console.log("Built browser assets");
