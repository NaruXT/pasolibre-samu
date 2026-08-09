---
shaping: true
---

# Issue #12 — Destino dinámico + ambulancias múltiples + GPS pluggable — Shaping

## Frame

### Source

> Issue #12 original: "Post-tracer-bullet: GPS real de ambulancia + hospital destino dinámico" (needs-triage, backlog, no fully specificado).

> Usuario, esta sesión: "Hospital dinámico no excluir ninguno, ademas quiero mantener la interpolacion simulada de varias ambulancias recoriendo el mapa ppero tambien la opción de adicionar alguna real con la intefaz GPS pluggable"

### Problem

El destino (Hospital Rebagliati) y la posición de la ambulancia son simplificaciones deliberadas del tracer-bullet (ver `CLAUDE.md`, invariante "Destination is fixed"). Un solo trayecto, una sola ambulancia, un destino fijo. El sistema real necesita: destino calculado dinámicamente por cercanía real (sin filtrar por especialidad, a diferencia de lo que sugería el issue original), varias ambulancias simuladas moviéndose a la vez, y una vía para que una ambulancia con posición GPS real conviva con las simuladas.

### Outcome

El mapa puede mostrar N ambulancias moviéndose simultáneamente (simuladas y/o reales), cada una con su propio destino calculado dinámicamente al hospital más cercano, sin que el sistema de coordinación semafórica se rompa por mezclarlas.

---

## Hechos del sistema actual (CURRENT)

- **Destino fijo**: `REBAGLIATI` es un `const` local no exportado en `components/EmergencyMap.tsx:22` — no hay módulo compartido.
- **Interpolación**: `ambulancePositionAt(route, elapsedSeconds)` en `lib/mapbox/ambulance.ts:16-33` es pura (route + elapsed → posición), pero el estado (`elapsedSeconds`, timer, marker) vive en refs *singulares* dentro de `EmergencyMap.tsx` (`ambulanceTimerRef`, `ambulanceMarkerRef`, `markerRef`, `semaforosDeLaRutaRef` — una instancia de cada una, líneas 55-60).
- **Sin identidad de trayecto**: ni `RoutePublishPayload` ni `AmbulancePositionPayload` (`lib/portal/messages.ts:6-15`) ni `OrquestarTickInput` (`lib/tick/orquestar.ts:19-22`) tienen `tripId`/`ambulanceId`. Confirmado: sigue siendo cierto (gap conocido desde ticket #7, `CLAUDE.md`).
- **Canales Portal singulares**: `"ambulancia-1"` y `"ruta-ambulancia-1"` son IDs de canal fijos (`lib/portal/constants.ts:10,13`) — un canal total, compartido por lo que sea que esté corriendo.
- **Un solo click = un solo trayecto**: el handler de click en `EmergencyMap.tsx:199-281` siempre llama `stopAmbulance()` primero, matando cualquier timer/marker previo antes de arrancar uno nuevo.
- **Orquestación asume 1 trayecto activo**: `orquestarTick` (`lib/tick/orquestar.ts:62-102`) recibe una sola `posicionAmbulancia` y un solo array `semaforosPendientes`; el check "ya decidido" filtra Portal history por `semaforoId` solo, sin trip, en las ~500 últimas entradas del canal.
- **Patrón Overpass reusable**: `docs/Fuentes_Data.md:41` ya documenta la query análoga para hospitales: `node["amenity"="hospital"]({{bbox}}); out geom;` — mismo patrón que ticket #9 usó para semáforos.

---

## Requirements (R)

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | Hospital destino se calcula dinámicamente desde el punto de emergencia (dataset Overpass `amenity=hospital`, patrón ticket #9), **sin excluir ningún hospital por especialidad** | Core goal |
| R1 | Soportar N ambulancias simuladas moviéndose en el mapa simultáneamente (hoy: máx 1, y arrancar una mata la anterior) | Core goal |
| R2 | Permitir agregar una ambulancia con posición "real" (vía interfaz GPS pluggable) conviviendo con las simuladas | Core goal |
| R3 | La coordinación semafórica (`orquestarTick`) sigue funcionando correctamente con varias ambulancias activas a la vez, sin que una trip pise las decisiones de otra | Must-have |
| R4 | 🟡 Métrica de "hospital más cercano" = **distancia de ruta real (Mapbox Directions)**, no línea recta | Decided |
| R5 | 🟡 Cada ambulancia simulada es un **trayecto independiente completo**, con su propia coordinación semafórica real (no decorativas) | Decided |
| R6 | 🟡 Posición GPS real entra por **endpoint HTTP** (`POST /api/ambulance/:id/position`), no input manual en UI | Decided |
| R7 | Compatibilidad con `/ambulance-watch` — al volverse multi-ambulancia, necesariamente debe mostrar varias en vez de una | 🟡 Implicado por R1+R5, no opcional |

**Notas:**
- R4, R5, R6 decididos por el usuario. R7 se vuelve obligatorio como consecuencia directa de R1+R5 (el canal Portal deja de tener un solo ocupante), no es alcance nuevo.

---

## A: Ambulancias con identidad + destino dinámico + fuente de posición pluggable

| Part | Mechanism | Flag |
|------|-----------|:----:|
| **A1** | **Identidad de trayecto** — `ambulanceId` (`crypto.randomUUID()` en el cliente para simuladas; provisto en la URL para reales) agregado a `RoutePublishPayload`, `AmbulancePositionPayload` (`lib/portal/messages.ts`) y `OrquestarTickInput` (`lib/tick/orquestar.ts`). Resuelve como efecto colateral el gap documentado en ticket #7 (decisión no scoped por trayecto). | |
| **A2** | **Estado multi-instancia en cliente** — reemplaza los refs singulares de `EmergencyMap.tsx` (`ambulanceMarkerRef`, `ambulanceTimerRef`, `markerRef`, `semaforosDeLaRutaRef`, `elapsedSeconds`) por `Map<string, AmbulanceInstance>`, donde cada instancia trae su propio marker/timer/elapsedSeconds/route/destino/semáforos pendientes. | |
| **A3** | **Hospital dinámico** — `lib/hospital/hospitalesSanBorjaYColindantes.ts` (Overpass `amenity=hospital`, mismo patrón de relación distrital que ticket #9) + `lib/hospital/hospitalMasCercano.ts`: preselección por haversine, luego Mapbox Directions real a cada candidato, gana la duración mínima real. Reemplaza el `REBAGLIATI` const de `EmergencyMap.tsx:22`. | |
| **A4** | **`orquestarTick` scoped por `(semaforoId, ambulanceId)`** — `obtenerAccionesPrevias`/`publicarDecision` (`lib/portal/serverReader.ts`, `lib/tick/orquestar.ts`) filtran y publican con ambos campos en vez de solo `semaforoId`. | |
| **A5** | **Interfaz de fuente de posición** — `PosicionSource` con dos implementaciones: `InterpoladaPosicionSource` (envuelve `ambulancePositionAt` existente) y `RealPosicionSource` (lee la última posición recibida por HTTP). Cada `AmbulanceInstance` (A2) referencia cuál usa. | |
| **A6** | **Endpoint de ingestión GPS real** — `POST /api/ambulance/[id]/position` (`{lat, lng, timestamp}`): valida, publica al canal Portal (ahora compartido y tageado por `ambulanceId`, A1), y si es la primera posición de ese id, dispara el cálculo de destino (A3) usando esa posición como origen — mismo flujo que un click simulado. | |
| **A7** | 🟡 **Afordance de UI para agregar ambulancias** — botón explícito **"Agregar ambulancia"** que arma un modo "esperando click de origen"; el click subsiguiente crea la instancia sin tocar las existentes. Distinto de "nueva emergencia" (que hoy resetea todo). | |
| **A8** | 🟡 **`/ambulance-watch` multi-instancia** — todas las `ambulanceId` activas visibles a la vez en el mismo mapa, cada una su propio marker, todas moviéndose en simultáneo. | |

## Macro Fit Check: R × A

| Req | Requirement | Addressed? | Answered? |
|-----|-------------|:----------:|:---------:|
| R0 | Hospital dinámico sin exclusión | ✅ | ✅ |
| R1 | N ambulancias simuladas simultáneas | ✅ | ✅ |
| R2 | Ambulancia real vía GPS pluggable | ✅ | ✅ |
| R3 | Coordinación semafórica no se pisa entre trayectos | ✅ | ✅ |
| R4 | Métrica de ruta real | ✅ | ✅ |
| R5 | Trayecto independiente por ambulancia | ✅ | ✅ |
| R6 | Endpoint HTTP para GPS real | ✅ | ✅ |
| R7 | Watch page multi-ambulancia | ✅ | ✅ |

Shape A queda sin flags — todos los mecanismos están concretamente descritos. Lista para slicing.
