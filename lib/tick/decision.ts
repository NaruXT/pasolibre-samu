export type AccionSemaforo = "anticipar_verde" | "extender_verde" | "mantener_ciclo";

/** Forma publicada a semaforos-ruta-1 — ver CLAUDE.md, ticket #7. */
export interface DecisionSemaforo {
  semaforoId: string;
  accion: AccionSemaforo;
  explicacion: string;
}
