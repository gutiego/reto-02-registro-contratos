// Armado de filas, validación final y archivo en SharePoint simulado. No exporta herramientas.
import { copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import type { Reglas } from "./comun.js"
import type { Analisis } from "./analisis.js"
import type { Extraccion } from "./extraccion.js"
import { aCeldas, slug, type Columna, type Fila, type Clasificacion } from "./maestro.js"

const ISO = /^\d{4}-\d{2}-\d{2}$/
const fechaValida = (s: string | null): boolean => !!s && ISO.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"))

/** Última barrera antes de escribir: tipos y dominios del esquema 7.2. Devuelve el problema o null. */
export function validarFinal(x: Extraccion, clasificacion: Clasificacion, reglas: Reglas): string | null {
  const faltan = clasificacion === "nuevo" ? reglas.campos_obligatorios_nuevo.filter((k) => k !== "id_contrato" && x[k as keyof Extraccion] === null) : []
  if (faltan.length) return `faltan campos obligatorios: ${faltan.join(", ")}`
  if (x.moneda !== null && !reglas.monedas.includes(x.moneda)) return `moneda desconocida: ${x.moneda}`
  if (x.pais !== null && !reglas.paises.includes(x.pais)) return `país no soportado: ${x.pais}`
  if (x.valor !== null && (!Number.isFinite(x.valor) || x.valor < 0)) return `valor inválido: ${x.valor}`
  for (const k of ["fecha_inicio", "fecha_fin"] as const) if (x[k] !== null && !fechaValida(x[k])) return `fecha inválida en ${k}: ${x[k]}`
  if (x.fecha_inicio && x.fecha_fin && x.fecha_fin < x.fecha_inicio) return "fecha_fin es anterior a fecha_inicio"
  return null
}

function idAutomatico(filas: Fila[], anio: string): string {
  const n = filas.filter((f) => f.id_contrato.startsWith(`AUTO-${anio}-`)).length + 1
  return `AUTO-${anio}-${String(n).padStart(3, "0")}`
}

export function construirFila(x: Extraccion, a: Analisis, filas: Fila[], hoy: string): Fila {
  const anio = (x.fecha_inicio ?? hoy).slice(0, 4)
  const requiere = x.requiere_poliza === true
  return {
    id_contrato: x.id_contrato ?? idAutomatico(filas, anio),
    cliente: x.cliente ?? "",
    nit_cliente: x.nit_cliente ?? "",
    pais: x.pais ?? "",
    objeto: x.objeto ?? "",
    valor: String(x.valor ?? 0),
    moneda: x.moneda ?? "",
    fecha_inicio: x.fecha_inicio ?? "",
    fecha_fin: x.fecha_fin ?? "",
    requiere_poliza: String(requiere),
    tipo_poliza: requiere ? x.tipo_poliza.join(";") : "",
    estado_poliza: requiere ? "pendiente" : "no_aplica",
    comercial: a.comercial?.nombre ?? `desconocido (${a.correo.de})`,
    ruta_sharepoint: "",
    fecha_registro: hoy,
    fuente: "buzon",
  }
}

/** Aplica sobre la fila los campos que el documento trae y difieren. Devuelve { campo: { antes, despues } }. */
export function aplicarCambios(fila: Fila, x: Extraccion): Record<string, { antes: string; despues: string }> {
  const cambios: Record<string, { antes: string; despues: string }> = {}
  const nuevas = aCeldas(x)
  for (const k of Object.keys(nuevas) as Columna[]) {
    if (k === "id_contrato" || k === "cliente" || (x.tipo_documento === "contrato" && k === "estado_poliza")) continue
    const valor = nuevas[k] ?? ""
    if (valor === fila[k]) continue
    cambios[k] = { antes: fila[k], despues: valor }
    fila[k] = valor
  }
  return cambios
}

/** Copia el adjunto a out/sharepoint/Contratos/<año_inicio>/<cliente-slug>/<nombre>.<ext>. Devuelve la ruta relativa a sharepoint/. */
export async function archivar(a: Analisis, fila: Fila, nombre: string): Promise<string> {
  const ext = path.extname(a.adjunto ?? "") || ".txt"
  const relativa = ["Contratos", fila.fecha_inicio.slice(0, 4) || "sin-fecha", slug(fila.cliente, a.reglas) || "sin-cliente", `${nombre}${ext}`].join("/")
  const destino = path.join(a.r.sharepoint, ...relativa.split("/"))
  await mkdir(path.dirname(destino), { recursive: true })
  await copyFile(path.join(a.r.buzon, a.correo.id, a.adjunto ?? ""), destino)
  return relativa
}
