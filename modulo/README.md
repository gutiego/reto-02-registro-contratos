# Módulo reutilizable

- `agent.md`: el system prompt de `agent/prompt.md` con frontmatter de agente.
- `tools/contratos.ts`: re-exporta las herramientas reales de `src/tools/contratos.ts` (no es una copia).
- `skill/registro-contratos/SKILL.md`: el conocimiento de `src/knowledge/registro-contratos.md`.

`agent.md` y `SKILL.md` se regeneran desde las fuentes con `npm run modulo`, para que no diverjan.
