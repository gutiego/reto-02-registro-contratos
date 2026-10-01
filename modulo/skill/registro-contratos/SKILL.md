---
name: registro-contratos
description: Conocimiento del proceso de registro de contratos vigentes (reglas RN1–RN6, esquema del maestro, confianza y revisión humana, alertas). Úsalo al procesar el buzón de contratos.
---

# Proceso de registro de contratos vigentes

## Contexto
El maestro de contratos (`maestro-contratos.csv`) estuvo congelado desde el 2026-05-30. El agente es el punto único de recepción: todo contrato que llegue al buzón se registra, requiera póliza o no.

## Fuentes y destinos
- Buzón: `fixtures/reto-02/buzon/<mensaje_id>/` con `correo.json` y el adjunto (texto del contrato).
- Maestro: el fixture es de solo lectura; se trabaja sobre la copia `out/sharepoint/maestro-contratos.csv`.
- Archivo: `out/sharepoint/Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext>`; los otrosíes se archivan como `<id_contrato>-otrosi-<n>.<ext>`.
- Trazabilidad: `out/sharepoint/historial.jsonl` (altas y cambios), `out/procesados.json` (mensajes ya procesados) y `out/log.jsonl` (cada llamada a herramienta).

## Clasificación (RN1–RN4)
- **Duplicado**: mismo `id_contrato` y mismos `valor`, `fecha_inicio`, `fecha_fin`. No se escribe nada.
- **Actualización**: mismo `id_contrato` (o mismo NIT y objeto con similitud ≥ 0.9) con algún campo distinto, o el documento es un **otrosí**. Se actualiza la fila y se registra el cambio en el historial. Un otrosí solo modifica los campos que menciona; si exige ampliar las garantías, la póliza pasa a `pendiente`.
- **Nuevo**: sin coincidencia. Se inserta.
- **Rechazado**: sin contrato adjunto (p. ej. una cotización) o sin partes ni objeto identificables.

## Confianza y revisión humana (RN5)
- Cada campo extraído trae una confianza en [0, 1]. Los campos ausentes son `null` con confianza 0.
- Campos con confianza < 0.8 van a `requiere_revision`. El registro se detiene hasta que la analista confirma.
- Casos típicos de baja confianza: contrato marco o **por demanda** (valor 0, `valor_indeterminado = true`) y **plazo en meses** contado desde la firma (la fecha fin se deriva: firma + N meses).
- La analista puede corregir **solo** los campos en revisión; el resto debe coincidir con el documento.

## Reglas de los campos (esquema 7.2)
- `nit_cliente`: sin dígito de verificación ni puntos. `pais` se infiere del identificador (NIT → CO, RUC de 13 dígitos → EC, RUC de 11 → PE, RTN → HN) y del texto.
- `estado_poliza`: nuevo registro con póliza → `pendiente`; sin póliza → `no_aplica`.
- `comercial`: nombre resuelto desde `comerciales.json` por el correo remitente. Un remitente desconocido se reporta como advertencia y se registra como `desconocido (<correo>)`; no bloquea.
- `fuente`: `buzon` para lo que entra por el agente.

## Alertas
`out/alertas.md` con tres secciones: contratos que vencen en ≤ 60 días desde `hoy`, contratos con póliza requerida no vigente y contratos registrados desde la fecha de corte (2026-05-30). Los umbrales viven en `src/knowledge/reglas-negocio.json`.
