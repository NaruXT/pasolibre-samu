/** Canal descartable usado solo para probar que los paths de publicación cliente/servidor funcionan (ticket #1). */
export const PORTAL_SETUP_TEST_CHANNEL_ID = "setup-test-1";

/**
 * La semántica de los canales está fija según el Intent Layer de CLAUDE.md — no cambies el
 * publisher ni el carácter ephemeral sin actualizar también ese doc.
 */

/** Cliente, una publicación por trayecto, no ephemeral — geometría/metadata de la ruta calculada. */
export const PORTAL_ROUTE_CHANNEL_ID = "ruta-ambulancia-1";

/** Cliente, ephemeral: true, WebSocket — posición en vivo de la ambulancia, un envío por tick. */
export const PORTAL_AMBULANCE_CHANNEL_ID = "ambulancia-1";

/** Servidor, REST, no ephemeral — decisiones del agente (mock en el ticket #7) por semáforo. */
export const PORTAL_SEMAFOROS_CHANNEL_ID = "semaforos-ruta-1";
