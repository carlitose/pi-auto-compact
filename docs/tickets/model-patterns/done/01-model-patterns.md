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
- Parent: [model-patterns.md](../../../specs/model-patterns.md)

## Parent Spec
[model-patterns.md](../../../specs/model-patterns.md)

## What to Build
`modelPatterns` en la configuración: una lista ordenada de regex sobre `provider/id` con su
umbral, buscada después de las claves exactas y antes del general. Versión 0.2.0.

## Acceptance Criteria
- [x] Un patrón que coincide con `provider/id` da su umbral; gana el primero que coincide; sin
  coincidencia se usa el general.
- [x] Una clave exacta de `modelThresholds` gana a cualquier patrón.
- [x] Una lista mal formada, un `match` vacío, un regex que no compila o un umbral fuera de
  rango invalidan el fichero.
- [x] `/auto-compact` y `/auto-compact model` conservan `modelPatterns`; el «(inherited)»
  muestra el umbral del patrón.
- [x] README con el ejemplo Anthropic 30% / OpenAI 90%; `package.json` 0.2.0.
- [x] `npm test` pasa en local y en CI.

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

## Evidence
- PR [#1](https://github.com/carlitose/pi-auto-compact/pull/1), implementation commit `5bdfe3e425584378c8af080c58f9b7dce535e3ff`; CI `test` run 38610251089 `success`.
- `npm test` 109/109, with 9 new cases in `tests/model-thresholds.test.mjs` (pattern match and fallback, first match wins, exact before pattern, commands keep patterns, inherited prompt and reset message show the pattern value, five invalid forms reject the file).
- `npm run smoke` and `npm run smoke:recovery` with the installed Pi SDK `dist/index.js`: exit 0.
- `npm pack --dry-run`: version 0.2.0, 4 files, 13.5 kB.
- Publication to npm by the user (2FA) still open.
