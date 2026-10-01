// Maestro CSV, clasificación RN1–RN4 y armado de filas. No exporta herramientas.
import { copyFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { escribir, existe, type Reglas, type Rutas } from "./comun.js"
import { sinTildes, type Extraccion, type CampoConfianza } from "./extraccion.js"

export const COLUMNAS = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin",
  "requiere_poliza", "tipo_poliza", "estado_poliza", "comercial", "ruta_sharepoint", "fecha_registro", "fuente",
] as const
export type Columna = (typeof COLUMNAS)[number]
export type Fila = Record<Columna, string>

// ---------- CSV ----------

function parsearLinea(linea: string): string[] {
  const celdas: string[] = []
  let actual = ""
  let comillas = false
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i]
    if (comillas && c === '"' && linea[i + 1] === '"') { actual += '"'; i++ }
    else if (c === '"') comillas = !comillas
    else if (c === "," && !comillas) { celdas.push(actual); actual = "" }
    else actual += c
  }
  celdas.push(actual)
  return celdas
}

const celdaCsv = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export function parsearCsv(texto: string): Fila[] {
  const lineas = texto.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "")
  const encabezado = parsearLinea(lineas[0] ?? "")
  return lineas.slice(1).map((l) => {
    const celdas = parsearLinea(l)
    return Object.fromEntries(COLUMNAS.map((c) => [c, celdas[encabezado.indexOf(c)] ?? ""])) as Fila
  })
}

export const serializarCsv = (filas: Fila[]): string =>
  [COLUMNAS.join(","), ...filas.map((f) => COLUMNAS.map((c) => celdaCsv(f[c])).join(","))].join("\n") + "\n"

/** RN6: el fixture es de solo lectura; la primera vez se copia a out/sharepoint/. */
export async function asegurarMaestro(r: Rutas): Promise<void> {
  if (await existe(r.maestro)) return
  await mkdir(path.dirname(r.maestro), { recursive: true })
  await copyFile(r.maestroFixture, r.maestro)
}

export async function leerMaestro(r: Rutas): Promise<Fila[]> {
  await asegurarMaestro(r)
  return parsearCsv(await readFile(r.maestro, "utf8"))
}

export const guardarMaestro = (r: Rutas, filas: Fila[]): Promise<void> => escribir(r.maestro, serializarCsv(filas))

// ---------- Utilidades de comparación ----------

export function slug(nombre: string, reglas: Reglas): string {
  let s = sinTildes(nombre).toLowerCase().trim()
  for (const suf of reglas.sufijos_razon_social) if (s.endsWith(" " + suf)) s = s.slice(0, -suf.length).trim()
  return s.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

function bigramas(s: string): string[] {
  const t = sinTildes(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  return Array.from({ length: Math.max(t.length - 1, 0) }, (_, i) => t.slice(i, i + 2))
}

/** Coeficiente de Dice sobre bigramas de caracteres, en [0, 1]. */
export function similitud(a: string, b: string): number {
  const x = bigramas(a)
  const y = bigramas(b)
  if (!x.length || !y.length) return 0
  const resto = [...y]
  let comunes = 0
  for (const g of x) {
    const i = resto.indexOf(g)
    if (i >= 0) { comunes++; resto.splice(i, 1) }
  }
  return (2 * comunes) / (x.length + y.length)
}

// ---------- Clasificación ----------

export type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado"

export interface Diferencia {
  campo: Columna
  actual: string
  nuevo: string
}

export interface Validacion {
  clasificacion: Clasificacion
  motivo: string
  id_contrato_existente: string | null
  requiere_revision: string[]
  diferencias: Diferencia[]
}

/** Valores de la extracción expresados como celdas del maestro (solo los presentes). */
export function aCeldas(c: Extraccion): Partial<Fila> {
  const celdas: Partial<Fila> = {}
  const poner = (k: Columna, v: string | number | boolean | null) => { if (v !== null && v !== "") celdas[k] = String(v) }
  poner("id_contrato", c.id_contrato)
  poner("cliente", c.cliente)
  poner("nit_cliente", c.nit_cliente)
  poner("pais", c.pais)
  poner("objeto", c.objeto)
  poner("valor", c.valor)
  poner("moneda", c.moneda)
  poner("fecha_inicio", c.fecha_inicio)
  poner("fecha_fin", c.fecha_fin)
  poner("requiere_poliza", c.requiere_poliza)
  if (c.tipo_poliza.length) celdas.tipo_poliza = c.tipo_poliza.join(";")
  poner("estado_poliza", c.estado_poliza)
  return celdas
}

function buscarExistente(c: Extraccion, filas: Fila[], reglas: Reglas): Fila | null {
  const porId = filas.find((f) => c.id_contrato && f.id_contrato === c.id_contrato)
  if (porId) return porId
  if (!c.nit_cliente || !c.objeto) return null
  return filas.find((f) => f.nit_cliente === c.nit_cliente && similitud(f.objeto, c.objeto ?? "") >= reglas.umbral_similitud_objeto) ?? null
}

/** Campos con confianza < umbral (solo los que el documento aporta o debe aportar). */
export function camposDudosos(c: Extraccion, reglas: Reglas, obligatorios: string[]): string[] {
  return (Object.keys(c.confianza) as CampoConfianza[]).filter((k) => {
    const presente = c[k] !== null
    return (presente || obligatorios.includes(k)) && c.confianza[k] < reglas.umbral_confianza
  })
}

function diferenciasCon(fila: Fila, c: Extraccion): Diferencia[] {
  const nuevas = aCeldas(c)
  return (Object.keys(nuevas) as Columna[])
    .filter((k) => k !== "id_contrato" && k !== "cliente" && nuevas[k] !== fila[k])
    .filter((k) => !(c.tipo_documento === "contrato" && k === "estado_poliza"))
    .map((k) => ({ campo: k, actual: fila[k], nuevo: nuevas[k] ?? "" }))
}

export function clasificar(c: Extraccion, filas: Fila[], reglas: Reglas): Validacion {
  const base = { id_contrato_existente: null, requiere_revision: [] as string[], diferencias: [] as Diferencia[] }
  if (c.tipo_documento !== "contrato" && c.tipo_documento !== "otrosi") {
    return { ...base, clasificacion: "rechazado", motivo: `el adjunto es de tipo "${c.tipo_documento}", no un contrato ni un otrosí` }
  }
  if (!c.cliente && !c.objeto && !c.id_contrato) {
    return { ...base, clasificacion: "rechazado", motivo: "el texto no contiene partes ni objeto identificables" }
  }
  const existente = buscarExistente(c, filas, reglas)
  if (c.tipo_documento === "otrosi") {
    const dudosos = camposDudosos(c, reglas, ["id_contrato"])
    if (!existente) return { ...base, clasificacion: "actualizacion", motivo: "otrosí sin contrato base en el maestro", requiere_revision: [...dudosos, "id_contrato (no existe en el maestro)"] }
    return { ...base, clasificacion: "actualizacion", motivo: "el documento es un otrosí de un contrato existente", id_contrato_existente: existente.id_contrato, requiere_revision: dudosos, diferencias: diferenciasCon(existente, c) }
  }
  if (!existente) {
    return { ...base, clasificacion: "nuevo", motivo: "no hay coincidencia en el maestro", requiere_revision: camposDudosos(c, reglas, reglas.campos_obligatorios_nuevo) }
  }
  const mismos = (["valor", "fecha_inicio", "fecha_fin"] as const).every((k) => existente[k] === (aCeldas(c)[k] ?? ""))
  if (mismos && existente.id_contrato === c.id_contrato) {
    return { ...base, clasificacion: "duplicado", motivo: "mismo id_contrato, valor y fechas que una fila existente", id_contrato_existente: existente.id_contrato }
  }
  return {
    ...base,
    clasificacion: "actualizacion",
    motivo: existente.id_contrato === c.id_contrato ? "mismo id_contrato con campos distintos" : "mismo NIT y objeto similar (≥ umbral)",
    id_contrato_existente: existente.id_contrato,
    requiere_revision: camposDudosos(c, reglas, []),
    diferencias: diferenciasCon(existente, c),
  }
}
