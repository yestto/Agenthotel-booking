import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distRoot = resolve(projectRoot, "dist");
const [page, workerTemplate] = await Promise.all([
  readFile(resolve(projectRoot, "src/index.html"), "utf8"),
  readFile(resolve(projectRoot, "worker/index.js"), "utf8"),
]);

const placeholder = '"__STAYPILOT_PAGE__"';
if (!workerTemplate.includes(placeholder)) {
  throw new Error("Worker page placeholder is missing");
}

await rm(distRoot, { recursive: true, force: true });
await mkdir(resolve(distRoot, "server"), { recursive: true });
await mkdir(resolve(distRoot, ".openai"), { recursive: true });
await Promise.all([
  writeFile(resolve(distRoot, "server/index.js"), workerTemplate.replace(placeholder, JSON.stringify(page))),
  cp(resolve(projectRoot, ".openai/hosting.json"), resolve(distRoot, ".openai/hosting.json")),
]);

console.log(`Built ${distRoot}`);
