// Utilidades compartidas por las herramientas. No exporta herramientas.
import { readFile, mkdir, writeFile, access } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

export interface CtxHerramienta {
  /** Raíz del proyecto. Todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
  /**
   * Lo fija el servidor: true solo si el turno anterior del agente pidió confirmación
   * y el mensaje actual del usuario la da. Sin servidor (demo) queda undefined.
   */
  confirmacionHumana?: boolean
}

export interface Herramienta<S extends z.ZodRawShape> {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: CtxHerramienta): Promise<string>
}

/** Identidad tipada: deja que TypeScript infiera los argumentos desde el esquema zod. */
export function definir<S extends z.ZodRawShape>(h: Herramienta<S>): Herramienta<S> {
  return h
}

export const ok = (data: object): string => JSON.stringify({ ok: true, data })
export const fallo = (error: string, extra: object = {}): string =>
  JSON.stringify({ ok: false, error, ...extra })

export const esquemaMensajeId = z
  .string()
  .regex(/^[a-z0-9-]+$/, "solo minúsculas, números y guiones")
  .describe("Id del mensaje del buzón (carpeta en fixtures/reto-02/buzon/), ej. 'msg-001'")

export const esquemaFecha = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "formato YYYY-MM-DD")

export interface Rutas {
  fixtures: string
  buzon: string
  mensaje: string
  maestroFixture: string
  comerciales: string
  reglas: string
  out: string
  sharepoint: string
  maestro: string
  historial: string
  procesados: string
  alertas: string
}

export function rutas(ctx: CtxHerramienta, mensajeId = ""): Rutas {
  const fixtures = path.join(ctx.directory, "fixtures", "reto-02")
  const outEnv = process.env.OUT_DIR ?? "out"
  const out = path.isAbsolute(outEnv) ? outEnv : path.join(ctx.directory, outEnv)
  const sharepoint = path.join(out, "sharepoint")
  return {
    fixtures,
    buzon: path.join(fixtures, "buzon"),
    mensaje: path.join(fixtures, "buzon", mensajeId),
    maestroFixture: path.join(fixtures, "maestro-contratos.csv"),
    comerciales: path.join(fixtures, "comerciales.json"),
    reglas: path.join(ctx.directory, "src", "knowledge", "reglas-negocio.json"),
    out,
    sharepoint,
    maestro: path.join(sharepoint, "maestro-contratos.csv"),
    historial: path.join(sharepoint, "historial.jsonl"),
    procesados: path.join(out, "procesados.json"),
    alertas: path.join(out, "alertas.md"),
  }
}

export type Lectura<T> = { ok: true; valor: T } | { ok: false; error: string }

/** Lee y parsea JSON sin lanzar. Distingue archivo ausente de archivo corrupto. */
export async function leerJson<T>(archivo: string, esquema: z.ZodType<T>): Promise<Lectura<T>> {
  let texto: string
  try {
    texto = await readFile(archivo, "utf8")
  } catch {
    return { ok: false, error: `no existe ${path.basename(archivo)}` }
  }
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch {
    return { ok: false, error: `${path.basename(archivo)} está corrupto (JSON inválido)` }
  }
  const r = esquema.safeParse(crudo)
  if (!r.success) {
    return { ok: false, error: `${path.basename(archivo)} no tiene la estructura esperada: ${r.error.issues[0]?.message ?? ""}` }
  }
  return { ok: true, valor: r.data }
}

export async function existe(archivo: string): Promise<boolean> {
  try {
    await access(archivo)
    return true
  } catch {
    return false
  }
}

export async function escribir(archivo: string, contenido: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(archivo), { recursive: true })
  await writeFile(archivo, contenido)
}

/** Ruta relativa a la raíz del proyecto, con "/" para que sea legible en el chat. */
export function relativa(ctx: CtxHerramienta, archivo: string): string {
  return path.relative(ctx.directory, archivo).split(path.sep).join("/")
}

export function mensajeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------- Esquemas de los fixtures y del conocimiento ----------

export const esquemaCorreo = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string().optional(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string().default(""),
  adjuntos: z.array(z.string()).default([]),
})
export type Correo = z.infer<typeof esquemaCorreo>

export const esquemaComerciales = z.array(z.object({ email: z.string(), nombre: z.string(), region: z.string() }))
export type Comercial = z.infer<typeof esquemaComerciales>[number]

export const esquemaReglas = z.object({
  umbral_confianza: z.number(),
  umbral_similitud_objeto: z.number(),
  dias_alerta_vencimiento: z.number(),
  fecha_corte_maestro: z.string(),
  max_caracteres_objeto: z.number(),
  nit_propio: z.string(),
  monedas: z.array(z.string()),
  paises: z.array(z.string()),
  extensiones_contrato: z.array(z.string()),
  campos_obligatorios_nuevo: z.array(z.string()),
  tipos_poliza: z.record(z.string(), z.string()),
  sufijos_razon_social: z.array(z.string()),
})
export type Reglas = z.infer<typeof esquemaReglas>
