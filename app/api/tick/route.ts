import { NextResponse } from "next/server";
import { orquestarTick, type OrquestarTickInput } from "@/lib/tick/orquestar";
import { decidirAccionLLM } from "@/lib/tick/agent";
import { publishToPortalChannel } from "@/lib/portal/server";
import { obtenerAccionesPreviasSemaforo } from "@/lib/portal/serverReader";
import { PORTAL_SEMAFOROS_CHANNEL_ID } from "@/lib/portal/constants";
import type { DecisionSemaforoPublicada } from "@/lib/tick/decision";
import { obtenerCongestionTransversal } from "@/lib/tomtom/trafficFlow";

export async function POST(request: Request) {
  let input: OrquestarTickInput;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "El body debe ser JSON válido." }, { status: 400 });
  }

  if (
    typeof input?.ambulanceId !== "string" ||
    !input.posicionAmbulancia ||
    !Array.isArray(input.semaforosPendientes)
  ) {
    return NextResponse.json(
      { error: "Se espera { ambulanceId, posicionAmbulancia, semaforosPendientes }." },
      { status: 400 }
    );
  }

  try {
    const resultados = await orquestarTick(input, {
      obtenerAccionesPrevias: obtenerAccionesPreviasSemaforo,
      decidirAccion: decidirAccionLLM,
      obtenerCongestionTransversal,
      publicarDecision: async (decision: DecisionSemaforoPublicada) => {
        await publishToPortalChannel({
          channelId: PORTAL_SEMAFOROS_CHANNEL_ID,
          content: decision,
          type: "decision-semaforo",
          senderId: "tick-orchestrator",
        });
      },
    });
    return NextResponse.json({ resultados });
  } catch (error) {
    console.error("Error orquestando el tick:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 }
    );
  }
}
