import fs from "fs";
import path from "path";
import archiver from "archiver";

const outDir = "release";
const inputDir = "dist";
const outFile = path.join(outDir, "GSVR.zip");

fs.mkdirSync(outDir, { recursive: true });

const output = fs.createWriteStream(outFile);
const archive = archiver("zip", { zlib: { level: 9 } });

archive.pipe(output);
archive.directory(inputDir, false);
await archive.finalize();

output.on("close", () => {
  console.log(`Created ${outFile} (${archive.pointer()} bytes)`);
});
