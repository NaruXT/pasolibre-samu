export type AccionSemaforo = "anticipar_verde" | "extender_verde" | "mantener_ciclo";

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
