import { NextResponse } from "next/server";
import { distance } from "@turf/distance";
import { obtenerCanalServidor } from "@/lib/portal/serverReader";
import {
  ambulanciaChannelId,
  PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID,
  rutaAmbulanciaChannelId,
} from "@/lib/portal/constants";
import type {
  AmbulanciaActivaPayload,
  AmbulancePositionPayload,
  RoutePublishPayload,
} from "@/lib/portal/messages";
import { fetchDrivingRoute, type LngLat } from "@/lib/mapbox/directions";
import { hospitalMasCercano } from "@/lib/hospital/hospitalMasCercano";
import { HOSPITALES_SAN_BORJA_Y_COLINDANTES } from "@/lib/hospital/hospitalesSanBorjaYColindantes";
import { SEMAFOROS_SAN_BORJA_Y_COLINDANTES } from "@/lib/semaforo/semaforosSanBorjaYColindantes";
import { semaforosEnRuta, type SemaforoEnRuta } from "@/lib/semaforo/semaforosEnRuta";
import { orquestarTick } from "@/lib/tick/orquestar";
import { crearOrquestarTickDepsReales } from "@/lib/tick/deps";

/** A partir de esta distancia al hospital destino se considera "llegó" — mismo orden de magnitud que el buffer de semaforosEnRuta (ticket #9). */
const UMBRAL_LLEGADA_METROS = 50;

interface EstadoAmbulanciaReal {
  destino: LngLat;
  semaforosPendientes: SemaforoEnRuta[];
  ultimaPosicion: { lat: number; lng: number; timestampMs: number } | null;
}

// Cacheado en globalThis por la misma razón que `lib/portal/serverReader.ts`: sobrevive al HMR
// de Next.js en dev sin perder el estado de trayecto ya resuelto para cada ambulancia real.
const cacheAmbulanciasReales = globalThis as unknown as {
  __ambulanciasReales?: Map<string, EstadoAmbulanciaReal>;
};
if (!cacheAmbulanciasReales.__ambulanciasReales) {
  cacheAmbulanciasReales.__ambulanciasReales = new Map();
}

async function resolverPrimeraPosicion(
  ambulanceId: string,
  origen: LngLat
): Promise<EstadoAmbulanciaReal> {
  // Mismo flujo que un click simulado (issue #12, `components/EmergencyMap.tsx`): hospital más
  // cercano por ruta real, sin excluir ninguno por especialidad.
  const hospitalCercano = await hospitalMasCercano(origen, HOSPITALES_SAN_BORJA_Y_COLINDANTES, {
    obtenerRuta: (o, d) => fetchDrivingRoute(o, d, "driving"),
  });
  const destino = { lng: hospitalCercano.lng, lat: hospitalCercano.lat };
  const semaforosPendientes = semaforosEnRuta(
    SEMAFOROS_SAN_BORJA_Y_COLINDANTES,
    hospitalCercano.ruta.geometry
  );

  const rutaChannel = await obtenerCanalServidor<RoutePublishPayload>(
    rutaAmbulanciaChannelId(ambulanceId)
  );
  await rutaChannel.send({
    content: {
      ambulanceId,
      geometry: hospitalCercano.ruta.geometry,
      distanceMeters: hospitalCercano.ruta.distanceMeters,
      durationSeconds: hospitalCercano.ruta.durationSeconds,
      origin: origen,
      destination: destino,
    },
  });

  // Anuncio de descubrimiento (issue #12/#15) — sin esto, ningún watcher (mapa principal,
  // /ambulance-watch) puede enterarse de que esta ambulancia existe. `tipo: "viaje"` (issue
  // #20/#22): una ambulancia GPS real se autoasigna un destino al prenderse, sin pasar por
  // flota (A9, fuera de alcance) — no tiene concepto de "libre" para ofrecer "Fin de turno".
  const registroChannel = await obtenerCanalServidor<AmbulanciaActivaPayload>(
    PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID
  );
  await registroChannel.send({ content: { ambulanceId, tipo: "viaje" } });

  return { destino, semaforosPendientes, ultimaPosicion: null };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: ambulanceId } = await params;

  let body: { lat: number; lng: number; timestamp: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "El body debe ser JSON válido." }, { status: 400 });
  }
  if (
    typeof body?.lat !== "number" ||
    typeof body?.lng !== "number" ||
    typeof body?.timestamp !== "number"
  ) {
    return NextResponse.json({ error: "Se espera { lat, lng, timestamp }." }, { status: 400 });
  }

  try {
    const cache = cacheAmbulanciasReales.__ambulanciasReales!;
    let estado = cache.get(ambulanceId);

    if (!estado) {
      estado = await resolverPrimeraPosicion(ambulanceId, { lng: body.lng, lat: body.lat });
      cache.set(ambulanceId, estado);
    }

    const distanciaADestinoMetros = distance(
      [body.lng, body.lat],
      [estado.destino.lng, estado.destino.lat],
      { units: "meters" }
    );
    const arrived = distanciaADestinoMetros <= UMBRAL_LLEGADA_METROS;

    const posicionChannel = await obtenerCanalServidor<AmbulancePositionPayload>(
      ambulanciaChannelId(ambulanceId)
    );
    await posicionChannel.send({
      content: { ambulanceId, lat: body.lat, lng: body.lng, arrived },
      ephemeral: true,
    });

    // Sin una posición previa no hay forma de estimar velocidad (a diferencia de una ambulancia
    // simulada, que ya conoce la ruta completa) — se omite el tick en el primer POST de cada
    // ambulancia; el ETA se vuelve calculable a partir del segundo.
    let resultados: Awaited<ReturnType<typeof orquestarTick>> = [];
    if (estado.ultimaPosicion && !arrived) {
      const segundosTranscurridos = (body.timestamp - estado.ultimaPosicion.timestampMs) / 1000;
      const distanciaRecorridaMetros = distance(
        [estado.ultimaPosicion.lng, estado.ultimaPosicion.lat],
        [body.lng, body.lat],
        { units: "meters" }
      );
      const velocidadMetrosPorSegundo =
        segundosTranscurridos > 0 ? distanciaRecorridaMetros / segundosTranscurridos : 0;

      resultados = await orquestarTick(
        {
          ambulanceId,
          posicionAmbulancia: { lng: body.lng, lat: body.lat, velocidadMetrosPorSegundo },
          semaforosPendientes: estado.semaforosPendientes,
        },
        crearOrquestarTickDepsReales("gps-real")
      );
    }

    estado.ultimaPosicion = { lat: body.lat, lng: body.lng, timestampMs: body.timestamp };

    return NextResponse.json({ ok: true, arrived, resultados });
  } catch (error) {
    console.error("Error ingiriendo posición GPS real:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 }
    );
  }
}
