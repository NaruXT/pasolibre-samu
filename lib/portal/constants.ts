/** Canal descartable usado solo para probar que los paths de publicación cliente/servidor funcionan (ticket #1). */
export const PORTAL_SETUP_TEST_CHANNEL_ID = "setup-test-1";

/**
 * La semántica de los canales está fija según el Intent Layer de CLAUDE.md — no cambies el
 * publisher ni el carácter ephemeral sin actualizar también ese doc.
 */

/**
 * Issue #12/#15: un canal Portal real y separado por ambulancia (decisión explícita del
 * usuario, en vez de un único canal compartido con `ambulanceId` como campo del payload) — el
 * patrón que usaría un fleet-tracking real: cada unidad su propio topic, aislado de las demás.
 * Cliente, una publicación por trayecto, no ephemeral — geometría/metadata de la ruta calculada.
 */
export function rutaAmbulanciaChannelId(ambulanceId: string): string {
  return `ruta-ambulancia-${ambulanceId}`;
}

/** Cliente, ephemeral: true, WebSocket — posición en vivo de esta ambulancia, un envío por tick. */
export function ambulanciaChannelId(ambulanceId: string): string {
  return `ambulancia-${ambulanceId}`;
}

/**
 * Canal de descubrimiento (issue #12/#15): con canales dinámicos por ambulancia, un watcher
 * (`/ambulance-watch`) no puede saber de antemano qué `ambulanceId` existen. Cada ambulancia
 * anuncia acá su propio id al arrancar (una publicación, no ephemeral, mismo patrón que
 * ruta-ambulancia-*) — el watcher se suscribe a este único canal fijo para descubrir cuáles
 * canales por-ambulancia suscribir dinámicamente.
 */
export const PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID = "ambulancias-activas";

/**
 * Canal de "detención" (post-slice #16, a pedido del usuario): cuando el servidor detiene una
 * simulación explícitamente (reset por click o `pagehide` de la pestaña que la arrancó — ver
 * `detenerSimulacionServidor`), publica acá para que TODOS los observadores (no solo quien la
 * detuvo) le quiten el marker de inmediato. Una llegada natural a destino NO publica acá — ya
 * se comunica sola vía `arrived: true` en el propio canal de posición; este canal es solo para
 * el caso que ningún observador podría inferir por su cuenta (el servidor dejó de moverla, pero
 * seguiría "viva" en pantalla para siempre sin este aviso).
 */
export const PORTAL_AMBULANCIAS_DETENIDAS_CHANNEL_ID = "ambulancias-detenidas";

/** Servidor, REST, no ephemeral — decisiones del agente (mock en el ticket #7) por semáforo. */
export const PORTAL_SEMAFOROS_CHANNEL_ID = "semaforos-ruta-1";
