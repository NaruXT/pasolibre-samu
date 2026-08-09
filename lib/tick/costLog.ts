import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Auditoría de costo del LLM (skill `cost-audit`, 2026-08-08) — antes de esto no había ningún
 * registro de tokens/costo por llamada a `decidirAccionLLM`. Un archivo JSONL local es
 * suficiente para este proyecto (un solo proceso Next.js, sin DB — ver CLAUDE.md): cada línea
 * es una llamada real al modelo. Si el proceso corre en un entorno serverless/efímero en vez de
 * local, este archivo no persiste entre invocaciones — asumido aceptable para el estado actual
 * (tracer-bullet, corrido localmente vía `bun dev`).
 */
const LOG_PATH = path.join(process.cwd(), ".data", "llm-cost-log.jsonl");

export type OrigenLlamadaTick = "simulacion" | "gps-real" | "api-tick-legacy";

export interface RegistroLlamadaLLM {
  timestamp: string;
  modelo: string;
  semaforoId: string;
  ambulanceId: string;
  origen: OrigenLlamadaTick;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** `null` si no hay precio configurado para `modelo` (ver `calcularCostoUsd`) — los tokens siempre se guardan igual. */
  costoUsd: number | null;
}

/**
 * Precio USD por millón de tokens, vía env vars — deliberadamente NO hardcodeado acá: los
 * precios de Anthropic cambian y no hay forma de verificarlos desde este entorno con certeza.
 * Sin estas env vars seteadas, `costoUsd` queda `null` en el log (los tokens sí se guardan
 * siempre, son un hecho objetivo devuelto por la API; el costo en USD es best-effort).
 */
export function calcularCostoUsd(inputTokens: number, outputTokens: number): number | null {
  const precioInput = Number(process.env.LLM_PRICE_INPUT_USD_PER_M);
  const precioOutput = Number(process.env.LLM_PRICE_OUTPUT_USD_PER_M);
  if (!Number.isFinite(precioInput) || !Number.isFinite(precioOutput)) return null;
  return (inputTokens * precioInput + outputTokens * precioOutput) / 1_000_000;
}

export async function registrarLlamadaLLM(datos: {
  modelo: string;
  semaforoId: string;
  ambulanceId: string;
  origen: OrigenLlamadaTick;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}): Promise<void> {
  const registro: RegistroLlamadaLLM = {
    ...datos,
    timestamp: new Date().toISOString(),
    costoUsd: calcularCostoUsd(datos.inputTokens, datos.outputTokens),
  };
  try {
    await mkdir(path.dirname(LOG_PATH), { recursive: true });
    await appendFile(LOG_PATH, `${JSON.stringify(registro)}\n`);
  } catch (error) {
    // Nunca debe romper una decisión real por un fallo de logging — mismo criterio que TomTom
    // (congestión opcional, ver CLAUDE.md): el costo es diagnóstico, no debe bloquear el tick.
    console.error("No se pudo registrar el costo de la llamada LLM:", error);
  }
}

export async function leerRegistrosLLM(): Promise<RegistroLlamadaLLM[]> {
  try {
    const contenido = await readFile(LOG_PATH, "utf-8");
    return contenido
      .split("\n")
      .filter((linea) => linea.trim().length > 0)
      .map((linea) => JSON.parse(linea) as RegistroLlamadaLLM);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
