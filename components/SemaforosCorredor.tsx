"use client";

import type mapboxgl from "mapbox-gl";
import { Semaforo } from "@/components/Semaforo";
import type { SemaforoEnRuta } from "@/lib/semaforo/semaforosEnRuta";
import type { AccionSemaforo } from "@/lib/tick/decision";

interface SemaforosCorredorProps {
  map: mapboxgl.Map;
  /**
   * Semáforos a renderizar — la lista ya filtrada por trayecto (`semaforosEnRuta`, ticket #9),
   * no el dataset crudo completo. El dataset fijo tiene cientos de semáforos reales en 7
   * distritos (San Borja y colindantes); renderizarlos todos a la vez satura el navegador
   * (~1000 markers + ~1000 setInterval, ver EmergencyMap). Por eso la invariante del ticket #6
   * ("siempre visibles, incluso sin trayecto activo") pasó de aplicar al dataset completo a
   * aplicar a la lista filtrada: sin trayecto, esta lista está vacía y no se renderiza nada.
   */
  semaforos: readonly SemaforoEnRuta[];
  /** Decisiones ya conocidas por semaforoId (ticket #9) — ver `Semaforo`. */
  accionesPreviasPorSemaforo?: Readonly<Record<string, readonly AccionSemaforo[]>>;
}

/** Renderiza los semáforos del trayecto activo, cada uno latiendo su fase efectiva (ciclo físico + decisiones ya publicadas). */
export function SemaforosCorredor({
  map,
  semaforos,
  accionesPreviasPorSemaforo = {},
}: SemaforosCorredorProps) {
  return (
    <>
      {semaforos.map((semaforo) => (
        <Semaforo
          key={semaforo.semaforoId}
          map={map}
          semaforoId={semaforo.semaforoId}
          lng={semaforo.lng}
          lat={semaforo.lat}
          accionesPrevias={accionesPreviasPorSemaforo[semaforo.semaforoId]}
        />
      ))}
    </>
  );
}
