/**
 * Decisão: exceljs para XLSX server-side no import CRM B2B.
 *
 * - Contatos CSV (`lib/contacts/csv.ts`) permanece zero-deps.
 * - SheetJS (`xlsx`) community tem restrições de licensing para self-host.
 * - exceljs (MIT) lê .xlsx no Node; import dinâmico evita bundle no cliente.
 */
export const EXCELJS_DECISION = {
  library: "exceljs",
  version_pin: "package.json dependencies.exceljs",
  scope: "server-only via dynamic import in lib/crm-b2b/spreadsheet.ts",
} as const;
