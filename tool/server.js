import express from "express";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BRAND = process.env.BRAND || "hyundai";
const BRAND_DIR = path.join(ROOT, "data", BRAND);
const WORK = path.join(BRAND_DIR, "work");
const PORT = Number(process.env.PORT) || 3847;

const app = express();
app.use(express.json({ limit: "60mb" }));
app.use(express.static(path.join(import.meta.dirname, "public")));
app.use("/src", express.static(path.join(BRAND_DIR, "src")));
app.use("/work", express.static(WORK, { etag: false, maxAge: 0 }));

const readJson = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
};
const exists = (file) => fs.access(file).then(() => true, () => false);

async function products() {
  return readJson(path.join(BRAND_DIR, "products.json"), []);
}

function image(value, mime) {
  const prefix = `data:${mime};base64,`;
  return typeof value === "string" && value.startsWith(prefix) ? Buffer.from(value.slice(prefix.length), "base64") : null;
}

app.get("/api/products", async (_req, res) => {
  const list = await products();
  res.json(await Promise.all(list.map(async (p) => {
    const dir = path.join(WORK, p.key);
    return {
      ...p,
      state: await readJson(path.join(dir, "state.json"), null),
      done: (await Promise.all(["satin.jpg", "gloss.jpg", "diagram.png"].map((f) => exists(path.join(dir, f))))).every(Boolean),
    };
  })));
});

app.post("/api/state/:key", async (req, res) => {
  const p = (await products()).find((x) => x.key === req.params.key);
  if (!p) return res.status(404).json({ error: "Unknown product" });
  const { points, roundness, closed } = req.body ?? {};
  if (!Array.isArray(points) || !points.every((q) => Number.isFinite(q?.x) && Number.isFinite(q?.y)) ||
      !Number.isFinite(roundness) || typeof closed !== "boolean") {
    return res.status(400).json({ error: "Invalid state" });
  }
  const dir = path.join(WORK, p.key);
  await fs.mkdir(dir, { recursive: true });
  const outputs = [["satin.jpg", image(req.body.satin, "image/jpeg")],
                   ["gloss.jpg", image(req.body.gloss, "image/jpeg")],
                   ["diagram.png", image(req.body.diagram, "image/png")]];
  if (closed && outputs.some(([, buf]) => !buf)) return res.status(400).json({ error: "Closed contour needs all three images" });
  await Promise.all(outputs.filter(([, buf]) => buf).map(([name, buf]) => fs.writeFile(path.join(dir, name), buf)));
  if (!closed) await Promise.all(outputs.map(([name]) => fs.rm(path.join(dir, name), { force: true })));
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ points, roundness, closed }), "utf8");
  res.json({ saved: true });
});

app.post("/api/source/:key", async (req, res) => {
  const list = await products();
  const p = list.find((x) => x.key === req.params.key);
  if (!p) return res.status(404).json({ error: "Unknown product" });
  const buf = image(req.body?.image, "image/jpeg");
  if (!buf) return res.status(400).json({ error: "JPEG data URL required" });
  const src = path.join(BRAND_DIR, "src");
  const name = `${p.key}.jpg`;
  await fs.mkdir(path.join(src, "_prev"), { recursive: true });
  if (p.source && await exists(path.join(src, p.source))) {
    await fs.copyFile(path.join(src, p.source), path.join(src, "_prev", `${Date.now()}-${p.source}`));
  }
  await fs.writeFile(path.join(src, name), buf);
  p.source = name;
  await fs.writeFile(path.join(BRAND_DIR, "products.json"), JSON.stringify(list, null, 2), "utf8");
  res.json({ source: name });
});

app.listen(PORT, () => console.log(`Tool folii: http://localhost:${PORT}  (${BRAND})`));
