"use client";

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import { faseDeSemaforo } from "@/lib/semaforo/fase";

// Coordenada de prueba fija sobre el corredor Javier Prado, sin conexión a la ambulancia ni
// al agente todavía (ticket #6) — eso llega con la orquestación real en tickets posteriores.
const SEMAFORO_PRUEBA_ID = "semaforo-prueba-1";
const SEMAFORO_PRUEBA_COORD: [number, number] = [-77.0186, -12.08445];
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
}

/** Renderiza un único semáforo hardcodeado cuya fase se recalcula cada segundo desde `faseDeSemaforo`. */
export function Semaforo({ map }: SemaforoProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  useEffect(() => {
    const elemento = crearElementoSemaforo();
    const marker = new mapboxgl.Marker({ element: elemento })
      .setLngLat(SEMAFORO_PRUEBA_COORD)
      .addTo(map);
    markerRef.current = marker;

    const inicio = Date.now();
    const actualizarFase = () => {
      const tiempoTranscurrido = (Date.now() - inicio) / 1000;
      const { fase } = faseDeSemaforo(SEMAFORO_PRUEBA_ID, tiempoTranscurrido);
      elemento.style.backgroundColor = fase === "verde" ? COLOR_VERDE : COLOR_ROJO;
    };
    actualizarFase();
    const timer = setInterval(actualizarFase, TICK_MS);

    return () => {
      clearInterval(timer);
      marker.remove();
      markerRef.current = null;
    };
  }, [map]);

  return null;
}
