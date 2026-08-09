"use client";

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import { faseEfectiva } from "@/lib/semaforo/faseEfectiva";
import type { AccionSemaforo, DecisionSemaforo } from "@/lib/tick/decision";

const TICK_MS = 1000;
const COLOR_VERDE = "#16a34a";
const COLOR_ROJO = "#dc2626";
const COLOR_BORDE_SIN_DECISION = "white";

/** Icono + etiqueta + color distintivo por acción (ticket #11) — además del texto de la explicación. */
const INFO_ACCION: Record<AccionSemaforo, { icono: string; etiqueta: string; color: string }> = {
  anticipar_verde: { icono: "⏩", etiqueta: "Verde anticipado", color: "#2563eb" },
  extender_verde: { icono: "⏳", etiqueta: "Verde extendido", color: "#7c3aed" },
  mantener_ciclo: { icono: "➖", etiqueta: "Sin intervención", color: "#64748b" },
};

function crearElementoSemaforo(): { contenedor: HTMLDivElement; badge: HTMLDivElement } {
  const contenedor = document.createElement("div");
  // Sin `position` propio a propósito: mapbox-gl aplica la clase "mapboxgl-marker", cuya hoja
  // de estilos ya fija `position: absolute; top: 0; left: 0` — necesario para que el transform
  // que posiciona el marker en el mapa funcione. Un `position: relative` inline (como tenía
  // este código antes) gana por especificidad sobre esa regla y rompe la ubicación real del
  // marker (se nota sobre todo al hacer zoom, cuando el transform se recalcula). `absolute` ya
  // sirve igual de bien como contenedor posicional para el badge de abajo.
  contenedor.style.width = "18px";
  contenedor.style.height = "18px";
  contenedor.style.borderRadius = "50%";
  contenedor.style.border = `2px solid ${COLOR_BORDE_SIN_DECISION}`;
  contenedor.style.boxShadow = "0 0 4px rgba(0,0,0,0.5)";

  // Oculto hasta que haya una decisión publicada (ticket #11) — el ícono/color de la acción se
  // agrega encima del punto de fase, sin taparlo.
  const badge = document.createElement("div");
  badge.style.position = "absolute";
  badge.style.top = "-7px";
  badge.style.right = "-7px";
  badge.style.width = "14px";
  badge.style.height = "14px";
  badge.style.borderRadius = "50%";
  badge.style.border = "1px solid white";
  badge.style.display = "none";
  badge.style.alignItems = "center";
  badge.style.justifyContent = "center";
  badge.style.fontSize = "9px";
  badge.style.lineHeight = "1";
  contenedor.appendChild(badge);

  return { contenedor, badge };
}

// El popup de mapbox-gl siempre tiene fondo blanco, sin importar el tema del sistema — pero sin
// un color de texto explícito, este contenido hereda el `color` de `body` (app/globals.css), que
// en modo oscuro es #ededed (casi blanco). Texto casi blanco sobre fondo blanco = ilegible (bug
// real reportado por el usuario, con screenshot). Colores fijos acá, independientes del tema.
const COLOR_TITULO_POPUP = "#111827";
const COLOR_TEXTO_POPUP = "#374151";

/** Contenido del popup vía DOM (no `setHTML`): la `explicacion` viene del LLM y no es texto de confianza. */
function crearContenidoPopup(decision: DecisionSemaforo): HTMLElement {
  const { icono, etiqueta } = INFO_ACCION[decision.accion];

  const contenedor = document.createElement("div");
  contenedor.style.maxWidth = "220px";
  contenedor.style.fontSize = "13px";
  contenedor.style.lineHeight = "1.4";

  const titulo = document.createElement("div");
  titulo.style.fontWeight = "600";
  titulo.style.marginBottom = "4px";
  titulo.style.color = COLOR_TITULO_POPUP;
  titulo.textContent = `${icono} ${etiqueta}`;
  contenedor.appendChild(titulo);

  const texto = document.createElement("div");
  texto.style.color = COLOR_TEXTO_POPUP;
  texto.textContent = decision.explicacion;
  contenedor.appendChild(texto);

  return contenedor;
}

interface SemaforoProps {
  map: mapboxgl.Map;
  semaforoId: string;
  lng: number;
  lat: number;
  /**
   * Decisión ya publicada para este semáforo en el trayecto activo (tickets #8/#9/#11) — fuerza
   * verde vía `faseEfectiva`, igual que en el servidor, y muestra su `explicacion` en un popup al
   * hacer click. `undefined`/`null` = solo ciclo físico (ticket #6): el semáforo late su fase
   * incluso sin trayecto activo, y no es clickeable.
   */
  decision?: DecisionSemaforo | null;
}

/** Renderiza un semáforo: fase efectiva coloreada cada segundo, más acción/explicación de su decisión (ticket #11) si ya la tiene. */
export function Semaforo({ map, semaforoId, lng, lat, decision }: SemaforoProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const badgeRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  // Ref para que el intervalo (creado una sola vez, ver abajo) siempre lea la decisión más
  // reciente sin tener que recrear el marker cada vez que el padre publica una nueva.
  const decisionRef = useRef(decision);

  // Se declara antes que el efecto de sincronización de la decisión (más abajo) para que, en el
  // montaje inicial, markerRef/badgeRef ya existan cuando ese efecto corra — React ejecuta los
  // efectos en orden de declaración.
  useEffect(() => {
    const { contenedor, badge } = crearElementoSemaforo();
    badgeRef.current = badge;
    const marker = new mapboxgl.Marker({ element: contenedor }).setLngLat([lng, lat]).addTo(map);
    markerRef.current = marker;

    const actualizarFase = () => {
      // Referenciado al reloj de pared (no al momento de montaje) para que coincida con
      // `ahoraSegundos` del lado del servidor (Date.now()/1000, ver orquestar.ts) — si no,
      // el ciclo físico que ve el usuario y el que razona el agente quedarían desfasados.
      const tiempoTranscurrido = Date.now() / 1000;
      const accionesPrevias = decisionRef.current ? [decisionRef.current.accion] : [];
      const { fase } = faseEfectiva(semaforoId, tiempoTranscurrido, accionesPrevias);
      contenedor.style.backgroundColor = fase === "verde" ? COLOR_VERDE : COLOR_ROJO;
    };
    actualizarFase();
    const timer = setInterval(actualizarFase, TICK_MS);

    return () => {
      clearInterval(timer);
      marker.remove();
      markerRef.current = null;
      badgeRef.current = null;
      popupRef.current = null;
    };
  }, [map, semaforoId, lng, lat]);

  useEffect(() => {
    decisionRef.current = decision;

    const badge = badgeRef.current;
    const marker = markerRef.current;
    if (!badge || !marker) return;

    if (decision) {
      const { icono, color } = INFO_ACCION[decision.accion];
      badge.style.display = "flex";
      badge.style.backgroundColor = color;
      badge.textContent = icono;
      marker.getElement().style.borderColor = color;
      marker.getElement().style.cursor = "pointer";

      const popup = popupRef.current ?? new mapboxgl.Popup({ offset: 14 });
      popup.setDOMContent(crearContenidoPopup(decision));
      popupRef.current = popup;
      marker.setPopup(popup);
    } else {
      badge.style.display = "none";
      marker.getElement().style.borderColor = COLOR_BORDE_SIN_DECISION;
      marker.getElement().style.cursor = "default";
      marker.setPopup(undefined);
      popupRef.current = null;
    }
  }, [decision]);

  return null;
}
