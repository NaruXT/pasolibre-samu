const DURACION_CICLO_SEGUNDOS = 90;
const DURACION_VERDE_SEGUNDOS = 45;

/**
 * Finalizador estilo MurmurHash3 (avalancha de bits) — sin esto, IDs cortos y secuenciales
 * como "1".."6" (el dataset real del ticket #9) producen offsets casi idénticos con un hash
 * ingenuo (p. ej. una suma de charCodes), sincronizando los semáforos entre sí y arruinando la
 * demo de coordinación. Determinístico, cero `Math.random()`.
 */
function mezclarBits(h: number): number {
  h = h >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Offset determinístico en [0, 90), derivado del id vía djb2 + finalizador. Nunca aleatorio. */
function offsetDeSemaforo(semaforoId: string): number {
  let hash = 5381;
  for (let i = 0; i < semaforoId.length; i++) {
    hash = ((hash * 33) ^ semaforoId.charCodeAt(i)) >>> 0;
  }
  return mezclarBits(hash) % DURACION_CICLO_SEGUNDOS;
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
