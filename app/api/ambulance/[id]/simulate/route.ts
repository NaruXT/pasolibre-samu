import { NextResponse } from "next/server";
import {
  detenerSimulacionServidor,
  iniciarSimulacionServidor,
  LimiteSimulacionesAlcanzadoError,
} from "@/lib/tick/simulacion";

/** Arranca (o reinicia) una ambulancia simulada del lado servidor — ver lib/tick/simulacion.ts. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: ambulanceId } = await params;

  let body: { lat: number; lng: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "El body debe ser JSON válido." }, { status: 400 });
  }
  if (typeof body?.lat !== "number" || typeof body?.lng !== "number") {
    return NextResponse.json({ error: "Se espera { lat, lng }." }, { status: 400 });
  }

  try {
    const resultado = await iniciarSimulacionServidor(ambulanceId, { lng: body.lng, lat: body.lat });
    return NextResponse.json({ ok: true, ambulanceId, ...resultado });
  } catch (error) {
    if (error instanceof LimiteSimulacionesAlcanzadoError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    console.error("Error iniciando simulación de ambulancia:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 }
    );
  }
}

/** Detiene una simulación activa — no-op si ya llegó o nunca existió. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: ambulanceId } = await params;
  try {
    await detenerSimulacionServidor(ambulanceId);
  } catch (error) {
    console.error(`Error deteniendo la simulación ${ambulanceId}:`, error);
  }
  return NextResponse.json({ ok: true });
}
