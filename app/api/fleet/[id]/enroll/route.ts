import { NextResponse } from "next/server";
import { darDeAltaUnidadFlota, detenerUnidadFlota, LimiteFlotaAlcanzadaError } from "@/lib/tick/flota";

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

/**
 * "Fin de turno" — retira una unidad de flota libre de forma permanente. No-op (200) si no
 * existe. A diferencia de `DELETE /api/ambulance/[id]/simulate` (que siempre devuelve 200,
 * inofensivo ahí porque su único caller ignora la respuesta), acá sí hace falta un status real
 * de error: `EmergencyMap.tsx#crearPopupFinDeTurno` chequea `response.ok` para reintentar el
 * botón — encontrado en code-review, un 200 falso dejaría al usuario creyendo que la unidad se
 * retiró cuando en realidad `detenerUnidadFlota` falló (ver su comentario sobre por qué el
 * publish va antes de tocar el cache, para que este error sea seguro de reintentar).
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: ambulanceId } = await params;
  try {
    await detenerUnidadFlota(ambulanceId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`Error dando de baja la unidad de flota ${ambulanceId}:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 }
    );
  }
}
