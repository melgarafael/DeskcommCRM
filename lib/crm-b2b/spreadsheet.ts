/**
 * Mapeamento de colunas do import B2B (empresas e pessoas).
 *
 * A leitura do arquivo (CSV e XLSX) mora em `lib/planilha/ler-arquivo.ts`; os nomes
 * são reexportados aqui para a API pública deste módulo continuar a mesma.
 */
export {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_DATA_ROWS,
  isCsvFilename,
  isXlsxFilename,
  parseImportFile,
} from "@/lib/planilha/ler-arquivo";
export type { SheetMatrix } from "@/lib/planilha/ler-arquivo";

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
