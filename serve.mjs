// serve.mjs — minimal static file server for local preview. No dependencies.
// Usage: npm run serve  → http://localhost:5173
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve public/ relative to this file so it works from any cwd.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "public");
const PORT = process.env.PORT || 5173;
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
};

createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split("?")[0]);
  if (path === "/") path = "/index.html";
  const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ""));
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}).listen(PORT, () => console.log(`AI Repo Radar → http://localhost:${PORT}`));
