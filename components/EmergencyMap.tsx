"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Feature, LineString } from "geojson";
import type { ChannelHandle } from "@portalsdk/core";
import type { RouteState } from "@/lib/mapbox/directions";
import { RealPosicionSource, type PosicionSource } from "@/lib/mapbox/posicionSource";
import { portalClient } from "@/lib/portal/client";
import {
  ambulanciaChannelId,
  PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID,
  PORTAL_SEMAFOROS_CHANNEL_ID,
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
import { HOSPITALES_SAN_BORJA_Y_COLINDANTES } from "@/lib/hospital/hospitalesSanBorjaYColindantes";
import type { DecisionSemaforo, DecisionSemaforoPublicada } from "@/lib/tick/decision";
import type { ResultadoIniciarSimulacion } from "@/lib/tick/simulacion";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// Punto de partida del corredor de referencia (Av. Javier Prado Este x Av. Aviación, San Borja)
// — solo se usa para el encuadre inicial del mapa. El destino ya no es fijo (issue #12): se
// calcula por hospital más cercano en tiempo real a partir del punto de emergencia elegido.
const CORRIDOR_START: [number, number] = [-76.9973, -12.0905];

const ROUTE_SOURCE_ID = "emergency-route";
const ROUTE_LAYER_ID = "emergency-route-line";
const EMPTY_ROUTE_GEOMETRY: LineString = { type: "LineString", coordinates: [] };

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
  semaforosPendientes: SemaforoEnRuta[];
  // Issue #12/#15: canal Portal real y propio de esta ambulancia (no uno compartido) — se
  // adquiere al arrancar/observar la instancia y se libera al detenerla.
  routeChannel: ChannelHandle<RoutePublishPayload>;
  ambulanceChannel: ChannelHandle<AmbulancePositionPayload>;
  // Post-slice #16: este cliente solo observa (`RealPosicionSource`, empujada por Portal) — la
  // simulación en sí (`InterpoladaPosicionSource`) corre del lado servidor (`lib/tick/simulacion.ts`)
  // sin importar si la ambulancia es simulada o GPS real. `detenerFuente` cancela la suscripción.
  detenerFuente: () => void;
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
  // Issue #12/#16: ids ya conocidos — evita que el descubrimiento vía ambulancias-activas
  // intente observar dos veces la misma ambulancia (su propio anuncio le puede volver a este
  // mismo cliente por el mismo canal).
  const idsConocidosRef = useRef<Set<string>>(new Set());
  // Post-slice #16: ids de simulaciones que ESTE cliente arrancó (vía POST a
  // /api/ambulance/[id]/simulate) — a diferencia de las meramente observadas (creadas por otra
  // pestaña, o reales), este cliente es responsable de pedirle al servidor que las detenga al
  // resetear el mapa o desmontar, para no dejar simulaciones "abandonadas" corriendo para
  // siempre (cada tick real gasta cuota del LLM).
  const misSimulacionesRef = useRef<Set<string>>(new Set());
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
    // Capturado una vez: el mismo Set vive durante todo el ciclo de vida del efecto (nunca se
    // reasigna), así que leerlo acá en vez de `misSimulacionesRef.current` en cada sitio evita
    // la advertencia de exhaustive-deps sobre refs leídos en el cleanup.
    const misSimulaciones = misSimulacionesRef.current;

    // Descubierto en vivo probando este mismo fix: el cleanup de useEffect (el `return () =>
    // {...}` de más abajo) NO corre en una recarga dura o al cerrar la pestaña — React solo lo
    // dispara cuando desmonta el componente por su cuenta (ej. navegación SPA), y acá no hay
    // ninguna. En una recarga real, el navegador destruye el contexto de JS antes de que React
    // tenga chance de reaccionar. `pagehide` es el evento correcto para engancharse (más
    // confiable que `beforeunload` con el bfcache); `keepalive` dejar que el fetch de DELETE
    // siga en vuelo aunque la página ya se esté descargando.
    const detenerMisSimulaciones = () => {
      for (const id of misSimulaciones) {
        fetch(`/api/ambulance/${id}/simulate`, { method: "DELETE", keepalive: true }).catch(() => {});
      }
      misSimulaciones.clear();
    };
    window.addEventListener("pagehide", detenerMisSimulaciones);

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
    // AmbulanceInstance) — este cliente adquiere los suyos al observarla en `observarAmbulancia`.
    const ambulanciasActivasChannel = portalClient.channel<AmbulanciaActivaPayload>(
      PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID
    );
    ambulanciasActivasChannel.acquire();

    // Post-slice #16: todas las ambulancias (simuladas o reales) las mueve el servidor — este
    // cliente nunca publica posición ni dispara /api/tick por su cuenta, solo observa. Las
    // decisiones semafóricas (ticket #11) se leen directo de semaforos-ruta-1, no de la
    // respuesta de un tick propio — cualquier tick, sin importar qué ambulancia lo disparó,
    // actualiza esta vista igual.
    const decisionesChannel = portalClient.channel<DecisionSemaforoPublicada>(
      PORTAL_SEMAFOROS_CHANNEL_ID
    );
    decisionesChannel.acquire();
    const procesarDecisiones = () => {
      if (!mountedRef.current || decisionesChannel.messages.length === 0) return;
      setDecisionesPorSemaforo((previo) => {
        const siguiente = { ...previo };
        for (const msg of decisionesChannel.messages) {
          siguiente[msg.content.semaforoId] = msg.content;
        }
        return siguiente;
      });
    };
    const cancelarDecisiones = decisionesChannel.subscribe(procesarDecisiones);
    procesarDecisiones();

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

    const detenerInstancia = (id: string) => {
      const instancia = ambulanceInstancesRef.current.get(id);
      if (!instancia) return;
      instancia.detenerFuente();
      instancia.marker.remove();
      instancia.routeChannel.release();
      instancia.ambulanceChannel.release();
      ambulanceInstancesRef.current.delete(id);
      idsConocidosRef.current.delete(id);
    };

    const detenerTodasLasInstancias = () => {
      for (const id of [...ambulanceInstancesRef.current.keys()]) detenerInstancia(id);
      recalcularSemaforosVisibles();
    };

    // Issue #12/#16: espera al primer mensaje ya publicado de `canal` — NO alcanza con esperar
    // `status === "ready"` (descubierto en vivo probando este mismo slice): el backfill de
    // historial llega en un evento posterior, separado, vía `subscribe()` — leer `.messages`
    // justo cuando el status pasa a "ready" agarra un snapshot todavía vacío. `subscribe()` es
    // el "useSyncExternalStore-shaped store contract" documentado por el SDK para reaccionar a
    // cambios en `.messages`, así que re-chequear ahí (en vez de una sola lectura puntual) es la
    // forma correcta de esperar el backfill.
    const esperarPrimerMensaje = <M,>(
      canal: ChannelHandle<M>,
      timeoutMs = 5000
    ): Promise<M | undefined> => {
      const ultimoMensaje = () => canal.messages[canal.messages.length - 1]?.content;
      const yaDisponible = ultimoMensaje();
      if (yaDisponible !== undefined) return Promise.resolve(yaDisponible);

      return new Promise((resolve) => {
        let cancelar: () => void = () => {};
        const temporizador = setTimeout(() => {
          cancelar();
          resolve(undefined);
        }, timeoutMs);
        cancelar = canal.subscribe(() => {
          const mensaje = ultimoMensaje();
          if (mensaje !== undefined) {
            clearTimeout(temporizador);
            cancelar();
            resolve(mensaje);
          }
        });
      });
    };

    // Post-slice #16: toda ambulancia (simulada por este cliente o por otro, o GPS real) la
    // mueve el servidor — este archivo nunca la "crea" ni publica posición por su cuenta, solo
    // observa lo que llegue por sus canales. Arrancar una simulación es un `fetch` a
    // `/api/ambulance/[id]/simulate` (ver el click handler más abajo); una vez que el servidor
    // publica la ruta + el anuncio, esta misma función la recoge igual que a cualquier otra.
    const observarAmbulancia = async (ambulanceId: string) => {
      if (idsConocidosRef.current.has(ambulanceId)) return;
      idsConocidosRef.current.add(ambulanceId);

      const routeChannel = portalClient.channel<RoutePublishPayload>(
        rutaAmbulanciaChannelId(ambulanceId)
      );
      const ambulanceChannel = portalClient.channel<AmbulancePositionPayload>(
        ambulanciaChannelId(ambulanceId)
      );
      routeChannel.acquire();
      ambulanceChannel.acquire();

      const ruta = await esperarPrimerMensaje(routeChannel);

      if (!mountedRef.current || !ruta) {
        routeChannel.release();
        ambulanceChannel.release();
        idsConocidosRef.current.delete(ambulanceId);
        if (!ruta) {
          console.error(`No se encontró ruta publicada para la ambulancia ${ambulanceId}.`);
        }
        return;
      }

      const semaforosPendientes = semaforosEnRuta(SEMAFOROS_SAN_BORJA_Y_COLINDANTES, ruta.geometry);
      const marker = new mapboxgl.Marker({ element: createAmbulanceElement() })
        .setLngLat([ruta.origin.lng, ruta.origin.lat])
        .addTo(map);

      const fuente: PosicionSource = new RealPosicionSource(ambulanceChannel);
      const detenerFuente = fuente.suscribir((posicion) => {
        marker.setLngLat([posicion.lng, posicion.lat]);
      });

      ambulanceInstancesRef.current.set(ambulanceId, {
        id: ambulanceId,
        marker,
        semaforosPendientes,
        routeChannel,
        ambulanceChannel,
        detenerFuente,
      });
      recalcularSemaforosVisibles();
    };

    // Backfill (ambulancias ya anunciadas antes de este mount) + descubrimiento en vivo, en un
    // solo mecanismo: `subscribe()` dispara tanto cuando llega el historial inicial como en cada
    // anuncio nuevo, así que re-escanear `.messages` ahí cubre ambos casos — `observarAmbulancia`
    // ya deduplica por id, así que reprocesar mensajes ya vistos no hace nada.
    const procesarAnunciosDeRegistro = () => {
      if (!mountedRef.current) return;
      for (const msg of ambulanciasActivasChannel.messages) {
        void observarAmbulancia(msg.content.ambulanceId);
      }
    };
    const cancelarAnuncios = ambulanciasActivasChannel.subscribe(procesarAnunciosDeRegistro);
    procesarAnunciosDeRegistro();

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
          // A pedido del usuario: resetear el mapa también detiene, en el servidor, las
          // simulaciones que ESTE cliente arrancó — no solo deja de observarlas acá. Sin esto
          // quedarían corriendo para siempre (cada tick real gasta cuota del LLM).
          detenerMisSimulaciones();
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
          // Post-slice #16: el cliente ya no calcula hospital/ruta ni simula nada — le pide al
          // servidor que arranque (o reinicie) la simulación de esta ambulancia. El servidor
          // hace exactamente lo que antes hacía este click handler (hospital más cercano por
          // ruta real, sin excluir por especialidad) y además la mueve, sin depender de que
          // esta pestaña siga abierta — mismo mecanismo que una ambulancia GPS real.
          const response = await fetch(`/api/ambulance/${ambulanceId}/simulate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lat, lng }),
            signal: fetchOptions.signal,
          });
          if (!response.ok) throw new Error(`No se pudo arrancar la simulación (${response.status}).`);
          const data: ResultadoIniciarSimulacion = await response.json();
          if (!mountedRef.current || !sigueVigente()) return;

          misSimulaciones.add(ambulanceId);

          if (!esAgregar) {
            onDestinationChange?.(data.destino);
            // El flujo default dibuja la línea "de tráfico" (perfil driving-traffic, la que ve
            // el usuario); con ambulancias agregadas, cada una publica su propia ruta a Portal
            // pero no pisa esta línea (la única que se muestra en el mapa).
            routeSource()?.setData(toRouteFeature(data.rutaTrafico.geometry));
            onRouteStateChange({ status: "ready", route: data.rutaTrafico });
          }
          // El marker y la coordinación semafórica de esta ambulancia los recoge
          // `observarAmbulancia`, ya suscrita al canal de descubrimiento — apenas el servidor
          // publique su ruta y su anuncio, aparece igual que cualquier otra.
        } catch (error) {
          if (!mountedRef.current || !sigueVigente()) return;

          const message = error instanceof Error ? error.message : String(error);
          if (!esAgregar) {
            routeSource()?.setData(toRouteFeature(EMPTY_ROUTE_GEOMETRY));
            onRouteStateChange({ status: "error", message });
            onDestinationChange?.(null);
          }
          console.error("No se pudo arrancar la simulación de la ambulancia:", error);
        }
      });
    });

    return () => {
      mountedRef.current = false;
      abortControllerRef.current?.abort();
      // Cubre el desmontaje "normal" (ej. Fast Refresh en dev, o si este componente algún día
      // se desmonta desde una navegación SPA) — el caso de recarga dura/cierre de pestaña ya lo
      // cubrió `pagehide` arriba, no este cleanup.
      window.removeEventListener("pagehide", detenerMisSimulaciones);
      detenerMisSimulaciones();
      misSimulaciones.clear();
      cancelarAnuncios();
      cancelarDecisiones();
      detenerTodasLasInstancias();
      markerRef.current?.remove();
      map.remove();
      ambulanciasActivasChannel.release();
      decisionesChannel.release();
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
