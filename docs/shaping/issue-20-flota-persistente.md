---
shaping: true
---

# Issue #20 — Flota persistente de ambulancias — Shaping

## Frame

### Source

> Usuario, esta sesión: reportó que después de que una ambulancia llegaba a destino, un click nuevo hacía aparecer varias ambulancias — se investigó y se confirmó en vivo (Portal real: 4 `ambulanceId` anunciados sin marca de detención, todos con último tick real 5-11 minutos antes de la consulta). Causa raíz: el modelo actual trata cada ambulancia como un viaje efímero de un solo uso — al llegar, no publica ninguna señal durable de "terminé", así que cualquier reprocesamiento del canal de descubrimiento la vuelve a mostrar, congelada en su origen.

> Usuario, propuesta original: "que pasa si defino mi flota con el botón 'Agregar ambulancia' pero ese evento únicamente crea el canal y un emisor (Ambulancia), estas ambulancias se quedan activas pero escuchando que alguien pida una atención o urgencia entonces aquella que este mas cerca le asigna el mensaje a ese canal de la ambulancia lo cual la pone en ejecución para ir al punto solicitado y luego continua su ejecución para llegar al hospital más cercano, culminado el proceso nuevamente se queda en escucha".

> Usuario, refinamiento con 3 consideraciones explícitas: botón "Llamada de emergencia" (asignación por cercanía, un canal atiende máximo 1 persona a la vez), botón "Fin de turno" (cierra el canal de una unidad disponible, no debe reaparecer en la siguiente carga), y las unidades libres deben verse en movimiento, no inmóviles.

Sesión de grilling completa — 7 decisiones cerradas, resumidas en Requirements abajo.

### Problem

El modelo actual (`ambulanceId` = un viaje, se crea y se descarta) no tiene ningún concepto de "unidad disponible esperando trabajo". Esto produce dos problemas reales, uno de bug y uno de fidelidad:
- **Bug**: la llegada natural nunca publica una señal durable de cierre — solo se comunica en vivo, vía un mensaje ephemeral, a quien esté observando en ese instante. Cualquier cliente que reconstruya el estado después (recarga, u otra reprocesada del canal de descubrimiento) no tiene forma de distinguir "ya llegó" de "sigue viva".
- **Fidelidad**: en un despacho real (SAMU), las unidades no nacen por incidente — existen de antemano, están disponibles o no, y un despachador les asigna la llamada más cercana. El modelo de "un click crea y mueve una ambulancia" nunca pudo representar eso.

### Outcome

Las ambulancias pasan a ser unidades de flota persistentes con estado explícito (libre/ocupada). Una "llamada de emergencia" se resuelve asignando la unidad libre más cercana, que atiende el llamado (recogida → hospital, con orquestación semafórica completa en ambos tramos) y vuelve a quedar libre — patrullando visiblemente, no inmóvil — hasta la próxima asignación o hasta que alguien la retire explícitamente con "Fin de turno". Como consecuencia directa (no como fix aparte), el bug de markers fantasma por llegada natural deja de poder ocurrir: ya no hay "terminó en silencio", solo "volvió a libre" o "se retiró".

---

## Hechos del sistema actual (CURRENT)

- **Un click = un `ambulanceId` nuevo con un viaje completo**: `components/EmergencyMap.tsx` (click handler, ~línea 397) siempre genera `crypto.randomUUID()` y hace `POST /api/ambulance/[id]/simulate`, que calcula hospital + ruta y arranca el movimiento de inmediato. No existe ningún estado intermedio "dado de alta, sin viaje".
- **`iniciarSimulacionServidor`** (`lib/tick/simulacion.ts`) hace, en una sola llamada: hospital más cercano (`hospitalMasCercano`), ruta real (`fetchDrivingRoute`), publish de ruta + anuncio, y arranca `InterpoladaPosicionSource`. No hay separación entre "existir" y "tener un destino".
- **`InterpoladaPosicionSource`** (`lib/mapbox/posicionSource.ts`) recorre una ruta fija una sola vez y limpia su timer al llegar (`arrived`) — no soporta recorrer en loop indefinidamente, que es lo que necesita el patrullaje.
- **Reserva síncrona en memoria ya existe como patrón**: `MAX_SIMULACIONES_ACTIVAS = 8` (`lib/tick/simulacion.ts`) chequea y reserva contra `cacheSimulaciones.__simulacionesActivas` (`globalThis`, singleton por proceso) antes de cualquier `await` — es exactamente el mecanismo anti-carrera que necesita la asignación por cercanía, generalizado de "tope de simulaciones" a "estado de flota".
- **Canales Portal por-ambulancia ya existen y son reusables**: `ambulanciaChannelId(id)` (posición), `rutaAmbulanciaChannelId(id)` (ruta), `PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID` (descubrimiento), `PORTAL_AMBULANCIAS_DETENIDAS_CHANNEL_ID` (detención) — `lib/portal/constants.ts`. Ninguno necesita reemplazo; `ambulancias-detenidas` en particular pasa de significar "este viaje terminó" (semántica vieja, ambigua) a significar exactamente "esta unidad se retiró de la flota" (semántica nueva, sin ambigüedad — ver R6).
- **`orquestarTick`** (`lib/tick/orquestar.ts`) ya recibe `semaforosPendientes` como parámetro por invocación — no asume una única llamada por ambulancia por vida, así que invocarlo dos veces (recogida, luego hospital) para una misma ambulancia no requiere cambios en su firma.
- **El bug de fantasmas por llegada natural es real y actual**: confirmado en vivo contra Portal (script `bun -e` vía `serverReader`) — 4 `ambulanceId` con anuncio pero sin detención, última actividad de tick 5-11 min antes de la consulta, consistente con llegadas naturales que nunca se despublicaron.

---

## Requirements (R)

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | 🟡 Modelo de interacción: click plano sin botón armado no crea nada; **"Agregar ambulancia"** da de alta una unidad libre (sin viaje); **"Llamada de emergencia"** reporta una urgencia y dispara asignación contra la flota existente | Decided |
| R1 | 🟡 Unidad libre patrulla con **posición real** (no cosmética) sobre una ruta real de Mapbox calculada **una sola vez** al dar de alta, recorrida en loop — **sin** orquestación de semáforos/TomTom/LLM mientras está libre | Decided |
| R2 | 🟡 Asignación por cercanía con **reserva síncrona en memoria** (generalización del patrón de `MAX_SIMULACIONES_ACTIVAS`) — sin carrera posible entre llamadas simultáneas. Si no hay ninguna unidad libre: **rechazo simple con mensaje explícito, sin cola** | Decided |
| R3 | 🟡 **"Fin de turno"** solo aplica a unidades libres (nunca a una "en proceso"); se selecciona con **click en el marker → popup con el botón** (mismo patrón que `Semaforo.tsx`); la baja es **durable** — la unidad no debe reaparecer en una carga posterior del sitio | Decided |
| R4 | 🟡 Alcance limitado a **ambulancias simuladas**. Las GPS reales (`/api/ambulance/[id]/position`) quedan con su comportamiento actual (autoasignación al prenderse) — extenderles este modelo es un ticket aparte, explícitamente fuera de este | Decided |
| R5 | 🟡 Atender una llamada tiene **dos tramos**, ambos con **orquestación completa** (semáforos + TomTom + LLM): posición actual → punto de la llamada (recogida), y punto de la llamada → hospital más cercano (ya existente, sin cambios) | Decided |
| R6 | La coordinación semafórica no se rompe por reusar la misma ambulancia entre múltiples llamadas a lo largo de su vida (a diferencia del modelo viejo, donde cada llamada era un `ambulanceId` nuevo) | Must-have, implicado por R5 |
| R7 | El bug de markers fantasma por llegada natural (ver Problem) queda resuelto como efecto colateral — no requiere un fix aparte | Consecuencia directa de R0+R3, no alcance nuevo |

**Notas:**
- R0–R5 son las 7 decisiones cerradas en la sesión de grilling (algunas se fusionan en un mismo requirement porque son una sola decisión con dos caras — p.ej. R2 cubre tanto la carrera como el caso sin unidades libres, porque fueron la misma pregunta).
- R6 se vuelve obligatorio como consecuencia de que R5 reutiliza `orquestarTick` dos veces por llamada, para la misma ambulancia — a diferencia del modelo viejo donde cada invocación era de un `ambulanceId` recién nacido.
- R7 no es trabajo nuevo — es la validación de que este rediseño, bien implementado, hace innecesario cualquier patch aparte sobre `ambulancias-detenidas` para el caso de llegada natural.

---

## A: Flota persistente con estado explícito

| Part | Mechanism | Flag |
|------|-----------|:----:|
| **A1** | 🟡 **Estado de flota en servidor** — nuevo módulo (p.ej. `lib/tick/flota.ts`), mismo patrón `globalThis` que `__simulacionesActivas`: un `Map<ambulanceId, { estado: "libre" \| "en_proceso", posicionActual, rutaPatrullaje, ... }>`, singleton por proceso. Generaliza (no reemplaza) el cache que ya existe — el tope de flota (`MAX_SIMULACIONES_ACTIVAS` renombrado a algo como `MAX_FLOTA_ACTIVA`) pasa a contar unidades dadas de alta, libres + ocupadas, no viajes concurrentes. | |
| **A2** | 🟡 **Reserva síncrona para la asignación (R2)** — el endpoint de "Llamada de emergencia" calcula distancias contra las unidades `libre` en A1 y marca la elegida como `en_proceso` **antes** de cualquier `await` (Mapbox, Portal) — mismo mecanismo que ya usa el chequeo de tope, generalizado de "reservar un slot" a "reservar una unidad específica". | |
| **A3** | 🟡 **Loop de patrullaje (R1)** — extiende `InterpoladaPosicionSource` (`lib/mapbox/posicionSource.ts`) con soporte de loop: en vez de limpiar el timer al llegar (`arrived`), **rebota (ping-pong)** — recorre la ruta de vuelta en vez de reiniciar `elapsedSeconds` a 0, para no generar un salto/teletransporte irreal al final de cada tramo (decisión tomada durante la implementación, no estaba en la shaping original). La ruta de patrullaje se calcula **una sola vez** al dar de alta (`fetchDrivingRoute` entre el punto de alta y un punto cercano, ~700m) y se reusa para todo el loop, en ambas direcciones — sin llamadas repetidas a Mapbox por vuelta. | |
| **A4** | 🟡 **Endpoint "dar de alta" (R0)** — nuevo endpoint (p.ej. `POST /api/fleet/[id]/enroll`), reemplaza el uso de `/api/ambulance/[id]/simulate` para el flujo de "Agregar ambulancia": calcula la ruta de patrullaje (A3), registra la unidad en A1 como `libre`, publica en `ambulancias-activas` (reusa el canal de descubrimiento existente sin cambios). No calcula hospital ni arranca ningún viaje. | |
| **A5** | 🟡 **Endpoint "llamada de emergencia" (R0, R2)** — nuevo endpoint (p.ej. `POST /api/fleet/dispatch`, `{lat, lng}`): busca la unidad libre más cercana en A1, reserva (A2), calcula el tramo de recogida (posición actual de la unidad → punto de la llamada) y lo publica en el canal existente de esa ambulancia (`ruta-ambulancia-<id>`) — la unidad abandona su loop de patrullaje de inmediato. Si no hay ninguna libre: 409/404 con mensaje explícito (mismo patrón que el 429 de tope hoy), sin cola (R2). | |
| **A6** | 🟡 **Dos tramos con orquestación completa (R5)** — al llegar al punto de la llamada (fin del tramo de recogida), el mismo flujo que hoy calcula hospital más cercano (`hospitalMasCercano`) y arranca el tramo 2 exactamente como el flujo actual de `iniciarSimulacionServidor`, reusando `orquestarTick` para ambos tramos por separado (semáforos recalculados por tramo vía `semaforosEnRuta`, sin cambios en la firma de `orquestarTick`). | |
| **A7** | 🟡 **Vuelta a libre tras completar la llamada** — al llegar al hospital (tramo 2), la unidad NO se retira ni desaparece: se recalcula una nueva ruta de patrullaje (A3) desde su posición actual y vuelve a estado `libre` en A1. Reemplaza el `cacheSimulaciones.__simulacionesActivas!.delete(ambulanceId)` que hoy corre en `arrived` (`simulacion.ts`) — ya no aplica, "llegar" deja de significar "terminar". | |
| **A8** | ✅ **"Fin de turno" (R3, implementado slice 2/3)** — popup en el marker (mismo patrón que `crearContenidoPopup` en `Semaforo.tsx`, colores reusados vía export). Reusa el canal `ambulancias-detenidas` **tal cual existía** — con el nuevo modelo, ese canal deja de tener el significado ambiguo de "este viaje terminó" y pasa a significar exactamente "esta unidad se retiró". **Corrección respecto a lo planeado acá**: no reusa `DELETE /api/ambulance/[id]/simulate` (esa idea asumía un solo cache compartido) — como A1 (slice 1/3) terminó separando `__flotaActiva` de `__simulacionesActivas`, hizo falta un `DELETE` propio en `/api/fleet/[id]/enroll` llamando a `detenerUnidadFlota` (`lib/tick/flota.ts`). El gating "visible solo si libre" no aplica todavía en la práctica — no hay estado `en_proceso` posible hasta la asignación (slice 3/3), así que toda unidad en `__flotaActiva` hoy es, por construcción, siempre libre; el popup sí se gatea por `tipo: "flota"` (nuevo campo en `AmbulanciaActivaPayload`) para no ofrecerse en un viaje efímero, que no tiene este concepto. | |
| **A9** | 🟡 **GPS real fuera de alcance (R4)** — `POST /api/ambulance/[id]/position` no se modifica; sigue autoasignando destino a la primera posición, sin pasar por A1. Extenderlo es un ticket nuevo, explícitamente pospuesto. | |

## Macro Fit Check: R × A

| Req | Requirement | Addressed? | Answered? |
|-----|-------------|:----------:|:---------:|
| R0 | Modelo de interacción (3 botones/estados) | ✅ (A4, A5) | ✅ |
| R1 | Patrullaje real, sin LLM/TomTom | ✅ (A3) | ✅ |
| R2 | Asignación sin carrera, sin cola | ✅ (A1, A2, A5) | ✅ |
| R3 | Fin de turno: solo libres, click+popup, baja durable | ✅ (A8) | ✅ |
| R4 | GPS real fuera de alcance | ✅ (A9) | ✅ |
| R5 | Dos tramos, orquestación completa en ambos | ✅ (A6) | ✅ |
| R6 | Coordinación semafórica no se rompe al reusar la unidad | ✅ (A6 reusa `orquestarTick` sin cambios de firma) | ✅ |
| R7 | Bug de fantasmas por llegada natural resuelto sin fix aparte | ✅ (A7 elimina el "terminar en silencio"; A8 reusa `ambulancias-detenidas` con semántica ya no ambigua) | ✅ |

Todos los requirements cerrados en la sesión de grilling quedan cubiertos por el approach. Sin partes 🔴 pendientes de decisión — listo para partir en tickets.

### Notas para el corte en tickets (siguiente paso, no parte de este documento)

- A1–A3 (estado de flota + loop de patrullaje) son la base técnica de todo lo demás — probable primer slice, sin depender de UI nueva.
- A4/A8 (dar de alta / fin de turno) son el par simétrico de alta/baja — probable segundo slice, ya con UI (botón + popup).
- A5–A7 (asignación + dos tramos + vuelta a libre) es el flujo de negocio central — probable tercer slice, el más grande, depende de A1–A3.
- A9 no requiere trabajo — es una nota de alcance, no un slice.
