# Reto 02 — Agente conversacional "Registro de Contratos Vigentes"

Agente de chat que actúa como punto único de recepción de contratos: lee el buzón, extrae los datos de cada contrato con confianza por campo, detecta duplicados y otrosíes, registra en el maestro (CSV en un SharePoint simulado), pide confirmación humana para los campos dudosos y genera alertas de vencimiento y pólizas.

**Link de prueba:** https://reto-02-registro-contratos.onrender.com (plan gratuito de Render: la primera visita puede tardar 30–60 s en despertar)

## Levantar en local

Requisitos: Node 20+ (se usa `tsx`, no hace falta compilar).

```bash
cp .env.example .env      # y pon tu ANTHROPIC_API_KEY
npm install && npm start  # http://localhost:3000
```

Sin clave el servidor arranca igual; el chat responde con un aviso y las herramientas siguen funcionando con la demo.

## Variables de entorno

| Variable | Default | Uso |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | Proveedor del modelo |
| `ANTHROPIC_API_KEY` | — | Clave del modelo (solo backend; nunca se sube ni se registra en logs) |
| `LLM_MODEL` | `claude-opus-5-5` | Modelo |
| `LLM_TIMEOUT_MS` | `60000` | Timeout por llamada al modelo |
| `MAX_ITERACIONES` | `25` | Tope de iteraciones herramienta → modelo por turno (CA1) |
| `MAX_TOKENS_SESION` | `400000` | Tope de tokens por sesión |
| `PORT` | `3000` | Puerto HTTP |
| `OUT_DIR` | `out` | Directorio de salida |

## Demo sin modelo

```bash
npm run demo     # o: npx tsx demo.ts
```

Limpia `out/`, procesa los 6 mensajes del buzón con las herramientas, deja `msg-006` sin registrar, lo registra en una segunda llamada con `confirmado: true` y termina con `contratos_alertas({ hoy: "2026-09-03" })`.

Salidas: `out/sharepoint/maestro-contratos.csv`, `out/sharepoint/Contratos/...`, `out/sharepoint/historial.jsonl`, `out/procesados.json`, `out/log.jsonl`, `out/alertas.md`.

Para volver a procesar el buzón en el chat, borra `out/` (o corre la demo, que también lo limpia y deja todo procesado).

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, error? }` |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión, tokens consumidos y si espera confirmación |
| `GET` | `/api/health` | `{ ok, provider, model, maxIteraciones }` sin exponer claves |
| `GET` | `/api/archivos/<ruta en out/>` | Descarga de archivos generados (p. ej. `alertas.md`) |

Prompt de ejemplo (sección 11 del PRD): *"Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme."* y después *"confirmo el valor 0 y la fecha fin 2027-08-31"*.

## Estructura

```
agent/prompt.md                     comportamiento (system prompt)
src/knowledge/                      conocimiento: registro-contratos.md + reglas-negocio.json (umbrales, días, corte)
src/tools/contratos.ts              herramientas (cada export → contratos_<export>)
src/tools/{extraccion,maestro,analisis,escritura,alertas}.ts   lógica de apoyo
src/agent/                          ciclo del agente y sesiones
src/llm/                            adaptador de proveedor + implementación Anthropic
src/server.ts                       API HTTP + front estático
web/index.html                      chat
modulo/                             agente empaquetado (bonus 9.4); `npm run modulo` lo regenera
```
