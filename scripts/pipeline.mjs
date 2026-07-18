// pipeline.mjs — grid -> matrix -> embedding, in order.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
for (const step of ["generateGrid.mjs", "fetchMatrix.mjs", "embed.mjs"]) {
  execFileSync("node", [path.join(here, step)], { stdio: "inherit" });
}
