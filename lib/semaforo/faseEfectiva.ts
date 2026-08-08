import { faseDeSemaforo, type FaseSemaforo } from "./fase";
import type { AccionSemaforo } from "@/lib/tick/decision";

/**
 * Fase "efectiva" de un semáforo: el ciclo físico base, salvo que `accionesPrevias` incluya
 * anticipar_verde o extender_verde, en cuyo caso queda forzado a verde — ambas son
 * intervenciones a favor del verde, así que se tratan igual aquí: una vez que el semáforo se
 * "abrió", no vuelve a ponerse en rojo mientras existan esas acciones. mantener_ciclo no
 * interviene. Esta función no sabe nada de trayectos — quien le pasa `accionesPrevias` decide
 * qué cuenta como "previo" (ver la limitación documentada en `orquestarTick`).
 */
export function faseEfectiva(
  semaforoId: string,
  tiempoTranscurrido: number,
  accionesPrevias: readonly AccionSemaforo[]
): FaseSemaforo {
  const intervino = accionesPrevias.some(
    (accion) => accion === "anticipar_verde" || accion === "extender_verde"
  );
  if (intervino) {
    return { fase: "verde", segundosRestantes: Number.POSITIVE_INFINITY };
  }
  return faseDeSemaforo(semaforoId, tiempoTranscurrido);
}
