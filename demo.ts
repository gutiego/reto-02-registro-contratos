// Procesa los 6 mensajes del buzón llamando directamente a las herramientas, sin modelo de lenguaje.
// Uso: npm run demo   (o: npx tsx demo.ts)
import { rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ejecutarHerramienta } from "./src/tools/registro.js"
import type { CtxHerramienta } from "./src/tools/comun.js"

const directory = path.dirname(fileURLToPath(import.meta.url))
const ctx: CtxHerramienta = { directory, sessionId: "demo" }
const HOY = "2026-09-03"

type Salida = { ok: boolean; error?: string; data?: Record<string, unknown> }

async function llamar(nombre: string, args: unknown): Promise<Salida> {
  const e = await ejecutarHerramienta(nombre, args, ctx)
  console.log(`  ${e.ok ? "✔" : "✖"} ${nombre.padEnd(22)} ${e.resumen}`)
  return JSON.parse(e.salida) as Salida
}

async function procesar(id: string): Promise<Record<string, unknown> | null> {
  console.log(`\n━━━ ${id} ━━━`)
  const ext = await llamar("contratos_extraer", { mensaje_id: id })
  if (!ext.ok || !ext.data) return null
  const val = await llamar("contratos_validar", { mensaje_id: id, contrato: ext.data })
  const reg = await llamar("contratos_registrar", { mensaje_id: id, contrato: ext.data, hoy: HOY })
  const v = val.data ?? {}
  console.log(`  · clasificación: ${String(v.clasificacion)}${v.id_contrato_existente ? ` (existente: ${String(v.id_contrato_existente)})` : ""}`)
  console.log(`  · en revisión: ${(v.requiere_revision as string[] | undefined)?.join(", ") || "ninguno"}`)
  for (const adv of (v.advertencias as string[] | undefined) ?? []) console.log(`  · advertencia: ${adv}`)
  console.log(`  · acción: ${reg.ok ? String(reg.data?.accion) : `NO registrado — ${reg.error ?? ""}`}`)
  return ext.data
}

async function main(): Promise<void> {
  await rm(path.join(directory, process.env.OUT_DIR ?? "out"), { recursive: true, force: true })
  console.log(`Fecha de referencia: ${HOY}`)
  const buzon = await llamar("contratos_leer_buzon", {})
  const ids = ((buzon.data?.mensajes as { id: string }[] | undefined) ?? []).map((m) => m.id)
  const pendientes: Record<string, Record<string, unknown>> = {}
  for (const id of ids) {
    const extraido = await procesar(id)
    if (extraido) pendientes[id] = extraido
  }

  console.log("\n━━━ Segunda pasada: msg-006 confirmado por la analista (valor 0, fecha_fin 2027-08-31) ━━━")
  await llamar("contratos_registrar", { mensaje_id: "msg-006", contrato: { ...pendientes["msg-006"], valor: 0, fecha_fin: "2027-08-31" }, confirmado: true, hoy: HOY })

  console.log("\n━━━ Buzón tras procesar ━━━")
  await llamar("contratos_leer_buzon", {})

  console.log("\n━━━ Alertas ━━━")
  const al = await llamar("contratos_alertas", { hoy: HOY })
  console.log(`  · reporte en ${String(al.data?.ruta)}`)

  console.log("\n━━━ Manejo de errores (CA2 / HU-6) ━━━")
  await llamar("contratos_extraer", { mensaje_id: "msg-999" })
  await llamar("contratos_alertas", { hoy: "2026-13-45" })
  await llamar("contratos_validar", { mensaje_id: "msg-001", contrato: { valor: 999 } })
}

main().catch((e: unknown) => {
  console.error("La demo falló:", e)
  process.exit(1)
})
