import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { DecisionSemaforo } from "./decision";
import type { FaseSemaforo } from "@/lib/semaforo/fase";

/** Modelo configurable vía env var — Anthropic por defecto (ticket #8). */
const modeloDecision = anthropic(process.env.TICK_AGENT_MODEL ?? "claude-opus-5");

const esquemaDecision = z.object({
  accion: z.enum(["anticipar_verde", "extender_verde", "mantener_ciclo"]),
  explicacion: z.string(),
});

export interface ContextoDecisionSemaforo {
  semaforoId: string;
  etaSegundos: number;
  fase: FaseSemaforo;
}

/**
 * Agente LLM real (ticket #8) — reemplaza el mock del ticket #7 detrás del mismo punto de
 * invocación en orquestarTick. El semaforoId no se le pide al modelo: ya lo sabemos, y hacer
 * que lo repita solo agrega una forma de que se equivoque.
 */
export async function decidirAccionLLM(
  contexto: ContextoDecisionSemaforo
): Promise<DecisionSemaforo> {
  const segundosRestantesTexto = Number.isFinite(contexto.fase.segundosRestantes)
    ? `${contexto.fase.segundosRestantes.toFixed(1)}s`
    : "indefinido (un semáforo forzado a verde por una decisión previa)";

  const { object } = await generateObject({
    model: modeloDecision,
    schema: esquemaDecision,
    instructions:
      "Sos el agente de coordinación semafórica de una ambulancia del SAMU. Para un solo " +
      "semáforo, decidís entre anticipar_verde (adelantar el cambio a verde), extender_verde " +
      "(mantener el verde más tiempo) o mantener_ciclo (no intervenir), según el ETA de la " +
      "ambulancia y la fase actual del semáforo. Explicá tu decisión en una oración breve.",
    prompt:
      `Semáforo ${contexto.semaforoId}:\n` +
      `- ETA de la ambulancia: ${contexto.etaSegundos.toFixed(1)}s\n` +
      `- Fase actual: ${contexto.fase.fase}\n` +
      `- Segundos restantes de esa fase: ${segundosRestantesTexto}`,
  });

  return {
    semaforoId: contexto.semaforoId,
    accion: object.accion,
    explicacion: object.explicacion,
  };
}
