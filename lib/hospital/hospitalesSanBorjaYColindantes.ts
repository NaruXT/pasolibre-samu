export interface HospitalFijo {
  hospitalId: string;
  lat: number;
  lng: number;
  zona: string;
  nombre: string;
  /** `healthcare:speciality` de OSM cuando existe (ej. "paediatrics", "oncology"); no se usa para filtrar — ver issue #12. */
  especialidad: string | null;
}

/**
 * Dataset fijo de hospitales reales (`amenity=hospital`) en los mismos 7 distritos que
 * `lib/semaforo/semaforosSanBorjaYColindantes.ts` (ticket #9) — San Borja, San Isidro, San
 * Luis, La Victoria, Santiago de Surco, Surquillo, Jesús María. Issue #12: reemplaza el
 * destino fijo (Rebagliati) por un cálculo dinámico del hospital más cercano por ruta real.
 * Verificado vía Overpass API con las mismas relaciones distritales que ticket #9 (San Borja
 * 1944802, San Isidro 1944812, San Luis 1944820, La Victoria 1944748, Santiago de Surco
 * 1944844, Surquillo 1944852, Jesús María 1944744).
 *
 * A diferencia de los semáforos (siempre nodos `highway=traffic_signals`), los hospitales reales
 * casi nunca son nodos: la mayoría son *ways* (el polígono del complejo hospitalario) etiquetados
 * `amenity=hospital`. Un query `node[amenity=hospital]` solo devolvía 4 resultados en toda la
 * zona (clínicas pequeñas mapeadas como punto) — ni Rebagliati ni el Instituto del Niño
 * aparecían. Se usó `nwr[amenity=hospital]` (node/way/relation) con `out center` para obtener
 * un punto representativo de cada way/relation. `hospitalId` es `"<tipo-osm>/<id-osm>"` (ej.
 * `"way/39413837"` para Rebagliati) porque, a diferencia de los semáforos, el id numérico solo
 * no es único entre tipos OSM aquí.
 *
 * `especialidad` viene de `healthcare:speciality` cuando OSM lo tiene (ej. el Instituto Nacional
 * de Salud del Niño es "paediatrics" — el hallazgo original que motivó el issue #12). No se usa
 * para excluir candidatos: a pedido explícito del usuario, `hospitalMasCercano` no filtra por
 * especialidad, así que este campo es informativo únicamente por ahora. Seedeado como datos
 * estáticos: no se vuelve a consultar Overpass en runtime. 20 hospitales.
 */
export const HOSPITALES_SAN_BORJA_Y_COLINDANTES: readonly HospitalFijo[] = [
  { hospitalId: "way/39413837", lat: -12.078364, lng: -77.0399044, zona: "Jesús María", nombre: "Hospital Nacional Edgardo Rebagliati Martins", especialidad: "general" },
  { hospitalId: "way/450128393", lat: -12.0785806, lng: -77.0371483, zona: "Jesús María", nombre: "Complejo Hospitalario Arenales", especialidad: "general" },
  { hospitalId: "node/13626817206", lat: -12.0788208, lng: -77.0369795, zona: "Jesús María", nombre: "Torre Trecca", especialidad: null },
  { hospitalId: "node/4552742992", lat: -12.071483, lng: -77.0498354, zona: "Jesús María", nombre: "UBAB Jesús María", especialidad: null },
  { hospitalId: "node/5008524121", lat: -12.0877134, lng: -77.0546996, zona: "Jesús María", nombre: "Policlínico Peruano Japonés", especialidad: null },
  { hospitalId: "way/175012617", lat: -12.0862779, lng: -77.0612312, zona: "Jesús María", nombre: "Hospital Central Militar Coronel Luis Arias Schreiber", especialidad: null },
  { hospitalId: "way/278393025", lat: -12.0849729, lng: -77.0599318, zona: "Jesús María", nombre: "Hospital Nacional PNP Luis N. Saenz", especialidad: null },
  { hospitalId: "way/1340373104", lat: -12.0848068, lng: -77.0591135, zona: "Jesús María", nombre: "Hospital Nacional PNP Luis N. Saenz", especialidad: null },
  { hospitalId: "way/151303103", lat: -12.0856358, lng: -76.9921762, zona: "San Borja", nombre: "Instituto Nacional de Salud del Niño", especialidad: "paediatrics" },
  { hospitalId: "node/5082616122", lat: -12.0609093, lng: -77.0294569, zona: "La Victoria", nombre: "Hospitalidad de la Solidaridad", especialidad: null },
  { hospitalId: "way/40301323", lat: -12.0595788, lng: -77.022335, zona: "La Victoria", nombre: "Hospital Nacional Guillermo Almenara Irigoyen", especialidad: null },
  { hospitalId: "way/412486776", lat: -12.0614801, lng: -77.0217478, zona: "La Victoria", nombre: "Centro de Rehabilitación Personal La Victoria", especialidad: null },
  { hospitalId: "way/437496535", lat: -12.0609181, lng: -77.02994, zona: "La Victoria", nombre: "SISOL Salud La Victoria", especialidad: "general" },
  { hospitalId: "way/485409220", lat: -12.0584042, lng: -77.0214361, zona: "La Victoria", nombre: "Hospital Especializado de Emergencias Pediatricas", especialidad: null },
  { hospitalId: "way/1016726371", lat: -12.0712644, lng: -77.0133991, zona: "La Victoria", nombre: "Centro De Salud Mental Comunitario La Victoria", especialidad: null },
  { hospitalId: "way/185197319", lat: -12.1441317, lng: -77.0058183, zona: "Santiago de Surco", nombre: "Hospital Municipal de Surco", especialidad: null },
  { hospitalId: "way/391969601", lat: -12.1479973, lng: -76.9839532, zona: "Santiago de Surco", nombre: "Hospital Municipal Surco Salud", especialidad: null },
  { hospitalId: "way/338350659", lat: -12.1126056, lng: -76.9985145, zona: "Surquillo", nombre: "Instituto Nacional de Enfermedades Neoplásicas", especialidad: "oncology" },
  { hospitalId: "way/445502597", lat: -12.1087954, lng: -77.0120165, zona: "Surquillo", nombre: "Centro de Salud Villa Victoria", especialidad: null },
  { hospitalId: "way/780628452", lat: -12.1032022, lng: -77.020556, zona: "Surquillo", nombre: "Instituto de Salud Oral FAP", especialidad: "geriatrics" },
];
