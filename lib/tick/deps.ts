import { decidirAccionLLM } from "@/lib/tick/agent";
import type { OrquestarTickDeps } from "@/lib/tick/orquestar";
import type { DecisionSemaforoPublicada } from "@/lib/tick/decision";
import { publishToPortalChannel } from "@/lib/portal/server";
import { obtenerAccionesPreviasSemaforo } from "@/lib/portal/serverReader";
import { PORTAL_SEMAFOROS_CHANNEL_ID } from "@/lib/portal/constants";
import { obtenerCongestionTransversal } from "@/lib/tomtom/trafficFlow";

/**
 * Wiring real de `OrquestarTickDeps` — compartido por `/api/tick` (ambulancias simuladas) y
 * `/api/ambulance/[id]/position` (issue #12/#16, GPS real): ambos disparan `orquestarTick` desde
 * el servidor y deben decidir/publicar exactamente igual, sin importar de dónde vino el tick.
 */
export function crearOrquestarTickDepsReales(): OrquestarTickDeps {
  return {
    obtenerAccionesPrevias: obtenerAccionesPreviasSemaforo,
    decidirAccion: decidirAccionLLM,
    obtenerCongestionTransversal,
    publicarDecision: async (decision: DecisionSemaforoPublicada) => {
      await publishToPortalChannel({
        channelId: PORTAL_SEMAFOROS_CHANNEL_ID,
        content: decision,
        type: "decision-semaforo",
        senderId: "tick-orchestrator",
      });
    },
  };
}
