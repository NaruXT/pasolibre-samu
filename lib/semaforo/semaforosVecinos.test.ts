import { describe, expect, test } from "bun:test";
import { semaforosVecinos } from "./semaforosVecinos";

// 0.0003° de latitud ≈ 33m (1° ≈ 111.2km) — dentro del radio por defecto de 50m.
const CENTRO = { semaforoId: "centro", lng: -77.0, lat: -12.1 };
const VECINO_CERCA = { semaforoId: "vecino-cerca", lng: -77.0, lat: -12.1 + 0.0003 };
// 0.001° ≈ 111m — fuera del radio por defecto, simula la siguiente cuadra.
const LEJOS = { semaforoId: "lejos", lng: -77.0, lat: -12.1 + 0.001 };

describe("semaforosVecinos", () => {
  test("incluye semáforos dentro del radio, excluye los que están más lejos", () => {
    const resultado = semaforosVecinos(CENTRO, [CENTRO, VECINO_CERCA, LEJOS]);
    expect(resultado.map((s) => s.semaforoId)).toEqual(["vecino-cerca"]);
  });

  test("nunca se incluye a sí mismo, incluso si aparece duplicado en la lista", () => {
    expect(semaforosVecinos(CENTRO, [CENTRO])).toEqual([]);
  });

  test("un radio más chico descarta un vecino que sí pasaba con el default", () => {
    expect(semaforosVecinos(CENTRO, [VECINO_CERCA], 50)).toEqual([VECINO_CERCA]);
    expect(semaforosVecinos(CENTRO, [VECINO_CERCA], 20)).toEqual([]);
  });

  test("lista vacía da resultado vacío", () => {
    expect(semaforosVecinos(CENTRO, [])).toEqual([]);
  });
});