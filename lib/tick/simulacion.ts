import { fetchDrivingRoute, type DrivingRoute, type LngLat } from "@/lib/mapbox/directions";
import { InterpoladaPosicionSource } from "@/lib/mapbox/posicionSource";
import { hospitalMasCercano } from "@/lib/hospital/hospitalMasCercano";
import { HOSPITALES_SAN_BORJA_Y_COLINDANTES } from "@/lib/hospital/hospitalesSanBorjaYColindantes";
import { SEMAFOROS_SAN_BORJA_Y_COLINDANTES } from "@/lib/semaforo/semaforosSanBorjaYColindantes";
import { semaforosEnRuta, type SemaforoEnRuta } from "@/lib/semaforo/semaforosEnRuta";
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
import { orquestarTick } from "@/lib/tick/orquestar";
import { crearOrquestarTickDepsReales } from "@/lib/tick/deps";

/**
 * Ambulancia simulada corriendo del lado servidor (post-slice #16, a pedido del usuario). Antes
 * vivía como un `setInterval` en la pestaña del navegador que hizo click (`InterpoladaPosicionSource`
 * dentro de `EmergencyMap.tsx`) — recargar o cerrar esa pestaña la dejaba congelada para cualquier
 * otro observador (el marker quedaba en su última posición, pero nadie volvía a publicar). Ahora
 * el servidor la mueve, exactamente igual que a una ambulancia GPS real (`lib/tick/simulacion.ts`
 * comparte código con `app/api/ambulance/[id]/position/route.ts`), sin importar qué pestañas
 * estén abiertas o se recarguen.
 */
interface SimulacionActiva {
  detener: () => void;
}

// Cacheado en globalThis por la misma razón que el resto de `lib/portal/serverReader.ts`:
// sobrevive al HMR de Next.js en dev sin perder las simulaciones ya arrancadas.
const cacheSimulaciones = globalThis as unknown as {
  __simulacionesActivas?: Map<string, SimulacionActiva>;
};
if (!cacheSimulaciones.__simulacionesActivas) {
  cacheSimulaciones.__simulacionesActivas = new Map();
}

export interface ResultadoIniciarSimulacion {
  destino: LngLat & { nombre: string };
  /** Perfil "driving-traffic" — la línea/ETA que se muestra en el mapa, no el ritmo propio de la ambulancia. */
  rutaTrafico: DrivingRoute;
}

export async function iniciarSimulacionServidor(
  ambulanceId: string,
  origen: LngLat
): Promise<ResultadoIniciarSimulacion> {
  // Mismo flujo que un click simulado (issue #12/#13): hospital más cercano por ruta real, sin
  // excluir ninguno por especialidad. La ruta "driving" que gana esta comparación es
  // directamente el ritmo propio de la ambulancia — no hace falta pedirla de nuevo.
  const hospitalCercano = await hospitalMasCercano(origen, HOSPITALES_SAN_BORJA_Y_COLINDANTES, {
    obtenerRuta: (o, d) => fetchDrivingRoute(o, d, "driving"),
  });
  const destino = { lng: hospitalCercano.lng, lat: hospitalCercano.lat };
  const ruta = hospitalCercano.ruta;

  // Perfil separado a propósito: la línea/ETA que ve el usuario en el mapa refleja tráfico real
  // (lo que experimentaría un auto normal); el ritmo propio de la ambulancia nunca lo hace
  // (vehículo con prioridad) — mismo motivo documentado originalmente en el click handler.
  const rutaTrafico = await fetchDrivingRoute(origen, destino, "driving-traffic");

  const semaforosPendientes: SemaforoEnRuta[] = semaforosEnRuta(
    SEMAFOROS_SAN_BORJA_Y_COLINDANTES,
    ruta.geometry
  );

  const rutaChannel = await obtenerCanalServidor<RoutePublishPayload>(
    rutaAmbulanciaChannelId(ambulanceId)
  );
  await rutaChannel.send({
    content: {
      ambulanceId,
      geometry: ruta.geometry,
      distanceMeters: ruta.distanceMeters,
      durationSeconds: ruta.durationSeconds,
      origin: origen,
      destination: destino,
    },
  });

  // Anuncio de descubrimiento (issue #12/#15) — sin esto, ningún watcher (mapa principal,
  // /ambulance-watch) puede enterarse de que esta ambulancia existe.
  const registroChannel = await obtenerCanalServidor<AmbulanciaActivaPayload>(
    PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID
  );
  await registroChannel.send({ content: { ambulanceId } });

  const ambulanceChannel = await obtenerCanalServidor<AmbulancePositionPayload>(
    ambulanciaChannelId(ambulanceId)
  );
  const velocidadMetrosPorSegundo = ruta.distanceMeters / ruta.durationSeconds;
  const depsOrquestacion = crearOrquestarTickDepsReales();

  const fuente = new InterpoladaPosicionSource(ruta);
  const detener = fuente.suscribir((posicion) => {
    void ambulanceChannel
      .send({ content: { ...posicion, ambulanceId }, ephemeral: true })
      .catch((error) => {
        console.error(`No se pudo publicar posición de la simulación ${ambulanceId}:`, error);
      });

    if (semaforosPendientes.length > 0) {
      void orquestarTick(
        {
          ambulanceId,
          posicionAmbulancia: { ...posicion, velocidadMetrosPorSegundo },
          semaforosPendientes,
        },
        depsOrquestacion
      ).catch((error) => {
        console.error(`Error orquestando tick de la simulación ${ambulanceId}:`, error);
      });
    }

    if (posicion.arrived) {
      cacheSimulaciones.__simulacionesActivas!.delete(ambulanceId);
    }
  });

  cacheSimulaciones.__simulacionesActivas!.set(ambulanceId, { detener });

  return { destino: { ...destino, nombre: hospitalCercano.nombre }, rutaTrafico };
}

/**
 * Detiene una simulación activa — a pedido del usuario, resetear el mapa (nueva emergencia)
 * también para la simulación en el servidor, no solo deja de observarla en un cliente. Sin
 * efecto (no-op) si `ambulanceId` no tiene una simulación corriendo, sea porque ya llegó o
 * porque nunca existió.
 */
export function detenerSimulacionServidor(ambulanceId: string): void {
  const simulacion = cacheSimulaciones.__simulacionesActivas?.get(ambulanceId);
  if (!simulacion) return;
  simulacion.detener();
  cacheSimulaciones.__simulacionesActivas!.delete(ambulanceId);
}
