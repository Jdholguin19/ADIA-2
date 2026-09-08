// Tipos para infer.js. El modulo se mantiene en JS plano a proposito: lo
// comparten el Web Worker del navegador y los scripts de node, y duplicar
// esa logica seria la forma mas facil de que cliente y servidor discrepen.
export interface InferredColumn {
  ordinal: number
  source_name: string
  column_name: string
  data_type: 'text' | 'bigint' | 'numeric' | 'boolean' | 'date'
  decimal_sep: string
  role: string
  is_analyzable: boolean
}
export function sanitizeIdent(name: unknown, fallback?: string, taken?: Set<string>): string
export function detectHeaderRow(rows: unknown[][], limit?: number): number
export function inferColumns(headers: string[], sampleRows: unknown[][]): InferredColumn[]
export function sampleIndices(total: number, want?: number): Set<number> | null
export function mojibakeRatio(text: string): number
