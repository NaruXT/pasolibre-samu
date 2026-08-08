/** Throwaway channel used only to prove the client/server publish paths work (ticket #1). */
export const PORTAL_SETUP_TEST_CHANNEL_ID = "setup-test-1";

/**
 * Channel semantics are fixed per CLAUDE.md's Intent Layer — don't change publisher or
 * ephemeral-ness without updating that doc too.
 */

/** Client, one publish per trip, not ephemeral — the calculated route's geometry/metadata. */
export const PORTAL_ROUTE_CHANNEL_ID = "ruta-ambulancia-1";

/** Client, ephemeral: true, WebSocket — the ambulance's live position, one send per tick. */
export const PORTAL_AMBULANCE_CHANNEL_ID = "ambulancia-1";
