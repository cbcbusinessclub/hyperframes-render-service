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

app.use((req, res, next) => {
  if (!API_KEY) return next();
  const key = req.get("x-api-key") || req.query.key;
  if (key === API_KEY) return next();
  res.status(401).json({ error: "unauthorized: missing or wrong x-api-key" });
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8">
<title>HyperFrames Render Service</title>
<body style="font-family:system-ui;max-width:760px;margin:40px auto;line-height:1.5">
<h1>HyperFrames Render Service</h1>
<p>Convierte composiciones HTML de HyperFrames en vídeos MP4 vía HTTP.</p>
<h3>Endpoints</h3>
<pre>
POST /render          { "template": "launch", "params": { ... }, "sync": true }
                      o { "html": "&lt;composición HyperFrames completa&gt;" }
GET  /jobs/:id        estado del job
GET  /videos/:f.mp4   descarga del MP4
GET  /health          liveness
</pre>
<h3>Plantillas disponibles</h3>
<pre>${listTemplates().join("\n") || "(ninguna)"}</pre>
<h3>Ejemplo</h3>
<pre>curl -X POST $HOST/render -H "content-type: application/json" -H "x-api-key: $KEY" \\
  -d '{"template":"launch","sync":true,"params":{
    "KICKER":"NUEVO LANZAMIENTO","TITLE":"AgentHub","TAGLINE":"Tu empresa, operada por agentes IA",
    "CHIP1":"63 agentes","CHIP2":"11 departamentos","CHIP3":"8 workflows",
    "CTA":"agenthub.ai","ACCENT":"#6366f1"}}'</pre>
</body>`);
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

app.use("/videos", express.static(VIDEOS_DIR, { maxAge: "365d", immutable: true }));

app.listen(PORT, () => {
  console.log(`[hyperframes-render-service] listening on :${PORT}`);
  console.log(`[hyperframes-render-service] cli=${CLI} data=${DATA_DIR} concurrency=${CONCURRENCY} auth=${API_KEY ? "on" : "OFF"}`);
});
