// serve.mjs — tiny static server so the viewer can fetch ../data.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const types = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript" };

http
  .createServer((req, res) => {
    const url = req.url === "/" ? "/viewer/index.html" : req.url;
    const file = path.join(root, path.normalize(url).replace(/^\/+/, ""));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(8642, () => console.log("viewer: http://localhost:8642"));
