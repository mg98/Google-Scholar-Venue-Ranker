import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const outDir = "release";
const inputDir = "dist";
const outFile = path.join(outDir, "GSVR.zip");

if (!fs.existsSync(inputDir)) {
  throw new Error(`Expected build output at ${inputDir}. Run npm run build first.`);
}

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(outFile, { force: true });

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
};

if (process.platform === "win32") {
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Compress-Archive -Path '${inputDir}\\*' -DestinationPath '${outFile}' -Force`,
  ]);
} else {
  run("zip", ["-r", path.resolve(outFile), "."], { cwd: inputDir });
}

const size = fs.statSync(outFile).size;
console.log(`Created ${outFile} (${size} bytes)`);
