import { fetchDrivingRoute, type DrivingRoute, type LngLat } from "@/lib/mapbox/directions";
import { InterpoladaPosicionSource } from "@/lib/mapbox/posicionSource";
import { hospitalMasCercano } from "@/lib/hospital/hospitalMasCercano";
import { HOSPITALES_SAN_BORJA_Y_COLINDANTES } from "@/lib/hospital/hospitalesSanBorjaYColindantes";
import { SEMAFOROS_SAN_BORJA_Y_COLINDANTES } from "@/lib/semaforo/semaforosSanBorjaYColindantes";
import { semaforosEnRuta, type SemaforoEnRuta } from "@/lib/semaforo/semaforosEnRuta";
import { esperarBackfillDe, obtenerCanalServidor } from "@/lib/portal/serverReader";
import {
  ambulanciaChannelId,
  PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID,
  PORTAL_AMBULANCIAS_DETENIDAS_CHANNEL_ID,
  rutaAmbulanciaChannelId,
} from "@/lib/portal/constants";
import type {
  AmbulanciaActivaPayload,
  AmbulanciaDetenidaPayload,
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
  __huerfanasReconciliadas?: boolean;
};
if (!cacheSimulaciones.__simulacionesActivas) {
  cacheSimulaciones.__simulacionesActivas = new Map();
}

/**
 * Reconciliación al arrancar (a pedido del usuario, tras notar markers "fantasma" en el mapa):
 * `__simulacionesActivas` es un Map en memoria — un reinicio del proceso (frecuente en
 * desarrollo, cada vez que se edita código y se reinicia `bun dev`) lo vacía sin avisarle a
 * nadie. Cualquier ambulancia que estuviera corriendo en el proceso anterior queda "huérfana":
 * anunciada en `ambulancias-activas`, nunca llegó (nadie la seguía moviendo) y nunca se publicó
 * su detención (nadie llamó `detenerSimulacionServidor`). Como este proyecto es un solo proceso
 * Next.js (ver CLAUDE.md, "One Next.js project, no separate service"), cualquier id anunciado
 * que este proceso fresco no conoce en su `__simulacionesActivas` (que arranca vacío) está
 * garantizado detenido — no hay otro proceso donde pudiera seguir viva. Se corre una única vez
 * por vida del proceso (guardia `__huerfanasReconciliadas`), en el primer acceso a cualquier
 * función de este módulo.
 *
 * Exportada (issue #20/#21) — `lib/tick/flota.ts` la llama también en su primer acceso, porque
 * opera sobre los canales Portal compartidos (`ambulancias-activas`/`ambulancias-detenidas`),
 * no sobre `__simulacionesActivas`: cubre por igual a las simulaciones de viaje de este módulo
 * y a las unidades de flota de `flota.ts`, sin necesitar una copia separada de esta lógica.
 */
export async function reconciliarSimulacionesHuerfanas(): Promise<void> {
  if (cacheSimulaciones.__huerfanasReconciliadas) return;
  cacheSimulaciones.__huerfanasReconciliadas = true;

  try {
    // `history: 500` explícito — el default del SDK sin esta opción es 50 (confirmado en su
    // fuente: `deps.options?.history ?? 50`), y una sesión de pruebas extensa supera esas 50
    // fácil. Sin esto, esta misma función queda ciega a cualquier anuncio/detención más viejo
    // que los últimos 50 mensajes de cada canal, y deja huérfanas sin reconciliar para siempre
    // (bug real encontrado post-#23: 13 ambulancias fantasma nunca marcadas como detenidas).
    const activasChannel = await obtenerCanalServidor<AmbulanciaActivaPayload>(
      PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID,
      { history: 500 }
    );
    await esperarBackfillDe(PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID, activasChannel);

    const detenidasChannel = await obtenerCanalServidor<AmbulanciaDetenidaPayload>(
      PORTAL_AMBULANCIAS_DETENIDAS_CHANNEL_ID,
      { history: 500 }
    );
    await esperarBackfillDe(PORTAL_AMBULANCIAS_DETENIDAS_CHANNEL_ID, detenidasChannel);

    const idsAnunciados = new Set(activasChannel.messages.map((m) => m.content.ambulanceId));
    const idsYaDetenidos = new Set(detenidasChannel.messages.map((m) => m.content.ambulanceId));
    const huerfanas = [...idsAnunciados].filter((id) => !idsYaDetenidos.has(id));

    for (const ambulanceId of huerfanas) {
      await detenidasChannel.send({ content: { ambulanceId } }).catch((error) => {
        console.error(`No se pudo reconciliar la ambulancia huérfana ${ambulanceId}:`, error);
      });
    }
    if (huerfanas.length > 0) {
      console.log(
        `Reconciliación al arrancar: ${huerfanas.length} ambulancia(s) huérfana(s) marcadas como detenidas.`
      );
    }
  } catch (error) {
    console.error("Error reconciliando ambulancias huérfanas al arrancar:", error);
  }
}

/**
 * Tope a pedido del usuario — solo cuenta simuladas (`__simulacionesActivas`), no ambulancias
 * GPS reales (esas tienen su propio cache en `app/api/ambulance/[id]/position/route.ts`, sin
 * tope). Una simulación sale de este Map en cuanto llega a destino (ver el callback de
 * `iniciarSimulacionServidor` más abajo), así que el conteo siempre refleja las que siguen en
 * ruta, no un total histórico.
 */
export const MAX_SIMULACIONES_ACTIVAS = 8;

/** Distinguible del resto de errores (Mapbox/Portal caídos, etc.) para que la ruta HTTP devuelva 429, no 502. */
export class LimiteSimulacionesAlcanzadoError extends Error {}

export interface ResultadoIniciarSimulacion {
  destino: LngLat & { nombre: string };
  /** Perfil "driving-traffic" — la línea/ETA que se muestra en el mapa, no el ritmo propio de la ambulancia. */
  rutaTrafico: DrivingRoute;
}

export async function iniciarSimulacionServidor(
  ambulanceId: string,
  origen: LngLat
): Promise<ResultadoIniciarSimulacion> {
  await reconciliarSimulacionesHuerfanas();

  // Chequeado antes de gastar ninguna llamada real (Mapbox/LLM) — si ya está en el tope, ni
  // vale la pena calcular hospital/ruta.
  if (
    !cacheSimulaciones.__simulacionesActivas!.has(ambulanceId) &&
    cacheSimulaciones.__simulacionesActivas!.size >= MAX_SIMULACIONES_ACTIVAS
  ) {
    throw new LimiteSimulacionesAlcanzadoError(
      `Ya hay ${MAX_SIMULACIONES_ACTIVAS} ambulancias simuladas activas (el máximo) — esperá a que alguna llegue a destino antes de agregar otra.`
    );
  }

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
  // /ambulance-watch) puede enterarse de que esta ambulancia existe. `tipo: "viaje"` (issue
  // #20/#22) distingue esto de una unidad de flota (`lib/tick/flota.ts`) — el cliente lo usa
  // para no ofrecer "Fin de turno" en un viaje efímero, que no tiene ese concepto.
  // `history: 500` explícito acá también — `obtenerCanalServidor` cachea por channelId, así que
  // si esta acquisition (solo-escritura) ganara la carrera contra `reconciliarSimulacionesHuerfanas`
  // (que ya la pide arriba), el resto del proceso quedaría pegado al default de 50 del SDK.
  const registroChannel = await obtenerCanalServidor<AmbulanciaActivaPayload>(
    PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID,
    { history: 500 }
  );
  await registroChannel.send({ content: { ambulanceId, tipo: "viaje" } });

  const ambulanceChannel = await obtenerCanalServidor<AmbulancePositionPayload>(
    ambulanciaChannelId(ambulanceId)
  );
  const velocidadMetrosPorSegundo = ruta.distanceMeters / ruta.durationSeconds;
  const depsOrquestacion = crearOrquestarTickDepsReales("simulacion");

  const fuente = new InterpoladaPosicionSource(ruta);
  // Guardia de tick-en-curso (skill `cost-audit`, 2026-08-08) — bug real confirmado con datos:
  // con ~11 semáforos por trayecto, una sola pasada de `orquestarTick` (I/O secuencial por
  // semáforo: lectura Portal + posible llamada LLM + TomTom + publish) puede tardar más que los
  // 5s entre ticks de posición. Sin esta guardia, `void orquestarTick(...)` deja el tick anterior
  // corriendo en paralelo con el siguiente — dos invocaciones concurrentes leen "sin decisión
  // previa" para el mismo semáforo (la publicación REST del primero no llegó a tiempo a la
  // lectura WS del segundo) y ambas llaman al LLM. Verificado en vivo: 31 llamadas reales para
  // 11 semáforos únicos en un solo trayecto (64.5% de las llamadas eran reprocesamiento puro).
  // El tick que se salta NO se encola — la posición se sigue publicando cada 5s sin importar
  // esto, solo se throttlea el efecto de `orquestarTick`; el próximo tick libre retoma cualquier
  // semáforo que siga pendiente.
  let tickEnCurso = false;
  const detener = fuente.suscribir((posicion) => {
    void ambulanceChannel
      .send({ content: { ...posicion, ambulanceId }, ephemeral: true })
      .catch((error) => {
        console.error(`No se pudo publicar posición de la simulación ${ambulanceId}:`, error);
      });

    if (semaforosPendientes.length > 0 && !tickEnCurso) {
      tickEnCurso = true;
      void orquestarTick(
        {
          ambulanceId,
          posicionAmbulancia: { ...posicion, velocidadMetrosPorSegundo },
          semaforosPendientes,
        },
        depsOrquestacion
      )
        .catch((error) => {
          console.error(`Error orquestando tick de la simulación ${ambulanceId}:`, error);
        })
        .finally(() => {
          tickEnCurso = false;
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
 * porque nunca existió — en ese caso no se publica nada (una llegada natural ya se comunicó
 * sola vía `arrived: true`, y no hay nada que avisar si el id nunca existió).
 */
export async function detenerSimulacionServidor(ambulanceId: string): Promise<void> {
  await reconciliarSimulacionesHuerfanas();

  const simulacion = cacheSimulaciones.__simulacionesActivas?.get(ambulanceId);
  if (!simulacion) return;
  simulacion.detener();
  cacheSimulaciones.__simulacionesActivas!.delete(ambulanceId);

  // A pedido del usuario: avisar a TODOS los observadores (no solo a quien la detuvo) para que
  // le quiten el marker de inmediato, en vez de dejarlo congelado hasta que alguien recargue.
  const detenidasChannel = await obtenerCanalServidor<AmbulanciaDetenidaPayload>(
    PORTAL_AMBULANCIAS_DETENIDAS_CHANNEL_ID,
    { history: 500 }
  );
  await detenidasChannel.send({ content: { ambulanceId } });
}
