import { create } from 'zustand'

// Estado de filtros del tablero. Vive fuera del arbol de rutas para que el
// chat flotante lea exactamente lo mismo que se esta viendo, sin pasar props
// por media aplicacion.
export interface DashFilters {
  datasetId: number | null
  period: string | null
  filters: Record<string, string>
  search: string
  setDataset: (id: number) => void
  setPeriod: (p: string | null) => void
  setFilter: (col: string, value: string) => void
  setSearch: (s: string) => void
  reset: () => void
}

export const useFilters = create<DashFilters>((set) => ({
  datasetId: null,
  period: null,
  filters: {},
  search: '',
  setDataset: (id) =>
    set((s) => (s.datasetId === id ? s : { datasetId: id, period: null, filters: {}, search: '' })),
  setPeriod: (period) => set({ period }),
  setFilter: (col, value) =>
    set((s) => {
      const f = { ...s.filters }
      if (!value) delete f[col]
      else f[col] = value
      return { filters: f }
    }),
  setSearch: (search) => set({ search }),
  reset: () => set({ period: null, filters: {}, search: '' }),
}))

/** Resumen legible de los filtros activos, para mostrarlo y para el chat. */
export function describeFilters(s: Pick<DashFilters, 'period' | 'filters' | 'search'>) {
  const out: string[] = []
  if (s.period) out.push('periodo ' + s.period)
  for (const [k, v] of Object.entries(s.filters)) out.push(k + ' = ' + v)
  if (s.search.trim()) out.push('texto contiene "' + s.search.trim() + '"')
  return out
}
