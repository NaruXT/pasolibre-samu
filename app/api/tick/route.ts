import { NextResponse } from "next/server";
import { orquestarTick, type OrquestarTickInput } from "@/lib/tick/orquestar";
import { crearOrquestarTickDepsReales } from "@/lib/tick/deps";

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
    const resultados = await orquestarTick(input, crearOrquestarTickDepsReales("api-tick-legacy"));
    return NextResponse.json({ resultados });
  } catch (error) {
    console.error("Error orquestando el tick:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 }
    );
  }
}
