# lib/

## Purpose

Toda la lógica de dominio y los I/O boundaries del proyecto (orquestación de ticks, Portal SDK, Mapbox, TomTom, datasets de semáforos/hospitales). No contiene rutas HTTP (`app/api/`) ni componentes React (`components/`) — solo funciones puras y clientes de servicios externos que esas capas consumen.

## Estructura

- `lib/tick/` — el seam de orquestación: `orquestarTick` (ETA → fase → TomTom → LLM → publish), `agent.ts` (LLM), `decision.ts`, `eta.ts`, `simulacion.ts` (ciclo de vida de ambulancias simuladas, corre server-side), `deps.ts` (factory de dependencias reales, compartida entre `/api/tick` y `/api/ambulance/[id]/position`).
- `lib/portal/` — cliente, constantes de canales, shapes de mensajes, y lectura server-side vía WebSocket anónimo (`serverReader.ts`).
- `lib/semaforo/` — fase determinística del semáforo (`fase.ts`, `faseEfectiva.ts`) + dataset real de 3784 nodos OSM cubriendo Lima Metropolitana completa (`semaforosSanBorjaYColindantes.ts`, ~331KB — es el archivo que hace que este directorio cruce el umbral de tokens, no complejidad de lógica).
- `lib/hospital/` — selección de hospital más cercano por ruta real (`hospitalMasCercano.ts`) + dataset real de 20 hospitales OSM.
- `lib/mapbox/` — Directions API (`directions.ts`) + fuentes de posición intercambiables (`posicionSource.ts`: interpolada vs. GPS real).
- `lib/tomtom/` — Traffic Flow API para congestión cruzada en cada semáforo.

## Entry Points

- `lib/tick/orquestar.ts#orquestarTick` — único seam que arma ETA → fase → TomTom → LLM → publish. Invocado desde `app/api/tick` y desde `app/api/ambulance/[id]/position`.
- `lib/tick/simulacion.ts#iniciarSimulacionServidor` / `detenerSimulacionServidor` — ciclo de vida completo de una ambulancia simulada (arranca en `app/api/ambulance/[id]/simulate`).
- `lib/portal/serverReader.ts#obtenerCanalServidor` — único punto para adquirir un canal Portal del lado servidor (cacheado por `channelId`, singleton de vida larga).

## Contratos e invariantes

(La razón detrás de cada uno vive en `../CLAUDE.md` — no duplicado acá, solo la regla.)

- ETA y fase de semáforo son funciones puras — deben poder correr en tests sin mocks. Solo los boundaries de I/O (TomTom, LLM, Portal) se reemplazan con test doubles.
- "Decidido una vez por semáforo por trayecto" se escopa por `(semaforoId, ambulanceId)`, no solo `semaforoId` — ver `obtenerAccionesPreviasSemaforo`.
- Cualquier lectura de `.messages` de un canal Portal del lado servidor DEBE esperar `esperarBackfillDe(...)` antes de leer — `status === "ready"` no garantiza que el historial ya llegó (race real, corregida dos veces — cliente y servidor — ver issue #18).
- `semaforosSanBorjaYColindantes.ts` y `hospitalesSanBorjaYColindantes.ts` son datasets estáticos generados vía Overpass — no se regeneran en runtime; no editar a mano sin volver a correr la query original (ver `CLAUDE.md` para el query exacto por dataset).
- Máximo 8 simulaciones activas a la vez (`MAX_SIMULACIONES_ACTIVAS`), chequeado en `iniciarSimulacionServidor` antes de gastar cualquier llamada real (Mapbox/LLM).

## Patrones

Agregar un nuevo canal Portal dinámico (por ejemplo, uno más por ambulancia):
1. Agregar el generador de id en `lib/portal/constants.ts` (`xChannelId(id)`).
2. Agregar el payload shape en `lib/portal/messages.ts`.
3. Adquirir vía `obtenerCanalServidor<Payload>(channelId)` — nunca instanciar `Portal`/`ChannelHandle` directo fuera de `serverReader.ts`.

## Anti-patrones

- No llamar a Mapbox/TomTom/Portal directo desde `app/api/*` — siempre a través de `lib/*`.
- No guardar el resultado de `offsetDeSemaforo` en un store separado — es una función pura de `(semaforoId, elapsedTime)`, recalcularla siempre en vez de cachear estado.
- No leer `.messages` de un `ChannelHandle` del lado servidor sin `esperarBackfillDe` primero.

## Contexto relacionado

- Invariantes globales y rationale completo de cada decisión: `../CLAUDE.md`
- Shaping doc del issue #12 (multi-ambulancia, GPS real, hospital dinámico): `../docs/shaping/issue-12-destino-y-ambulancias.md`
