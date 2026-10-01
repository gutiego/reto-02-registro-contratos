// Sesiones en memoria con copia en archivo (out/sesiones/<id>.json). Sin base de datos.
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { Mensaje } from "../llm/adapter.js"
import { escribir } from "../tools/comun.js"

export interface LlamadaVisible {
  nombre: string
  args: unknown
  ok: boolean
  resumen: string
  resultado: string
}

export interface EntradaVisible {
  rol: "usuario" | "agente"
  texto: string
  toolCalls?: LlamadaVisible[]
  needsConfirmation?: boolean
  error?: boolean
  ts: string
}

export interface Sesion {
  id: string
  mensajes: Mensaje[] // historial que ve el modelo
  vista: EntradaVisible[] // historial que ve el usuario
  tokens: number
  esperandoConfirmacion: boolean
  ocupada: boolean
}

export const ID_VALIDO = /^[a-zA-Z0-9-]{8,64}$/

export class AlmacenSesiones {
  private readonly memoria = new Map<string, Sesion>()
  constructor(private readonly dir: string) {}

  async obtener(id: string): Promise<Sesion> {
    const enMemoria = this.memoria.get(id)
    if (enMemoria) return enMemoria
    let sesion: Sesion = { id, mensajes: [], vista: [], tokens: 0, esperandoConfirmacion: false, ocupada: false }
    try {
      const guardada = JSON.parse(await readFile(this.archivo(id), "utf8")) as Sesion
      sesion = { ...guardada, ocupada: false }
    } catch {
      // sesión nueva
    }
    this.memoria.set(id, sesion)
    return sesion
  }

  async buscar(id: string): Promise<Sesion | null> {
    const s = await this.obtener(id)
    return s.vista.length > 0 ? s : null
  }

  async guardar(sesion: Sesion): Promise<void> {
    try {
      await escribir(this.archivo(sesion.id), JSON.stringify({ ...sesion, ocupada: false }))
    } catch {
      // si el disco falla, la sesión sigue en memoria
    }
  }

  private archivo(id: string): string {
    return path.join(this.dir, `${id}.json`)
  }
}
