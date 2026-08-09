import { NextResponse } from "next/server";
import { leerRegistrosLLM } from "@/lib/tick/costLog";

/**
 * Endpoint de solo lectura (skill `cost-audit`, 2026-08-08) — agrega el log de
 * `.data/llm-cost-log.jsonl` para ver de dónde sale el costo del LLM sin tener que leer el JSONL
 * a mano. `reprocesados` es el chequeo clave: más de una llamada para el mismo
 * `(semaforoId, ambulanceId)` significa que `orquestarTick` decidió el mismo semáforo dos veces
 * para el mismo trayecto — no debería pasar nunca dado el invariante "decide una vez por
 * semáforo por trayecto" (ver CLAUDE.md), así que un valor > 0 acá es señal de la race
 * documentada entre la escritura REST de la decisión y su lectura vía WS.
 */
export async function GET() {
  const registros = await leerRegistrosLLM();

  const totalLlamadas = registros.length;
  const totalTokens = registros.reduce((acc, r) => acc + r.totalTokens, 0);
  const hayCostoConocido = registros.some((r) => r.costoUsd !== null);
  const costoTotalUsd = hayCostoConocido
    ? registros.reduce((acc, r) => acc + (r.costoUsd ?? 0), 0)
    : null;

  const porOrigen = new Map<string, { llamadas: number; tokens: number; costoUsd: number | null }>();
  const porDia = new Map<string, { llamadas: number; tokens: number; costoUsd: number | null }>();
  const porIdentificador = new Map<string, number>();

  for (const r of registros) {
    const dia = r.timestamp.slice(0, 10);
    const identificador = `${r.semaforoId}:${r.ambulanceId}`;

    for (const [mapa, clave] of [
      [porOrigen, r.origen],
      [porDia, dia],
    ] as const) {
      const actual = mapa.get(clave) ?? { llamadas: 0, tokens: 0, costoUsd: 0 };
      mapa.set(clave, {
        llamadas: actual.llamadas + 1,
        tokens: actual.tokens + r.totalTokens,
        costoUsd: hayCostoConocido ? (actual.costoUsd ?? 0) + (r.costoUsd ?? 0) : null,
      });
    }

    porIdentificador.set(identificador, (porIdentificador.get(identificador) ?? 0) + 1);
  }

  const reprocesados = [...porIdentificador.entries()]
    .filter(([, llamadas]) => llamadas > 1)
    .map(([identificador, llamadas]) => ({ identificador, llamadas }));

  return NextResponse.json({
    totalLlamadas,
    totalTokens,
    costoTotalUsd,
    costoConfigurable:
      "Setear LLM_PRICE_INPUT_USD_PER_M y LLM_PRICE_OUTPUT_USD_PER_M para calcular costoUsd — sin esas env vars queda null.",
    porOrigen: Object.fromEntries(porOrigen),
    porDia: Object.fromEntries(porDia),
    identificadoresUnicos: porIdentificador.size,
    reprocesados,
  });
}
