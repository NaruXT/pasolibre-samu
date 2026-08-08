import { describe, expect, test } from "bun:test";
import { faseEfectiva } from "./faseEfectiva";

describe("faseEfectiva", () => {
  test("sin decisiones previas, la fase efectiva es igual a la física (t=45, offset=0 → rojo)", () => {
    expect(faseEfectiva("Z", 45, [])).toEqual({ fase: "rojo", segundosRestantes: 45 });
  });

  // t=45, offset=0 ("Z") físicamente es rojo (ver fase.test.ts) — una decisión previa de
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
      segundosRestantes: 45,
    });
  });
});
