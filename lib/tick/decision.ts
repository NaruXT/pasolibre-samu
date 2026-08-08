export type AccionSemaforo = "anticipar_verde" | "extender_verde" | "mantener_ciclo";

/** Forma publicada a semaforos-ruta-1 — ver CLAUDE.md, ticket #7. */
export interface DecisionSemaforo {
  semaforoId: string;
  accion: AccionSemaforo;
  explicacion: string;
}

/**
 * Decisión mock (ticket #7) — acción fija, sin LLM real todavía. Se reemplaza en el ticket #8
 * por el agente real; la forma de la decisión y el punto de invocación no cambian.
 */
export function decidirAccionMock(semaforoId: string): DecisionSemaforo {
  return {
    semaforoId,
    accion: "mantener_ciclo",
    explicacion: "Decisión mock (ticket #7) — el agente LLM real llega en el ticket #8.",
  };
}
