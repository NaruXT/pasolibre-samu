import { describe, expect, test } from "bun:test";
import { faseDeSemaforo } from "./fase";

// offset("Z") = 15 y offset("A") = 23 bajo el hash actual (djb2 + finalizador estilo Murmur3
// — ver comentario en fase.ts). Valores calculados aparte, no llamando al código bajo prueba.

describe("faseDeSemaforo", () => {
  test("justo en el borde verde→rojo (t=30, offset=15 → tiempoEnCiclo=45) da rojo", () => {
    expect(faseDeSemaforo("Z", 30)).toEqual({ fase: "rojo", segundosRestantes: 45 });
  });

  test("un segundo antes del borde (t=29, offset=15 → tiempoEnCiclo=44) todavía da verde", () => {
    expect(faseDeSemaforo("Z", 29)).toEqual({ fase: "verde", segundosRestantes: 1 });
  });

  // "A" → offset 23. tiempoTranscurrido=70 → 70+23=93, que cruza el ciclo de 90s y envuelve a 3
  // (93 % 90 = 3) → dentro del tramo verde [0,45).
  test("un offset que cruza el límite del ciclo de 90s envuelve correctamente", () => {
    expect(faseDeSemaforo("A", 70)).toEqual({ fase: "verde", segundosRestantes: 42 });
  });

  // offset=15 ("Z"), t=-20 → t+offset=-5, que en JS da -5 % 90 = -5 (no el resultado matemático
  // correcto); el envoltorio manual (bruto+90)%90 lo corrige a 85 → tramo rojo.
  test("tiempoTranscurrido negativo envuelve hacia atrás del ciclo", () => {
    expect(faseDeSemaforo("Z", -20)).toEqual({ fase: "rojo", segundosRestantes: 5 });
  });

  // Borde rojo→verde: offset=15 ("Z"), t=75 cierra el ciclo completo (75+15=90 % 90 = 0) →
  // vuelve al inicio del tramo verde. Complementa el borde verde→rojo probado arriba.
  test("justo en el borde rojo→verde (t=75, offset=15) vuelve a verde", () => {
    expect(faseDeSemaforo("Z", 75)).toEqual({ fase: "verde", segundosRestantes: 45 });
  });

  test("es determinística: mismos argumentos dan siempre el mismo resultado", () => {
    expect(faseDeSemaforo("semaforo-7", 123)).toEqual(faseDeSemaforo("semaforo-7", 123));
  });

  // "Z" (offset 15) y "A" (offset 23) están desfasados 8s entre sí — en t=22 caen en fases
  // distintas, lo que confirma que el offset depende del id (no es el mismo valor fijo para
  // todos, y no es Math.random() porque ya probamos arriba que es reproducible).
  test("distintos semaforoId producen offsets distintos, no el mismo fijo para todos", () => {
    expect(faseDeSemaforo("Z", 22).fase).not.toBe(faseDeSemaforo("A", 22).fase);
  });

  // Caso concreto del dataset real del ticket #9: IDs cortos y secuenciales ("1".."6") deben
  // producir offsets bien distribuidos, no casi idénticos como con un hash ingenuo de charCodes
  // (ver el comentario en fase.ts). Basta con que no todos caigan en la misma fase a la vez.
  test("IDs secuenciales cortos (1..6, dataset real) no quedan sincronizados entre sí", () => {
    const ids = ["1", "2", "3", "4", "5", "6"];
    const fases = ids.map((id) => faseDeSemaforo(id, 0).fase);
    expect(new Set(fases).size).toBeGreaterThan(1);
  });
});
