import { decidirAccionLLM } from "@/lib/tick/agent";
import type { OrquestarTickDeps } from "@/lib/tick/orquestar";
import type { DecisionSemaforoPublicada } from "@/lib/tick/decision";
import { publishToPortalChannel } from "@/lib/portal/server";
import { obtenerAccionesPreviasSemaforo } from "@/lib/portal/serverReader";
import { PORTAL_SEMAFOROS_CHANNEL_ID } from "@/lib/portal/constants";
import { obtenerCongestionTransversal } from "@/lib/tomtom/trafficFlow";
import type { OrigenLlamadaTick } from "@/lib/tick/costLog";

/**
 * Wiring real de `OrquestarTickDeps` — compartido por `/api/tick` (legado, ver nota abajo),
 * `lib/tick/simulacion.ts` (ambulancias simuladas server-side) y
 * `/api/ambulance/[id]/position` (issue #12/#16, GPS real): todos disparan `orquestarTick` desde
 * el servidor y deben decidir/publicar exactamente igual, sin importar de dónde vino el tick.
 *
 * `origen` (skill `cost-audit`, 2026-08-08) es solo para el log de costo del LLM — permite
 * distinguir en el log agregado si el gasto viene de simulaciones, GPS real, o de `/api/tick`
 * (ruta que quedó huérfana tras mover la simulación al servidor — nada la llama ya desde el
 * cliente, pero sigue existiendo; si el log muestra costo real con `origen: "api-tick-legacy"`
 * es señal de que algo externo la sigue golpeando y vale la pena investigar).
 */
export function crearOrquestarTickDepsReales(origen: OrigenLlamadaTick): OrquestarTickDeps {
  return {
    obtenerAccionesPrevias: obtenerAccionesPreviasSemaforo,
    decidirAccion: (contexto) => decidirAccionLLM(contexto, origen),
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
