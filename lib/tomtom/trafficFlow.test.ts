import { describe, expect, test } from "bun:test";
import { nivelDeCongestion } from "./trafficFlow";

describe("nivelDeCongestion", () => {
  test("velocidad actual igual a la de flujo libre es fluido", () => {
    expect(nivelDeCongestion(60, 60)).toBe("fluido");
  });

  test("justo en el borde fluido/moderado (ratio 0.8) es fluido", () => {
    expect(nivelDeCongestion(48, 60)).toBe("fluido");
  });

  test("un poco por debajo del borde (ratio < 0.8) es moderado", () => {
    expect(nivelDeCongestion(47, 60)).toBe("moderado");
  });

  test("justo en el borde moderado/congestionado (ratio 0.5) es moderado", () => {
    expect(nivelDeCongestion(30, 60)).toBe("moderado");
  });

  test("un poco por debajo del borde (ratio < 0.5) es congestionado", () => {
    expect(nivelDeCongestion(29, 60)).toBe("congestionado");
  });

  test("velocidad actual cero con flujo libre normal es congestionado", () => {
    expect(nivelDeCongestion(0, 60)).toBe("congestionado");
  });

  test("velocidad de flujo libre cero (dato inválido) no divide por cero: fluido por default", () => {
    expect(nivelDeCongestion(10, 0)).toBe("fluido");
  });
});
