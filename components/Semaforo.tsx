"use client";

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import { faseEfectiva } from "@/lib/semaforo/faseEfectiva";
import type { AccionSemaforo } from "@/lib/tick/decision";

const TICK_MS = 1000;
const COLOR_VERDE = "#16a34a";
const COLOR_ROJO = "#dc2626";

function crearElementoSemaforo(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.width = "18px";
  el.style.height = "18px";
  el.style.borderRadius = "50%";
  el.style.border = "2px solid white";
  el.style.boxShadow = "0 0 4px rgba(0,0,0,0.5)";
  return el;
}

interface SemaforoProps {
  map: mapboxgl.Map;
  semaforoId: string;
  lng: number;
  lat: number;
  /**
   * Decisiones ya publicadas para este semáforo en el trayecto activo (tickets #8/#9) — fuerzan
   * verde vía `faseEfectiva`, igual que en el servidor. Vacío/omitido = solo ciclo físico
   * (ticket #6): el semáforo late su fase incluso sin trayecto activo.
   */
  accionesPrevias?: readonly AccionSemaforo[];
}

/** Renderiza un semáforo cuya fase efectiva (ciclo físico + decisiones ya publicadas) se recalcula cada segundo. */
export function Semaforo({ map, semaforoId, lng, lat, accionesPrevias = [] }: SemaforoProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  // Ref para que el intervalo (creado una sola vez, ver abajo) siempre lea las acciones más
  // recientes sin tener que recrear el marker cada vez que el padre publica una decisión nueva.
  const accionesPreviasRef = useRef(accionesPrevias);
  useEffect(() => {
    accionesPreviasRef.current = accionesPrevias;
  }, [accionesPrevias]);

  useEffect(() => {
    const elemento = crearElementoSemaforo();
    const marker = new mapboxgl.Marker({ element: elemento }).setLngLat([lng, lat]).addTo(map);
    markerRef.current = marker;

    const actualizarFase = () => {
      // Referenciado al reloj de pared (no al momento de montaje) para que coincida con
      // `ahoraSegundos` del lado del servidor (Date.now()/1000, ver orquestar.ts) — si no,
      // el ciclo físico que ve el usuario y el que razona el agente quedarían desfasados.
      const tiempoTranscurrido = Date.now() / 1000;
      const { fase } = faseEfectiva(semaforoId, tiempoTranscurrido, accionesPreviasRef.current);
      elemento.style.backgroundColor = fase === "verde" ? COLOR_VERDE : COLOR_ROJO;
    };
    actualizarFase();
    const timer = setInterval(actualizarFase, TICK_MS);

    return () => {
      clearInterval(timer);
      marker.remove();
      markerRef.current = null;
    };
  }, [map, semaforoId, lng, lat]);

  return null;
}
