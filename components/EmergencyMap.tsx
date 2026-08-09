"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Feature, LineString } from "geojson";
import type { ChannelHandle } from "@portalsdk/core";
import { fetchDrivingRoute, type DrivingRoute, type LngLat, type RouteState } from "@/lib/mapbox/directions";
import { ambulancePositionAt, type AmbulancePosition } from "@/lib/mapbox/ambulance";
import { portalClient } from "@/lib/portal/client";
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
import { SemaforosCorredor } from "@/components/SemaforosCorredor";
import { SEMAFOROS_SAN_BORJA_Y_COLINDANTES } from "@/lib/semaforo/semaforosSanBorjaYColindantes";
import { semaforosEnRuta, type SemaforoEnRuta } from "@/lib/semaforo/semaforosEnRuta";
import { hospitalMasCercano } from "@/lib/hospital/hospitalMasCercano";
import { HOSPITALES_SAN_BORJA_Y_COLINDANTES } from "@/lib/hospital/hospitalesSanBorjaYColindantes";
import type { DecisionSemaforo } from "@/lib/tick/decision";
import type { ResultadoSemaforo } from "@/lib/tick/orquestar";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// Punto de partida del corredor de referencia (Av. Javier Prado Este x Av. Aviación, San Borja)
// — solo se usa para el encuadre inicial del mapa. El destino ya no es fijo (issue #12): se
// calcula por hospital más cercano en tiempo real a partir del punto de emergencia elegido.
const CORRIDOR_START: [number, number] = [-76.9973, -12.0905];

const ROUTE_SOURCE_ID = "emergency-route";
const ROUTE_LAYER_ID = "emergency-route-line";
const EMPTY_ROUTE_GEOMETRY: LineString = { type: "LineString", coordinates: [] };

const AMBULANCE_TICK_SECONDS = 5;
const AMBULANCE_TICK_MS = AMBULANCE_TICK_SECONDS * 1000;

function toRouteFeature(geometry: LineString): Feature<LineString> {
  return { type: "Feature", properties: {}, geometry };
}

function createAmbulanceElement(): HTMLDivElement {
  const el = document.createElement("div");
  el.textContent = "🚑";
  el.style.fontSize = "24px";
  el.style.lineHeight = "1";
  return el;
}

export interface EmergencyPoint {
  lng: number;
  lat: number;
}

export interface HospitalDestino {
  nombre: string;
  lng: number;
  lat: number;
}

interface AmbulanceInstance {
  id: string;
  marker: mapboxgl.Marker;
  timer: ReturnType<typeof setInterval> | null;
  elapsedSeconds: number;
  route: DrivingRoute;
  semaforosPendientes: SemaforoEnRuta[];
  velocidadMetrosPorSegundo: number;
  // Issue #12/#15: canal Portal real y propio de esta ambulancia (no uno compartido) — se
  // adquiere al arrancar la instancia y se libera al detenerla.
  routeChannel: ChannelHandle<RoutePublishPayload>;
  ambulanceChannel: ChannelHandle<AmbulancePositionPayload>;
}

interface EmergencyMapProps {
  onEmergencyPointChange: (point: EmergencyPoint | null) => void;
  onRouteStateChange: (state: RouteState) => void;
  onDestinationChange?: (destino: HospitalDestino | null) => void;
}

export function EmergencyMap({
  onEmergencyPointChange,
  onRouteStateChange,
  onDestinationChange,
}: EmergencyMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Issue #12/#14: varias ambulancias simuladas a la vez, cada una con su propio marker/timer/
  // ruta/semáforos pendientes — reemplaza los refs singulares que solo soportaban una. Clickear
  // el mapa en modo default sigue reseteando todo (comportamiento original); "Agregar ambulancia"
  // arma un modo de un solo click que suma una instancia sin tocar las existentes.
  const ambulanceInstancesRef = useRef<Map<string, AmbulanceInstance>>(new Map());
  const modoAgregarRef = useRef(false);
  const mountedRef = useRef(true);
  const [modoAgregarActivo, setModoAgregarActivo] = useState(false);
  const [loadedMap, setLoadedMap] = useState<mapboxgl.Map | null>(null);
  // El dataset fijo (ticket #9) tiene cientos de semáforos reales en 7 distritos — mostrarlos
  // todos a la vez (invariante original del ticket #6, pensada para 1 semáforo de prueba) satura
  // el mapa y el navegador (~1000 markers + ~1000 setInterval). Por eso solo se renderiza la
  // unión (deduplicada por semaforoId) de los corredores filtrados (`semaforosEnRuta`) de las
  // ambulancias activas, no el dataset crudo completo.
  const [semaforosVisibles, setSemaforosVisibles] = useState<SemaforoEnRuta[]>([]);
  // Ticket #11: solo hace falta la última decisión por semáforo (el sistema ya decide una única
  // vez por semáforo por trayecto — ver orquestarTick), no un historial de acciones. Con varias
  // ambulancias activas, dos trayectos distintos pueden decidir para el mismo semaforoId físico
  // — el marcador en el mapa es uno solo por ubicación, así que solo puede mostrar la decisión
  // más reciente que llegó, no las dos a la vez (límite de la UI, no de la orquestación: cada
  // ambulancia sí decide de forma independiente — ver `orquestarTick`).
  const [decisionesPorSemaforo, setDecisionesPorSemaforo] = useState<
    Record<string, DecisionSemaforo>
  >({});

  useEffect(() => {
    if (!containerRef.current || !MAPBOX_TOKEN) return;

    mountedRef.current = true;
    mapboxgl.accessToken = MAPBOX_TOKEN;
    // Sin destino fijo, el encuadre inicial cubre el punto de partida de referencia y todo el
    // dataset de hospitales (mismos 7 distritos que el dataset de semáforos, ticket #9) en vez
    // de un único punto fijo.
    const corridorBounds = HOSPITALES_SAN_BORJA_Y_COLINDANTES.reduce(
      (bounds, hospital) => bounds.extend([hospital.lng, hospital.lat]),
      new mapboxgl.LngLatBounds().extend(CORRIDOR_START)
    );
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      bounds: corridorBounds,
      fitBoundsOptions: { padding: 64 },
    });

    map.addControl(new mapboxgl.NavigationControl(), "top-right");

    // Issue #12/#15: canal fijo de descubrimiento — cada ambulancia anuncia acá su propio id al
    // arrancar, para que un watcher (ej. /ambulance-watch) sepa qué canales por-ambulancia
    // suscribir dinámicamente. Los canales de ruta/posición en sí ya no son compartidos (ver
    // AmbulanceInstance) — cada ambulancia adquiere los suyos en `iniciarAmbulancia`.
    const ambulanciasActivasChannel = portalClient.channel<AmbulanciaActivaPayload>(
      PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID
    );
    ambulanciasActivasChannel.acquire();

    const publishAmbulancePosition = (
      ambulanceChannel: ChannelHandle<AmbulancePositionPayload>,
      ambulanceId: string,
      position: AmbulancePosition
    ) => {
      ambulanceChannel
        .send({ content: { ...position, ambulanceId }, ephemeral: true })
        .catch((error) => {
          console.error("No se pudo publicar la posición de la ambulancia en Portal:", error);
        });
    };

    // Unión deduplicada (por semaforoId) de los corredores filtrados de todas las instancias
    // activas — el marcador en el mapa es uno por ubicación física, no uno por ambulancia.
    const recalcularSemaforosVisibles = () => {
      const vistos = new Map<string, SemaforoEnRuta>();
      for (const instancia of ambulanceInstancesRef.current.values()) {
        for (const semaforo of instancia.semaforosPendientes) {
          vistos.set(semaforo.semaforoId, semaforo);
        }
      }
      setSemaforosVisibles([...vistos.values()]);
    };

    // El seam de orquestación (ticket #7/#8) vive en /api/tick — este es el único punto donde
    // el cliente lo invoca. Por cada semáforo del corredor filtrado (ticket #9), el servidor
    // calcula ETA/fase y decide (LLM real) si entra en la ventana de decisión; acá guardamos la
    // decisión completa (no solo la acción) para que `SemaforosCorredor` fuerce verde igual que
    // `faseEfectiva` del servidor, y además muestre la `explicacion` en un popup (ticket #11).
    // Issue #12/#14: `ambulanceId` viaja en el body para que el servidor escope "ya decidido"
    // por trayecto, no solo por semáforo.
    const ejecutarTickOrquestacion = async (
      ambulanceId: string,
      position: AmbulancePosition,
      velocidadMetrosPorSegundo: number,
      semaforosPendientes: SemaforoEnRuta[]
    ) => {
      if (semaforosPendientes.length === 0) return;

      try {
        const response = await fetch("/api/tick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ambulanceId,
            posicionAmbulancia: { lng: position.lng, lat: position.lat, velocidadMetrosPorSegundo },
            semaforosPendientes,
          }),
        });
        if (!response.ok) throw new Error(`Tick de orquestación falló (${response.status}).`);

        const { resultados }: { resultados: ResultadoSemaforo[] } = await response.json();
        if (resultados.every((resultado) => resultado.decision === null)) return;
        if (!mountedRef.current) return;

        setDecisionesPorSemaforo((previo) => {
          const siguiente = { ...previo };
          for (const resultado of resultados) {
            if (!resultado.decision) continue;
            siguiente[resultado.semaforoId] = resultado.decision;
          }
          return siguiente;
        });
      } catch (error) {
        console.error("No se pudo ejecutar el tick de orquestación:", error);
      }
    };

    const detenerInstancia = (id: string) => {
      const instancia = ambulanceInstancesRef.current.get(id);
      if (!instancia) return;
      if (instancia.timer !== null) clearInterval(instancia.timer);
      instancia.marker.remove();
      instancia.routeChannel.release();
      instancia.ambulanceChannel.release();
      ambulanceInstancesRef.current.delete(id);
    };

    const detenerTodasLasInstancias = () => {
      for (const id of [...ambulanceInstancesRef.current.keys()]) detenerInstancia(id);
      recalcularSemaforosVisibles();
    };

    // `route` debe venir del perfil "driving" plano — la ambulancia es un vehículo con
    // prioridad y nunca se ralentiza por tráfico, a diferencia del ETA que ve el usuario.
    const iniciarAmbulancia = (
      ambulanceId: string,
      route: DrivingRoute,
      origin: LngLat,
      destination: LngLat,
      semaforosPendientes: SemaforoEnRuta[]
    ) => {
      // Issue #12/#15: canal Portal real y propio de esta ambulancia, no uno compartido.
      const routeChannel = portalClient.channel<RoutePublishPayload>(
        rutaAmbulanciaChannelId(ambulanceId)
      );
      const ambulanceChannel = portalClient.channel<AmbulancePositionPayload>(
        ambulanciaChannelId(ambulanceId)
      );
      routeChannel.acquire();
      ambulanceChannel.acquire();

      ambulanciasActivasChannel.send({ content: { ambulanceId } }).catch((error) => {
        console.error("No se pudo anunciar la ambulancia en Portal:", error);
      });

      // El propio canal de ruta de esta ambulancia lleva su geometría/metadata (no la ruta de
      // tráfico que se muestra) para que un suscriptor coincida exactamente con las
      // actualizaciones de posición en su canal de posición.
      routeChannel
        .send({
          content: {
            ambulanceId,
            geometry: route.geometry,
            distanceMeters: route.distanceMeters,
            durationSeconds: route.durationSeconds,
            origin,
            destination,
          },
        })
        .catch((error) => {
          console.error("No se pudo publicar la ruta en Portal:", error);
        });

      const velocidadMetrosPorSegundo = route.distanceMeters / route.durationSeconds;
      const posicionInicial = ambulancePositionAt(route, 0);
      const marker = new mapboxgl.Marker({ element: createAmbulanceElement() })
        .setLngLat([posicionInicial.lng, posicionInicial.lat])
        .addTo(map);

      const instancia: AmbulanceInstance = {
        id: ambulanceId,
        marker,
        timer: null,
        elapsedSeconds: 0,
        route,
        semaforosPendientes,
        velocidadMetrosPorSegundo,
        routeChannel,
        ambulanceChannel,
      };
      ambulanceInstancesRef.current.set(ambulanceId, instancia);
      recalcularSemaforosVisibles();

      publishAmbulancePosition(ambulanceChannel, ambulanceId, posicionInicial);
      void ejecutarTickOrquestacion(
        ambulanceId,
        posicionInicial,
        velocidadMetrosPorSegundo,
        semaforosPendientes
      );

      if (posicionInicial.arrived) return; // origin === destination, nada que animar

      instancia.timer = setInterval(() => {
        instancia.elapsedSeconds += AMBULANCE_TICK_SECONDS;
        const posicion = ambulancePositionAt(route, instancia.elapsedSeconds);
        instancia.marker.setLngLat([posicion.lng, posicion.lat]);
        publishAmbulancePosition(ambulanceChannel, ambulanceId, posicion);
        void ejecutarTickOrquestacion(
          ambulanceId,
          posicion,
          velocidadMetrosPorSegundo,
          semaforosPendientes
        );
        if (posicion.arrived && instancia.timer !== null) {
          clearInterval(instancia.timer);
          instancia.timer = null;
        }
      }, AMBULANCE_TICK_MS);
    };

    // El manejo de clicks vive dentro de "load" para que sea un no-op hasta que existan la
    // fuente/capa de la ruta — si no, un click durante la breve ventana de carga colocaría un
    // marcador sin ruta dibujada.
    map.on("load", () => {
      map.addSource(ROUTE_SOURCE_ID, {
        type: "geojson",
        data: toRouteFeature(EMPTY_ROUTE_GEOMETRY),
      });
      map.addLayer({
        id: ROUTE_LAYER_ID,
        type: "line",
        source: ROUTE_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#2563eb", "line-width": 5, "line-opacity": 0.85 },
      });

      setLoadedMap(map);

      map.on("click", async (event) => {
        // Mapbox entrega el evento "click" del mapa para clicks en CUALQUIER punto del
        // contenedor, incluyendo los que caen sobre un marker (semáforo, ambulancia, el pin de
        // emergencia) — es el mismo evento que un Marker con popup usa internamente para
        // decidir si togglear su popup (ver Marker#_onMapClick en mapbox-gl). Sin este filtro,
        // clickear un semáforo para ver su explicación (ticket #11) también reseteaba el
        // trayecto entero: se interpretaba como un nuevo punto de emergencia ahí mismo, lo que
        // además explicaba por qué "no aparecían todos los semáforos" — la lista se recalculaba
        // para una ruta nueva y mucho más corta desde ese semáforo.
        if (event.originalEvent.target !== map.getCanvas()) return;

        const { lng, lat } = event.lngLat;

        // Issue #12/#14: sin "Agregar ambulancia" armado, un click se comporta exactamente como
        // antes (resetea todo — "nueva emergencia"). Con el modo armado (un solo click, se
        // desarma acá mismo), en cambio suma una instancia sin tocar las existentes.
        const esAgregar = modoAgregarRef.current;
        modoAgregarRef.current = false;
        setModoAgregarActivo(false);

        const ambulanceId = crypto.randomUUID();
        const routeSource = () =>
          map.getSource(ROUTE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;

        let requestId = -1;
        let fetchOptions: { signal: AbortSignal };
        if (esAgregar) {
          fetchOptions = { signal: new AbortController().signal };
        } else {
          detenerTodasLasInstancias();
          markerRef.current?.remove();
          markerRef.current = new mapboxgl.Marker({ color: "#dc2626" })
            .setLngLat([lng, lat])
            .addTo(map);

          onEmergencyPointChange({ lng, lat });
          onRouteStateChange({ status: "loading" });

          abortControllerRef.current?.abort();
          const abortController = new AbortController();
          abortControllerRef.current = abortController;
          requestId = ++requestIdRef.current;
          fetchOptions = { signal: abortController.signal };
        }
        // Para el flujo default, un click posterior invalida este: comparar contra
        // requestIdRef.current. El flujo "agregar" no se cancela por otros clicks — cada
        // ambulancia agregada corre independiente hasta resolver o fallar.
        const sigueVigente = () => esAgregar || requestId === requestIdRef.current;

        try {
          const origin = { lng, lat };

          // Hospital más cercano por duración de ruta real (issue #12), no línea recta ni un
          // destino fijo — sin excluir ninguno por especialidad. La ruta "driving" que gana esta
          // comparación es directamente `ambulanceRoute`: no hace falta pedirla de nuevo.
          const hospitalCercano = await hospitalMasCercano(
            origin,
            HOSPITALES_SAN_BORJA_Y_COLINDANTES,
            { obtenerRuta: (o, d) => fetchDrivingRoute(o, d, "driving", fetchOptions) }
          );
          if (!mountedRef.current || !sigueVigente()) return;

          const destination = { lng: hospitalCercano.lng, lat: hospitalCercano.lat };
          const ambulanceRoute = hospitalCercano.ruta;
          if (!esAgregar) {
            onDestinationChange?.({
              nombre: hospitalCercano.nombre,
              lng: hospitalCercano.lng,
              lat: hospitalCercano.lat,
            });
          }
          // Fetch separado a propósito: la ruta/ETA dibujada refleja tráfico real (lo que
          // experimentaría un auto normal); el ritmo propio de la ambulancia nunca lo hace
          // (vehículo con prioridad) — ver `ambulanceRoute` arriba, perfil "driving" plano.
          const displayRoute = await fetchDrivingRoute(origin, destination, "driving-traffic", fetchOptions);
          if (!mountedRef.current || !sigueVigente()) return;

          // El flujo default sigue dibujando SU ruta como la línea "de tráfico" mostrada; con
          // ambulancias agregadas, cada una publica su propia ruta a Portal pero no pisa la
          // línea dibujada del flujo default (que es la única que se muestra en este mapa).
          if (!esAgregar) {
            routeSource()?.setData(toRouteFeature(displayRoute.geometry));
            onRouteStateChange({ status: "ready", route: displayRoute });
          }

          // Corredor de esta ambulancia: recorta el corredor fijo (ticket #9) a los semáforos
          // dentro del buffer de SU ruta — cada instancia tiene su propia lista, unida con las
          // de las demás para renderizar (ver `recalcularSemaforosVisibles`).
          const semaforosDeLaRuta = semaforosEnRuta(
            SEMAFOROS_SAN_BORJA_Y_COLINDANTES,
            ambulanceRoute.geometry
          );
          if (!esAgregar) setDecisionesPorSemaforo({});

          iniciarAmbulancia(ambulanceId, ambulanceRoute, origin, destination, semaforosDeLaRuta);
        } catch (error) {
          if (!mountedRef.current || !sigueVigente()) return;

          const message = error instanceof Error ? error.message : String(error);
          if (!esAgregar) {
            routeSource()?.setData(toRouteFeature(EMPTY_ROUTE_GEOMETRY));
            onRouteStateChange({ status: "error", message });
            onDestinationChange?.(null);
          }
          console.error("No se pudo calcular la ruta al hospital más cercano:", error);
        }
      });
    });

    return () => {
      mountedRef.current = false;
      abortControllerRef.current?.abort();
      detenerTodasLasInstancias();
      markerRef.current?.remove();
      map.remove();
      ambulanciasActivasChannel.release();
      setLoadedMap(null);
    };
  }, [onEmergencyPointChange, onRouteStateChange, onDestinationChange]);

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-zinc-100 p-8 text-center text-sm text-zinc-500 dark:bg-zinc-900">
        Falta NEXT_PUBLIC_MAPBOX_TOKEN — agrégalo a .env (ver .env.example).
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {loadedMap && (
        <button
          type="button"
          onClick={() => {
            modoAgregarRef.current = true;
            setModoAgregarActivo(true);
          }}
          disabled={modoAgregarActivo}
          className="absolute left-4 top-4 z-10 rounded-md bg-white px-3 py-2 text-sm font-medium text-zinc-900 shadow disabled:cursor-default disabled:opacity-80 dark:bg-zinc-800 dark:text-zinc-100"
        >
          {modoAgregarActivo ? "Click en el mapa para agregar…" : "Agregar ambulancia"}
        </button>
      )}
      {loadedMap && (
        <SemaforosCorredor
          map={loadedMap}
          semaforos={semaforosVisibles}
          decisionesPorSemaforo={decisionesPorSemaforo}
        />
      )}
    </div>
  );
}
