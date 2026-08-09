import { NextResponse } from "next/server";
import { asignarLlamadaEmergencia, NoHayUnidadLibreError } from "@/lib/tick/flota";

/**
 * "Llamada de emergencia" (issue #20/#23) — reporta una urgencia en `{lat, lng}` y asigna la
 * unidad de flota libre más cercana (por ruta real, ver `asignarLlamadaEmergencia`). No recibe
 * `ambulanceId` en la URL como el resto de endpoints de flota: quién atiende la llamada lo
 * decide el servidor, no el cliente.
 */
export async function POST(request: Request) {
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
    const { ambulanceId } = await asignarLlamadaEmergencia({ lng: body.lng, lat: body.lat });
    return NextResponse.json({ ok: true, ambulanceId });
  } catch (error) {
    if (error instanceof NoHayUnidadLibreError) {
      // 409, no 429: no es un tope de capacidad (podría haber cupo de sobra) — es que en este
      // momento ninguna unidad está libre. Sin cola (R2): se rechaza, no se encola.
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Error asignando unidad a la llamada de emergencia:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 }
    );
  }
}
