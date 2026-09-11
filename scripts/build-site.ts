import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const outputDirectory = new URL("../site/dist/", import.meta.url);
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../site/index.html", import.meta.url))],
  outdir: fileURLToPath(outputDirectory),
  target: "browser",
  minify: true,
});

if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}

await copyFile(new URL("../site/.nojekyll", import.meta.url), new URL(".nojekyll", outputDirectory));
const bytes = result.outputs.reduce((total, output) => total + output.size, 0);
console.log(`Built site/dist: ${result.outputs.length + 1} files, ${(bytes / 1024).toFixed(1)} KiB`);
