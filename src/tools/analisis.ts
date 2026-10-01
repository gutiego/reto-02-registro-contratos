// Carga de un mensaje del buzón, extracción y contraste con lo que propone el modelo. No exporta herramientas.
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import {
  esquemaComerciales, esquemaCorreo, esquemaReglas, leerJson, rutas, escribir,
  type Comercial, type Correo, type CtxHerramienta, type Reglas, type Rutas,
} from "./comun.js"
import { extraerContrato, pareceContrato, type Extraccion } from "./extraccion.js"

export interface Analisis {
  r: Rutas
  correo: Correo
  adjunto: string | null
  extraccion: Extraccion
  reglas: Reglas
  comercial: Comercial | null
}

export type Resultado<T> = { ok: true; valor: T } | { ok: false; error: string }

export async function cargarReglas(ctx: CtxHerramienta): Promise<Resultado<Reglas>> {
  return leerJson(rutas(ctx).reglas, esquemaReglas)
}

export async function listarMensajes(r: Rutas): Promise<string[]> {
  const entradas = await readdir(r.buzon, { withFileTypes: true })
  return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
}

export async function leerCorreo(r: Rutas, id: string): Promise<Resultado<Correo>> {
  return leerJson(path.join(r.buzon, id, "correo.json"), esquemaCorreo)
}

/** Primer adjunto con extensión de contrato cuyo texto parece contrato u otrosí. */
export async function adjuntoContrato(r: Rutas, correo: Correo, reglas: Reglas): Promise<{ adjunto: string | null; texto: string; motivo?: string }> {
  for (const a of correo.adjuntos) {
    if (!reglas.extensiones_contrato.includes(path.extname(a).toLowerCase()) || path.basename(a) !== a) continue
    const texto = await readFile(path.join(r.buzon, correo.id, a), "utf8").catch(() => "")
    if (pareceContrato(texto)) return { adjunto: a, texto }
  }
  if (correo.adjuntos.length === 0) return { adjunto: null, texto: "", motivo: "el correo no trae adjuntos" }
  return { adjunto: null, texto: "", motivo: "ningún adjunto es un contrato u otrosí" }
}

export async function resolverComercial(r: Rutas, email: string): Promise<Comercial | null> {
  const lista = await leerJson(r.comerciales, esquemaComerciales)
  if (!lista.ok) return null
  return lista.valor.find((c) => c.email.toLowerCase() === email.trim().toLowerCase()) ?? null
}

export async function analizar(ctx: CtxHerramienta, mensajeId: string): Promise<Resultado<Analisis>> {
  const r = rutas(ctx, mensajeId)
  const reglas = await cargarReglas(ctx)
  if (!reglas.ok) return reglas
  const correo = await leerCorreo(r, mensajeId)
  if (!correo.ok) return { ok: false, error: `mensaje ${mensajeId}: ${correo.error}` }
  const adj = await adjuntoContrato(r, correo.valor, reglas.valor)
  let extraccion: Extraccion
  if (adj.adjunto) {
    if (!adj.texto.trim()) return { ok: false, error: `el adjunto ${adj.adjunto} de ${mensajeId} está vacío` }
    extraccion = extraerContrato(adj.texto, correo.valor, reglas.valor)
  } else {
    const otro = correo.valor.adjuntos[0]
    const texto = otro ? await readFile(path.join(r.mensaje, path.basename(otro)), "utf8").catch(() => "") : ""
    extraccion = extraerContrato(texto, correo.valor, reglas.valor)
    extraccion.notas.unshift(adj.motivo ?? "sin contrato")
  }
  const comercial = await resolverComercial(r, correo.valor.de)
  return { ok: true, valor: { r, correo: correo.valor, adjunto: adj.adjunto, extraccion, reglas: reglas.valor, comercial } }
}

// ---------- Contraste con el contrato que envía el modelo (CA2) ----------

export const esquemaContrato = z
  .object({
    id_contrato: z.string().nullable().optional().describe("Número del contrato"),
    cliente: z.string().nullable().optional().describe("Razón social de la contraparte"),
    nit_cliente: z.string().nullable().optional().describe("Identificador tributario sin DV ni puntos"),
    pais: z.string().nullable().optional().describe("CO|EC|PE|PA|HN"),
    objeto: z.string().nullable().optional().describe("Objeto del contrato"),
    valor: z.number().nullable().optional().describe("Valor sin separadores; 0 si es por demanda"),
    valor_indeterminado: z.boolean().optional().describe("true si el contrato es por demanda"),
    moneda: z.string().nullable().optional().describe("COP|USD|PEN|PAB|HNL"),
    fecha_inicio: z.string().nullable().optional().describe("YYYY-MM-DD"),
    fecha_fin: z.string().nullable().optional().describe("YYYY-MM-DD"),
    requiere_poliza: z.boolean().nullable().optional().describe("Si el contrato exige póliza"),
    tipo_poliza: z.array(z.string()).optional().describe("Tipos de póliza"),
  })
  .describe("Datos del contrato tal como los devolvió contratos_extraer; solo los campos en requiere_revision pueden cambiarse y solo con confirmación humana")
export type ContratoPropuesto = z.infer<typeof esquemaContrato>

const COMPARABLES = ["id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza"] as const
type Comparable = (typeof COMPARABLES)[number]

const norm = (v: unknown): string => (Array.isArray(v) ? v.join(";") : v === null || v === undefined ? "" : String(v).trim())

export interface Contraste {
  conflictos: string[]
  propuestas: Partial<Record<Comparable, string>>
}

/** Campos en los que el modelo propone un valor distinto al extraído. Solo son propuestas si estaban en revisión. */
export function contrastar(extr: Extraccion, propuesto: ContratoPropuesto, revisables: string[]): Contraste {
  const res: Contraste = { conflictos: [], propuestas: {} }
  for (const k of COMPARABLES) {
    if (propuesto[k] === undefined || norm(propuesto[k]) === norm(extr[k])) continue
    if (revisables.includes(k)) res.propuestas[k] = norm(propuesto[k])
    else res.conflictos.push(`${k} (extraído: "${norm(extr[k])}", enviado: "${norm(propuesto[k])}")`)
  }
  return res
}

/** Aplica las propuestas confirmadas por el humano sobre la extracción. */
export function aplicarPropuestas(extr: Extraccion, propuesto: ContratoPropuesto, c: Contraste): Extraccion {
  const final: Extraccion = { ...extr, confianza: { ...extr.confianza } }
  for (const k of Object.keys(c.propuestas) as Comparable[]) {
    Object.assign(final, { [k]: propuesto[k] ?? null })
    if (k in final.confianza) final.confianza[k as keyof Extraccion["confianza"]] = 1
  }
  if (propuesto.valor_indeterminado !== undefined && "valor" in c.propuestas) final.valor_indeterminado = propuesto.valor_indeterminado
  return final
}

export const campoBase = (s: string): string => s.split(" ")[0]

// ---------- procesados.json ----------

export const esquemaProcesados = z.record(z.string(), z.object({ clasificacion: z.string(), accion: z.string(), id_contrato: z.string().nullable(), ts: z.string() }))
export type Procesados = z.infer<typeof esquemaProcesados>

export async function leerProcesados(r: Rutas): Promise<Procesados> {
  const p = await leerJson(r.procesados, esquemaProcesados)
  return p.ok ? p.valor : {}
}

export async function marcarProcesado(r: Rutas, id: string, entrada: Omit<Procesados[string], "ts">): Promise<void> {
  const p = await leerProcesados(r)
  p[id] = { ...entrada, ts: new Date().toISOString() }
  await escribir(r.procesados, JSON.stringify(p, null, 2))
}
