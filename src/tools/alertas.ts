// Cálculo y render del reporte de alertas. No exporta herramientas.
import type { Reglas } from "./comun.js"
import type { Fila } from "./maestro.js"

export interface ItemAlerta {
  id_contrato: string
  cliente: string
  fecha_fin: string
  dias?: number
  estado_poliza?: string
  tipo_poliza?: string
  fecha_registro?: string
  comercial: string
}

export interface DatosAlertas {
  vencen: ItemAlerta[]
  vencidos: ItemAlerta[]
  polizas_pendientes: ItemAlerta[]
  registrados_desde_corte: ItemAlerta[]
}

const DIA = 86_400_000
const dias = (desde: string, hasta: string): number => Math.round((Date.parse(hasta + "T00:00:00Z") - Date.parse(desde + "T00:00:00Z")) / DIA)
const item = (f: Fila): ItemAlerta => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_fin: f.fecha_fin, comercial: f.comercial })

export function calcularAlertas(filas: Fila[], hoy: string, reglas: Reglas): DatosAlertas {
  const conDias = filas.filter((f) => f.fecha_fin).map((f) => ({ f, d: dias(hoy, f.fecha_fin) }))
  return {
    vencen: conDias.filter(({ d }) => d >= 0 && d <= reglas.dias_alerta_vencimiento).sort((a, b) => a.d - b.d).map(({ f, d }) => ({ ...item(f), dias: d })),
    vencidos: conDias.filter(({ d }) => d < 0).map(({ f, d }) => ({ ...item(f), dias: d })),
    polizas_pendientes: filas.filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente").map((f) => ({ ...item(f), estado_poliza: f.estado_poliza, tipo_poliza: f.tipo_poliza })),
    registrados_desde_corte: filas.filter((f) => f.fecha_registro >= reglas.fecha_corte_maestro).map((f) => ({ ...item(f), fecha_registro: f.fecha_registro })),
  }
}

function tabla(cols: string[], filas: string[][]): string {
  if (!filas.length) return "_Sin registros._\n"
  return [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...filas.map((f) => `| ${f.join(" | ")} |`)].join("\n") + "\n"
}

export function alertasMarkdown(d: DatosAlertas, hoy: string, reglas: Reglas): string {
  return [
    `# Alertas de contratos — ${hoy}`,
    "",
    `## 1. Vencen en ≤ ${reglas.dias_alerta_vencimiento} días`,
    tabla(["Contrato", "Cliente", "Fecha fin", "Días", "Comercial"], d.vencen.map((i) => [i.id_contrato, i.cliente, i.fecha_fin, String(i.dias), i.comercial])),
    d.vencidos.length ? `> Nota: ${d.vencidos.length} contrato(s) del maestro ya vencieron sin registro de renovación: ${d.vencidos.map((i) => `${i.id_contrato} (${i.fecha_fin})`).join(", ")}.\n` : "",
    "## 2. Póliza requerida no vigente",
    tabla(["Contrato", "Cliente", "Tipo de póliza", "Estado", "Comercial"], d.polizas_pendientes.map((i) => [i.id_contrato, i.cliente, i.tipo_poliza || "—", i.estado_poliza ?? "", i.comercial])),
    `## 3. Registrados desde el corte (${reglas.fecha_corte_maestro})`,
    tabla(["Contrato", "Cliente", "Fecha registro", "Fecha fin", "Comercial"], d.registrados_desde_corte.map((i) => [i.id_contrato, i.cliente, i.fecha_registro ?? "", i.fecha_fin, i.comercial])),
  ].join("\n")
}
