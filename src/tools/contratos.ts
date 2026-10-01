// Herramientas del agente. Cada export es una herramienta visible como contratos_<export>.
import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { definir, ok, fallo, esquemaMensajeId, esquemaFecha, rutas, relativa, mensajeError, escribir } from "./comun.js"
import {
  analizar, listarMensajes, leerCorreo, adjuntoContrato, cargarReglas, leerProcesados, marcarProcesado,
  contrastar, aplicarPropuestas, campoBase, esquemaContrato, type Analisis,
} from "./analisis.js"
import { clasificar, leerMaestro, guardarMaestro, asegurarMaestro, type Validacion } from "./maestro.js"
import { construirFila, aplicarCambios, validarFinal, archivar } from "./escritura.js"
import { calcularAlertas, alertasMarkdown } from "./alertas.js"

export const leer_buzon = definir({
  description: "Lista los mensajes del buzón de contratos aún no procesados, con remitente, asunto, adjuntos y si traen contrato.",
  args: {},
  async execute(_args, ctx) {
    try {
      const r = rutas(ctx)
      const reglas = await cargarReglas(ctx)
      if (!reglas.ok) return fallo(reglas.error)
      const procesados = await leerProcesados(r)
      const mensajes = []
      for (const id of await listarMensajes(r)) {
        if (procesados[id]) continue
        const correo = await leerCorreo(r, id)
        if (!correo.ok) { mensajes.push({ id, error: correo.error, tiene_contrato: false }); continue }
        const { de, asunto, fecha, adjuntos } = correo.valor
        const adj = await adjuntoContrato(r, correo.valor, reglas.valor)
        mensajes.push({ id, de, asunto, fecha, adjuntos, tiene_contrato: adj.adjunto !== null, ...(adj.motivo && !adj.adjunto ? { motivo: adj.motivo } : {}) })
      }
      const conContrato = mensajes.filter((m) => m.tiene_contrato).length
      return ok({ mensajes, ya_procesados: Object.keys(procesados).length, resumen: `${mensajes.length} pendientes (${conContrato} con contrato)` })
    } catch (e) {
      return fallo(`no se pudo leer el buzón: ${mensajeError(e)}`)
    }
  },
})

function vistaExtraccion(a: Analisis) {
  const { extraccion: x } = a
  return {
    mensaje_id: a.correo.id,
    adjunto: a.adjunto,
    ...x,
    remitente: a.correo.de,
    comercial: a.comercial?.nombre ?? null,
    comercial_registrado: a.comercial !== null,
  }
}

export const extraer = definir({
  description: "Extrae de forma determinista los datos del contrato adjunto a un mensaje, con confianza por campo en [0,1] (null y 0 si el dato no está en el texto).",
  args: { mensaje_id: esquemaMensajeId },
  async execute({ mensaje_id }, ctx) {
    try {
      const a = await analizar(ctx, mensaje_id)
      if (!a.ok) return fallo(a.error)
      const x = a.valor.extraccion
      const bajos = Object.entries(x.confianza).filter(([, c]) => c < a.valor.reglas.umbral_confianza).map(([k]) => k)
      const resumen = `${x.tipo_documento} ${x.id_contrato ?? "sin id"} · ${x.cliente ?? "sin cliente"} · baja confianza: ${bajos.join(", ") || "ninguno"}`
      return ok({ ...vistaExtraccion(a.valor), resumen })
    } catch (e) {
      return fallo(`no se pudo extraer ${mensaje_id}: ${mensajeError(e)}`)
    }
  },
})

interface Evaluacion {
  a: Analisis
  v: Validacion
  conflictos: string[]
  propuestas: Record<string, string>
  advertencias: string[]
}

async function evaluar(ctx: Parameters<typeof extraer.execute>[1], mensajeId: string, contrato: z.infer<typeof esquemaContrato>): Promise<{ ok: true; e: Evaluacion } | { ok: false; error: string }> {
  const a = await analizar(ctx, mensajeId)
  if (!a.ok) return a
  const filas = await leerMaestro(a.valor.r)
  const v = clasificar(a.valor.extraccion, filas, a.valor.reglas)
  const c = contrastar(a.valor.extraccion, contrato, v.requiere_revision.map(campoBase))
  const advertencias = a.valor.comercial ? [] : [`remitente ${a.valor.correo.de} no está en comerciales.json (se reporta, no bloquea)`]
  return { ok: true, e: { a: a.valor, v, conflictos: c.conflictos, propuestas: c.propuestas, advertencias } }
}

export const validar = definir({
  description: "Clasifica el contrato de un mensaje como nuevo, actualizacion, duplicado o rechazado frente al maestro (RN1–RN4) y lista los campos que requieren revisión humana.",
  args: { mensaje_id: esquemaMensajeId, contrato: esquemaContrato },
  async execute({ mensaje_id, contrato }, ctx) {
    try {
      const r = await evaluar(ctx, mensaje_id, contrato)
      if (!r.ok) return fallo(r.error)
      const { v, conflictos, propuestas, advertencias, a } = r.e
      const requiere_revision = [...v.requiere_revision, ...conflictos.map((c) => `conflicto: ${c}`)]
      const pendiente = requiere_revision.length > 0 && (v.clasificacion === "nuevo" || v.clasificacion === "actualizacion")
      const resumen = `${v.clasificacion}${v.id_contrato_existente ? ` (${v.id_contrato_existente})` : ""} · revisión: ${requiere_revision.join(", ") || "ninguna"}`
      return ok({
        mensaje_id, ...v, requiere_revision, propuestas_del_modelo: propuestas, advertencias,
        comercial: a.comercial?.nombre ?? null, notas: a.extraccion.notas,
        ...(pendiente ? { pide_confirmacion: true } : {}), resumen,
      })
    } catch (e) {
      return fallo(`no se pudo validar ${mensaje_id}: ${mensajeError(e)}`)
    }
  },
})

async function escribirHistorial(e: Evaluacion, id: string, accion: string, cambios: object): Promise<void> {
  await mkdir(path.dirname(e.a.r.historial), { recursive: true })
  await appendFile(e.a.r.historial, JSON.stringify({ ts: new Date().toISOString(), id_contrato: id, accion, cambios, mensaje_id: e.a.correo.id }) + "\n")
}

export const registrar = definir({
  description: "Registra o actualiza el contrato de un mensaje en el maestro, lo archiva en SharePoint (simulado) y marca el mensaje como procesado; si hay campos en revisión exige confirmado=true tras confirmación explícita del usuario.",
  args: {
    mensaje_id: esquemaMensajeId,
    contrato: esquemaContrato,
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente los campos en revisión en su último mensaje"),
    hoy: esquemaFecha.optional().describe("Fecha de registro YYYY-MM-DD (por defecto, la fecha actual)"),
  },
  async execute({ mensaje_id, contrato, confirmado, hoy }, ctx) {
    try {
      const r = rutas(ctx)
      const previo = (await leerProcesados(r))[mensaje_id]
      if (previo) return ok({ ...previo, mensaje_id, accion: "ya_procesado", resumen: `${mensaje_id} ya estaba procesado (${previo.accion})` })
      const ev = await evaluar(ctx, mensaje_id, contrato)
      if (!ev.ok) return fallo(ev.error)
      return await ejecutarRegistro(ev.e, contrato, confirmado === true && ctx.confirmacionHumana !== false, hoy ?? new Date().toISOString().slice(0, 10))
    } catch (e) {
      return fallo(`no se pudo registrar ${mensaje_id}: ${mensajeError(e)}`)
    }
  },
})

async function ejecutarRegistro(e: Evaluacion, contrato: z.infer<typeof esquemaContrato>, confirmado: boolean, hoy: string): Promise<string> {
  const { v, a } = e
  const id = a.correo.id
  if (e.conflictos.length) return fallo(`el contrato enviado no coincide con la extracción en: ${e.conflictos.join("; ")}. Usa los valores de contratos_extraer; solo los campos en revisión pueden corregirse con confirmación.`)
  if (v.clasificacion === "rechazado" || v.clasificacion === "duplicado") {
    await marcarProcesado(a.r, id, { clasificacion: v.clasificacion, accion: "sin_escritura", id_contrato: v.id_contrato_existente })
    return ok({ mensaje_id: id, clasificacion: v.clasificacion, accion: "sin_escritura", motivo: v.motivo, id_contrato: v.id_contrato_existente, resumen: `${v.clasificacion}: no se escribe en el maestro (${v.motivo})` })
  }
  if (v.requiere_revision.length && !confirmado) {
    return fallo(`requiere revisión: ${v.requiere_revision.join(", ")}. Pide confirmación explícita al usuario y vuelve a llamar con confirmado=true.`, { pide_confirmacion: true, requiere_revision: v.requiere_revision })
  }
  const final = aplicarPropuestas(a.extraccion, contrato, { conflictos: [], propuestas: e.propuestas })
  const problema = validarFinal(final, v.clasificacion, a.reglas)
  if (problema) return fallo(problema)
  const filas = await leerMaestro(a.r)
  if (v.clasificacion === "nuevo") {
    const fila = construirFila(final, a, filas, hoy)
    fila.ruta_sharepoint = await archivar(a, fila, fila.id_contrato)
    await guardarMaestro(a.r, [...filas, fila])
    await escribirHistorial(e, fila.id_contrato, "alta", fila)
    await marcarProcesado(a.r, id, { clasificacion: "nuevo", accion: "insertado", id_contrato: fila.id_contrato })
    return ok({ mensaje_id: id, id_contrato: fila.id_contrato, accion: "insertado", ruta_archivo: `out/sharepoint/${fila.ruta_sharepoint}`, estado_poliza: fila.estado_poliza, advertencias: e.advertencias, resumen: `insertado ${fila.id_contrato} (${fila.estado_poliza})` })
  }
  const idx = filas.findIndex((f) => f.id_contrato === v.id_contrato_existente)
  if (idx < 0) return fallo(`el contrato base ${v.id_contrato_existente ?? "(sin id)"} no está en el maestro; no se puede actualizar`)
  const cambios = aplicarCambios(filas[idx], final)
  const sufijo = final.tipo_documento === "otrosi" ? `-otrosi-${final.numero_otrosi ?? 1}` : `-${id}`
  const ruta = await archivar(a, filas[idx], filas[idx].id_contrato + sufijo)
  await guardarMaestro(a.r, filas)
  await escribirHistorial(e, filas[idx].id_contrato, "actualizacion", { ...cambios, documento: ruta })
  await marcarProcesado(a.r, id, { clasificacion: "actualizacion", accion: "actualizado", id_contrato: filas[idx].id_contrato })
  return ok({ mensaje_id: id, id_contrato: filas[idx].id_contrato, accion: "actualizado", cambios, ruta_archivo: `out/sharepoint/${ruta}`, resumen: `actualizado ${filas[idx].id_contrato}: ${Object.keys(cambios).join(", ")}` })
}

export const alertas = definir({
  description: "Genera out/alertas.md con contratos que vencen pronto, pólizas requeridas no vigentes y contratos registrados desde la fecha de corte, según la fecha hoy dada.",
  args: { hoy: esquemaFecha.describe("Fecha de referencia YYYY-MM-DD, ej. '2026-09-03'") },
  async execute({ hoy }, ctx) {
    try {
      if (Number.isNaN(Date.parse(hoy + "T00:00:00Z"))) return fallo(`fecha inválida: ${hoy}`)
      const r = rutas(ctx)
      const reglas = await cargarReglas(ctx)
      if (!reglas.ok) return fallo(reglas.error)
      await asegurarMaestro(r)
      const datos = calcularAlertas(await leerMaestro(r), hoy, reglas.valor)
      await escribir(r.alertas, alertasMarkdown(datos, hoy, reglas.valor))
      const resumen = `${datos.vencen.length} vencen ≤${reglas.valor.dias_alerta_vencimiento}d · ${datos.polizas_pendientes.length} pólizas pendientes · ${datos.registrados_desde_corte.length} registrados desde corte`
      return ok({ ruta: relativa(ctx, r.alertas), ...datos, resumen })
    } catch (e) {
      return fallo(`no se pudieron generar las alertas: ${mensajeError(e)}`)
    }
  },
})
