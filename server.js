/**
 * HyperFrames Render Service
 * --------------------------
 * HTTP API that turns HyperFrames HTML compositions (or built-in templates)
 * into deterministic MP4 videos.
 *
 * Endpoints:
 *   GET  /health              → liveness probe
 *   GET  /                    → minimal API docs
 *   POST /render              → queue a render job
 *        body: { html }                          raw HyperFrames composition
 *          or  { template, params }              built-in template + variables
 *        opts: { sync: true }                    wait for the MP4 (default: async)
 *   GET  /jobs/:id            → job status ({ status, videoUrl, error })
 *   GET  /videos/:file        → download the rendered MP4
 *
 * Auth: if the API_KEY env var is set, every request (except /health)
 * must send it as an `x-api-key` header or `?key=` query param.
 */

const express = require("express");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const CONCURRENCY = Math.max(1, parseInt(process.env.RENDER_CONCURRENCY || "1", 10));
const SYNC_TIMEOUT_MS = parseInt(process.env.SYNC_TIMEOUT_MS || "900000", 10); // 15 min
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || "1800000", 10); // 30 min
const MAX_BODY = process.env.MAX_BODY || "5mb";

const JOBS_DIR = path.join(DATA_DIR, "jobs");
const VIDEOS_DIR = path.join(DATA_DIR, "videos");
fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(VIDEOS_DIR, { recursive: true });

/* Resolve the hyperframes CLI: local dependency first, PATH fallback. */
const LOCAL_CLI = path.join(__dirname, "node_modules", ".bin", "hyperframes");
const CLI = fs.existsSync(LOCAL_CLI) ? LOCAL_CLI : "hyperframes";

/* Resolve a local gsap build to copy into each job (offline-safe renders). */
let GSAP_PATH = null;
try {
  GSAP_PATH = require.resolve("gsap/dist/gsap.min.js");
} catch {
  /* optional — templates that don't use GSAP still work */
}

/* ---------------------------------------------------------------- jobs -- */

const jobs = new Map(); // id → { status, error, videoUrl, createdAt, startedAt, finishedAt }
const queue = [];
let running = 0;

function newJobId() {
  return crypto.randomBytes(8).toString("hex");
}

function enqueue(id) {
  queue.push(id);
  pump();
}

function pump() {
  while (running < CONCURRENCY && queue.length > 0) {
    const id = queue.shift();
    running++;
    runJob(id).finally(() => {
      running--;
      pump();
    });
  }
}

async function runJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "rendering";
  job.startedAt = new Date().toISOString();
  const dir = path.join(JOBS_DIR, id);

  try {
    await new Promise((resolve, reject) => {
      execFile(
        CLI,
        ["render"],
        { cwd: dir, timeout: RENDER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, HYPERFRAMES_TELEMETRY: process.env.HYPERFRAMES_TELEMETRY || "0" } },
        (err, stdout, stderr) => {
          if (err) {
            const tail = ((stdout || "") + "\n" + (stderr || "")).split("\n").filter(Boolean).slice(-12).join("\n");
            reject(new Error(tail || err.message));
          } else resolve();
        }
      );
    });

    /* newest mp4 in renders/ is the artifact */
    const rendersDir = path.join(dir, "renders");
    const outputs = fs.existsSync(rendersDir)
      ? fs.readdirSync(rendersDir).filter((f) => f.endsWith(".mp4"))
          .map((f) => ({ f, t: fs.statSync(path.join(rendersDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t)
      : [];
    if (outputs.length === 0) throw new Error("render finished but no MP4 was produced");

    const finalName = `${id}.mp4`;
    fs.copyFileSync(path.join(rendersDir, outputs[0].f), path.join(VIDEOS_DIR, finalName));
    fs.rmSync(dir, { recursive: true, force: true }); // keep only the video

    job.status = "done";
    job.videoUrl = `/videos/${finalName}`;
  } catch (e) {
    job.status = "error";
    job.error = String(e.message || e).slice(0, 4000);
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

function waitForJob(id, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const job = jobs.get(id);
      if (!job) return resolve(null);
      if (job.status === "done" || job.status === "error") return resolve(job);
      if (Date.now() - t0 > timeoutMs) return resolve(job); // still queued/rendering
      setTimeout(tick, 1500);
    };
    tick();
  });
}

/* ----------------------------------------------------------- templates -- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function listTemplates() {
  const dir = path.join(__dirname, "templates");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, ""));
}

const TEMPLATE_DEFAULTS = {
  launch: { ACCENT: "#6366f1", KICKER: "", TITLE: "", TAGLINE: "", HEADLINE: "", CHIP1: "", CHIP2: "", CHIP3: "", CTA: "" },
};

function buildFromTemplate(name, params = {}) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("invalid template name");
  const file = path.join(__dirname, "templates", `${name}.html`);
  if (!fs.existsSync(file)) throw new Error(`unknown template "${name}" (available: ${listTemplates().join(", ")})`);
  params = { ...(TEMPLATE_DEFAULTS[name] || {}), ...params };
  let html = fs.readFileSync(file, "utf8");
  /* {{KEY}} → escaped value; {{{KEY}}} → raw value (colors, css) */
  html = html.replace(/\{\{\{(\w+)\}\}\}/g, (_, k) => (params[k] != null ? String(params[k]) : ""));
  html = html.replace(/\{\{(\w+)\}\}/g, (_, k) => (params[k] != null ? escapeHtml(params[k]) : ""));
  return html;
}

/* ----------------------------------------------------------------- app -- */

const app = express();
app.use(express.json({ limit: MAX_BODY }));

app.get("/health", (_req, res) => res.json({ ok: true, queue: queue.length, running }));

/* ---- public landing page + video downloads (no secrets exposed) ---- */

app.get("/", (_req, res) => {
  const hasDemo = fs.existsSync(path.join(VIDEOS_DIR, "demo.mp4"));
  res.type("html").send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HyperFrames Render Service</title>
<style>
  :root { color-scheme: dark; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:system-ui,-apple-system,sans-serif; background:#0b0f1e; color:#e2e6f5; line-height:1.6; }
  .wrap { max-width:880px; margin:0 auto; padding:48px 24px 80px; }
  .badge { display:inline-block; padding:4px 14px; border-radius:20px; background:rgba(99,102,241,.15); border:1px solid #313c63; color:#8b93ff; font-size:13px; font-weight:600; letter-spacing:2px; }
  h1 { font-size:44px; font-weight:800; letter-spacing:-1px; margin:18px 0 8px; }
  .sub { color:#9aa3b8; font-size:18px; margin-bottom:36px; }
  .ok { color:#86efac; }
  h2 { font-size:22px; margin:42px 0 14px; letter-spacing:-.5px; }
  video { width:100%; border-radius:14px; border:1px solid #232c47; box-shadow:0 30px 70px rgba(0,0,0,.5); }
  pre { background:#0d1220; border:1px solid #232c47; border-radius:12px; padding:18px 20px; overflow-x:auto; font-size:13.5px; line-height:1.7; color:#c7cee6; }
  code { color:#7dd3fc; }
  table { width:100%; border-collapse:collapse; font-size:15px; }
  td, th { text-align:left; padding:10px 12px; border-bottom:1px solid #1c2440; }
  th { color:#8b93ff; font-size:13px; letter-spacing:1px; text-transform:uppercase; }
  .muted { color:#9aa3b8; }
  a { color:#8b93ff; }
</style></head><body><div class="wrap">
<span class="badge">HYPERFRAMES · RENDER SERVICE</span>
<h1>V&iacute;deo hecho con c&oacute;digo</h1>
<p class="sub">API HTTP que convierte composiciones HTML en v&iacute;deos MP4 deterministas.
Estado: <b class="ok">&#9679; operativo</b> &middot; Chrome headless + FFmpeg &middot; plantillas: ${listTemplates().join(", ") || "&mdash;"}</p>
${hasDemo
  ? `<h2>Demo generada por este servidor</h2>
<video controls muted playsinline preload="metadata" src="/videos/demo.mp4"></video>
<p class="muted" style="margin-top:10px">Este v&iacute;deo se gener&oacute; autom&aacute;ticamente aqu&iacute; con la plantilla <code>launch</code>.</p>`
  : `<h2>Demo</h2><p class="muted">El v&iacute;deo de demostraci&oacute;n se est&aacute; generando (~1 min tras el arranque)&hellip; recarga en un momento.</p>`}
<h2>Endpoints</h2>
<table>
<tr><th>M&eacute;todo</th><th>Ruta</th><th>Descripci&oacute;n</th><th>Auth</th></tr>
<tr><td>POST</td><td><code>/render</code></td><td>Genera un v&iacute;deo (plantilla + params, o HTML propio)</td><td>x-api-key</td></tr>
<tr><td>GET</td><td><code>/jobs/:id</code></td><td>Estado del job</td><td>x-api-key</td></tr>
<tr><td>GET</td><td><code>/videos/:f.mp4</code></td><td>Descarga del MP4</td><td class="muted">p&uacute;blico</td></tr>
<tr><td>GET</td><td><code>/health</code></td><td>Liveness</td><td class="muted">p&uacute;blico</td></tr>
</table>
<h2>Ejemplo</h2>
<pre>curl -X POST ${"https://hyperframes-render.onrender.com"}/render \\
  -H "content-type: application/json" -H "x-api-key: TU_CLAVE" \\
  -d '{"template":"launch","sync":true,"params":{
    "KICKER":"NUEVO LANZAMIENTO","TITLE":"Tu producto",
    "TAGLINE":"Tu mensaje aquí","HEADLINE":"Disponible hoy",
    "CHIP1":"Rápido","CHIP2":"Determinista","CHIP3":"Open source",
    "CTA":"tu-dominio.com","ACCENT":"#6366f1"}}'</pre>
<p class="muted" style="margin-top:28px">Basado en <a href="https://github.com/heygen-com/hyperframes">HyperFrames</a> (Apache 2.0) &middot;
c&oacute;digo del servicio en <a href="https://github.com/cbcbusinessclub/hyperframes-render-service">GitHub</a></p>
</div></body></html>`);
});

app.use("/videos", express.static(VIDEOS_DIR, { maxAge: "365d", immutable: true }));

/* ---- everything below requires the API key ---- */

app.use((req, res, next) => {
  if (!API_KEY) return next();
  const key = req.get("x-api-key") || req.query.key;
  if (key === API_KEY) return next();
  res.status(401).json({ error: "unauthorized: missing or wrong x-api-key" });
});

app.post("/render", async (req, res) => {
  try {
    const { html, template, params, sync } = req.body || {};
    let composition;
    if (typeof html === "string" && html.trim()) {
      composition = html;
    } else if (typeof template === "string" && template.trim()) {
      composition = buildFromTemplate(template.trim(), params || {});
    } else {
      return res.status(400).json({ error: 'provide "html" (raw composition) or "template" + "params"' });
    }
    if (!composition.includes("data-composition-id")) {
      return res.status(400).json({ error: "not a HyperFrames composition: missing data-composition-id" });
    }

    const id = newJobId();
    const dir = path.join(JOBS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), composition, "utf8");
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, name: id }), "utf8");
    if (GSAP_PATH) fs.copyFileSync(GSAP_PATH, path.join(dir, "gsap.min.js"));

    jobs.set(id, { status: "queued", createdAt: new Date().toISOString() });
    enqueue(id);

    if (sync) {
      const job = await waitForJob(id, SYNC_TIMEOUT_MS);
      const code = job.status === "done" ? 200 : job.status === "error" ? 500 : 202;
      return res.status(code).json({ id, ...job });
    }
    res.status(202).json({ id, status: "queued", poll: `/jobs/${id}` });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json({ id: req.params.id, ...job });
});

/* ---- self-generating demo video for the landing page ---- */

async function bootstrapDemo() {
  const demoPath = path.join(VIDEOS_DIR, "demo.mp4");
  if (fs.existsSync(demoPath)) return;
  try {
    const composition = buildFromTemplate("launch", {
      KICKER: "SERVICIO DE RENDERIZADO",
      TITLE: "HyperFrames API",
      TAGLINE: "Manda un JSON. Recibe un vídeo.",
      HEADLINE: "Así funciona",
      CHIP1: "HTTP → MP4",
      CHIP2: "1080p · 30fps",
      CHIP3: "Determinista",
      CTA: "POST /render",
      ACCENT: "#6366f1",
    });
    const id = "demo-" + newJobId();
    const dir = path.join(JOBS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), composition, "utf8");
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, name: id }), "utf8");
    if (GSAP_PATH) fs.copyFileSync(GSAP_PATH, path.join(dir, "gsap.min.js"));
    jobs.set(id, { status: "queued", createdAt: new Date().toISOString() });
    enqueue(id);
    const job = await waitForJob(id, RENDER_TIMEOUT_MS);
    if (job && job.status === "done") {
      fs.copyFileSync(path.join(VIDEOS_DIR, `${id}.mp4`), demoPath);
      console.log("[hyperframes-render-service] demo video ready at /videos/demo.mp4");
    } else {
      console.log("[hyperframes-render-service] demo bootstrap failed:", job && job.error);
    }
  } catch (e) {
    console.log("[hyperframes-render-service] demo bootstrap error:", e.message);
  }
}

app.listen(PORT, () => {
  console.log(`[hyperframes-render-service] listening on :${PORT}`);
  console.log(`[hyperframes-render-service] cli=${CLI} data=${DATA_DIR} concurrency=${CONCURRENCY} auth=${API_KEY ? "on" : "OFF"}`);
  setTimeout(bootstrapDemo, 3000);
});
