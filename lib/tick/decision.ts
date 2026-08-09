export type AccionSemaforo = "anticipar_verde" | "extender_verde" | "mantener_ciclo";

/** Decisión del agente (LLM) para un semáforo — no conoce `ambulanceId`, no le hace falta. */
export interface DecisionSemaforo {
  semaforoId: string;
  accion: AccionSemaforo;
  explicacion: string;
}

/**
 * Forma publicada a semaforos-ruta-1 — issue #12/#14: `ambulanceId` scopea "ya decidido" por
 * ambulancia. Issue #20/#23: `tramoId` scopea además por LLAMADA atendida, no por la vida
 * entera de la unidad — necesario desde que una unidad de flota reutiliza el mismo
 * `ambulanceId` en cada llamada que atiende (a diferencia de un viaje efímero, donde
 * `ambulanceId` ya era fresco por trayecto). Ver `orquestarTick`/`OrquestarTickInput.tramoId`.
 */
export interface DecisionSemaforoPublicada extends DecisionSemaforo {
  ambulanceId: string;
  tramoId: string;
}
