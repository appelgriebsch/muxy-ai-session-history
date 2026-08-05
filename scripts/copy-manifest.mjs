import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const distScripts = resolve(dist, "scripts");

await mkdir(dist, { recursive: true });
await mkdir(distScripts, { recursive: true });
await copyFile(resolve(root, "package.json"), resolve(dist, "package.json"));
await copyFile(
  resolve(root, "scripts/scan-sessions.py"),
  resolve(distScripts, "scan-sessions.py"),
);

const scanner = await readFile(resolve(root, "scripts/scan-sessions.py"), "utf8");
const b64 = Buffer.from(scanner, "utf8").toString("base64");
const pickerSrc = await readFile(resolve(root, "scripts/resume-picker.js"), "utf8");
const pickerOut = pickerSrc.replaceAll("__SCANNER_SOURCE_B64__", b64);
await writeFile(resolve(distScripts, "resume-picker.js"), pickerOut, "utf8");
// Load Unpacked from project root resolves scripts from the package root.
await writeFile(resolve(root, "scripts/resume-picker.built.js"), pickerOut, "utf8");
// Keep dist path consistent with package.json script entry for published installs.
await writeFile(resolve(distScripts, "resume-picker.built.js"), pickerOut, "utf8");
