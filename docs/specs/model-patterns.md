# Umbral por patrón de modelo (regex)

## Artifact Graph
- Artifact ID: `spec:model-patterns`
- Role: `spec`
- Standalone: true

### Children
- [ACP-01](../tickets/model-patterns/done/01-model-patterns.md)

## Tipo
Funcionalidad.

## Hechos (2026-10-14)
- 0.1.0 tiene `autoCompactThreshold` (general) y `modelThresholds`, con claves exactas
  `provider/id` o `id`; orden: `provider/id` → `id` → general. Spec de origen:
  `carlitose/pi-personal-config` `docs/specs/auto-compact-model-thresholds.md`, que dejó
  fuera los umbrales por proveedor o patrón.
- El usuario quiere Anthropic al 30% y OpenAI al 90% («vorrei anthropic 30% e openai al 90%»)
  y, para no listar cada modelo, un regex («si fai un regex», 2026-10-14).
- Hoy su configuración lista los 9 modelos `openai-codex/*` uno a uno; un modelo nuevo cae al
  general.
- El fichero se lee en `session_start` y en los dos comandos; un fichero inválido da aviso y
  70%. `store.save` sustituye el fichero entero.

## Decisión
1. Campo opcional `modelPatterns`: lista ordenada de `{ "match": "<regex>", "threshold": n }`.
   `match` es un `RegExp` de JavaScript sin flags, probado contra `provider/id`; gana el
   primero que coincide. `threshold` sigue la regla del general (25 ≤ n < 100).
2. Orden de búsqueda: `modelThresholds` `provider/id` → `modelThresholds` `id` → primer
   `modelPatterns` que coincide → `autoCompactThreshold`. Lo exacto gana a lo genérico.
3. Una lista que no es un array, un elemento sin `match` de texto no vacío, un regex que no
   compila o un umbral fuera de rango invalidan el fichero entero, como hoy.
4. Los dos comandos conservan `modelPatterns` al guardar; `/auto-compact model` sigue
   escribiendo solo en `modelThresholds` y su «(inherited)» muestra el valor efectivo,
   también cuando viene de un patrón. Los patrones se editan en el fichero.
5. Versión 0.2.0; README con el ejemplo del usuario.

## Fuera de alcance
- Flags del regex, coincidencia con otros campos del modelo, comandos para editar patrones.
- Cambios en la lógica de compactación.

## Gates
- Intento: el trabajo hasta `main` con CI verde, la publicación de 0.2.0, la actualización
  del paquete en este ordenador y la configuración del usuario con dos patrones.
- Presupuesto, tiempo e intentos máximos: no fijados.
- Aprobaciones: el usuario pidió la funcionalidad («si fai un regex»). Merge, actualización y
  cambio de su configuración siguen la práctica de 0.1.0. **Abierta:** la publicación en npm
  la hace el usuario (2FA) desde su terminal.
- Versión exacta: `@carlitose86/pi-auto-compact` 0.2.0.
- Bloqueos existentes: ninguno. Buscado en `package.json`, `tests/`, README.

## Verificación
- `npm test`: patrón que coincide, orden exacto antes que patrón, primero que coincide gana,
  sin coincidencia cae al general, regex inválido y forma inválida rechazan el fichero, los
  comandos conservan los patrones; CI verde.
- Tras publicar y actualizar: una sesión Pi separada con el patrón compacta al umbral del
  patrón.
