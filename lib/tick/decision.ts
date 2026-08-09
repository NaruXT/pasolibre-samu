/**
 * `forzar_rojo_cruce` nunca lo produce el LLM (el schema de `agent.ts` solo permite las otras
 * tres) — lo sintetiza `orquestarTick` como salvaguarda mecánica cuando un semáforo vecino, a
 * metros de distancia (misma intersección física, ver `semaforosVecinos`), se acaba de forzar a
 * verde para la ambulancia: el tránsito transversal no debe tener luz verde al mismo tiempo.
 */
export type AccionSemaforo =
  | "anticipar_verde"
  | "extender_verde"
  | "mantener_ciclo"
  | "forzar_rojo_cruce";

/** Decisión del agente (LLM) para un semáforo — no conoce `ambulanceId`, no le hace falta. */
export interface DecisionSemaforo {
  semaforoId: string;
  accion: AccionSemaforo;
  explicacion: string;
}

/**
 * Forma publicada a semaforos-ruta-1 — issue #12/#14: `ambulanceId` scopea "ya decidido" por
 * trayecto, no solo por semáforo (gap documentado desde ticket #7, ver CLAUDE.md).
 */
export interface DecisionSemaforoPublicada extends DecisionSemaforo {
  ambulanceId: string;
}
