# SOLUCIÓN — Reto 02 · Agente "Registro de Contratos Vigentes"

## 1. Problema en una frase

El maestro de contratos está congelado desde el 2026-05-30 y solo llegan a administración los contratos con póliza, así que **nadie sabe qué contratos están vigentes, cuáles vencen ni qué pólizas faltan**. Le duele a la analista administrativa (dueña del maestro y de las pólizas), a la gerencia (sin visibilidad de vigencias ni riesgo) y a la empresa, porque el proceso dependía de una sola persona.

## 2. Arquitectura

```
┌──────────────────┐  POST /api/chat   ┌──────────────────────────────────────────────┐
│ web/index.html   │ ────────────────▶ │ src/server.ts (Hono)                         │
│ chat, tool calls │ ◀──────────────── │  ├─ src/agent/ciclo.ts   bucle + CA1/CA3      │
│ visibles, banda  │  {reply, toolCalls│  ├─ src/agent/sesiones.ts memoria + out/sesiones
│ de confirmación  │   needsConfirm.}  │  ├─ src/llm/adapter.ts   interfaz propia      │
└──────────────────┘                   │  │   └─ anthropic.ts     implementación       │
                                       │  └─ src/tools/registro.ts zod + log (CA4/RN7) │
                                       └───────────────┬──────────────────────────────┘
                                                       │ (también desde demo.ts y modulo/)
                                       ┌───────────────▼──────────────────────────────┐
                                       │ src/tools/contratos.ts (5 herramientas P0)    │
                                       │  extraccion · maestro · analisis · escritura ·│
                                       │  alertas (helpers, no son herramientas)       │
                                       └───────┬───────────────────────────┬──────────┘
                                 fixtures/reto-02/ (solo lectura)     out/ (escritura)
                                 buzon/, maestro-contratos.csv,       sharepoint/maestro-contratos.csv,
                                 comerciales.json                     sharepoint/Contratos/..., historial.jsonl,
                                                                      procesados.json, log.jsonl, alertas.md
```

- **Comportamiento**: `agent/prompt.md` (orden de herramientas, prohibición de afirmar valores sin herramienta, confirmación explícita, formato de respuesta).
- **Conocimiento**: `src/knowledge/registro-contratos.md` (proceso y reglas, se anexa al system prompt) y `src/knowledge/reglas-negocio.json` (umbral de confianza 0.8, similitud 0.9, 60 días de alerta, fecha de corte, monedas, países, tipos de póliza, sufijos de razón social). Cambiar una regla de negocio no toca el servidor ni las herramientas.
- **Ejecución**: `src/tools/`. Solo los exports de `contratos.ts` son herramientas (`contratos_leer_buzon`, `contratos_extraer`, `contratos_validar`, `contratos_registrar`, `contratos_alertas`); el resto son helpers.

El núcleo (adaptador LLM, ciclo, sesiones, registro de herramientas, servidor y front) se reutilizó del reto 01 con cambios mínimos: el módulo de herramientas, el archivo de conocimiento, el formato del log (ahora `{ ts, herramienta, mensaje_id, ok, resumen }`) y los textos del front.

## 3. Ciclo del agente

`src/agent/ciclo.ts`:

1. Se agrega el mensaje del usuario al historial del modelo y se llama a `ProveedorLLM.enviar(mensajes, herramientas, sistema)`.
2. Si el modelo pide herramientas, `registro.ts` valida los argumentos con zod (si no cumplen, el error vuelve al modelo), ejecuta en `try/catch` (las herramientas nunca lanzan), escribe una línea en `out/log.jsonl` y devuelve el JSON al modelo. Cada llamada queda visible en el chat (nombre, argumentos, resultado).
3. El bucle se repite hasta que el modelo responde sin herramientas o se llega al tope `MAX_ITERACIONES` (25 por defecto, CA1). Al llegar al tope responde con la lista de lo hecho, sin otra llamada al modelo.
4. Hay tope de tokens por sesión (`MAX_TOKENS_SESION`), timeout al proveedor y traducción de errores del proveedor a lenguaje claro (CA5). La sesión nunca muere por un error.

**Confirmación humana (CA3)**, en dos capas:
- Cuando una herramienta deja algo pendiente devuelve `pide_confirmacion: true` (`contratos_validar` con campos en revisión y `contratos_registrar` cuando se niega por revisión). El ciclo marca el turno con `needsConfirmation` y el front lo resalta con botones "Sí, confirmo / No, todavía no".
- En el siguiente mensaje, el servidor calcula `ctx.confirmacionHumana` = (el turno anterior pidió confirmación) ∧ (el mensaje del usuario es una confirmación explícita; una negación siempre gana). `contratos_registrar` con campos en revisión solo escribe si `confirmado === true` **y** `ctx.confirmacionHumana !== false`. Así, aunque el modelo se equivoque y mande `confirmado: true` sin que el usuario lo haya dicho, la herramienta lo rechaza.

## 4. Elección del modelo

- **Proveedor y modelo**: Anthropic `claude-opus-5-5`, con `effort: medium` y *fallback* del lado del servidor ante rechazos (beta `server-side-fallback-2026-07-01`).
- **Por qué**: buen uso de herramientas en paralelo (en la prueba procesó los 6 mensajes en pocas iteraciones), respeta bien instrucciones del tipo "no afirmes valores que no salgan de una herramienta" y redacta en español. `effort: medium` basta porque la lógica difícil (extracción, clasificación, validación) es determinista y vive en las herramientas; el modelo orquesta y resume.
- **Costo observado** (precio $4/M de entrada y $20/M de salida): la prueba real con el prompt de la sección 11 y la confirmación consumió **131.959 tokens en total** en la sesión (2 turnos, unas 10 llamadas al modelo). El servidor guarda el total de la sesión, no la división entrada/salida. Estimando ~90 % de entrada (historial + resultados de herramientas reenviados en cada iteración) y ~10 % de salida: ≈ 119 k × $4/M + 13 k × $20/M ≈ **$0,74 por el lote de 6 mensajes, unos $0,12 por caso procesado**. Para bajarlo: caché de prompt para el system prompt y las herramientas, resultados de herramientas más compactos, o un modelo más pequeño para orquestar.

## 5. Estrategia de extracción

Determinista (regex y heurísticas sobre el `.txt`), en `src/tools/extraccion.ts`. El modelo **no** extrae ni corrige valores.

- **Tipo de documento**: primera línea (`CONTRATO…` → contrato, `OTROSÍ…` → otrosí, `COTIZACIÓN` → cotización; lo demás, desconocido). Una cotización se rechaza (RN4).
- **Número de contrato**: último `No. XX-AAAA-N` de la primera línea (en un otrosí es el contrato base).
- **Partes**: patrón `RAZÓN SOCIAL, (identificada con) NIT|RUC|RTN número`. Se toma la primera parte cuyo identificador no es el NIT propio de Periferia. La razón social con mayúsculas y minúsculas correctas se recupera del bloque de firmas. NIT sin dígito de verificación ni puntos.
- **País**: por tipo y longitud del identificador (NIT → CO, RUC 13 → EC, RUC 11 → PE, RTN → HN) y por el texto ("Quito, Ecuador", "Lima, Perú"). Si ambas fuentes coinciden la confianza es 0.95; si solo hay una, 0.7.
- **Objeto**: párrafo de la cláusula `OBJETO`, recortado a 200 caracteres.
- **Valor y moneda**: párrafo `VALOR`, patrón `(MON $ número)`. El formato numérico se detecta por el separador decimal (`265.000.000` → 265000000; `120,000.00` → 120000). Si el texto dice "no tiene un valor determinado" o "por demanda": `valor = 0`, `valor_indeterminado = true`, **confianza 0.5**. Moneda fuera de la lista → `null`, confianza 0 y error al registrar.
- **Plazo**: párrafo `PLAZO`. Con dos fechas en letras y número (`quince (15) de agosto de 2026`) → inicio y fin (0.95). Si solo dice "N meses contados a partir de la firma" → `fecha_inicio` = fecha de firma y `fecha_fin` = firma + N meses, **confianza 0.6** porque es derivada. Si la firma solo indica el mes ("en el mes de agosto de 2026") y el correo es de ese mismo mes, se usa la fecha del correo (0.8; dos fuentes coinciden en el mes). Las fechas imposibles (31 de febrero) quedan en `null`.
- **Póliza**: menciones de `póliza de <tipo>` o `garantías de <tipo>`, mapeadas con `tipos_poliza`. Si está condicionada ("para cada orden … cuyo valor supere") la confianza baja a 0.8. En un otrosí que exige "ampliar" las garantías, la póliza pasa a `pendiente`.
- **Campo ausente** → `null` con confianza 0, nunca inventado.

**Dónde entra el modelo**: decide el orden de las llamadas, resume en lenguaje natural, formula la pregunta de confirmación y transmite las correcciones que dicta la usuaria. **Dónde no**: el valor que se registra siempre sale de la herramienta. `contratos_validar` y `contratos_registrar` **re-extraen** el documento por dentro y comparan el `contrato` que envía el modelo. Si algún campo difiere y **no** estaba en `requiere_revision`, es un conflicto y se rechaza (CA2). Solo los campos en revisión aceptan un valor del modelo, y solo con `confirmado: true` y confirmación humana real.

## 6. Regla de gobierno (propuesta de una página)

**Dueño del proceso**: la analista administrativa es la dueña del maestro de contratos. La Gerencia Administrativa es la instancia de escalamiento. No hay área legal interna: la revisión jurídica queda fuera de este proceso.

1. **Canal único**: `contratos@periferia.com` es el único canal válido para radicar contratos. Lo administra la analista administrativa, con la Gerencia Administrativa como suplente. El agente lee el buzón y es el único que escribe en el maestro (fuente `buzon`). Correos enviados a personas no cuentan como radicados.
2. **Obligación del comercial**: enviar **todo** contrato firmado, tenga póliza o no, y también otrosíes, actas de inicio, actas de terminación o liquidación y renovaciones. Plazo: **3 días hábiles desde la firma**. Formato: PDF con texto (no escaneado), un documento por correo, asunto `[CONTRATO|OTROSI|ACTA] <Cliente> - <No. contrato>`, y en el cuerpo si requiere póliza. El remitente debe estar en `comerciales.json`; si no lo está, el área comercial lo da de alta.
3. **Acuse automático**: en menos de 1 hora hábil el agente responde al remitente con la clasificación (nuevo, actualización, duplicado o rechazado), el número de contrato registrado, la ruta en SharePoint y, si aplica, los campos pendientes de revisión y el motivo del rechazo. Si la póliza queda `pendiente`, copia al corredor de seguros.
4. **Excepciones y escalamiento**:
   - Contrato **sin firmar**: se rechaza con el motivo y el comercial debe reenviarlo firmado.
   - **Sin valor** o por demanda: se registra con valor 0 e indeterminado, previa confirmación de la analista.
   - Campos de baja confianza: los confirma la analista en máximo 2 días hábiles.
   - Si el comercial no responde en 5 días hábiles, se escala a su director comercial. Si pasan 10, se escala a la Gerencia Administrativa, que puede retener la primera factura del contrato hasta que se radique.
5. **Cierre del gap (junio a agosto de 2026)**: una sola campaña de 2 semanas. Finanzas extrae la lista de clientes facturados desde el 2026-05-30. Se cruza contra el maestro y se le envía a cada comercial su lista de contratos faltantes, con plazo de 5 días hábiles para reenviarlos al buzón (con asunto `[MIGRACION]`, fuente `migracion`). Al final, la analista certifica el cierre y lo que no aparezca se escala a la Gerencia.
6. **Indicador mensual**: **% de contratos facturados en el mes que existen en el maestro** (meta ≥ 95 %). Como indicadores secundarios: días promedio entre la firma y la radicación (meta ≤ 3) y número de pólizas `pendiente` con más de 15 días.

## 7. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Extracción determinista con regex y heurísticas, y confianza fija por regla | Que el modelo extraiga los campos | El PRD pide P0 determinista. Es reproducible (la demo corre sin clave), auditable y no "redondea" valores. El costo es que es frágil ante formatos nuevos, lo que se mitiga marcando `null` / baja confianza para revisión. |
| Las herramientas re-extraen y comparan lo que manda el modelo (CA2) | Confiar en el `contrato` que envía el modelo | El modelo podría alterar un valor. Re-extraer cuesta milisegundos y hace que solo los campos en revisión, confirmados por un humano, puedan cambiar. |
| La confirmación se valida en el servidor (`ctx.confirmacionHumana`) además del argumento `confirmado` | Confiar solo en el argumento `confirmado` | Así el modelo no puede "autoconfirmar". |
| `registrar` también procesa duplicados y rechazados (sin escribir en el maestro, solo en `procesados.json`) | Una herramienta aparte, o que `validar` marque | Mantiene `validar` de solo lectura y el contrato de 5 herramientas del PRD. |
| CSV propio (parser y escritor con escapado RFC 4180) | Librería CSV | El esquema es fijo y pequeño; se evita una dependencia. |
| Otrosí archivado como `<id>-otrosi-<n>.<ext>` sin cambiar `ruta_sharepoint` | Sobrescribir `<id>.<ext>` | No se pierde el documento original. La ruta del otrosí queda en `historial.jsonl`. |
| Similitud NIT + objeto con Dice sobre bigramas | Embeddings | Es determinista y suficiente para el umbral 0.9. |
| Node 20 + tsx | Bun | Bun no estaba instalado y el PRD acepta Node 20+. |

**Dependencias**: `zod` (obligatorio, argumentos de herramientas), `@anthropic-ai/sdk` (proveedor), `hono` + `@hono/node-server` (API HTTP mínima), `tsx` (ejecutar TypeScript sin compilar), `typescript` + `@types/node` (typecheck).

## 8. Supuestos

- Los adjuntos `.txt` son el texto ya extraído del PDF (PRD 3.2). Se aceptan `.txt` y `.pdf` como extensiones de contrato, pero no se lee el PDF (P1 no implementado).
- **msg-006**: la firma solo dice "agosto de 2026". Se toma la fecha del correo (2026-08-31, mismo mes) como fecha de firma e inicio, y la fecha fin es firma + 12 meses = 2027-08-31, lo que coincide con la confirmación del PRD. La moneda COP sale de las cifras en pesos del contrato (0.8). La póliza es condicional por orden de servicio: se registra `requiere_poliza = true` (cumplimiento, `pendiente`) para no perder la alerta.
- **Otrosí (msg-003)**: solo modifica los campos que menciona (valor y fecha fin). El objeto y la fecha de inicio vacíos no se tratan como faltantes. Como exige ampliar las garantías, `estado_poliza` pasa de `vigente` a `pendiente`; no estaba explícito en el PRD, pero refleja el riesgo real.
- **Comercial desconocido**: se registra como `desconocido (<correo>)` en la columna `comercial`.
- `fecha_registro` = argumento `hoy` de `contratos_registrar` (el agente pasa la fecha que da el usuario), o la fecha del sistema si no se pasa. Esto mantiene la demo determinista.
- En un contrato (no otrosí), el `estado_poliza` extraído no reemplaza al del maestro: el estado de la póliza es operativo, no viene del documento.
- "Registrados desde el corte" lista las filas con `fecha_registro ≥ 2026-05-30`. Las actualizaciones por otrosí se ven en el historial, no en esa sección.
- La sección 1 de alertas incluye además una nota con los contratos ya vencidos (dato útil que no contradice las 3 secciones).

## 9. Cobertura

| HU | Estado | Nota / qué falta para producción |
|---|---|---|
| HU-1 Leer buzón | Hecho | `tiene_contrato` mira el tipo de documento, no solo la extensión. Falta conexión real a Exchange/Graph. |
| HU-2 Extraer | Hecho | Confianza por campo y `null` cuando el dato no está. Falta OCR / lectura de PDF (P1 `leer_pdf` no implementado) y más plantillas de contrato. |
| HU-3 Validar | Hecho | RN1–RN4, `requiere_revision`, conflictos con lo que envía el modelo, comercial desconocido como advertencia. |
| HU-4 Registrar y archivar | Hecho | Copia del maestro, CSV escapado, archivo por año y cliente, historial, procesados, log. Falta SharePoint real, bloqueo de concurrencia sobre el CSV y versionado. |
| HU-5 Alertas | Hecho | `out/alertas.md` con 3 secciones y `hoy` como argumento. Falta envío programado a gerencia. |
| HU-6 Errores | Hecho | `{ ok:false, error }` legibles (mensaje inexistente, fecha inválida, moneda desconocida, adjunto vacío). El lote continúa. |
| Front, API, sesiones, topes | Hecho | Reutilizados del reto 01. Falta streaming y autenticación. |
| Link público | Hecho | https://reto-02-registro-contratos.onrender.com (Render, plan gratuito). |
| Bonus `modulo/` | Hecho | `agent.md` y `SKILL.md` se generan desde las fuentes (`npm run modulo`); `tools/contratos.ts` re-exporta las herramientas reales. |

## 10. Uso de IA

- **Claude Code (Claude Opus 5.5)**, con subagentes, para construir: leer el PRD y los fixtures, adaptar el núcleo del reto 01, escribir las herramientas, la demo y la documentación, y ejecutar la prueba con el modelo real.
- **Núcleo reutilizado del reto 01**, construido y probado antes con el mismo asistente.
- **Qué se descartó**:
  - Dejar que el modelo extraiga los campos: viola CA2 y hace la demo no determinista.
  - Un parser CSV externo: es innecesario.
  - Poner `fecha_inicio` de msg-006 en el día 1 del mes: daba una fecha fin 2027-08-01, que contradice la confirmación esperada. Se prefirió la fecha del correo cuando cae en el mismo mes, documentada como supuesto.
  - Marcar la moneda de msg-006 para revisión: añadía un campo que el PRD no espera. Se infiere de las cifras en pesos del texto, con confianza 0.8.

## 11. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| PDF escaneados o formatos de contrato nuevos rompen las regex | OCR y extracción asistida por modelo como *propuesta*, siempre validada por la herramienta y confirmada por un humano cuando la confianza es baja. Métricas de % de campos en revisión por plantilla. |
| Falsos duplicados o falsas actualizaciones por variaciones de nombre | Deduplicar por NIT antes que por nombre (ya implementado), umbral configurable y revisión humana en caso de duda. |
| Concurrencia sobre el CSV (dos sesiones registrando a la vez) | Mover el maestro a una lista de SharePoint o una base de datos con transacciones; mientras tanto, un lock de archivo. |
| El comercial no envía los contratos (el problema de fondo) | Regla de gobierno, indicador mensual de cobertura contra facturación y escalamiento. |
| Prompt injection dentro del texto del contrato | El texto nunca da instrucciones al agente: los valores salen de regex y las escrituras exigen confirmación humana validada en el servidor. |
| Costo del modelo | Topes de iteraciones y tokens por sesión, caché de prompt y resultados de herramientas compactos. |
| Fuga de la clave | La clave solo vive en una variable de entorno del backend, `.env` está en `.gitignore`, `/api/health` no la expone y los logs no la registran. |
| Datos personales en el chat y los logs | Retención limitada de `out/sesiones` y `log.jsonl`, y autenticación del link en producción. |
