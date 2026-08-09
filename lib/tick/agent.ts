import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { DecisionSemaforo } from "./decision";
import type { FaseSemaforo } from "@/lib/semaforo/fase";
import type { CongestionTransversal } from "@/lib/tomtom/trafficFlow";
import { registrarLlamadaLLM, type OrigenLlamadaTick } from "./costLog";

/** Modelo configurable vía env var — Anthropic por defecto (ticket #8). */
const nombreModelo = process.env.TICK_AGENT_MODEL ?? "claude-opus-5";
const modeloDecision = anthropic(nombreModelo);

const esquemaDecision = z.object({
  accion: z.enum(["anticipar_verde", "extender_verde", "mantener_ciclo"]),
  explicacion: z.string(),
});

export interface ContextoDecisionSemaforo {
  semaforoId: string;
  etaSegundos: number;
  fase: FaseSemaforo;
  /** Congestión del tráfico transversal (ticket #10) — `null`/omitido si TomTom no respondió. */
  congestionTransversal?: CongestionTransversal | null;
  /** Solo para el log de costo (skill `cost-audit`) — nunca se manda en el prompt al modelo. */
  ambulanceId: string;
}

/**
 * Agente LLM real (ticket #8) — reemplaza el mock del ticket #7 detrás del mismo punto de
 * invocación en orquestarTick. El semaforoId no se le pide al modelo: ya lo sabemos, y hacer
 * que lo repita solo agrega una forma de que se equivoque.
 */
export async function decidirAccionLLM(
  contexto: ContextoDecisionSemaforo,
  origen: OrigenLlamadaTick
): Promise<DecisionSemaforo> {
  const segundosRestantesTexto = Number.isFinite(contexto.fase.segundosRestantes)
    ? `${contexto.fase.segundosRestantes.toFixed(1)}s`
    : "indefinido (un semáforo forzado a verde por una decisión previa)";

  const congestion = contexto.congestionTransversal;
  const congestionTexto = congestion
    ? `${congestion.nivel} (${congestion.currentSpeedKmph} km/h actual vs. ${congestion.freeFlowSpeedKmph} km/h de flujo libre)`
    : "sin dato (TomTom no respondió para este semáforo)";

  const { object, usage } = await generateObject({
    model: modeloDecision,
    schema: esquemaDecision,
    instructions:
      "Sos el agente de coordinación semafórica de una ambulancia del SAMU. Para un solo " +
      "semáforo, decidís entre anticipar_verde (adelantar el cambio a verde), extender_verde " +
      "(mantener el verde más tiempo) o mantener_ciclo (no intervenir), según el ETA de la " +
      "ambulancia, la fase actual del semáforo, y la congestión del tráfico transversal (el " +
      "tráfico que cruza y se vería bloqueado por una intervención a favor de la ambulancia). " +
      "Un tráfico transversal ya congestionado hace más costoso intervenir — sopesalo contra " +
      "la urgencia de la ambulancia. Explicá tu decisión en una oración breve, mencionando la " +
      "congestión transversal cuando haya influido en la decisión.",
    prompt:
      `Semáforo ${contexto.semaforoId}:\n` +
      `- ETA de la ambulancia: ${contexto.etaSegundos.toFixed(1)}s\n` +
      `- Fase actual: ${contexto.fase.fase}\n` +
      `- Segundos restantes de esa fase: ${segundosRestantesTexto}\n` +
      `- Congestión del tráfico transversal: ${congestionTexto}`,
  });

  await registrarLlamadaLLM({
    modelo: nombreModelo,
    semaforoId: contexto.semaforoId,
    ambulanceId: contexto.ambulanceId,
    origen,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  });

  return {
    semaforoId: contexto.semaforoId,
    accion: object.accion,
    explicacion: object.explicacion,
  };
}
