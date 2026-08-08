"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Feature, LineString } from "geojson";
import { fetchDrivingRoute, type DrivingRoute, type RouteState } from "@/lib/mapbox/directions";
import { ambulancePositionAt, type AmbulancePosition } from "@/lib/mapbox/ambulance";
import { portalClient } from "@/lib/portal/client";
import { PORTAL_AMBULANCE_CHANNEL_ID, PORTAL_ROUTE_CHANNEL_ID } from "@/lib/portal/constants";
import type { AmbulancePositionPayload, RoutePublishPayload } from "@/lib/portal/messages";
import { SemaforosCorredor } from "@/components/SemaforosCorredor";
import { SEMAFOROS_SAN_BORJA_Y_COLINDANTES } from "@/lib/semaforo/semaforosSanBorjaYColindantes";
import { semaforosEnRuta, type SemaforoEnRuta } from "@/lib/semaforo/semaforosEnRuta";
import type { DecisionSemaforo } from "@/lib/tick/decision";
import type { ResultadoSemaforo } from "@/lib/tick/orquestar";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// Corredor Av. Javier Prado (San Borja) -> Hospital Nacional Edgardo Rebagliati Martins.
const CORRIDOR_START: [number, number] = [-76.9973, -12.0905]; // Av. Javier Prado Este x Av. Aviación, San Borja
const REBAGLIATI: [number, number] = [-77.0399, -12.0784]; // Destino fijo (ver CLAUDE.md)

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

interface EmergencyMapProps {
  onEmergencyPointChange: (point: EmergencyPoint | null) => void;
  onRouteStateChange: (state: RouteState) => void;
}

export function EmergencyMap({ onEmergencyPointChange, onRouteStateChange }: EmergencyMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const ambulanceMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const ambulanceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const semaforosDeLaRutaRef = useRef<SemaforoEnRuta[]>([]);
  const [loadedMap, setLoadedMap] = useState<mapboxgl.Map | null>(null);
  // El dataset fijo (ticket #9) tiene cientos de semáforos reales en 7 distritos — mostrarlos
  // todos a la vez (invariante original del ticket #6, pensada para 1 semáforo de prueba) satura
  // el mapa y el navegador (~1000 markers + ~1000 setInterval). Por eso solo se renderiza la
  // lista ya filtrada por trayecto (`semaforosEnRuta`), no el dataset crudo completo.
  const [semaforosVisibles, setSemaforosVisibles] = useState<SemaforoEnRuta[]>([]);
  // Ticket #11: solo hace falta la última decisión por semáforo (el sistema ya decide una única
  // vez por semáforo por trayecto — ver orquestarTick), no un historial de acciones.
  const [decisionesPorSemaforo, setDecisionesPorSemaforo] = useState<
    Record<string, DecisionSemaforo>
  >({});

  useEffect(() => {
    if (!containerRef.current || !MAPBOX_TOKEN) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;
    const corridorBounds = new mapboxgl.LngLatBounds()
      .extend(CORRIDOR_START)
      .extend(REBAGLIATI);
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      bounds: corridorBounds,
      fitBoundsOptions: { padding: 64 },
    });

    map.addControl(new mapboxgl.NavigationControl(), "top-right");

    const routeChannel = portalClient.channel<RoutePublishPayload>(PORTAL_ROUTE_CHANNEL_ID);
    const ambulanceChannel = portalClient.channel<AmbulancePositionPayload>(
      PORTAL_AMBULANCE_CHANNEL_ID
    );
    routeChannel.acquire();
    ambulanceChannel.acquire();

    const publishAmbulancePosition = (position: AmbulancePosition) => {
      ambulanceChannel.send({ content: position, ephemeral: true }).catch((error) => {
        console.error("No se pudo publicar la posición de la ambulancia en Portal:", error);
      });
    };

    // El seam de orquestación (ticket #7/#8) vive en /api/tick — este es el único punto donde
    // el cliente lo invoca. Por cada semáforo del corredor filtrado (ticket #9), el servidor
    // calcula ETA/fase y decide (LLM real) si entra en la ventana de decisión; acá guardamos la
    // decisión completa (no solo la acción) para que `SemaforosCorredor` fuerce verde igual que
    // `faseEfectiva` del servidor, y además muestre la `explicacion` en un popup (ticket #11).
    const ejecutarTickOrquestacion = async (
      position: AmbulancePosition,
      velocidadMetrosPorSegundo: number
    ) => {
      const semaforosPendientes = semaforosDeLaRutaRef.current;
      if (semaforosPendientes.length === 0) return;

      try {
        const response = await fetch("/api/tick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            posicionAmbulancia: { lng: position.lng, lat: position.lat, velocidadMetrosPorSegundo },
            semaforosPendientes,
          }),
        });
        if (!response.ok) throw new Error(`Tick de orquestación falló (${response.status}).`);

        const { resultados }: { resultados: ResultadoSemaforo[] } = await response.json();
        if (resultados.every((resultado) => resultado.decision === null)) return;

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

    const clearAmbulanceTimer = () => {
      if (ambulanceTimerRef.current !== null) {
        clearInterval(ambulanceTimerRef.current);
        ambulanceTimerRef.current = null;
      }
    };

    const stopAmbulance = () => {
      clearAmbulanceTimer();
      ambulanceMarkerRef.current?.remove();
      ambulanceMarkerRef.current = null;
    };

    // `route` debe venir del perfil "driving" plano — la ambulancia es un vehículo con
    // prioridad y nunca se ralentiza por tráfico, a diferencia del ETA que ve el usuario.
    const startAmbulance = (route: DrivingRoute) => {
      stopAmbulance();
      const velocidadMetrosPorSegundo = route.distanceMeters / route.durationSeconds;

      let elapsedSeconds = 0;
      const initialPosition = ambulancePositionAt(route, elapsedSeconds);
      const marker = new mapboxgl.Marker({ element: createAmbulanceElement() })
        .setLngLat([initialPosition.lng, initialPosition.lat])
        .addTo(map);
      ambulanceMarkerRef.current = marker;
      publishAmbulancePosition(initialPosition);
      void ejecutarTickOrquestacion(initialPosition, velocidadMetrosPorSegundo);

      if (initialPosition.arrived) return; // origin === destination, nada que animar

      ambulanceTimerRef.current = setInterval(() => {
        elapsedSeconds += AMBULANCE_TICK_SECONDS;
        const position = ambulancePositionAt(route, elapsedSeconds);
        marker.setLngLat([position.lng, position.lat]);
        publishAmbulancePosition(position);
        void ejecutarTickOrquestacion(position, velocidadMetrosPorSegundo);
        if (position.arrived) clearAmbulanceTimer();
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

        markerRef.current?.remove();
        markerRef.current = new mapboxgl.Marker({ color: "#dc2626" })
          .setLngLat([lng, lat])
          .addTo(map);

        onEmergencyPointChange({ lng, lat });
        onRouteStateChange({ status: "loading" });

        abortControllerRef.current?.abort();
        const abortController = new AbortController();
        abortControllerRef.current = abortController;
        const requestId = ++requestIdRef.current;
        const routeSource = () =>
          map.getSource(ROUTE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;

        try {
          const origin = { lng, lat };
          const destination = { lng: REBAGLIATI[0], lat: REBAGLIATI[1] };
          const fetchOptions = { signal: abortController.signal };
          // Dos fetches separados a propósito: la ruta/ETA dibujada refleja tráfico real (lo que
          // experimentaría un auto normal); el ritmo propio de la ambulancia nunca lo hace
          // (vehículo con prioridad).
          const [displayRoute, ambulanceRoute] = await Promise.all([
            fetchDrivingRoute(origin, destination, "driving-traffic", fetchOptions),
            fetchDrivingRoute(origin, destination, "driving", fetchOptions),
          ]);
          if (requestId !== requestIdRef.current) return; // reemplazado por un click posterior

          routeSource()?.setData(toRouteFeature(displayRoute.geometry));
          onRouteStateChange({ status: "ready", route: displayRoute });

          // Nuevo trayecto: recorta el corredor fijo (ticket #9) a los semáforos dentro del
          // buffer de esta ruta, y olvida las decisiones del trayecto anterior — son de otro
          // recorrido, no de este.
          const semaforosDeLaRuta = semaforosEnRuta(
            SEMAFOROS_SAN_BORJA_Y_COLINDANTES,
            ambulanceRoute.geometry
          );
          semaforosDeLaRutaRef.current = semaforosDeLaRuta;
          setSemaforosVisibles(semaforosDeLaRuta);
          setDecisionesPorSemaforo({});

          // ruta-ambulancia-1 lleva la ruta propia de la ambulancia (no la ruta de tráfico que
          // se muestra) para que la línea de un suscriptor coincida exactamente con las
          // actualizaciones de posición en ambulancia-1.
          routeChannel
            .send({
              content: {
                geometry: ambulanceRoute.geometry,
                distanceMeters: ambulanceRoute.distanceMeters,
                durationSeconds: ambulanceRoute.durationSeconds,
                origin,
                destination,
              },
            })
            .catch((error) => {
              console.error("No se pudo publicar la ruta en Portal:", error);
            });

          startAmbulance(ambulanceRoute);
        } catch (error) {
          if (requestId !== requestIdRef.current) return;

          stopAmbulance();
          routeSource()?.setData(toRouteFeature(EMPTY_ROUTE_GEOMETRY));
          const message = error instanceof Error ? error.message : String(error);
          onRouteStateChange({ status: "error", message });
          console.error("No se pudo calcular la ruta a Rebagliati:", error);
        }
      });
    });

    return () => {
      abortControllerRef.current?.abort();
      stopAmbulance();
      markerRef.current?.remove();
      map.remove();
      routeChannel.release();
      ambulanceChannel.release();
      setLoadedMap(null);
    };
  }, [onEmergencyPointChange, onRouteStateChange]);

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-zinc-100 p-8 text-center text-sm text-zinc-500 dark:bg-zinc-900">
        Falta NEXT_PUBLIC_MAPBOX_TOKEN — agrégalo a .env (ver .env.example).
      </div>
    );
  }

  return (
    <>
      <div ref={containerRef} className="h-full w-full" />
      {loadedMap && (
        <SemaforosCorredor
          map={loadedMap}
          semaforos={semaforosVisibles}
          decisionesPorSemaforo={decisionesPorSemaforo}
        />
      )}
    </>
  );
}
