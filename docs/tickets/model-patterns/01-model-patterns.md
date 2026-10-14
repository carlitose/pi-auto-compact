---
ticket_schema: 1
ticket_id: "ACP-01"
execution_mode: AFK
blocked_by: []
---

# ACP-01 — Umbral por patrón de modelo (`modelPatterns`)

## Artifact Graph
- Artifact ID: `ticket:model-patterns:01`
- Role: `ticket`
- Parent: [model-patterns.md](../../specs/model-patterns.md)

## Parent Spec
[model-patterns.md](../../specs/model-patterns.md)

## What to Build
`modelPatterns` en la configuración: una lista ordenada de regex sobre `provider/id` con su
umbral, buscada después de las claves exactas y antes del general. Versión 0.2.0.

## Acceptance Criteria
- [ ] Un patrón que coincide con `provider/id` da su umbral; gana el primero que coincide; sin
  coincidencia se usa el general.
- [ ] Una clave exacta de `modelThresholds` gana a cualquier patrón.
- [ ] Una lista mal formada, un `match` vacío, un regex que no compila o un umbral fuera de
  rango invalidan el fichero.
- [ ] `/auto-compact` y `/auto-compact model` conservan `modelPatterns`; el «(inherited)»
  muestra el umbral del patrón.
- [ ] README con el ejemplo Anthropic 30% / OpenAI 90%; `package.json` 0.2.0.
- [ ] `npm test` pasa en local y en CI.

## Frontier
Ready.

## Gates
- Intento: el trabajo hasta `main` con CI verde; publicación por el usuario.
- Presupuesto, tiempo e intentos máximos: no fijados.
- Aprobaciones: ver la spec; la publicación en npm está abierta (usuario, 2FA).
- Versión exacta: 0.2.0.
- Bloqueos existentes: ninguno.

## Blocked by
None — can start immediately.
