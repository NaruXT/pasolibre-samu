import { fetchDrivingRoute, type DrivingRoute, type LngLat } from "@/lib/mapbox/directions";
import { InterpoladaPosicionSource } from "@/lib/mapbox/posicionSource";
import { obtenerCanalServidor } from "@/lib/portal/serverReader";
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
import { reconciliarSimulacionesHuerfanas } from "@/lib/tick/simulacion";
import { hospitalMasCercano } from "@/lib/hospital/hospitalMasCercano";
import { HOSPITALES_SAN_BORJA_Y_COLINDANTES } from "@/lib/hospital/hospitalesSanBorjaYColindantes";
import { SEMAFOROS_SAN_BORJA_Y_COLINDANTES } from "@/lib/semaforo/semaforosSanBorjaYColindantes";
import { semaforosEnRuta, type SemaforoEnRuta } from "@/lib/semaforo/semaforosEnRuta";
import { orquestarTick } from "@/lib/tick/orquestar";
import { crearOrquestarTickDepsReales } from "@/lib/tick/deps";
import { unidadLibreMasCercana, type UnidadLibreMasCercanaResultado } from "@/lib/tick/asignacion";
import { distanciaHaversineMetros } from "@/lib/geo/haversine";

/**
 * Unidad de flota persistente (issue #20). Slice 1/3 (#21) cubrió alta+patrullaje; slice 2/3
 * (#22) "Fin de turno"; este módulo ahora también cubre slice 3/3 (#23) — asignación de
 * llamadas de emergencia, dos tramos con orquestación completa, y vuelta a libre.
 */
export type EstadoUnidadFlota = "libre" | "en_proceso";

interface UnidadFlota {
  estado: EstadoUnidadFlota;
  /** Mutada in-place en cada tick de posición (patrullaje o tramo de llamada) — mismo objeto referenciado en el Map. */
  posicionActual: LngLat;
  detener: () => void;
}

// Cacheado en globalThis por la misma razón que `__simulacionesActivas`: sobrevive al HMR de
// Next.js en dev sin perder las unidades ya dadas de alta.
const cacheFlota = globalThis as unknown as {
  __flotaActiva?: Map<string, UnidadFlota>;
};
if (!cacheFlota.__flotaActiva) {
  cacheFlota.__flotaActiva = new Map();
}

/** Separado de `MAX_SIMULACIONES_ACTIVAS` — cuenta unidades de flota dadas de alta, no viajes. */
export const MAX_FLOTA_ACTIVA = 8;

/** Cuántas unidades libres candidatas (por línea recta) se llevan a ruta real en una asignación. */
const TOPK_ASIGNACION = 3;

/** Distinguible del resto de errores (Mapbox/Portal caídos, etc.) para que la ruta HTTP devuelva 429, no 502. */
export class LimiteFlotaAlcanzadaError extends Error {}

/** Issue #20/#23: ninguna unidad de flota está libre — rechazo simple, sin cola (R2). */
export class NoHayUnidadLibreError extends Error {}

/** Issue #20/#23: "Fin de turno" solo aplica a unidades libres (R3) — no a una atendiendo una llamada. */
export class UnidadEnProcesoError extends Error {}

const RADIO_PATRULLAJE_METROS = 700;
const METROS_POR_GRADO_LAT = 111_320;

/**
 * Punto de "vuelta" del patrullaje — a pedido del usuario, un recorrido corto y real (no en
 * línea recta) alrededor de donde se dio de alta la unidad. Dirección fija (norte): simple y
 * suficiente para un patrullaje visible; no busca evitar agua/parques ni variar por unidad
 * (fuera de alcance de este ticket).
 */
function puntoDeVuelta(origen: LngLat): LngLat {
  const deltaLat = RADIO_PATRULLAJE_METROS / METROS_POR_GRADO_LAT;
  return { lng: origen.lng, lat: origen.lat + deltaLat };
}

async function publicarRuta(
  ambulanceId: string,
  ruta: DrivingRoute,
  origin: LngLat,
  destination: LngLat
): Promise<void> {
  const rutaChannel = await obtenerCanalServidor<RoutePublishPayload>(rutaAmbulanciaChannelId(ambulanceId));
  await rutaChannel.send({
    content: {
      ambulanceId,
      geometry: ruta.geometry,
      distanceMeters: ruta.distanceMeters,
      durationSeconds: ruta.durationSeconds,
      origin,
      destination,
    },
  });
}

/**
 * Arranca (o reanuda, issue #20/#23 A7) el patrullaje libre de una unidad desde `origen`:
 * calcula su ruta de ida y vuelta (`fetchDrivingRoute` una sola vez — el loop se recorre
 * reusando esa misma geometría, ver `InterpoladaPosicionSource#loop`), publica la ruta, y
 * arranca su posición en loop. Deja `estado="libre"` al terminar de arrancar. Deliberadamente
 * no llama a `orquestarTick`: mientras está libre, no hay gasto de LLM/TomTom.
 *
 * Extraída de `darDeAltaUnidadFlota` (donde vivía inline en el slice 1/3) para reusarla también
 * cuando una unidad vuelve a libre tras dejar a un paciente en el hospital (A7) — misma
 * mecánica en ambos casos, sin el paso de anuncio de descubrimiento (que solo aplica al alta).
 */
async function iniciarPatrullaje(ambulanceId: string, origen: LngLat): Promise<void> {
  // Detiene cualquier timer previo (ej. el tramo 2 recién llegando al hospital, ya autodetenido
  // — este llamado es un no-op seguro en ese caso) antes de arrancar uno nuevo, para no dejar
  // dos `setInterval` corriendo para la misma unidad.
  cacheFlota.__flotaActiva!.get(ambulanceId)?.detener();

  const destino = puntoDeVuelta(origen);
  const rutaPatrullaje = await fetchDrivingRoute(origen, destino, "driving");
  await publicarRuta(ambulanceId, rutaPatrullaje, origen, destino);

  const ambulanceChannel = await obtenerCanalServidor<AmbulancePositionPayload>(
    ambulanciaChannelId(ambulanceId)
  );
  const fuente = new InterpoladaPosicionSource(rutaPatrullaje, { loop: true });
  const detener = fuente.suscribir((posicion) => {
    const unidad = cacheFlota.__flotaActiva!.get(ambulanceId);
    if (unidad) unidad.posicionActual = { lng: posicion.lng, lat: posicion.lat };
    void ambulanceChannel
      .send({ content: { ...posicion, ambulanceId }, ephemeral: true })
      .catch((error) => {
        console.error(`No se pudo publicar posición de patrullaje de ${ambulanceId}:`, error);
      });
  });

  const unidad = cacheFlota.__flotaActiva!.get(ambulanceId);
  if (unidad) {
    unidad.estado = "libre";
    unidad.detener = detener;
  }
}

/**
 * Da de alta una unidad de flota en `origen`, publica su anuncio de descubrimiento, y arranca
 * su patrullaje libre (`iniciarPatrullaje`). El placeholder reservado antes de cualquier
 * `await` queda en `estado:"en_proceso"` (no "libre") hasta que `iniciarPatrullaje` termine de
 * verdad — evita que una unidad a medio dar de alta (sin `posicionActual` real todavía) pueda
 * ser tomada por una llamada de emergencia concurrente.
 */
export async function darDeAltaUnidadFlota(ambulanceId: string, origen: LngLat): Promise<void> {
  await reconciliarSimulacionesHuerfanas();

  if (
    !cacheFlota.__flotaActiva!.has(ambulanceId) &&
    cacheFlota.__flotaActiva!.size >= MAX_FLOTA_ACTIVA
  ) {
    throw new LimiteFlotaAlcanzadaError(
      `Ya hay ${MAX_FLOTA_ACTIVA} unidades de flota activas (el máximo) — esperá a que alguna termine su turno antes de agregar otra.`
    );
  }

  // Reserva el cupo de inmediato, antes de cualquier `await` — si no, dos altas casi
  // simultáneas podrían pasar ambas el chequeo del tope (ninguna se ve todavía en el Map)
  // y admitirse las dos.
  cacheFlota.__flotaActiva!.set(ambulanceId, {
    estado: "en_proceso",
    posicionActual: origen,
    detener: () => {},
  });

  try {
    const registroChannel = await obtenerCanalServidor<AmbulanciaActivaPayload>(
      PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID
    );
    await registroChannel.send({ content: { ambulanceId, tipo: "flota" } });

    await iniciarPatrullaje(ambulanceId, origen);
  } catch (error) {
    cacheFlota.__flotaActiva!.delete(ambulanceId);
    throw error;
  }
}

/**
 * Arranca un tramo con orquestación completa (semáforos + TomTom + LLM, issue #20/#23 R5):
 * publica la ruta del tramo, arranca una `InterpoladaPosicionSource` SIN loop (se detiene sola
 * al llegar), corre `orquestarTick` por tick con el mismo guard `tickEnCurso` que
 * `lib/tick/simulacion.ts` (copiado, no compartido — evita el reprocesamiento de LLM ya
 * documentado y arreglado ahí; cada tramo tiene su propio guard de vida corta), y al llegar
 * invoca `onLlegada`. Si `onLlegada` (el resto de la cadena — el siguiente tramo, o volver a
 * libre) falla por cualquier motivo, hace fallback a `iniciarPatrullaje` desde la posición
 * final en vez de dejar la unidad varada en `en_proceso` para siempre.
 */
async function iniciarTramo(
  ambulanceId: string,
  tramoId: string,
  ruta: DrivingRoute,
  origin: LngLat,
  destination: LngLat,
  onLlegada: (posicionFinal: LngLat) => Promise<void>
): Promise<void> {
  // Detiene el timer previo de esta unidad — crucial en la transición patrullaje→tramo 1: el
  // loop de patrullaje nunca se autodetiene (`loop:true`), así que sin esto quedaría corriendo
  // en paralelo para siempre, publicando posiciones de patrullaje encima de las del tramo real.
  cacheFlota.__flotaActiva!.get(ambulanceId)?.detener();

  await publicarRuta(ambulanceId, ruta, origin, destination);

  const semaforosPendientes: SemaforoEnRuta[] = semaforosEnRuta(
    SEMAFOROS_SAN_BORJA_Y_COLINDANTES,
    ruta.geometry
  );
  const ambulanceChannel = await obtenerCanalServidor<AmbulancePositionPayload>(
    ambulanciaChannelId(ambulanceId)
  );
  const velocidadMetrosPorSegundo = ruta.distanceMeters / ruta.durationSeconds;
  const depsOrquestacion = crearOrquestarTickDepsReales("flota");

  const fuente = new InterpoladaPosicionSource(ruta);
  // Guardia de tick-en-curso, mismo patrón que `simulacion.ts` (skill `cost-audit`,
  // 2026-08-08) — sin esto, una pasada lenta de `orquestarTick` puede solaparse con el
  // siguiente tick de posición y decidir dos veces el mismo semáforo.
  let tickEnCurso = false;
  const detener = fuente.suscribir((posicion) => {
    const unidad = cacheFlota.__flotaActiva!.get(ambulanceId);
    if (unidad) unidad.posicionActual = { lng: posicion.lng, lat: posicion.lat };

    void ambulanceChannel
      .send({ content: { ...posicion, ambulanceId }, ephemeral: true })
      .catch((error) => {
        console.error(`No se pudo publicar posición del tramo de ${ambulanceId}:`, error);
      });

    if (semaforosPendientes.length > 0 && !tickEnCurso) {
      tickEnCurso = true;
      void orquestarTick(
        {
          ambulanceId,
          tramoId,
          posicionAmbulancia: { ...posicion, velocidadMetrosPorSegundo },
          semaforosPendientes,
        },
        depsOrquestacion
      )
        .catch((error) => {
          console.error(`Error orquestando tick del tramo de ${ambulanceId}:`, error);
        })
        .finally(() => {
          tickEnCurso = false;
        });
    }

    if (posicion.arrived) {
      const posicionFinal = { lng: posicion.lng, lat: posicion.lat };
      void onLlegada(posicionFinal).catch((error) => {
        console.error(
          `Error avanzando el tramo de la unidad ${ambulanceId}, volviendo a patrullaje:`,
          error
        );
        void iniciarPatrullaje(ambulanceId, posicionFinal).catch((error2) => {
          console.error(`No se pudo recuperar la unidad ${ambulanceId} a patrullaje tras un fallo:`, error2);
        });
      });
    }
  });

  const unidad = cacheFlota.__flotaActiva!.get(ambulanceId);
  if (unidad) unidad.detener = detener;
}

/** Tramo 1 (recogida) — al llegar al punto de la llamada, encadena el tramo 2 (hospital). */
async function iniciarTramoRecogida(
  ambulanceId: string,
  tramoId: string,
  origenTramo: LngLat,
  puntoLlamada: LngLat,
  rutaRecogida: DrivingRoute
): Promise<void> {
  await iniciarTramo(ambulanceId, tramoId, rutaRecogida, origenTramo, puntoLlamada, async (posicionFinal) => {
    await iniciarTramoHospital(ambulanceId, tramoId, posicionFinal);
  });
}

/** Tramo 2 (hospital) — al llegar, la unidad vuelve a libre y retoma patrullaje (A7). */
async function iniciarTramoHospital(ambulanceId: string, tramoId: string, origenTramo: LngLat): Promise<void> {
  const hospitalCercano = await hospitalMasCercano(origenTramo, HOSPITALES_SAN_BORJA_Y_COLINDANTES, {
    obtenerRuta: (o, d) => fetchDrivingRoute(o, d, "driving"),
  });
  const destino = { lng: hospitalCercano.lng, lat: hospitalCercano.lat };
  await iniciarTramo(ambulanceId, tramoId, hospitalCercano.ruta, origenTramo, destino, async (posicionFinal) => {
    await iniciarPatrullaje(ambulanceId, posicionFinal);
  });
}

/**
 * Asigna la unidad de flota libre más cercana (por ruta real) a `puntoLlamada` — issue #20/#23,
 * R2/A2/A5. Reserva síncronamente el subconjunto de candidatos preseleccionados (topK por
 * línea recta) ANTES de cualquier `await`, exactamente el mismo mecanismo anti-carrera que
 * `MAX_FLOTA_ACTIVA`/`MAX_SIMULACIONES_ACTIVAS` (reservar antes de gastar I/O real): dos
 * llamadas casi simultáneas nunca pueden terminar compitiendo por, y ganando, la misma unidad,
 * porque cualquier candidato ya reservado por la primera deja de aparecer en la lista de
 * "libres" que la segunda evalúa. Genera un `tramoId` nuevo por llamada (issue #20/#23,
 * compartido por sus dos tramos) para que `orquestarTick` no confunda una decisión de una
 * llamada anterior de esta misma unidad con la de esta.
 */
export async function asignarLlamadaEmergencia(puntoLlamada: LngLat): Promise<{ ambulanceId: string }> {
  await reconciliarSimulacionesHuerfanas();

  const libres = [...cacheFlota.__flotaActiva!.entries()].filter(([, unidad]) => unidad.estado === "libre");
  if (libres.length === 0) {
    throw new NoHayUnidadLibreError(
      "No hay ninguna unidad de flota libre para atender esta llamada — probá de nuevo cuando alguna quede libre."
    );
  }

  const candidatos = libres
    .sort(
      ([, a], [, b]) =>
        distanciaHaversineMetros(puntoLlamada, a.posicionActual) -
        distanciaHaversineMetros(puntoLlamada, b.posicionActual)
    )
    .slice(0, TOPK_ASIGNACION);

  // Reserva síncrona de TODOS los candidatos preseleccionados, antes de cualquier await.
  for (const [, unidad] of candidatos) unidad.estado = "en_proceso";

  // Snapshot congelado de la posición de cada candidato AL MOMENTO de la reserva — usado tanto
  // para pedirle a Mapbox la ruta real (`unidadLibreMasCercana`) como, más abajo, para el
  // `origin` publicado del tramo 1: el patrullaje de la unidad sigue corriendo mientras se
  // espera la respuesta de Mapbox (recién se detiene al arrancar `iniciarTramo`), así que reusar
  // este mismo snapshot (en vez de releer `posicionActual` después del await) evita que el
  // origen publicado no coincida con el que realmente se usó para calcular la ruta.
  const candidatosParaAsignacion = candidatos.map(([ambulanceId, unidad]) => ({
    ambulanceId,
    posicionActual: unidad.posicionActual,
  }));

  let ganador: UnidadLibreMasCercanaResultado | null = null;
  try {
    ganador = await unidadLibreMasCercana(
      puntoLlamada,
      candidatosParaAsignacion,
      { obtenerRuta: (origen, destino) => fetchDrivingRoute(origen, destino, "driving") },
      TOPK_ASIGNACION
    );
  } finally {
    // Libera a todos los candidatos que NO ganaron (incluye los que fallaron al pedir ruta) de
    // vuelta a libre. Si `ganador` sigue null (todos fallaron), esto libera a los TOPK_ASIGNACION.
    for (const [ambulanceId, unidad] of candidatos) {
      if (ganador?.ambulanceId !== ambulanceId) unidad.estado = "libre";
    }
  }

  // Inalcanzable en la práctica: si `unidadLibreMasCercana` falló, ya lanzó dentro del `try` y
  // esta línea nunca se ejecuta — solo estrecha el tipo para TypeScript.
  if (!ganador) {
    throw new Error("asignarLlamadaEmergencia: no se encontró un ganador tras la asignación.");
  }

  const origenGanador = candidatosParaAsignacion.find(
    (candidato) => candidato.ambulanceId === ganador.ambulanceId
  )!.posicionActual;

  const tramoId = crypto.randomUUID();
  await iniciarTramoRecogida(ganador.ambulanceId, tramoId, origenGanador, puntoLlamada, ganador.ruta);

  return { ambulanceId: ganador.ambulanceId };
}

/**
 * "Fin de turno" (issue #20/#22) — retira una unidad de flota libre de forma permanente: para
 * su patrullaje y publica en `ambulancias-detenidas`, el mismo canal que ya usa
 * `detenerSimulacionServidor` para avisar a todos los observadores que le quiten el marker de
 * inmediato. A diferencia de una llegada natural (que nunca pasa por acá — ver R7 en el shaping
 * doc), esta sí es una baja explícita y durable: no hay ambigüedad que resolver.
 *
 * No-op si `ambulanceId` no tiene una unidad de flota activa (ya se retiró, o nunca fue una
 * unidad de flota). Issue #20/#23: si la unidad está `en_proceso` (atendiendo una llamada),
 * rechaza en vez de retirarla — R3, "Fin de turno" solo aplica a unidades libres.
 */
export async function detenerUnidadFlota(ambulanceId: string): Promise<void> {
  await reconciliarSimulacionesHuerfanas();

  const unidad = cacheFlota.__flotaActiva!.get(ambulanceId);
  if (!unidad) return;

  if (unidad.estado !== "libre") {
    throw new UnidadEnProcesoError(
      "Esta unidad está atendiendo una llamada — no se puede dar fin de turno hasta que vuelva a estar libre."
    );
  }

  // Publica ANTES de parar el timer/borrar del cache (encontrado en code-review, corregido acá
  // — a diferencia de `detenerSimulacionServidor`, que hace el orden inverso): si el publish
  // falla, la unidad sigue viva y patrullando en `__flotaActiva`, así que un reintento de "Fin
  // de turno" vuelve a intentar normalmente. Con el orden inverso, un publish fallido dejaría la
  // unidad ya borrada del cache — un reintento sería un no-op silencioso (`if (!unidad) return`)
  // y la unidad quedaría huérfana para siempre: exactamente la categoría de bug que esta feature
  // existe para eliminar.
  const detenidasChannel = await obtenerCanalServidor<AmbulanciaDetenidaPayload>(
    PORTAL_AMBULANCIAS_DETENIDAS_CHANNEL_ID
  );
  await detenidasChannel.send({ content: { ambulanceId } });

  unidad.detener();
  cacheFlota.__flotaActiva!.delete(ambulanceId);
}
