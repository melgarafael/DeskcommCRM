/**
 * Cliente HTTP isolado da BrasilAPI (CNPJ).
 *
 * Só consulta CNPJs explicitamente pedidos pelo usuário (cadastro/import).
 * Timeout curto; Zod na borda; nunca lança para o React — retorna Result.
 */
import { z } from "zod";

const DEFAULT_BASE = "https://brasilapi.com.br/api";
const DEFAULT_TIMEOUT_MS = 8_000;

const cnaeSchema = z.object({
  code: z.union([z.string(), z.number()]).transform(String).optional(),
  text: z.string().optional(),
}).passthrough();

export const brasilApiCnpjSchema = z
  .object({
    cnpj: z.string().optional(),
    razao_social: z.string().nullable().optional(),
    nome_fantasia: z.string().nullable().optional(),
    descricao_situacao_cadastral: z.string().nullable().optional(),
    natureza_juridica: z.string().nullable().optional(),
    porte: z.string().nullable().optional(),
    capital_social: z.union([z.number(), z.string()]).nullable().optional(),
    data_inicio_atividade: z.string().nullable().optional(),
    cnae_fiscal: z.union([z.number(), z.string()]).nullable().optional(),
    cnae_fiscal_descricao: z.string().nullable().optional(),
    cnaes_secundarios: z.array(cnaeSchema).nullable().optional(),
    logradouro: z.string().nullable().optional(),
    numero: z.string().nullable().optional(),
    complemento: z.string().nullable().optional(),
    bairro: z.string().nullable().optional(),
    municipio: z.string().nullable().optional(),
    uf: z.string().nullable().optional(),
    cep: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    ddd_telefone_1: z.string().nullable().optional(),
  })
  .passthrough();

export type BrasilApiCnpj = z.infer<typeof brasilApiCnpjSchema>;

export type BrasilApiResult =
  | { ok: true; data: BrasilApiCnpj; raw: unknown }
  | {
      ok: false;
      code: "invalid_cnpj" | "not_found" | "timeout" | "upstream_error" | "incomplete";
      message: string;
      status?: number;
    };

export interface BrasilApiClientOpts {
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export function createBrasilApiClient(opts: BrasilApiClientOpts = {}) {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? fetch;

  return {
    async lookupCnpj(normalizedCnpj: string): Promise<BrasilApiResult> {
      if (!/^\d{14}$/.test(normalizedCnpj)) {
        return { ok: false, code: "invalid_cnpj", message: "CNPJ deve ter 14 dígitos." };
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchFn(`${baseUrl}/cnpj/v1/${normalizedCnpj}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: ctrl.signal,
        });
        if (res.status === 404) {
          return { ok: false, code: "not_found", message: "CNPJ não encontrado na BrasilAPI.", status: 404 };
        }
        if (!res.ok) {
          return {
            ok: false,
            code: "upstream_error",
            message: `BrasilAPI respondeu ${res.status}.`,
            status: res.status,
          };
        }
        const raw: unknown = await res.json();
        const parsed = brasilApiCnpjSchema.safeParse(raw);
        if (!parsed.success) {
          return { ok: false, code: "incomplete", message: "Resposta da BrasilAPI incompleta ou inválida." };
        }
        if (!parsed.data.razao_social && !parsed.data.nome_fantasia) {
          return { ok: false, code: "incomplete", message: "BrasilAPI sem razão social nem nome fantasia." };
        }
        return { ok: true, data: parsed.data, raw };
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        return {
          ok: false,
          code: aborted ? "timeout" : "upstream_error",
          message: aborted ? "Timeout ao consultar a BrasilAPI." : "Falha de rede ao consultar a BrasilAPI.",
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Mapeia payload BrasilAPI → colunas de `companies` (sem id/org). */
export function mapBrasilApiToCompanyFields(data: BrasilApiCnpj): Record<string, unknown> {
  const capital =
    data.capital_social === null || data.capital_social === undefined
      ? null
      : Number(data.capital_social);
  return {
    legal_name: data.razao_social ?? null,
    trade_name: data.nome_fantasia || data.razao_social || null,
    registration_status: data.descricao_situacao_cadastral ?? null,
    legal_nature: data.natureza_juridica ?? null,
    company_size: data.porte ?? null,
    share_capital: Number.isFinite(capital) ? capital : null,
    opened_at: data.data_inicio_atividade ?? null,
    main_cnae_code: data.cnae_fiscal != null ? String(data.cnae_fiscal) : null,
    main_cnae_description: data.cnae_fiscal_descricao ?? null,
    secondary_cnaes: data.cnaes_secundarios ?? [],
    street: data.logradouro ?? null,
    number: data.numero ?? null,
    complement: data.complemento ?? null,
    district: data.bairro ?? null,
    city: data.municipio ?? null,
    state: data.uf ?? null,
    zip_code: data.cep ?? null,
    email: data.email ?? null,
    phone: data.ddd_telefone_1 ?? null,
  };
}
