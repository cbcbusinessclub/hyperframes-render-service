# HyperFrames Render Service

HyperFrames como **servicio de renderizado**: una API HTTP que convierte composiciones HTML de [HyperFrames](https://github.com/heygen-com/hyperframes) en vídeos MP4 deterministas. Pensado para desplegarse en Render.com con Docker, pero funciona en cualquier host con Docker.

```
   JSON / HTML  ──►  POST /render  ──►  cola  ──►  Chrome headless + FFmpeg  ──►  GET /videos/<id>.mp4
```

## Despliegue en Render.com (5 minutos)

1. Sube esta carpeta a un repositorio de GitHub/GitLab (`git init && git add -A && git commit -m "init" && git push`).
2. En el dashboard de Render: **New + → Blueprint**, selecciona el repo. Render lee `render.yaml` y crea el servicio con su disco persistente y una `API_KEY` autogenerada.
   - Alternativa manual: **New + → Web Service**, runtime **Docker**, añade un disco en `/data` (10 GB) y las variables de entorno `API_KEY` y `RENDER_CONCURRENCY=1`.
3. Espera el primer build (~5-8 min: instala Chromium, FFmpeg, fuentes y chrome-headless-shell).
4. Tu URL queda en `https://hyperframes-render.onrender.com` (o el nombre que elijas).

> **Plan mínimo recomendado: Standard (2 GB RAM).** Chrome headless + FFmpeg no caben cómodamente en el plan Starter, y en el plan Free el servicio se duerme y los renders largos morirían.

## Uso

### Render con plantilla (síncrono — espera el MP4)

```bash
curl -X POST https://TU-SERVICIO.onrender.com/render \
  -H "content-type: application/json" \
  -H "x-api-key: TU_API_KEY" \
  -d '{
    "template": "launch",
    "sync": true,
    "params": {
      "KICKER": "NUEVO LANZAMIENTO",
      "TITLE": "AgentHub",
      "TAGLINE": "Tu empresa, operada por agentes IA",
      "HEADLINE": "Disponible hoy",
      "CHIP1": "63 agentes",
      "CHIP2": "11 departamentos",
      "CHIP3": "8 workflows",
      "CTA": "agenthub.ai",
      "ACCENT": "#6366f1"
    }
  }'
# → { "id": "…", "status": "done", "videoUrl": "/videos/….mp4" }
```

### Render asíncrono (para vídeos largos o lotes)

```bash
# 1. encolar
curl -X POST …/render -H "x-api-key: …" -d '{"template":"launch","params":{…}}'
# → { "id": "abc123", "status": "queued", "poll": "/jobs/abc123" }

# 2. consultar
curl …/jobs/abc123 -H "x-api-key: …"
# → { "status": "rendering" } … { "status": "done", "videoUrl": "/videos/abc123.mp4" }

# 3. descargar
curl -O …/videos/abc123.mp4?key=…
```

### Render con HTML propio (composición HyperFrames completa)

```bash
curl -X POST …/render -H "x-api-key: …" \
  -d "$(jq -n --arg html "$(cat mi-composicion/index.html)" '{html:$html,sync:true}')"
```

La composición debe cumplir el contrato HyperFrames (`data-composition-id`, `data-start="0"`, clips con `class="clip"`, un timeline GSAP pausado en `window.__timelines`). El servicio copia `gsap.min.js` junto a cada job, así que referencia `./gsap.min.js` en el HTML para renders sin red.

## API

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/render` | Encola un render. Body: `{html}` o `{template, params}`, opcional `sync: true`. |
| GET | `/jobs/:id` | Estado del job: `queued` → `rendering` → `done` / `error`. |
| GET | `/videos/:file` | Descarga el MP4 renderizado. |
| GET | `/health` | Liveness (sin auth). |
| GET | `/` | Mini-documentación. |

**Auth:** si la variable de entorno `API_KEY` está definida, todas las rutas salvo `/health` exigen el header `x-api-key` (o `?key=`).

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `API_KEY` | *(vacío = sin auth)* | Clave de acceso a la API. |
| `RENDER_CONCURRENCY` | `1` | Renders simultáneos. Sube solo con más CPU/RAM. |
| `DATA_DIR` | `/data` | Dónde viven jobs y vídeos (monta el disco de Render aquí). |
| `SYNC_TIMEOUT_MS` | `900000` | Máximo que espera una petición `sync`. |
| `RENDER_TIMEOUT_MS` | `1800000` | Máximo por render antes de matarlo. |

## Añadir plantillas

Copia un HTML de composición HyperFrames en `templates/<nombre>.html` usando `{{VARIABLE}}` para texto (se escapa) y `{{{VARIABLE}}}` para valores raw como colores. Aparece automáticamente en `GET /` y se usa con `{"template":"<nombre>"}`.

## Desarrollo local

```bash
npm install
PORT=8787 DATA_DIR=./data node server.js
# requiere Chrome/Chromium y FFmpeg locales (hyperframes doctor los verifica)
```

## Licencias

HyperFrames es Apache 2.0 (HeyGen). Este servicio es un envoltorio fino sobre su CLI.
