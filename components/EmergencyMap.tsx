"use client";

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Feature, LineString } from "geojson";
import { fetchDrivingRoute, type DrivingRoute, type RouteState } from "@/lib/mapbox/directions";
import { ambulancePositionAt, type AmbulancePosition } from "@/lib/mapbox/ambulance";
import { portalClient } from "@/lib/portal/client";
import { PORTAL_AMBULANCE_CHANNEL_ID, PORTAL_ROUTE_CHANNEL_ID } from "@/lib/portal/constants";
import type { AmbulancePositionPayload, RoutePublishPayload } from "@/lib/portal/messages";

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

      let elapsedSeconds = 0;
      const initialPosition = ambulancePositionAt(route, elapsedSeconds);
      const marker = new mapboxgl.Marker({ element: createAmbulanceElement() })
        .setLngLat([initialPosition.lng, initialPosition.lat])
        .addTo(map);
      ambulanceMarkerRef.current = marker;
      publishAmbulancePosition(initialPosition);

      if (initialPosition.arrived) return; // origin === destination, nada que animar

      ambulanceTimerRef.current = setInterval(() => {
        elapsedSeconds += AMBULANCE_TICK_SECONDS;
        const position = ambulancePositionAt(route, elapsedSeconds);
        marker.setLngLat([position.lng, position.lat]);
        publishAmbulancePosition(position);
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

      map.on("click", async (event) => {
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
    };
  }, [onEmergencyPointChange, onRouteStateChange]);

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-zinc-100 p-8 text-center text-sm text-zinc-500 dark:bg-zinc-900">
        Falta NEXT_PUBLIC_MAPBOX_TOKEN — agrégalo a .env (ver .env.example).
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" />;
}
