import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { calcularCostoUsd } from "./costLog";

describe("calcularCostoUsd", () => {
  const originalInput = process.env.LLM_PRICE_INPUT_USD_PER_M;
  const originalOutput = process.env.LLM_PRICE_OUTPUT_USD_PER_M;

  beforeEach(() => {
    delete process.env.LLM_PRICE_INPUT_USD_PER_M;
    delete process.env.LLM_PRICE_OUTPUT_USD_PER_M;
  });

  afterEach(() => {
    if (originalInput === undefined) delete process.env.LLM_PRICE_INPUT_USD_PER_M;
    else process.env.LLM_PRICE_INPUT_USD_PER_M = originalInput;
    if (originalOutput === undefined) delete process.env.LLM_PRICE_OUTPUT_USD_PER_M;
    else process.env.LLM_PRICE_OUTPUT_USD_PER_M = originalOutput;
  });

  test("sin precios configurados: devuelve null (tokens se siguen guardando aparte)", () => {
    expect(calcularCostoUsd(1000, 500)).toBeNull();
  });

  test("con precios configurados: calcula el costo en USD por millón de tokens", () => {
    process.env.LLM_PRICE_INPUT_USD_PER_M = "10";
    process.env.LLM_PRICE_OUTPUT_USD_PER_M = "20";

    // 1M input a $10/M + 0.5M output a $20/M = $10 + $10 = $20
    expect(calcularCostoUsd(1_000_000, 500_000)).toBe(20);
  });

  test("precio inválido (no numérico) se trata como no configurado: devuelve null", () => {
    process.env.LLM_PRICE_INPUT_USD_PER_M = "no-es-un-numero";
    process.env.LLM_PRICE_OUTPUT_USD_PER_M = "20";

    expect(calcularCostoUsd(1000, 500)).toBeNull();
  });
});
