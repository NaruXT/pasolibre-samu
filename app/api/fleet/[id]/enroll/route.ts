import { NextResponse } from "next/server";
import { darDeAltaUnidadFlota, LimiteFlotaAlcanzadaError } from "@/lib/tick/flota";

/** Da de alta una unidad de flota en `{lat, lng}` — patrulla libre, sin viaje asignado. Ver lib/tick/flota.ts. */
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
    await darDeAltaUnidadFlota(ambulanceId, { lng: body.lng, lat: body.lat });
    return NextResponse.json({ ok: true, ambulanceId });
  } catch (error) {
    if (error instanceof LimiteFlotaAlcanzadaError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    console.error("Error dando de alta unidad de flota:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 }
    );
  }
}
