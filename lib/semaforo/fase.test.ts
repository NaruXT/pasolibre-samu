import { describe, expect, test } from "bun:test";
import { faseDeSemaforo } from "./fase";

// offset = suma de charCodes del id, mod 90 (calculado a mano, no llamando al código bajo prueba):
// "Z" → charCode 90 → 90 % 90 = 0. Offset 0, así que tiempoTranscurrido == tiempo en el ciclo.

describe("faseDeSemaforo", () => {
  test("justo en el borde verde→rojo (t=45, offset=0) da rojo", () => {
    expect(faseDeSemaforo("Z", 45)).toEqual({ fase: "rojo", segundosRestantes: 45 });
  });

  test("un segundo antes del borde (t=44, offset=0) todavía da verde", () => {
    expect(faseDeSemaforo("Z", 44)).toEqual({ fase: "verde", segundosRestantes: 1 });
  });

  // "A" → charCode 65 → offset = 65. tiempoTranscurrido=30 → 65+30=95, que cruza el ciclo de
  // 90s y envuelve a 5 (95 % 90 = 5) → dentro del tramo verde [0,45).
  test("un offset que cruza el límite del ciclo de 90s envuelve correctamente", () => {
    expect(faseDeSemaforo("A", 30)).toEqual({ fase: "verde", segundosRestantes: 40 });
  });

  // offset=0 ("Z"), t=-1 equivale a t=89 dentro del ciclo (-1 % 90 = -1 en JS, pero el
  // resultado matemáticamente correcto envolviendo hacia atrás es 89) → tramo rojo.
  test("tiempoTranscurrido negativo envuelve hacia atrás del ciclo", () => {
    expect(faseDeSemaforo("Z", -1)).toEqual({ fase: "rojo", segundosRestantes: 1 });
  });

  // Borde rojo→verde: offset=0 ("Z"), t=90 cierra el ciclo completo y envuelve a 0
  // (90 % 90 = 0) → vuelve al inicio del tramo verde. Complementa el borde verde→rojo (t=45)
  // probado arriba, cubriendo los dos bordes que pide el acceptance criteria.
  test("justo en el borde rojo→verde (t=90, offset=0) vuelve a verde", () => {
    expect(faseDeSemaforo("Z", 90)).toEqual({ fase: "verde", segundosRestantes: 45 });
  });

  test("es determinística: mismos argumentos dan siempre el mismo resultado", () => {
    expect(faseDeSemaforo("semaforo-7", 123)).toEqual(faseDeSemaforo("semaforo-7", 123));
  });

  // "Z" (offset 0) y "A" (offset 65) están desfasados 65s entre sí — en t=45 caen en fases
  // distintas, lo que confirma que el offset depende del id (no es el mismo valor fijo para
  // todos, y no es Math.random() porque ya probamos arriba que es reproducible).
  test("distintos semaforoId producen offsets distintos, no el mismo fijo para todos", () => {
    expect(faseDeSemaforo("Z", 45).fase).not.toBe(faseDeSemaforo("A", 45).fase);
  });
});
