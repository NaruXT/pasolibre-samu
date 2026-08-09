import { describe, expect, test } from "bun:test";
import { faseEfectiva } from "./faseEfectiva";

// offset("Z") = 15 bajo el hash actual (ver fase.ts) → t=45 da tiempoEnCiclo=60 → rojo.

describe("faseEfectiva", () => {
  test("sin decisiones previas, la fase efectiva es igual a la física (t=45, offset=15 → rojo)", () => {
    expect(faseEfectiva("Z", 45, [])).toEqual({ fase: "rojo", segundosRestantes: 30 });
  });

  // t=45, offset=15 ("Z") físicamente es rojo (ver fase.test.ts) — una decisión previa de
  // anticipar_verde debe forzar verde de todas formas, ignorando el ciclo físico.
  test("una decisión previa de anticipar_verde fuerza verde aunque el ciclo físico esté en rojo", () => {
    expect(faseEfectiva("Z", 45, ["anticipar_verde"])).toEqual({
      fase: "verde",
      segundosRestantes: Infinity,
    });
  });

  test("una decisión previa de extender_verde también fuerza verde", () => {
    expect(faseEfectiva("Z", 45, ["extender_verde"])).toEqual({
      fase: "verde",
      segundosRestantes: Infinity,
    });
  });

  test("una decisión previa de mantener_ciclo no interviene: sigue el ciclo físico", () => {
    expect(faseEfectiva("Z", 45, ["mantener_ciclo"])).toEqual({
      fase: "rojo",
      segundosRestantes: 30,
    });
  });

  // offset("A")=23 (ver fase.test.ts) → t=10 da tiempoEnCiclo=33 → físicamente verde — la
  // salvaguarda de cruce debe forzar rojo de todas formas, para no dejar pasar tránsito
  // transversal mientras el vecino de esta intersección está abierto para la ambulancia.
  test("un forzar_rojo_cruce fuerza rojo aunque el ciclo físico esté en verde", () => {
    expect(faseEfectiva("A", 10, ["forzar_rojo_cruce"])).toEqual({
      fase: "rojo",
      segundosRestantes: Infinity,
    });
  });

  // En la práctica nunca coexisten (una sola decisión publicada por semáforo por trayecto, ver
  // orquestar.ts) pero de coexistir, el verde propio gana — una ambulancia con decisión directa
  // para este semáforo nunca debe quedar bloqueada por la protección de cruce de un vecino.
  test("un verde propio gana sobre un forzar_rojo_cruce si ambos coexistieran", () => {
    expect(faseEfectiva("Z", 45, ["forzar_rojo_cruce", "anticipar_verde"])).toEqual({
      fase: "verde",
      segundosRestantes: Infinity,
    });
  });
});
