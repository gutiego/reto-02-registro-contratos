// Extracción determinista (regex + heurísticas) del texto de un contrato. No exporta herramientas.
import type { Correo, Reglas } from "./comun.js"

export type TipoDocumento = "contrato" | "otrosi" | "cotizacion" | "desconocido"

export interface CamposContrato {
  id_contrato: string | null
  cliente: string | null
  nit_cliente: string | null
  pais: string | null
  objeto: string | null
  valor: number | null
  valor_indeterminado: boolean
  moneda: string | null
  fecha_inicio: string | null
  fecha_fin: string | null
  requiere_poliza: boolean | null
  tipo_poliza: string[]
  estado_poliza: string | null
}

export type CampoConfianza = Exclude<keyof CamposContrato, "valor_indeterminado" | "tipo_poliza" | "estado_poliza">

export interface Extraccion extends CamposContrato {
  tipo_documento: TipoDocumento
  numero_otrosi: number | null
  plazo_meses: number | null
  confianza: Record<CampoConfianza, number>
  notas: string[]
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]

export const sinTildes = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "")
const pad = (n: number): string => String(n).padStart(2, "0")

/** Fecha ISO válida o null (descarta 31 de febrero y similares). */
export function fechaIso(anio: number, mes: number, dia: number): string | null {
  const d = new Date(Date.UTC(anio, mes - 1, dia))
  if (d.getUTCFullYear() !== anio || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null
  return `${anio}-${pad(mes)}-${pad(dia)}`
}

export function sumarMeses(iso: string, meses: number): string | null {
  const [a, m, d] = iso.split("-").map(Number)
  const total = (m - 1) + meses
  const anio = a + Math.floor(total / 12)
  const mes = (total % 12) + 1
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate()
  return fechaIso(anio, mes, Math.min(d, ultimo))
}

const mesNumero = (nombre: string): number => MESES.indexOf(sinTildes(nombre.toLowerCase())) + 1

/** Fechas "quince (15) de agosto de 2026" en orden de aparición. */
function fechasEnTexto(texto: string): (string | null)[] {
  const re = /\((\d{1,2})\)\s+(?:d[ií]as\s+del\s+mes\s+)?de\s+([a-záéíóú]+)\s+de\s+(\d{4})/gi
  return [...texto.matchAll(re)].map((m) => {
    const mes = mesNumero(m[2])
    return mes > 0 ? fechaIso(Number(m[3]), mes, Number(m[1])) : null
  })
}

function parrafo(texto: string, marcador: RegExp): string | null {
  return texto.split(/\n\s*\n/).find((p) => marcador.test(p)) ?? null
}

function tipoDocumento(texto: string): TipoDocumento {
  const inicio = sinTildes(texto.trimStart().split("\n")[0] ?? "").toUpperCase()
  if (inicio.startsWith("OTROSI")) return "otrosi"
  if (inicio.startsWith("CONTRATO")) return "contrato"
  if (inicio.includes("COTIZACION")) return "cotizacion"
  return "desconocido"
}

function idContrato(texto: string): string | null {
  const primera = texto.trimStart().split("\n")[0] ?? ""
  const ids = [...primera.matchAll(/No\.\s*([A-Z]{2,}-\d{4}-\d+)/g)].map((m) => m[1])
  return ids.at(-1) ?? null
}

/** Usa el bloque de firmas para recuperar la razón social con mayúsculas/minúsculas correctas. */
function nombrePropio(texto: string, mayus: string): string {
  const objetivo = sinTildes(mayus).toLowerCase()
  for (const linea of texto.split("\n")) {
    for (const trozo of linea.trim().split(/\s{2,}/)) {
      if (sinTildes(trozo).toLowerCase() === objetivo) return trozo
    }
  }
  return mayus
}

interface Parte {
  nombre: string
  tipoId: string
  numero: string
}

function contraparte(texto: string, reglas: Reglas): Parte | null {
  const re = /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .&,]+?),\s+(?:identificada con\s+)?(NIT|RUC|RTN)\s+([\d.\-]+\d)/g
  for (const m of texto.matchAll(re)) {
    const numero = limpiarId(m[2], m[3])
    if (numero !== reglas.nit_propio) return { nombre: m[1].trim(), tipoId: m[2], numero }
  }
  return null
}

/** NIT sin dígito de verificación ni puntos; RUC/RTN solo dígitos. */
function limpiarId(tipo: string, crudo: string): string {
  const base = tipo === "NIT" ? crudo.split("-")[0] : crudo
  return base.replace(/\D/g, "")
}

function paisDe(parte: Parte, texto: string): { pais: string | null; confianza: number } {
  const t = sinTildes(texto)
  const porTexto = /Ecuador/.test(t) ? "EC" : /Peru/.test(t) ? "PE" : /Panama/.test(t) ? "PA" : /Honduras/.test(t) ? "HN" : null
  let porId: string | null = null
  if (parte.tipoId === "NIT") porId = "CO"
  else if (parte.tipoId === "RTN") porId = "HN"
  else if (parte.numero.length === 13) porId = "EC"
  else if (parte.numero.length === 11) porId = "PE"
  if (porId && (porTexto === porId || (porId === "CO" && !porTexto))) return { pais: porId, confianza: 0.95 }
  if (porId ?? porTexto) return { pais: porId ?? porTexto, confianza: 0.7 }
  return { pais: null, confianza: 0 }
}

export function numeroDesdeTexto(crudo: string): number | null {
  const s = crudo.trim()
  const dec = /[.,]\d{2}$/.test(s) ? s.at(-3) : null
  const entero = dec ? s.slice(0, -3) : s
  const n = Number(entero.replace(/[.,\s]/g, "") + (dec ? "." + s.slice(-2) : ""))
  return Number.isFinite(n) ? n : null
}

interface Valor {
  valor: number | null
  indeterminado: boolean
  moneda: string | null
  confianza: number
  confMoneda: number
  nota?: string
}

function valorDe(texto: string, reglas: Reglas): Valor {
  const p = parrafo(texto, /\bVALOR\b/)
  if (!p) return { valor: null, indeterminado: false, moneda: null, confianza: 0, confMoneda: 0 }
  if (/no tiene un valor determinado|valor indeterminado|por demanda/i.test(p)) {
    const pesos = /pesos|COP/.test(texto)
    return {
      valor: 0, indeterminado: true, moneda: pesos ? "COP" : null, confianza: 0.5, confMoneda: pesos ? 0.8 : 0,
      nota: "valor por demanda: se registra 0 con valor_indeterminado" + (pesos ? "; moneda COP tomada de las cifras en pesos del contrato" : ""),
    }
  }
  const m = p.match(/\(([A-Z]{3})\s*\$?\s*([\d.,]+\d)\)/)
  if (!m) return { valor: null, indeterminado: false, moneda: null, confianza: 0, confMoneda: 0, nota: "no se encontró un valor numérico con moneda" }
  const valor = numeroDesdeTexto(m[2])
  const conocida = reglas.monedas.includes(m[1])
  return {
    valor,
    indeterminado: false,
    moneda: conocida ? m[1] : null,
    confianza: valor === null ? 0 : 0.95,
    confMoneda: conocida ? 0.95 : 0,
    nota: conocida ? undefined : `moneda desconocida: ${m[1]}`,
  }
}

interface Fechas {
  inicio: string | null
  fin: string | null
  confInicio: number
  confFin: number
  plazoMeses: number | null
  notas: string[]
}

/** Fecha de firma: exacta ("a los treinta (30) días del mes de julio de 2026") o solo mes ("en el mes de agosto de 2026"). */
function fechaFirma(texto: string, correo: Correo): { fecha: string | null; confianza: number; nota?: string } {
  const p = parrafo(texto, /Se firma|se firma/) ?? ""
  const exacta = fechasEnTexto(p)[0]
  if (exacta) return { fecha: exacta, confianza: 0.95 }
  const mes = p.match(/mes de ([a-záéíóú]+) de (\d{4})/i)
  if (!mes) return { fecha: null, confianza: 0 }
  const prefijo = `${mes[2]}-${pad(mesNumero(mes[1]))}`
  if (correo.fecha.startsWith(prefijo)) {
    return { fecha: correo.fecha.slice(0, 10), confianza: 0.8, nota: "la firma solo indica mes; se toma la fecha del correo (mismo mes) como fecha de firma" }
  }
  return { fecha: `${prefijo}-01`, confianza: 0.5, nota: "la firma solo indica mes; se asume el día 1" }
}

function fechasDe(texto: string, correo: Correo, tipo: TipoDocumento): Fechas {
  const p = parrafo(texto, /\bPLAZO\b/)
  const vacio: Fechas = { inicio: null, fin: null, confInicio: 0, confFin: 0, plazoMeses: null, notas: [] }
  if (!p) return vacio
  const fechas = fechasEnTexto(p)
  const meses = p.match(/\((\d{1,3})\)\s+meses/)
  const plazoMeses = meses ? Number(meses[1]) : null
  if (tipo === "otrosi") {
    const fin = fechas.at(-1) ?? null
    return { ...vacio, fin, confFin: fin ? 0.95 : 0, plazoMeses }
  }
  if (fechas.length >= 2) {
    const [inicio, fin] = [fechas[0], fechas[1]]
    return { inicio, fin, confInicio: inicio ? 0.95 : 0, confFin: fin ? 0.95 : 0, plazoMeses, notas: inicio && fin ? [] : ["fecha inválida en la cláusula de plazo"] }
  }
  if (plazoMeses && /a partir de la fecha de su firma/i.test(p)) {
    const firma = fechaFirma(texto, correo)
    const fin = firma.fecha ? sumarMeses(firma.fecha, plazoMeses) : null
    const notas = [firma.nota, `fecha_fin derivada: fecha de firma + ${plazoMeses} meses`].filter((n): n is string => !!n)
    return { inicio: firma.fecha, fin, confInicio: firma.confianza, confFin: fin ? 0.6 : 0, plazoMeses, notas }
  }
  return { ...vacio, plazoMeses, notas: ["no se identificaron fechas de inicio y fin"] }
}

function objetoDe(texto: string, reglas: Reglas): { objeto: string | null; confianza: number } {
  const p = parrafo(texto, /\bOBJETO\b/)
  if (!p) return { objeto: null, confianza: 0 }
  const limpio = p.replace(/^.*?OBJETO\.\s*/s, "").replace(/\s+/g, " ").trim()
  if (!limpio) return { objeto: null, confianza: 0 }
  const recortado = limpio.length > reglas.max_caracteres_objeto ? limpio.slice(0, reglas.max_caracteres_objeto - 1).trimEnd() + "…" : limpio
  return { objeto: recortado, confianza: 0.9 }
}

interface Poliza {
  requiere: boolean | null
  tipos: string[]
  confianza: number
  estado: string | null
  nota?: string
}

function polizaDe(texto: string, tipo: TipoDocumento, reglas: Reglas): Poliza {
  const t = sinTildes(texto).toLowerCase()
  const tipos = [...new Set(Object.entries(reglas.tipos_poliza).filter(([k]) => t.includes(`poliza de ${k}`) || t.includes(`garantias de ${k}`)).map(([, v]) => v))]
  if (tipo === "otrosi") {
    const amplia = /garantias[^.]*deberan ampliarse/.test(t)
    return amplia
      ? { requiere: true, tipos: [], confianza: 0.9, estado: "pendiente", nota: "el otrosí exige ampliar la vigencia de las pólizas: queda pendiente" }
      : { requiere: null, tipos: [], confianza: 0, estado: null }
  }
  if (!/poliza|garantia/.test(t)) return { requiere: false, tipos: [], confianza: 0.9, estado: "no_aplica" }
  const condicional = /para cada orden|cuyo valor supere/.test(t)
  return {
    requiere: true,
    tipos,
    confianza: condicional ? 0.8 : 0.95,
    estado: "pendiente",
    nota: condicional ? "póliza condicionada al valor de cada orden de servicio" : undefined,
  }
}

const VACIO: CamposContrato = {
  id_contrato: null, cliente: null, nit_cliente: null, pais: null, objeto: null, valor: null, valor_indeterminado: false,
  moneda: null, fecha_inicio: null, fecha_fin: null, requiere_poliza: null, tipo_poliza: [], estado_poliza: null,
}

export function extraerContrato(texto: string, correo: Correo, reglas: Reglas): Extraccion {
  const tipo = tipoDocumento(texto)
  const confianza: Record<CampoConfianza, number> = {
    id_contrato: 0, cliente: 0, nit_cliente: 0, pais: 0, objeto: 0, valor: 0, moneda: 0, fecha_inicio: 0, fecha_fin: 0, requiere_poliza: 0,
  }
  const base: Extraccion = { ...VACIO, tipo_documento: tipo, numero_otrosi: null, plazo_meses: null, confianza, notas: [] }
  if (tipo !== "contrato" && tipo !== "otrosi") return { ...base, notas: [`el documento es de tipo "${tipo}", no un contrato`] }

  const id = idContrato(texto)
  const parte = contraparte(texto, reglas)
  const pais = parte ? paisDe(parte, texto) : { pais: null, confianza: 0 }
  const obj = tipo === "contrato" ? objetoDe(texto, reglas) : { objeto: null, confianza: 0 }
  const val = valorDe(texto, reglas)
  const fec = fechasDe(texto, correo, tipo)
  const pol = polizaDe(texto, tipo, reglas)
  const otrosi = tipo === "otrosi" ? texto.match(/OTROS[ÍI]\s+No\.\s*(\d+)/i) : null

  Object.assign(confianza, {
    id_contrato: id ? 0.95 : 0,
    cliente: parte ? 0.95 : 0,
    nit_cliente: parte ? 0.95 : 0,
    pais: pais.confianza,
    objeto: obj.confianza,
    valor: val.confianza,
    moneda: val.confMoneda,
    fecha_inicio: fec.confInicio,
    fecha_fin: fec.confFin,
    requiere_poliza: pol.confianza,
  })
  return {
    ...base,
    id_contrato: id,
    cliente: parte ? nombrePropio(texto, parte.nombre) : null,
    nit_cliente: parte?.numero ?? null,
    pais: pais.pais,
    objeto: obj.objeto,
    valor: val.valor,
    valor_indeterminado: val.indeterminado,
    moneda: val.moneda,
    fecha_inicio: fec.inicio,
    fecha_fin: fec.fin,
    requiere_poliza: pol.requiere,
    tipo_poliza: pol.tipos,
    estado_poliza: pol.estado,
    numero_otrosi: otrosi ? Number(otrosi[1]) : null,
    plazo_meses: fec.plazoMeses,
    notas: [val.nota, pol.nota, ...fec.notas].filter((n): n is string => !!n),
  }
}

/** ¿El adjunto parece un contrato u otrosí? Se usa al listar el buzón. */
export function pareceContrato(texto: string): boolean {
  const t = tipoDocumento(texto)
  return t === "contrato" || t === "otrosi"
}
