// Pestañas del dataset y forma de sus rutas.
//
// Vive en su propio modulo, sin importar nada, para que la prueba de
// enrutado (scripts/test-routes.mjs) use EXACTAMENTE los mismos valores que
// la app sin arrastrar el cliente de Supabase. Si esto se duplicara, la
// prueba podria pasar mientras la navegacion real sigue rota.
//
// `to` es RELATIVO a proposito: los enlaces se renderizan dentro de la ruta
// de layout /d/:id, asi que resuelven contra ella sea cual sea la pestaña
// activa. Con rutas planas se resolvian contra la pestaña actual y
// /d/1/chat + "alertas" daba /d/1/chat/alertas, que no existe.
export interface DatasetTab {
  to: string
  label: string
  end?: boolean
}

// "Alertas" y "Copiloto" salen de la barra a peticion del usuario: las
// alertas no se usan por ahora, y el copiloto pasa a ser un chat flotante
// disponible desde cualquier pestaña. Sus RUTAS siguen existiendo, asi que
// /d/:id/alertas y /d/:id/chat se pueden abrir por URL.
export const DATASET_TABS: DatasetTab[] = [
  { to: '.', label: 'Tablero', end: true },
  { to: 'datos', label: 'Datos' },
  { to: 'rag', label: 'Configuración IA' },
]

/** Rutas hijas de /d/:id (incluidas las que no tienen pestaña). */
export const DATASET_CHILD_PATHS = ['alertas', 'chat', 'datos', 'rag'] as const
