// API HTTP del chat + front estático. El ciclo vive en src/agent, las herramientas en src/tools.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { z } from "zod"
import { ProveedorAnthropic } from "./llm/anthropic.js"
import type { ProveedorLLM } from "./llm/adapter.js"
import { ejecutarTurno, type ConfigCiclo } from "./agent/ciclo.js"
import { AlmacenSesiones, ID_VALIDO } from "./agent/sesiones.js"
import { rutas } from "./tools/comun.js"

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const env = (k: string, def: string) => process.env[k] ?? def

function crearLLM(): ProveedorLLM | null {
  const proveedor = env("LLM_PROVIDER", "anthropic")
  const clave = process.env.ANTHROPIC_API_KEY
  if (proveedor === "anthropic" && clave) {
    return new ProveedorAnthropic(env("LLM_MODEL", "claude-opus-5-5"), clave, Number(env("LLM_TIMEOUT_MS", "60000")))
  }
  console.warn(`[aviso] LLM no configurado (proveedor=${proveedor}). El chat responderá con un aviso.`)
  return null
}

async function cargarSistema(): Promise<string> {
  const [prompt, conocimiento] = await Promise.all([
    readFile(path.join(raiz, "agent", "prompt.md"), "utf8"),
    readFile(path.join(raiz, "src", "knowledge", "registro-contratos.md"), "utf8"),
  ])
  return `${prompt}\n\n---\n\n# Conocimiento de referencia\n\n${conocimiento}`
}

const cfg: ConfigCiclo = {
  llm: crearLLM(),
  sistema: await cargarSistema(),
  directorio: raiz,
  maxIteraciones: Number(env("MAX_ITERACIONES", "25")),
  maxTokensSesion: Number(env("MAX_TOKENS_SESION", "400000")),
}
const sesiones = new AlmacenSesiones(path.join(rutas({ directory: raiz, sessionId: "" }).out, "sesiones"))
const app = new Hono()

const cuerpoChat = z.object({
  sessionId: z.string().regex(ID_VALIDO).nullish(),
  message: z.string().trim().min(1).max(4000),
})

app.post("/api/chat", async (c) => {
  const body = cuerpoChat.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: "Cuerpo inválido: se espera { sessionId?, message } con un mensaje de 1 a 4000 caracteres." }, 400)
  const sesion = await sesiones.obtener(body.data.sessionId ?? randomUUID())
  if (sesion.ocupada) return c.json({ error: "La sesión está procesando otro mensaje. Espera a que termine." }, 409)
  sesion.ocupada = true
  try {
    const r = await ejecutarTurno(sesion, body.data.message, cfg)
    return c.json({ sessionId: sesion.id, ...r })
  } finally {
    sesion.ocupada = false
    await sesiones.guardar(sesion)
  }
})

app.get("/api/sessions/:id", async (c) => {
  const id = c.req.param("id")
  if (!ID_VALIDO.test(id)) return c.json({ error: "id inválido" }, 400)
  const s = await sesiones.buscar(id)
  if (!s) return c.json({ error: "sesión no encontrada" }, 404)
  return c.json({ id: s.id, historial: s.vista, tokens: s.tokens, esperandoConfirmacion: s.esperandoConfirmacion })
})

app.get("/api/health", (c) =>
  c.json({ ok: true, provider: cfg.llm?.nombre ?? "sin configurar", model: cfg.llm?.modelo ?? null, maxIteraciones: cfg.maxIteraciones }),
)

// Descarga de archivos generados (solo dentro de out/, sin sesiones).
app.get("/api/archivos/*", async (c) => {
  const out = rutas({ directory: raiz, sessionId: "" }).out
  const relativo = decodeURIComponent(c.req.path.replace(/^\/api\/archivos\//, ""))
  const archivo = path.resolve(out, relativo)
  if (!archivo.startsWith(out + path.sep) || relativo.startsWith("sesiones/") || relativo.includes("..")) return c.json({ error: "ruta no permitida" }, 403)
  try {
    const datos = await readFile(archivo)
    const tipo = /\.(md|csv|txt|jsonl)$/.test(archivo) ? "text/plain; charset=utf-8" : "application/octet-stream"
    return c.body(datos, 200, { "Content-Type": tipo, "Content-Disposition": `inline; filename="${path.basename(archivo)}"` })
  } catch {
    return c.json({ error: "archivo no encontrado" }, 404)
  }
})

app.get("/", async (c) => c.html(await readFile(path.join(raiz, "web", "index.html"), "utf8")))

const port = Number(env("PORT", "3000"))
serve({ fetch: app.fetch, port }, () => {
  console.log(`Agente de registro de contratos en http://localhost:${port} · modelo: ${cfg.llm?.modelo ?? "sin configurar"}`)
})
