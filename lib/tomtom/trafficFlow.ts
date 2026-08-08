import type { LngLat } from "@/lib/mapbox/directions";

const TOMTOM_API_URL = "https://api.tomtom.com/traffic/services/4/flowSegmentData";
/** Nivel de zoom para el snap al segmento vial — 10 es el valor de ejemplo de la propia
 * documentación de TomTom para contexto a nivel de calle urbana. */
const ZOOM = 10;

export type NivelCongestion = "fluido" | "moderado" | "congestionado";

export interface CongestionTransversal {
  currentSpeedKmph: number;
  freeFlowSpeedKmph: number;
  nivel: NivelCongestion;
}

interface TomTomFlowSegmentResponse {
  flowSegmentData?: {
    currentSpeed: number;
    freeFlowSpeed: number;
  };
}

/** Deriva el nivel de congestión de velocidad actual vs. velocidad de flujo libre (ticket #10). */
export function nivelDeCongestion(
  currentSpeedKmph: number,
  freeFlowSpeedKmph: number
): NivelCongestion {
  if (freeFlowSpeedKmph <= 0) return "fluido";
  const ratio = currentSpeedKmph / freeFlowSpeedKmph;
  if (ratio >= 0.8) return "fluido";
  if (ratio >= 0.5) return "moderado";
  return "congestionado";
}

/**
 * Congestión del tráfico transversal en el punto de un semáforo (ticket #10), vía TomTom Traffic
 * Flow Segment Data — nunca modula la velocidad de la ambulancia (ver CLAUDE.md), es solo
 * contexto adicional para la decisión del agente. Se consulta con el punto exacto del
 * semáforo: el dataset de semáforos (ticket #9) no tiene geometría verificada de la calle
 * transversal (rotularla quedó fuera de alcance), así que el segmento que TomTom "snapea" más
 * cerca de ese punto puede ser la vía principal o la transversal — es una simplificación
 * conocida, no un intento de forzar específicamente la transversal.
 *
 * Devuelve `null` en cualquier falla (sin API key, rate limit, red, respuesta inesperada) en
 * vez de lanzar: es contexto opcional para la decisión, no debe tumbar el tick completo si
 * TomTom no responde.
 */
export async function obtenerCongestionTransversal(
  punto: LngLat
): Promise<CongestionTransversal | null> {
  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) return null;

  const url = new URL(`${TOMTOM_API_URL}/absolute/${ZOOM}/json`);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("point", `${punto.lat},${punto.lng}`);
  url.searchParams.set("unit", "kmph");

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return null;

    const body: TomTomFlowSegmentResponse = await response.json();
    const datos = body.flowSegmentData;
    if (!datos) return null;

    return {
      currentSpeedKmph: datos.currentSpeed,
      freeFlowSpeedKmph: datos.freeFlowSpeed,
      nivel: nivelDeCongestion(datos.currentSpeed, datos.freeFlowSpeed),
    };
  } catch {
    return null;
  }
}
