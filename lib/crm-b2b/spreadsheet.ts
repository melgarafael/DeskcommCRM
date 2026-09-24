/**
 * Leitura de planilha para import CRM B2B — CSV (reusa parser existente) + XLSX (exceljs, server-only).
 *
 * Decisão de dependência: `exceljs` (MIT) só no servidor. Não usar `xlsx` (SheetJS)
 * community pelo risco de licensing no self-host. O importador de contatos CSV
 * permanece intacto em `lib/contacts/csv.ts`.
 */
import { decodificarCsv, parseCsv } from "@/lib/contacts/csv";

export type SheetMatrix = { headers: string[]; rows: string[][] };

export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_DATA_ROWS = 2_000;

export function isXlsxFilename(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith(".xlsx") || n.endsWith(".xls");
}

export function isCsvFilename(name: string): boolean {
  return name.toLowerCase().endsWith(".csv");
}

export async function parseImportFile(
  bytes: ArrayBuffer,
  filename: string,
): Promise<{ ok: true; sheet: SheetMatrix } | { ok: false; error: string }> {
  if (bytes.byteLength > IMPORT_MAX_BYTES) {
    return { ok: false, error: `Arquivo maior que ${IMPORT_MAX_BYTES} bytes.` };
  }

  if (isXlsxFilename(filename)) {
    return parseXlsx(bytes);
  }

  if (isCsvFilename(filename)) {
    return parseCsvBytes(bytes);
  }

  return {
    ok: false,
    error: "Formato não suportado — envie .csv ou .xlsx.",
  };
}

function parseCsvBytes(
  bytes: ArrayBuffer,
): { ok: true; sheet: SheetMatrix } | { ok: false; error: string } {
  const decoded = decodificarCsv(bytes);
  if ("erro" in decoded) return { ok: false, error: decoded.erro };
  const matrix = parseCsv(decoded.texto);
  if (matrix.length < 2) {
    return { ok: false, error: "Preciso de cabeçalho e ao menos uma linha de dados." };
  }
  const headers = matrix[0]!.map((h) => h.trim());
  const rows = matrix.slice(1);
  if (rows.length > IMPORT_MAX_DATA_ROWS) {
    return { ok: false, error: `Máximo de ${IMPORT_MAX_DATA_ROWS} linhas de dados.` };
  }
  const width = headers.length;
  const normalized = rows.map((r) => {
    const out = r.slice(0, width);
    while (out.length < width) out.push("");
    return out;
  });
  return { ok: true, sheet: { headers, rows: normalized } };
}

async function parseXlsx(
  bytes: ArrayBuffer,
): Promise<{ ok: true; sheet: SheetMatrix } | { ok: false; error: string }> {
  // Import dinâmico: exceljs não entra no bundle do cliente.
  const ExcelJS = await import("exceljs");
  const Workbook = ExcelJS.Workbook ?? (ExcelJS as unknown as { default: { Workbook: typeof ExcelJS.Workbook } }).default?.Workbook;
  if (!Workbook) return { ok: false, error: "exceljs indisponível." };
  const wb = new Workbook();
  try {
    // exceljs tipa Buffer; no Node 22 ArrayBuffer funciona via Buffer.from
    await wb.xlsx.load(Buffer.from(bytes) as never);
  } catch {
    return { ok: false, error: "Não consegui ler o arquivo XLSX." };
  }
  const sheet = wb.worksheets[0];
  if (!sheet) return { ok: false, error: "Planilha vazia." };

  const matrix: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values;
    // exceljs: values[0] é undefined; 1-based
    const cells: string[] = [];
    const len = Array.isArray(values) ? values.length - 1 : 0;
    for (let i = 1; i <= len; i++) {
      const v = Array.isArray(values) ? values[i] : undefined;
      cells.push(cellToString(v));
    }
    matrix.push(cells);
  });

  if (matrix.length < 2) {
    return { ok: false, error: "Preciso de cabeçalho e ao menos uma linha de dados." };
  }
  const headers = matrix[0]!.map((h) => h.trim());
  const rows = matrix.slice(1);
  if (rows.length > IMPORT_MAX_DATA_ROWS) {
    return { ok: false, error: `Máximo de ${IMPORT_MAX_DATA_ROWS} linhas de dados.` };
  }
  // Pad rows to header width
  const width = headers.length;
  const normalized = rows.map((r) => {
    const out = r.slice(0, width);
    while (out.length < width) out.push("");
    return out;
  });
  return { ok: true, sheet: { headers, rows: normalized } };
}

function cellToString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && v !== null && "text" in v) {
    return String((v as { text: unknown }).text ?? "");
  }
  if (typeof v === "object" && v !== null && "result" in v) {
    return String((v as { result: unknown }).result ?? "");
  }
  return String(v);
}

/** Sugere mapeamento por apelidos comuns de coluna. */
const ALIASES: Record<string, string[]> = {
  company_name: ["empresa", "company", "company_name", "nome da empresa", "razao", "razão social"],
  legal_name: ["razao social", "razão social", "legal_name", "razao_social"],
  trade_name: ["nome fantasia", "fantasia", "trade_name", "nome_fantasia"],
  cnpj: ["cnpj"],
  person_name: ["pessoa", "decisor", "contato", "nome", "person", "person_name", "nome do contato"],
  job_title: ["cargo", "job_title", "função", "funcao", "titulo"],
  phone: ["telefone", "phone", "celular", "whatsapp", "fone"],
  email: ["email", "e-mail", "mail"],
};

export type MappingField =
  | "company_name"
  | "legal_name"
  | "trade_name"
  | "cnpj"
  | "person_name"
  | "job_title"
  | "phone"
  | "email";

export function suggestColumnMapping(headers: string[]): Partial<Record<MappingField, string>> {
  const out: Partial<Record<MappingField, string>> = {};
  const lower = headers.map((h) => ({ raw: h, key: h.trim().toLowerCase() }));
  for (const [field, aliases] of Object.entries(ALIASES) as [MappingField, string[]][]) {
    const hit = lower.find((h) => aliases.includes(h.key));
    if (hit) out[field] = hit.raw;
  }
  return out;
}

export function applyMapping(
  headers: string[],
  row: string[],
  mapping: Partial<Record<MappingField, string>>,
): Record<MappingField, string> {
  const idx = new Map(headers.map((h, i) => [h, i]));
  const get = (field: MappingField): string => {
    const col = mapping[field];
    if (!col) return "";
    const i = idx.get(col);
    if (i === undefined) return "";
    return (row[i] ?? "").trim();
  };
  return {
    company_name: get("company_name"),
    legal_name: get("legal_name"),
    trade_name: get("trade_name"),
    cnpj: get("cnpj"),
    person_name: get("person_name"),
    job_title: get("job_title"),
    phone: get("phone"),
    email: get("email"),
  };
}
