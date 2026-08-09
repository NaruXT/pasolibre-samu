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
  PORTAL_AMBULANCIAS_DETENIDAS_CHANNEL_ID,
  PORTAL_SEMAFOROS_CHANNEL_ID,
  rutaAmbulanciaChannelId,
} from "@/lib/portal/constants";
import type {
  AmbulanciaActivaPayload,
  AmbulanciaDetenidaPayload,
  AmbulancePositionPayload,
  RoutePublishPayload,
} from "@/lib/portal/messages";
import { SemaforosCorredor } from "@/components/SemaforosCorredor";
import { COLOR_TITULO_POPUP, COLOR_TEXTO_POPUP } from "@/components/Semaforo";
import { SEMAFOROS_SAN_BORJA_Y_COLINDANTES } from "@/lib/semaforo/semaforosSanBorjaYColindantes";
import { semaforosEnRuta, type SemaforoEnRuta } from "@/lib/semaforo/semaforosEnRuta";
import { HOSPITALES_SAN_BORJA_Y_COLINDANTES } from "@/lib/hospital/hospitalesSanBorjaYColindantes";
import type { DecisionSemaforo, DecisionSemaforoPublicada } from "@/lib/tick/decision";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// Punto de partida del corredor de referencia (Av. Javier Prado Este x Av. Aviación, San Borja)
// — solo se usa para el encuadre inicial del mapa. El destino ya no es fijo (issue #12): se
// calcula por hospital más cercano en tiempo real a partir del punto de emergencia elegido.
const CORRIDOR_START: [number, number] = [-76.9973, -12.0905];

// Issue #20, post-#23: reusado para dibujar el corredor real (origen→destino) de cada unidad de
// flota `en_proceso` — antes solo dibujaba la línea "de tráfico" del flujo default (issue #20/#23
// R0 lo dejó huérfano al hacer que un click plano ya no cree nada). Ahora es una FeatureCollection
// con una línea por unidad ocupada, no un único Feature — puede haber varias a la vez.
const ROUTE_SOURCE_ID = "emergency-route";
const ROUTE_LAYER_ID = "emergency-route-line";

// A pedido del usuario: sin esto, una ambulancia que llega a destino queda congelada en el mapa
// para siempre (nadie la remueve) — se ve el marker "llegar" un momento y después desaparece.
const TIEMPO_VISIBLE_TRAS_LLEGAR_MS = 4000;

/** Opacidad del marker según estado — bug real reportado por el usuario: no había forma visual de distinguir una unidad libre de una ocupada. */
const OPACIDAD_MARKER_POR_ESTADO: Record<"libre" | "en_proceso", string> = {
  libre: "1",
  en_proceso: "0.5",
};

function toRutasEnProcesoFeatureCollection(
  rutas: readonly { ambulanceId: string; geometry: LineString }[]
): Feature<LineString>[] {
  return rutas.map((r) => ({
    type: "Feature",
    properties: { ambulanceId: r.ambulanceId },
    geometry: r.geometry,
  }));
}

/**
 * Devuelve dos elementos, no uno — bug real encontrado en vivo (issue #20, post-#23): Mapbox GL
 * JS (v3, confirmado en su fuente — `Marker#_evaluateOpacity`) sobreescribe
 * `elementoRaíz.style.opacity` en cada `_update()` (cada tick de posición, cada pan/zoom) con
 * `1 - fogOpacity`, como parte de su propio sistema de oclusión atmosférica — el estilo
 * "streets-v12" trae niebla por default en v3, así que ese valor es efectivamente `1` casi
 * siempre, pisando silenciosamente cualquier opacidad manual puesta en el elemento que
 * `marker.getElement()` devuelve. `raiz` es el elemento que Mapbox gestiona (nunca se le toca
 * `opacity` desde acá); `interior` es un hijo que Mapbox nunca mira, así que la opacidad puesta
 * ahí sobrevive indefinidamente.
 */
function createAmbulanceElement(): { raiz: HTMLDivElement; interior: HTMLDivElement } {
  const raiz = document.createElement("div");
  const interior = document.createElement("div");
  interior.textContent = "🚑";
  interior.style.fontSize = "24px";
  interior.style.lineHeight = "1";
  raiz.appendChild(interior);
  return { raiz, interior };
}

/**
 * Issue #20, post-#23: opacidad del marker según estado real — bug real reportado por el
 * usuario ("no entiendo por qué todas las ambulancias están ocupadas"): antes no había forma
 * visual de distinguir una unidad libre de una ocupada, todas se veían idénticas. Recibe el
 * elemento INTERIOR (ver `createAmbulanceElement`), no el marker ni su elemento raíz.
 */
function aplicarEstadoAlMarker(elementoInterior: HTMLDivElement, estado: "libre" | "en_proceso"): void {
  elementoInterior.style.opacity = OPACIDAD_MARKER_POR_ESTADO[estado];
}

interface PopupFinDeTurno {
  elemento: HTMLElement;
  /** Refleja el estado real en el texto y oculta el botón mientras la unidad está `en_proceso` (R3 — "Fin de turno" solo aplica a unidades libres). */
  actualizarEstado: (estado: "libre" | "en_proceso") => void;
}

/**
 * Popup de "Fin de turno" (issue #20/#22) — solo se adjunta a unidades de flota (`tipo:
 * "flota"`), nunca a un viaje efímero (`simulacion.ts`), que no tiene concepto de "libre" para
 * retirar. `onFinDeTurno` dispara el DELETE y deshabilita el botón mientras está en vuelo — el
 * marker lo remueve `procesarDetenciones` cuando llega el aviso por `ambulancias-detenidas`
 * (mismo mecanismo ya usado para el resto de retiros), no este código.
 */
function crearPopupFinDeTurno(onFinDeTurno: () => Promise<void>): PopupFinDeTurno {
  const contenedor = document.createElement("div");
  contenedor.style.maxWidth = "180px";
  contenedor.style.fontSize = "13px";
  contenedor.style.lineHeight = "1.4";

  const titulo = document.createElement("div");
  titulo.style.fontWeight = "600";
  titulo.style.marginBottom = "4px";
  titulo.style.color = COLOR_TITULO_POPUP;
  titulo.textContent = "🚑 Unidad de flota";
  contenedor.appendChild(titulo);

  const texto = document.createElement("div");
  texto.style.marginBottom = "8px";
  texto.style.color = COLOR_TEXTO_POPUP;
  contenedor.appendChild(texto);

  const boton = document.createElement("button");
  boton.type = "button";
  boton.textContent = "Fin de turno";
  boton.style.cursor = "pointer";
  boton.style.border = "none";
  boton.style.borderRadius = "4px";
  boton.style.padding = "4px 8px";
  boton.style.fontSize = "12px";
  boton.style.fontWeight = "600";
  boton.style.color = "white";
  boton.style.backgroundColor = "#dc2626";
  boton.addEventListener("click", () => {
    boton.disabled = true;
    boton.textContent = "Retirando…";
    void onFinDeTurno().catch((error) => {
      // `console.warn`, no `console.error` — mismo motivo que en el click handler principal:
      // Next.js dev muestra un overlay bloqueante ante `console.error`, incluso para un
      // resultado esperado (ej. unidad todavía `en_proceso`, 409).
      console.warn("No se pudo dar de baja la unidad:", error);
      boton.disabled = false;
      boton.textContent = "Fin de turno";
    });
  });
  contenedor.appendChild(boton);

  const actualizarEstado = (estado: "libre" | "en_proceso") => {
    if (estado === "libre") {
      texto.textContent = "Unidad libre, patrullando.";
      boton.style.display = "";
    } else {
      texto.textContent = "Unidad en camino, atendiendo una llamada.";
      boton.style.display = "none";
    }
  };

  return { elemento: contenedor, actualizarEstado };
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
  tipo: AmbulanciaActivaPayload["tipo"];
  marker: mapboxgl.Marker;
  // Elemento interior del marker (ver `createAmbulanceElement`) — donde vive la opacidad real,
  // no en `marker.getElement()` (Mapbox la pisa en cada tick, ver `aplicarEstadoAlMarker`).
  elementoInterior: HTMLDivElement;
  semaforosPendientes: SemaforoEnRuta[];
  // Issue #20, post-#23: estado real de la unidad y geometría de su ruta vigente — leídos de
  // `RoutePublishPayload` (no ephemeral, sobrevive un refresh), no del canal de posición. Solo
  // tiene sentido para `tipo === "flota"`; un viaje efímero no tiene concepto de "libre".
  estado: "libre" | "en_proceso";
  rutaGeometry: LineString;
  // Issue #12/#15: canal Portal real y propio de esta ambulancia (no uno compartido) — se
  // adquiere al arrancar/observar la instancia y se libera al detenerla.
  routeChannel: ChannelHandle<RoutePublishPayload>;
  ambulanceChannel: ChannelHandle<AmbulancePositionPayload>;
  // Post-slice #16: este cliente solo observa (`RealPosicionSource`, empujada por Portal) — la
  // simulación en sí (`InterpoladaPosicionSource`) corre del lado servidor (`lib/tick/simulacion.ts`)
  // sin importar si la ambulancia es simulada o GPS real. `detenerFuente` cancela la suscripción.
  detenerFuente: () => void;
  // Issue #20/#23: cancela la suscripción persistente a `routeChannel` (ver `observarAmbulancia`)
  // que mantiene `semaforosPendientes` al día cuando una unidad de flota despachada publica una
  // ruta nueva en cada tramo (recogida → hospital → patrullaje) — un viaje efímero solo publica
  // una ruta en su vida, así que para ese caso esta suscripción nunca vuelve a dispararse.
  cancelarRuta: () => void;
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
  // Issue #12/#14: varias ambulancias simuladas a la vez, cada una con su propio marker/timer/
  // ruta/semáforos pendientes — reemplaza los refs singulares que solo soportaban una. Clickear
  // el mapa en modo default sigue reseteando todo (comportamiento original); "Agregar ambulancia"
  // arma un modo de un solo click que suma una instancia sin tocar las existentes.
  const ambulanceInstancesRef = useRef<Map<string, AmbulanceInstance>>(new Map());
  // Issue #12/#16: ids ya conocidos — evita que el descubrimiento vía ambulancias-activas
  // intente observar dos veces la misma ambulancia (su propio anuncio le puede volver a este
  // mismo cliente por el mismo canal).
  const idsConocidosRef = useRef<Set<string>>(new Set());
  // Post-slice #16, a pedido del usuario: ids que ya sabemos detenidos (vía
  // ambulancias-detenidas) — evita observar (o mantener visible) una ambulancia que el
  // servidor ya dejó de mover, sin importar el orden en que lleguen los mensajes de los dos
  // canales de descubrimiento/detención (ver el listener más abajo).
  const idsDetenidosRef = useRef<Set<string>>(new Set());
  // Post-slice #16: ids de simulaciones que ESTE cliente arrancó (vía POST a
  // /api/ambulance/[id]/simulate) — a diferencia de las meramente observadas (creadas por otra
  // pestaña, o reales), este cliente es responsable de pedirle al servidor que las detenga al
  // resetear el mapa o desmontar, para no dejar simulaciones "abandonadas" corriendo para
  // siempre (cada tick real gasta cuota del LLM).
  const misSimulacionesRef = useRef<Set<string>>(new Set());
  const modoAgregarRef = useRef(false);
  // Issue #20/#23: "Llamada de emergencia" arma, igual que "Agregar ambulancia", un modo de un
  // solo click — mutuamente excluyente con ese (armar uno desarma el otro).
  const modoLlamadaRef = useRef(false);
  const mountedRef = useRef(true);
  const [modoAgregarActivo, setModoAgregarActivo] = useState(false);
  const [modoLlamadaActivo, setModoLlamadaActivo] = useState(false);
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
    // Bug real reportado por el usuario ("undefined is not an object evaluating
    // e1.getCanvasContainer().appendChild"): `mountedRef` es UN SOLO ref compartido entre
    // reintentos del efecto (React StrictMode en dev monta→limpia→remonta el mismo componente).
    // Si el mount viejo arranca una espera async (`esperarBackfillListo` de más abajo, hasta 2s)
    // y se limpia (su `map` propio se destruye vía `map.remove()`) ANTES de que esa promesa
    // resuelva, para cuando resuelve `mountedRef.current` ya está en `true` de nuevo — puesto ahí
    // por el mount NUEVO, no por este — así que el chequeo `!mountedRef.current` no alcanza para
    // detectar que ESTE closure específico (con su propio `map`, ya destruido) quedó obsoleto.
    // `cancelado` es local a esta invocación del efecto — no lo pisa ningún otro mount.
    let cancelado = false;
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
    // `history: 500` explícito — bug real encontrado post-#23: el default del SDK sin esta
    // opción es 50 mensajes (confirmado en su fuente), y una sesión de pruebas extensa supera
    // eso fácil — sin esto el cliente queda ciego a anuncios más viejos que los últimos 50 y
    // vuelve a mostrar ambulancias fantasma que el servidor ya reconcilió como detenidas (que
    // caerían fuera de la misma ventana de 50 en `ambulancias-detenidas`, ver más abajo).
    const ambulanciasActivasChannel = portalClient.channel<AmbulanciaActivaPayload>(
      PORTAL_AMBULANCIAS_ACTIVAS_CHANNEL_ID,
      { history: 500 }
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

    // A pedido del usuario: canal de "detención" — cuando el servidor para una simulación
    // explícitamente (reset o pagehide de la pestaña que la arrancó), avisa acá para que TODOS
    // los observadores le quiten el marker de inmediato, no solo quien la detuvo. Declarado
    // antes de `detenerInstancia`/`observarAmbulancia` (definidos más abajo) porque su handler
    // los referencia — JS los resuelve igual al ejecutarse (son funciones, no valores), así que
    // el orden de declaración acá no importa en la práctica, pero el de *invocación* sí: el
    // `.subscribe()` real ocurre recién después de que ambas estén definidas.
    const ambulanciasDetenidasChannel = portalClient.channel<AmbulanciaDetenidaPayload>(
      PORTAL_AMBULANCIAS_DETENIDAS_CHANNEL_ID,
      { history: 500 }
    );
    ambulanciasDetenidasChannel.acquire();

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

    const routeSource = () => map.getSource(ROUTE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;

    // Issue #20, post-#23: dibuja el corredor real (origen→destino) de cada unidad de flota
    // `en_proceso` — a pedido del usuario, para que una unidad ocupada siempre muestre a dónde va,
    // incluso después de recargar la página (la fuente de verdad es `estado` en `RoutePublishPayload`,
    // no ephemeral, así que sobrevive un refresh sin depender de haber visto un tick en vivo).
    const recalcularRutasEnProceso = () => {
      const rutas = [...ambulanceInstancesRef.current.values()]
        .filter((instancia) => instancia.tipo === "flota" && instancia.estado === "en_proceso")
        .map((instancia) => ({ ambulanceId: instancia.id, geometry: instancia.rutaGeometry }));
      routeSource()?.setData({
        type: "FeatureCollection",
        features: toRutasEnProcesoFeatureCollection(rutas),
      });
    };

    const detenerInstancia = (id: string) => {
      const instancia = ambulanceInstancesRef.current.get(id);
      if (!instancia) return;
      instancia.detenerFuente();
      instancia.cancelarRuta();
      instancia.marker.remove();
      instancia.routeChannel.release();
      instancia.ambulanceChannel.release();
      ambulanceInstancesRef.current.delete(id);
      idsConocidosRef.current.delete(id);
    };

    const detenerTodasLasInstancias = () => {
      for (const id of [...ambulanceInstancesRef.current.keys()]) detenerInstancia(id);
      recalcularSemaforosVisibles();
      recalcularRutasEnProceso();
    };

    // Reacciona a `ambulancias-detenidas` (backfill + en vivo, mismo patrón que el registro):
    // marca el id como detenido (para que `observarAmbulancia` nunca lo observe si el aviso
    // llegó antes que su anuncio) y, si ya estaba visible, lo remueve ahora mismo.
    const procesarDetenciones = () => {
      if (!mountedRef.current) return;
      for (const msg of ambulanciasDetenidasChannel.messages) {
        const { ambulanceId } = msg.content;
        idsDetenidosRef.current.add(ambulanceId);
        if (ambulanceInstancesRef.current.has(ambulanceId)) {
          detenerInstancia(ambulanceId);
          recalcularSemaforosVisibles();
          recalcularRutasEnProceso();
        }
      }
    };
    const cancelarDetenciones = ambulanciasDetenidasChannel.subscribe(procesarDetenciones);
    procesarDetenciones();

    // Bug real encontrado post-#23 (issue #20): `ambulancias-activas` ahora se lee con
    // `history: 500` (fix del bug de fantasmas, ver más abajo) — con una sesión de pruebas
    // extensa, eso significa que CUALQUIER carga de página intenta `observarAmbulancia` para
    // cientos de ids históricos, la enorme mayoría ya muertos, ANTES de que el backfill de
    // `ambulancias-detenidas` tenga chance de decirle a este cliente cuáles son. Cada intento
    // abre su propio par de canales (ruta + posición) y espera hasta 5s+ por una ruta que nunca
    // va a llegar — cientos de conexiones simultáneas generan caos de timing real (confirmado en
    // vivo: unidades genuinamente vivas y `en_proceso` mostrándose como libres, o directamente
    // fallando con "no se encontró ruta"). Mismo patrón que `esperarBackfillDe` del lado
    // servidor (`lib/portal/serverReader.ts`): espera al primer `subscribe()` de detenidas (o un
    // timeout corto) antes de arrancar el procesamiento de anuncios, para que la gran mayoría de
    // los ids ya-muertos se filtren por el chequeo de `idsDetenidosRef` sin abrir ningún canal.
    const esperarBackfillListo = (canal: ChannelHandle<unknown>, timeoutMs = 2000): Promise<void> => {
      return new Promise((resolve) => {
        let cancelar: () => void = () => {};
        const temporizador = setTimeout(() => {
          cancelar();
          resolve();
        }, timeoutMs);
        cancelar = canal.subscribe(() => {
          clearTimeout(temporizador);
          cancelar();
          resolve();
        });
      });
    };

    // Issue #12/#16: espera al primer mensaje ya publicado de `canal` — NO alcanza con esperar
    // `status === "ready"` (descubierto en vivo probando este mismo slice): el backfill de
    // historial llega en un evento posterior, separado, vía `subscribe()` — leer `.messages`
    // justo cuando el status pasa a "ready" agarra un snapshot todavía vacío. `subscribe()` es
    // el "useSyncExternalStore-shaped store contract" documentado por el SDK para reaccionar a
    // cambios en `.messages`, así que re-chequear ahí (en vez de una sola lectura puntual) es la
    // forma correcta de esperar el backfill.
    // Bug real encontrado post-#23 (issue #20): resolvía en cuanto `.messages` tenía CUALQUIER
    // mensaje, sin esperar a que el backfill terminara de llegar — inofensivo mientras cada
    // ambulancia solo publicaba una ruta en toda su vida (un viaje efímero: el primer mensaje ES
    // el último), pero una unidad de flota publica una ruta nueva por cada tramo, así que "el
    // primero que llegó" ya no es necesariamente "el vigente ahora" si el backfill de varios
    // mensajes no llega como un solo evento atómico. Confirmado en vivo: una unidad `en_proceso`
    // se observaba con su ruta de patrullaje vieja (la primera publicada en su vida), mostrando
    // `estado: "libre"` en el mapa aunque la unidad ya llevaba minutos en camino a una llamada
    // real. Corregido con un debounce: espera a que `.messages` deje de crecer por `debounceMs`
    // antes de resolver, no solo a que aparezca el primer mensaje.
    const esperarPrimerMensaje = <M,>(
      canal: ChannelHandle<M>,
      timeoutMs = 5000,
      debounceMs = 400
    ): Promise<M | undefined> => {
      const ultimoMensaje = () => canal.messages[canal.messages.length - 1]?.content;

      return new Promise((resolve) => {
        let resuelto = false;
        let cancelar: () => void = () => {};
        let temporizadorSettle: ReturnType<typeof setTimeout> | null = null;

        const finalizar = () => {
          if (resuelto) return;
          resuelto = true;
          clearTimeout(temporizadorTimeout);
          if (temporizadorSettle) clearTimeout(temporizadorSettle);
          cancelar();
          resolve(ultimoMensaje());
        };

        const temporizadorTimeout = setTimeout(finalizar, timeoutMs);

        const programarSettle = () => {
          if (temporizadorSettle) clearTimeout(temporizadorSettle);
          temporizadorSettle = setTimeout(finalizar, debounceMs);
        };

        if (ultimoMensaje() !== undefined) programarSettle();
        cancelar = canal.subscribe(() => {
          if (ultimoMensaje() !== undefined) programarSettle();
        });
      });
    };

    // Post-slice #16: toda ambulancia (simulada por este cliente o por otro, o GPS real) la
    // mueve el servidor — este archivo nunca la "crea" ni publica posición por su cuenta, solo
    // observa lo que llegue por sus canales. Arrancar una simulación es un `fetch` a
    // `/api/ambulance/[id]/simulate` (ver el click handler más abajo); una vez que el servidor
    // publica la ruta + el anuncio, esta misma función la recoge igual que a cualquier otra.
    const observarAmbulancia = async (
      ambulanceId: string,
      tipo: AmbulanciaActivaPayload["tipo"]
    ) => {
      if (idsConocidosRef.current.has(ambulanceId) || idsDetenidosRef.current.has(ambulanceId)) {
        return;
      }
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

      // Re-chequeado acá, no solo al principio: mientras se esperaba la ruta (puede tardar
      // segundos), pudo llegar un aviso de detención para este mismo id — sin este segundo
      // chequeo, `procesarDetenciones` ya habría corrido y encontrado "nada que remover"
      // (esta instancia ni existía todavía en `ambulanceInstancesRef`), y esta función seguiría
      // de largo creando un marker para una ambulancia que ya sabemos detenida.
      if (!mountedRef.current || !ruta || idsDetenidosRef.current.has(ambulanceId)) {
        routeChannel.release();
        ambulanceChannel.release();
        idsConocidosRef.current.delete(ambulanceId);
        if (!ruta) {
          console.error(`No se encontró ruta publicada para la ambulancia ${ambulanceId}.`);
        }
        return;
      }

      // Issue #20, post-#23: la fuente de verdad del estado real (libre/en_proceso) es
      // `RoutePublishPayload.estado` — no ephemeral, así que sobrevive un refresh de la página
      // sin depender de haber visto un tick en vivo. `undefined` (viaje efímero, GPS real, o una
      // ruta vieja publicada antes de que este campo existiera) se trata como "libre" — a pedido
      // explícito del usuario: "si no tienen esos datos deben estar disponibles".
      const estadoInicial: "libre" | "en_proceso" = ruta.estado ?? "libre";
      const semaforosPendientes = semaforosEnRuta(SEMAFOROS_SAN_BORJA_Y_COLINDANTES, ruta.geometry);
      const { raiz: elementoRaiz, interior: elementoInterior } = createAmbulanceElement();
      const marker = new mapboxgl.Marker({ element: elementoRaiz })
        .setLngLat([ruta.origin.lng, ruta.origin.lat])
        .addTo(map);

      // Issue #20/#22: solo una unidad de flota ofrece "Fin de turno" — un viaje efímero
      // (`tipo: "viaje"`) no tiene concepto de "libre" para retirar.
      let popupFinDeTurno: PopupFinDeTurno | undefined;
      if (tipo === "flota") {
        aplicarEstadoAlMarker(elementoInterior, estadoInicial);
        popupFinDeTurno = crearPopupFinDeTurno(async () => {
          const response = await fetch(`/api/fleet/${ambulanceId}/enroll`, { method: "DELETE" });
          if (!response.ok) {
            throw new Error(`No se pudo dar de baja la unidad (${response.status}).`);
          }
        });
        popupFinDeTurno.actualizarEstado(estadoInicial);
        const popup = new mapboxgl.Popup({ offset: 14 }).setDOMContent(popupFinDeTurno.elemento);
        marker.setPopup(popup);
      }

      // Issue #20/#23: una unidad de flota despachada publica una ruta NUEVA en cada transición
      // de tramo (patrullaje → recogida → hospital → patrullaje) al mismo `routeChannel` — sin
      // esto, `semaforosPendientes` (y por lo tanto los semáforos mostrados en el mapa)
      // quedarían congelados en el corredor de la ruta que estaba vigente cuando se observó la
      // ambulancia por primera vez. `subscribe()` solo dispara para mensajes FUTUROS (no
      // re-dispara para el ya consumido por `esperarPrimerMensaje` arriba), así que no hay
      // recómputo redundante en el caso común de un viaje efímero (una sola ruta en su vida).
      // También es acá donde se recoge el `estado` de cada transición — marker/popup/línea del
      // corredor real se actualizan en el mismo lugar que ya reaccionaba a rutas nuevas.
      const actualizarRutaYSemaforos = () => {
        const ultimaRuta = routeChannel.messages[routeChannel.messages.length - 1]?.content;
        if (!ultimaRuta || !mountedRef.current) return;
        const instancia = ambulanceInstancesRef.current.get(ambulanceId);
        if (!instancia) return;
        instancia.semaforosPendientes = semaforosEnRuta(SEMAFOROS_SAN_BORJA_Y_COLINDANTES, ultimaRuta.geometry);
        recalcularSemaforosVisibles();

        if (tipo === "flota") {
          const estado = ultimaRuta.estado ?? "libre";
          instancia.estado = estado;
          instancia.rutaGeometry = ultimaRuta.geometry;
          aplicarEstadoAlMarker(instancia.elementoInterior, estado);
          popupFinDeTurno?.actualizarEstado(estado);
          recalcularRutasEnProceso();
        }
      };
      const cancelarRuta = routeChannel.subscribe(actualizarRutaYSemaforos);

      const fuente: PosicionSource = new RealPosicionSource(ambulanceChannel);
      const detenerFuente = fuente.suscribir((posicion) => {
        marker.setLngLat([posicion.lng, posicion.lat]);
        // A pedido del usuario: al llegar, se ve un momento en el destino y después se quita
        // sola — si no, queda congelada en el mapa para siempre (nadie más la remueve).
        // Issue #20/#23: condicionado a `tipo !== "flota"` — una unidad de flota reporta
        // `arrived: true` al final de CADA tramo (recogida, luego hospital), no solo al
        // terminar de verdad; solo un viaje efímero tiene un `arrived` terminal de verdad.
        if (posicion.arrived && tipo !== "flota") {
          setTimeout(() => {
            if (!mountedRef.current) return;
            detenerInstancia(ambulanceId);
            recalcularSemaforosVisibles();
            recalcularRutasEnProceso();
          }, TIEMPO_VISIBLE_TRAS_LLEGAR_MS);
        }
      });

      ambulanceInstancesRef.current.set(ambulanceId, {
        id: ambulanceId,
        tipo,
        marker,
        elementoInterior,
        semaforosPendientes,
        estado: estadoInicial,
        rutaGeometry: ruta.geometry,
        routeChannel,
        ambulanceChannel,
        detenerFuente,
        cancelarRuta,
      });
      recalcularSemaforosVisibles();
      recalcularRutasEnProceso();
    };

    // Backfill (ambulancias ya anunciadas antes de este mount) + descubrimiento en vivo, en un
    // solo mecanismo: `subscribe()` dispara tanto cuando llega el historial inicial como en cada
    // anuncio nuevo, así que re-escanear `.messages` ahí cubre ambos casos — `observarAmbulancia`
    // ya deduplica por id, así que reprocesar mensajes ya vistos no hace nada.
    const procesarAnunciosDeRegistro = () => {
      if (!mountedRef.current) return;
      for (const msg of ambulanciasActivasChannel.messages) {
        void observarAmbulancia(msg.content.ambulanceId, msg.content.tipo);
      }
    };
    // Gate real (ver el comentario junto a `esperarBackfillListo` más arriba): no arranca el
    // procesamiento de `ambulancias-activas` hasta que `ambulancias-detenidas` tuvo su primera
    // chance de backfillear — `idsDetenidosRef` ya filtra por diseño, esto solo evita que ese
    // filtro llegue demasiado tarde para cientos de ids históricos a la vez.
    let cancelarAnuncios: () => void = () => {};
    void esperarBackfillListo(ambulanciasDetenidasChannel).then(() => {
      if (cancelado || !mountedRef.current) return;
      cancelarAnuncios = ambulanciasActivasChannel.subscribe(procesarAnunciosDeRegistro);
      procesarAnunciosDeRegistro();
    });

    // El manejo de clicks vive dentro de "load" para que sea un no-op hasta que existan la
    // fuente/capa de la ruta — si no, un click durante la breve ventana de carga colocaría un
    // marcador sin ruta dibujada.
    map.on("load", () => {
      map.addSource(ROUTE_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: ROUTE_LAYER_ID,
        type: "line",
        source: ROUTE_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#f97316", "line-width": 4, "line-opacity": 0.85, "line-dasharray": [2, 1] },
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
        // Issue #20/#23: "Llamada de emergencia" arma un tercer modo, mutuamente excluyente con
        // "Agregar ambulancia" (ver los botones más abajo, que ya se encargan de que solo uno
        // esté armado a la vez).
        const esLlamada = modoLlamadaRef.current;
        modoAgregarRef.current = false;
        modoLlamadaRef.current = false;
        setModoAgregarActivo(false);
        setModoLlamadaActivo(false);

        if (esLlamada) {
          // No toca el mapa ni las instancias existentes — solo reporta la urgencia. El
          // servidor decide qué unidad la atiende (`asignarLlamadaEmergencia`); su marker/ruta
          // los recoge `observarAmbulancia`, ya suscrita al canal de descubrimiento de esa
          // unidad desde que fue dada de alta.
          try {
            const response = await fetch("/api/fleet/dispatch", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ lat, lng }),
            });
            if (!response.ok) {
              const cuerpo = await response.json().catch(() => null);
              throw new Error(cuerpo?.error ?? `No se pudo asignar una unidad (${response.status}).`);
            }
          } catch (error) {
            if (!mountedRef.current) return;
            const message = error instanceof Error ? error.message : String(error);
            // Mismo canal de error genérico que usa el flujo "Agregar ambulancia" (ver
            // `app/page.tsx`: deliberadamente no condicionado a que exista un `emergencyPoint`).
            onRouteStateChange({ status: "error", message });
            // `console.warn`, no `console.error` — bug real reportado por el usuario: Next.js
            // dev intercepta `console.error` y muestra su overlay de error a pantalla completa,
            // incluso para un resultado esperado y ya manejado (ej. "no hay unidad libre", 409),
            // que además ya se muestra en el header vía `onRouteStateChange`. Un overlay
            // bloqueante para un caso de negocio normal (no un bug) es peor UX que no loguear.
            console.warn("No se pudo asignar una unidad a la llamada de emergencia:", error);
          }
          return;
        }

        // Issue #20/#23 (R0, shaping doc): un click sin ningún botón armado ya no crea nada —
        // bug real confirmado por el usuario, decidido en el shaping de #20 pero nunca convertido
        // en criterio de aceptación de ningún ticket, así que el viejo flujo "click plano crea un
        // viaje efímero buscando hospital" seguía disparándose. `/api/ambulance/[id]/simulate`
        // (`lib/tick/simulacion.ts`) queda huérfano, sin ningún caller — mismo criterio ya
        // aplicado a `/api/tick` (ver CLAUDE.md), no se borra por si hace falta reactivarlo.
        if (!esAgregar) return;

        const ambulanceId = crypto.randomUUID();
        try {
          const response = await fetch(`/api/fleet/${ambulanceId}/enroll`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lat, lng }),
          });
          if (!response.ok) {
            // El body trae el mensaje real (ej. "Ya hay 8 unidades de flota activas...", 429)
            // — mostrar solo el status code sería mucho menos útil que decir por qué falló.
            const cuerpo = await response.json().catch(() => null);
            throw new Error(cuerpo?.error ?? `No se pudo dar de alta la unidad (${response.status}).`);
          }
          // Una unidad de flota dada de alta no es responsabilidad de esta pestaña — patrulla
          // indefinidamente sin gastar LLM/TomTom y solo se retira con "Fin de turno". El marker
          // y la coordinación semafórica los recoge `observarAmbulancia`, ya suscrita al canal
          // de descubrimiento — apenas el servidor publique su ruta y su anuncio, aparece.
        } catch (error) {
          if (!mountedRef.current) return;
          const message = error instanceof Error ? error.message : String(error);
          onRouteStateChange({ status: "error", message });
          // `console.warn`, no `console.error` — ver la nota equivalente en la rama `esLlamada`
          // de este mismo handler: Next.js dev muestra un overlay bloqueante ante `console.error`
          // incluso para resultados esperados y ya manejados (ej. tope de flota alcanzado, 429),
          // que ya se muestran en el header vía `onRouteStateChange`.
          console.warn("No se pudo dar de alta la unidad:", error);
        }
      });
    });

    return () => {
      mountedRef.current = false;
      cancelado = true;
      // Cubre el desmontaje "normal" (ej. Fast Refresh en dev, o si este componente algún día
      // se desmonta desde una navegación SPA) — el caso de recarga dura/cierre de pestaña ya lo
      // cubrió `pagehide` arriba, no este cleanup.
      window.removeEventListener("pagehide", detenerMisSimulaciones);
      detenerMisSimulaciones();
      misSimulaciones.clear();
      cancelarAnuncios();
      cancelarDecisiones();
      cancelarDetenciones();
      detenerTodasLasInstancias();
      map.remove();
      ambulanciasActivasChannel.release();
      decisionesChannel.release();
      ambulanciasDetenidasChannel.release();
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
        <div className="absolute left-4 top-4 z-10 flex gap-2">
          <button
            type="button"
            onClick={() => {
              modoAgregarRef.current = true;
              modoLlamadaRef.current = false;
              setModoAgregarActivo(true);
              setModoLlamadaActivo(false);
            }}
            disabled={modoAgregarActivo}
            className="rounded-md bg-white px-3 py-2 text-sm font-medium text-zinc-900 shadow disabled:cursor-default disabled:opacity-80 dark:bg-zinc-800 dark:text-zinc-100"
          >
            {modoAgregarActivo ? "Click en el mapa para agregar…" : "Agregar ambulancia"}
          </button>
          {/* Issue #20/#23: asigna la unidad de flota libre más cercana (por ruta real) al punto
              clickeado — ver `asignarLlamadaEmergencia` en `lib/tick/flota.ts`. */}
          <button
            type="button"
            onClick={() => {
              modoLlamadaRef.current = true;
              modoAgregarRef.current = false;
              setModoLlamadaActivo(true);
              setModoAgregarActivo(false);
            }}
            disabled={modoLlamadaActivo}
            className="rounded-md bg-white px-3 py-2 text-sm font-medium text-zinc-900 shadow disabled:cursor-default disabled:opacity-80 dark:bg-zinc-800 dark:text-zinc-100"
          >
            {modoLlamadaActivo ? "Click en el mapa para la llamada…" : "Llamada de emergencia"}
          </button>
        </div>
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
