const DURACION_CICLO_SEGUNDOS = 90;
const DURACION_VERDE_SEGUNDOS = 45;

/** Offset determinístico en [0, 90) — suma de charCodes del id, mod 90. Nunca aleatorio. */
function offsetDeSemaforo(semaforoId: string): number {
  let suma = 0;
  for (let i = 0; i < semaforoId.length; i++) {
    suma += semaforoId.charCodeAt(i);
  }
  return suma % DURACION_CICLO_SEGUNDOS;
}

export interface FaseSemaforo {
  fase: "rojo" | "verde";
  segundosRestantes: number;
}

/**
 * Fase de un semáforo como función pura de (semaforoId, tiempoTranscurrido) — ciclo de 90s
 * (45s verde / 45s rojo), con el offset de cada semáforo derivado determinísticamente de su id.
 */
export function faseDeSemaforo(semaforoId: string, tiempoTranscurrido: number): FaseSemaforo {
  const offset = offsetDeSemaforo(semaforoId);
  const bruto = (tiempoTranscurrido + offset) % DURACION_CICLO_SEGUNDOS;
  const tiempoEnCiclo = (bruto + DURACION_CICLO_SEGUNDOS) % DURACION_CICLO_SEGUNDOS;

  if (tiempoEnCiclo < DURACION_VERDE_SEGUNDOS) {
    return { fase: "verde", segundosRestantes: DURACION_VERDE_SEGUNDOS - tiempoEnCiclo };
  }
  return { fase: "rojo", segundosRestantes: DURACION_CICLO_SEGUNDOS - tiempoEnCiclo };
}
