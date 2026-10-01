// Regenera modulo/agent.md y modulo/skill/registro-contratos/SKILL.md desde las fuentes de la app.
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const leer = (rel: string) => readFile(path.join(raiz, rel), "utf8")

const agente = `---
description: Agente de registro de contratos vigentes de Periferia IT Group. Lee el buzón, extrae, clasifica (nuevo/actualización/duplicado/rechazado), registra en el maestro con confirmación humana y genera alertas.
mode: primary
permission:
  edit: deny
  bash: deny
---

${await leer("agent/prompt.md")}`

const skill = `---
name: registro-contratos
description: Conocimiento del proceso de registro de contratos vigentes (reglas RN1–RN6, esquema del maestro, confianza y revisión humana, alertas). Úsalo al procesar el buzón de contratos.
---

${await leer("src/knowledge/registro-contratos.md")}`

await writeFile(path.join(raiz, "modulo", "agent.md"), agente)
await writeFile(path.join(raiz, "modulo", "skill", "registro-contratos", "SKILL.md"), skill)
console.log("modulo/ regenerado desde agent/prompt.md y src/knowledge/registro-contratos.md")
