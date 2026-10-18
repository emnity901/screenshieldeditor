// Uploads gloss, satin and diagram images and sets prices on the matching Shopify products.
//   npm run upload                 dry run: shows what would be uploaded
//   npm run upload -- --go         uploads for real (products stay as they are, e.g. DRAFT)
//   npm run upload -- --go --only hyundai-i30-navigatie
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BRAND = process.env.BRAND || "hyundai";
const STORE = "zgybes-mn.myshopify.com";
const TMP = path.join(ROOT, "data", "tmp-upload");
const args = process.argv.slice(2);
const go = args.includes("--go");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

// Same convention as the existing catalog: 01 Optical Clear (lucios), 02 Satin diffuse, then the diagram.
const IMAGES = [
  { file: "gloss.jpg", mime: "image/jpeg", label: "lucios", alt: "Optical Clear", slug: "optical-clear" },
  { file: "satin.jpg", mime: "image/jpeg", label: "satin", alt: "Satin diffuse", slug: "satin-diffuse" },
  { file: "diagram.png", mime: "image/png", label: "diagramă", alt: "Diagramă tehnică ScreenShield", slug: "diagrama-tehnica" },
];
const GLOSS_DISCOUNT = 10; // price in products.json is the Mat price; Lucios is 10 lei cheaper

async function gql(query, variables, mutation = false) {
  await fs.mkdir(TMP, { recursive: true });
  const q = path.join(TMP, "q.graphql"), v = path.join(TMP, "v.json"), o = path.join(TMP, "out.json");
  await Promise.all([fs.writeFile(q, query), fs.writeFile(v, JSON.stringify(variables ?? {})), fs.rm(o, { force: true })]);
  const cmd = ["store", "execute", "-s", STORE, "--no-input", "--query-file", q, "--variable-file", v, "--output-file", o];
  if (mutation) cmd.push("--allow-mutations");
  execFileSync("shopify", cmd, { stdio: ["ignore", "ignore", "inherit"], shell: true });
  return JSON.parse(await fs.readFile(o, "utf8"));
}

async function stage(file, mime, filename) {
  const data = await gql(`mutation($input:[StagedUploadInput!]!){ stagedUploadsCreate(input:$input){
      stagedTargets{ url resourceUrl parameters{ name value } } userErrors{ field message } } }`,
    { input: [{ filename, mimeType: mime, resource: "IMAGE", httpMethod: "POST" }] }, true);
  const res = data.stagedUploadsCreate;
  if (res.userErrors.length) throw new Error(JSON.stringify(res.userErrors));
  const t = res.stagedTargets[0];
  const form = new FormData();
  t.parameters.forEach((p) => form.append(p.name, p.value));
  form.append("file", new Blob([await fs.readFile(file)], { type: mime }), filename);
  const r = await fetch(t.url, { method: "POST", body: form });
  if (!r.ok) throw new Error(`Staged upload failed: ${r.status} ${await r.text()}`);
  return t.resourceUrl;
}

const products = JSON.parse(await fs.readFile(path.join(ROOT, "data", BRAND, "products.json"), "utf8"));
const slug = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const MAT = "Mat (anti-amprente & zgârieturi)", LUCIOS = "Lucios (anti-zgârieturi)";

// Creates a new DRAFT product shaped like the existing catalog ones (Finisaj option, custom.make/model/generation).
async function createProduct(p, dir) {
  const open = p.generation.endsWith("+");
  const gen = open ? p.generation.replace("+", " -") : p.generation.replace(/\s*[–-]\s*/, " - ");
  const shownGen = open ? p.generation : gen;
  const kind = /ceasuri/i.test(p.screen) ? "ceasuri digitale" : "navigație";
  const title = `Folie de protecție ${kind} ${p.brand.toUpperCase()} ${p.model}` + (p.size ? ` - ${p.size.replace(",", ".")}“` : ` ${p.generation}`);
  const handle = `folie-protectie-screenshield-${slug(p.model)}-${/ceasuri/i.test(p.screen) ? "cluster" : "navigation"}-${slug(p.generation.replace("+", ""))}`;
  const model = `${p.brand}-${p.model}`.toUpperCase().replace(/\s+/g, "-");
  const files = [];
  for (const [n, i] of IMAGES.entries()) {
    const name = `${p.key}-${i.slug}${path.extname(i.file)}`;
    files.push({ originalSource: await stage(path.join(dir, i.file), i.mime, name), contentType: "IMAGE", filename: name,
                 alt: `SSGallery|${model}|${String(n + 1).padStart(2, "0")}|${i.alt}` });
  }
  const meta = (key, value) => ({ namespace: "custom", key, type: "single_line_text_field", value });
  const variant = (name, price) => ({ optionValues: [{ optionName: "Finisaj", name }], price: price.toFixed(2), taxable: true, inventoryPolicy: "DENY" });
  const out = await gql(`mutation($input:ProductSetInput!){ productSet(input:$input, synchronous:true){
      product{ id handle } userErrors{ field message code } } }`, { input: {
    title, handle, vendor: "ScreenShield", productType: "Folie protectie auto", status: "DRAFT",
    descriptionHtml: `<p>Folie de protecție ScreenShield pentru ${p.brand.toUpperCase()} ${p.model}, generația ${shownGen}. Disponibilă în finisajele Lucios (anti-zgârieturi) și Mat (anti-amprente &amp; zgârieturi).</p>`,
    tags: [gen, p.brand.toUpperCase(), p.model, /ceasuri/i.test(p.screen) ? "tip-cluster" : "tip-display"],
    productOptions: [{ name: "Finisaj", values: [{ name: LUCIOS }, { name: MAT }] }],
    variants: [variant(LUCIOS, p.price - GLOSS_DISCOUNT), variant(MAT, p.price)],
    metafields: [meta("make", p.brand.toUpperCase()), meta("model", p.model), meta("generation", gen)],
    files } }, true);
  const res = out.productSet;
  if (res.userErrors.length) throw new Error(JSON.stringify(res.userErrors));
  return { id: res.product.id.split("/").pop(), handle: res.product.handle, title };
}

let failed = 0;
for (const p of products.filter((x) => !only || x.key === only)) {
  const dir = path.join(ROOT, "data", BRAND, "work", p.key);
  const missing = [];
  for (const i of IMAGES) await fs.access(path.join(dir, i.file)).catch(() => missing.push(i.file));
  if (missing.length) { console.log(`- ${p.key}: sărit (lipsește ${missing.join(", ")})`); continue; }

  if (!p.productId) {
    if (!p.price) { console.log(`- ${p.key}: sărit (fără preț)`); continue; }
    const ro = `Lucios ${p.price - GLOSS_DISCOUNT} / Mat ${p.price}`;
    if (!go) { console.log(`+ ${p.key}: ar CREA produs DRAFT nou, cu 3 imagini, ${ro}`); continue; }
    try {
      const made = await createProduct(p, dir);
      p.productId = Number(made.id); p.handle = made.handle;
      await fs.writeFile(path.join(ROOT, "data", BRAND, "products.json"), JSON.stringify(products, null, 2), "utf8");
      console.log(`✓ ${p.key}: creat „${made.title}” (DRAFT), 3 imagini, ${ro}`);
    } catch (e) { failed++; console.log(`✗ ${p.key}: ${e.message}`); }
    continue;
  }
  const gid = `gid://shopify/Product/${p.productId}`;
  const cur = await gql(`query($id:ID!){ product(id:$id){ title status mediaCount{ count }
      variants(first:10){ nodes{ id title price } } } }`, { id: gid });
  if (!cur.product) { console.log(`- ${p.key}: produsul ${p.productId} nu există în Shopify`); failed++; continue; }
  const wanted = (v) => (v.title.startsWith("Mat") ? p.price : v.title.startsWith("Lucios") ? p.price - GLOSS_DISCOUNT : null);
  const priceFixes = cur.product.variants.nodes.filter((v) => wanted(v) !== null && Number(v.price) !== wanted(v));
  const hasMedia = cur.product.mediaCount.count > 0;
  const prices = cur.product.variants.nodes.map((v) => `${v.title.split(" ")[0]} ${wanted(v)}`).join(" / ");
  if (!go) {
    console.log(`+ ${p.key}: „${cur.product.title}” (${cur.product.status})`);
    console.log(`    imagini: ${hasMedia ? `sărite (are deja ${cur.product.mediaCount.count})` : IMAGES.map((i) => i.label).join(", ")}`);
    console.log(`    prețuri: ${prices}${priceFixes.length ? "" : " (deja corecte)"}`);
    continue;
  }

  try {
    if (!hasMedia) {
      const model = `${p.brand}-${p.model}`.toUpperCase().replace(/\s+/g, "-");
      const media = [];
      for (const [n, i] of IMAGES.entries()) {
        const name = `${p.key}-${i.slug}${path.extname(i.file)}`;
        media.push({ originalSource: await stage(path.join(dir, i.file), i.mime, name), mediaContentType: "IMAGE",
                     alt: `SSGallery|${model}|${String(n + 1).padStart(2, "0")}|${i.alt}` });
      }
      const out = await gql(`mutation($product:ProductUpdateInput!,$media:[CreateMediaInput!]){
          productUpdate(product:$product, media:$media){ product{ id } userErrors{ field message } } }`,
        { product: { id: gid }, media }, true);
      if (out.productUpdate.userErrors.length) throw new Error(JSON.stringify(out.productUpdate.userErrors));
    }
    if (priceFixes.length) {
      const out = await gql(`mutation($id:ID!,$variants:[ProductVariantsBulkInput!]!){
          productVariantsBulkUpdate(productId:$id, variants:$variants){ userErrors{ field message } } }`,
        { id: gid, variants: priceFixes.map((v) => ({ id: v.id, price: wanted(v).toFixed(2) })) }, true);
      if (out.productVariantsBulkUpdate.userErrors.length) throw new Error(JSON.stringify(out.productVariantsBulkUpdate.userErrors));
    }
    console.log(`✓ ${p.key}: ${hasMedia ? "imagini existente" : "3 imagini urcate"}, prețuri ${prices} (${cur.product.status})`);
  } catch (e) {
    failed++;
    console.log(`✗ ${p.key}: ${e.message}`);
  }
}
await fs.rm(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
