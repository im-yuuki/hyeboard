import fs from "node:fs";
import path from "node:path";

const distDir = path.resolve(process.argv[2] ?? "apps/web/dist");
if (!fs.existsSync(distDir))
  throw new Error(`Missing build directory: ${distDir}`);

const assets = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else assets.push({ file, bytes: fs.statSync(file).size });
  }
}
walk(distDir);
const jsAssets = assets.filter(({ file }) => file.endsWith(".js"));
const entry =
  jsAssets.find(({ file }) => /(^|[\\/])index-[^/]+\.js$/.test(file)) ??
  jsAssets.sort((a, b) => b.bytes - a.bytes)[0];
const pdfBytes = jsAssets
  .filter(({ file }) => /pdfmake/i.test(file))
  .reduce((sum, asset) => sum + asset.bytes, 0);
const vfsBytes = jsAssets
  .filter(({ file }) => /vfs_fonts/i.test(file))
  .reduce((sum, asset) => sum + asset.bytes, 0);
const entryText = entry ? fs.readFileSync(entry.file, "utf8") : "";
const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
console.log(`WEB_BUNDLE_TOTAL_BYTES=${totalBytes}`);
console.log(`WEB_ENTRY_BYTES=${entry?.bytes ?? 0}`);
console.log(`WEB_PDF_BYTES=${pdfBytes}`);
console.log(`WEB_VFS_BYTES=${vfsBytes}`);
console.log(
  `WEB_ENTRY_PDF_MARKERS=${/pdfmake|vfs_fonts/i.test(entryText) ? 1 : 0}`,
);
for (const asset of assets.sort((a, b) => b.bytes - a.bytes).slice(0, 10))
  console.log(
    `WEB_ASSET=${asset.bytes} ${path.relative(process.cwd(), asset.file)}`,
  );
