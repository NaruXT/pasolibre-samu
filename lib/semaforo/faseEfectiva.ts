import { faseDeSemaforo, type FaseSemaforo } from "./fase";
import type { AccionSemaforo } from "@/lib/tick/decision";

/**
 * Fase "efectiva" de un semáforo: el ciclo físico base, salvo que `accionesPrevias` incluya
 * anticipar_verde o extender_verde, en cuyo caso queda forzado a verde — ambas son
 * intervenciones a favor del verde, así que se tratan igual aquí: una vez que el semáforo se
 * "abrió", no vuelve a ponerse en rojo mientras existan esas acciones. Si no hay intervención a
 * favor del verde pero sí un forzar_rojo_cruce (salvaguarda de intersección, ver
 * `orquestarTick`/`semaforosVecinos`), queda forzado a rojo, con la misma persistencia por el
 * resto del trayecto. El verde propio tiene prioridad sobre el rojo de cruce a propósito: en la
 * práctica nunca coexisten para el mismo semáforo (cada uno recibe una sola decisión publicada
 * por trayecto — ver `orquestarTick`), pero si alguna vez lo hicieran, una ambulancia con
 * decisión directa para ESTE semáforo nunca debe quedar bloqueada por la protección de cruce que
 * generó la apertura de un vecino. mantener_ciclo no interviene. Esta función no sabe nada de
 * trayectos — quien le pasa `accionesPrevias` decide qué cuenta como "previo" (ver la
 * limitación documentada en `orquestarTick`).
 */
export function faseEfectiva(
  semaforoId: string,
  tiempoTranscurrido: number,
  accionesPrevias: readonly AccionSemaforo[]
): FaseSemaforo {
  const intervinoVerde = accionesPrevias.some(
    (accion) => accion === "anticipar_verde" || accion === "extender_verde"
  );
  if (intervinoVerde) {
    return { fase: "verde", segundosRestantes: Number.POSITIVE_INFINITY };
  }
  const forzadoRojoPorCruce = accionesPrevias.some((accion) => accion === "forzar_rojo_cruce");
  if (forzadoRojoPorCruce) {
    return { fase: "rojo", segundosRestantes: Number.POSITIVE_INFINITY };
  }
  return faseDeSemaforo(semaforoId, tiempoTranscurrido);
}
