import { calcularETASegundos, type LngLat } from "./eta";
import type { AccionSemaforo, DecisionSemaforo } from "./decision";
import type { ContextoDecisionSemaforo } from "./agent";
import { faseEfectiva } from "@/lib/semaforo/faseEfectiva";
import type { FaseSemaforo } from "@/lib/semaforo/fase";
import type { CongestionTransversal } from "@/lib/tomtom/trafficFlow";

/** Ventana de decisión propuesta por el ticket #7: ~60s antes de que la ambulancia llegue. */
const VENTANA_DECISION_SEGUNDOS = 60;

export interface SemaforoPendiente extends LngLat {
  semaforoId: string;
}

export interface PosicionAmbulancia extends LngLat {
  velocidadMetrosPorSegundo: number;
}

export interface OrquestarTickInput {
  posicionAmbulancia: PosicionAmbulancia;
  semaforosPendientes: SemaforoPendiente[];
}

export interface ResultadoSemaforo {
  semaforoId: string;
  etaSegundos: number;
  fase: FaseSemaforo;
  decision: DecisionSemaforo | null;
}

export interface OrquestarTickDeps {
  /** Fronteras de I/O real — en producción hablan con Portal/el LLM, en tests son dobles en memoria. */
  obtenerAccionesPrevias: (semaforoId: string) => Promise<AccionSemaforo[]>;
  publicarDecision: (decision: DecisionSemaforo) => Promise<void>;
  /** Agente de decisión (LLM real en producción, ticket #8) — inyectado para no gastar cuota en tests. */
  decidirAccion: (contexto: ContextoDecisionSemaforo) => Promise<DecisionSemaforo>;
  /**
   * Congestión del tráfico transversal (TomTom, ticket #10) — inyectado por la misma razón que
   * `decidirAccion`. Se llama solo dentro de la ventana de decisión de un semáforo, en el mismo
   * punto que gatilla `decidirAccion` (ver abajo): como esa invocación ya ocurre una única vez
   * por semáforo por trayecto, TomTom hereda esa misma garantía sin lógica de rate-limit
   * adicional — es la forma en que este ticket cumple "no re-consultar el mismo semáforo más de
   * una vez por trayecto" contra la cuota gratuita de 2.500 requests/día.
   */
  obtenerCongestionTransversal: (semaforo: SemaforoPendiente) => Promise<CongestionTransversal | null>;
  /** Inyectable para tests determinísticos; por default el reloj real. */
  ahoraSegundos?: () => number;
}

/**
 * El seam principal del proyecto: por cada semáforo pendiente calcula ETA y fase (funciones
 * puras, se ejecutan de verdad), y si el ETA entra en la ventana de decisión y el semáforo
 * todavía no tiene ninguna decisión publicada, invoca al agente (LLM real, ticket #8; `deps`
 * lo inyecta para no gastar cuota en tests) una sola vez y publica su decisión.
 *
 * "Todavía no tiene decisión" se resuelve consultando semaforos-ruta-1 solo por `semaforoId`
 * (ver `deps.obtenerAccionesPrevias`) — no existe un `tripId`/`trayectoId` en ningún payload
 * de este proyecto todavía (tickets #1-#6 tampoco lo tienen), así que esto NO está acotado
 * por trayecto: una decisión de un trayecto anterior para el mismo semaforoId bloquearía una
 * nueva decisión en un trayecto nuevo. Limitación conocida, no resuelta por este ticket.
 */
export async function orquestarTick(
  input: OrquestarTickInput,
  deps: OrquestarTickDeps
): Promise<ResultadoSemaforo[]> {
  const ahora = (deps.ahoraSegundos ?? (() => Date.now() / 1000))();
  const resultados: ResultadoSemaforo[] = [];

  for (const semaforo of input.semaforosPendientes) {
    const etaSegundos = calcularETASegundos(
      input.posicionAmbulancia,
      semaforo,
      input.posicionAmbulancia.velocidadMetrosPorSegundo
    );

    const accionesPrevias = await deps.obtenerAccionesPrevias(semaforo.semaforoId);
    const yaTieneDecision = accionesPrevias.length > 0;

    let decision: DecisionSemaforo | null = null;
    if (etaSegundos <= VENTANA_DECISION_SEGUNDOS && !yaTieneDecision) {
      const faseAntesDeDecidir = faseEfectiva(semaforo.semaforoId, ahora, accionesPrevias);
      const congestionTransversal = await deps.obtenerCongestionTransversal(semaforo);
      decision = await deps.decidirAccion({
        semaforoId: semaforo.semaforoId,
        etaSegundos,
        fase: faseAntesDeDecidir,
        congestionTransversal,
      });
      await deps.publicarDecision(decision);
      accionesPrevias.push(decision.accion);
    }

    resultados.push({
      semaforoId: semaforo.semaforoId,
      etaSegundos,
      fase: faseEfectiva(semaforo.semaforoId, ahora, accionesPrevias),
      decision,
    });
  }

  return resultados;
}
