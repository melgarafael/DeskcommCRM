import { z } from "zod";

/**
 * O CONTRATO DA PROSPECÇÃO — um só, lido pela tela E pelas rotas.
 */

export const buscaCreateSchema = z.object({
  categorias: z.array(z.string().trim().min(2).max(80)).min(1).max(10),
  cidade: z.string().trim().max(120).optional(),
  estado: z.string().trim().max(10).optional(),
  pais: z.string().trim().length(2).default("BR"),
  raio_km: z.number().int().min(1).max(500).default(30),
  max_empresas: z.number().int().min(1).max(10000).default(500),
  provider: z.enum(["google_places", "osm_overpass", "maps_browser"]).default("osm_overpass"),
  campaign_id: z.string().uuid().nullable().optional(),
  /** "Buscar nesta área": centro direto do mapa — dispensa cidade/geocode. */
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  rotulo: z.string().trim().max(120).nullable().optional(),
});

export type BuscaCreate = z.infer<typeof buscaCreateSchema>;

export const STATUS_BUSCA = ["queued", "running", "paused", "completed", "failed", "cancelled"] as const;

export const STATUS_COMERCIAL = [
  "novo",
  "nao_analisado",
  "qualificado",
  "contato_pendente",
  "contatado",
  "respondeu",
  "sem_interesse",
  "cliente",
  "descartado",
] as const;
export type StatusComercial = (typeof STATUS_COMERCIAL)[number];

export const ROTULO_STATUS_COMERCIAL: Record<StatusComercial, string> = {
  novo: "Novo",
  nao_analisado: "Não analisado",
  qualificado: "Qualificado",
  contato_pendente: "Contato pendente",
  contatado: "Contatado",
  respondeu: "Respondeu",
  sem_interesse: "Sem interesse",
  cliente: "Cliente",
  descartado: "Descartado",
};

export const prospectPatchSchema = z.object({
  status_comercial: z.enum(STATUS_COMERCIAL).optional(),
  do_not_contact: z.boolean().optional(),
  bloqueado: z.boolean().optional(),
});

export type ProspectPatch = z.infer<typeof prospectPatchSchema>;

export const importBatchSchema = z.object({
  prospect_ids: z.array(z.string().uuid()).min(1).max(100),
  owner_user_id: z.string().uuid().nullable().optional(),
});

/**
 * Linha da ponte do Google Maps Scraper (JSON já mapeado pela tela via
 * `lib/prospeccao/importacao-maps.ts`). Espelha `NegocioDescoberto` campo a
 * campo — a rota revalida tudo, nunca confia no cliente.
 */
export const negocioArquivoSchema = z.object({
  idExterno: z.string().max(200).nullable().optional(),
  nome: z.string().trim().min(1).max(200),
  categoriaPrincipal: z.string().trim().max(120).nullable().optional(),
  categoriasSecundarias: z.array(z.string().trim().max(120)).max(10).optional(),
  telefone: z.string().trim().max(40).nullable().optional(),
  website: z.string().trim().max(300).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  endereco: z.string().trim().max(500).nullable().optional(),
  bairro: z.string().trim().max(120).nullable().optional(),
  cidade: z.string().trim().max(120).nullable().optional(),
  estado: z.string().trim().max(10).nullable().optional(),
  cep: z.string().trim().max(12).nullable().optional(),
  pais: z.string().trim().max(4).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  urlExterna: z.string().trim().max(500).nullable().optional(),
  nota: z.number().min(0).max(5).nullable().optional(),
  totalAvaliacoes: z.number().int().min(0).nullable().optional(),
});

export type NegocioArquivo = z.infer<typeof negocioArquivoSchema>;

export const arquivoMapsSchema = z.object({
  categoria: z.string().trim().min(2).max(80),
  negocios: z.array(negocioArquivoSchema).min(1).max(500),
});

export type ArquivoMaps = z.infer<typeof arquivoMapsSchema>;

export const campanhaCreateSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  categorias: z.array(z.string().trim().min(2).max(80)).min(1).max(10),
  cidades: z
    .array(z.object({ cidade: z.string().trim().min(2).max(120), estado: z.string().trim().max(10).optional() }))
    .min(1)
    .max(50),
  recorrencia_dias: z.number().int().min(7).max(365).nullable().optional(),
});

export const settingsPutSchema = z.object({
  provider_ativo: z.enum(["google_places", "osm_overpass", "maps_browser"]).optional(),
  google_api_key: z.string().trim().min(10).max(300).nullable().optional(),
  limite_por_busca: z.number().int().min(10).max(10000).optional(),
  limite_diario: z.number().int().min(10).max(100000).optional(),
  grid_size_km: z.number().min(1).max(50).optional(),
  raio_padrao_km: z.number().int().min(1).max(500).optional(),
  concorrencia: z.number().int().min(1).max(10).optional(),
  retries: z.number().int().min(0).max(10).optional(),
  timeout_ms: z.number().int().min(2000).max(120000).optional(),
  requisicoes_por_minuto: z.number().int().min(1).max(600).optional(),
  cache_ttl_dias: z.number().int().min(0).max(365).optional(),
});

export interface Prospect {
  id: string;
  nome: string;
  categoria: string | null;
  cidade: string | null;
  estado: string | null;
  telefone: string | null;
  website: string | null;
  whatsapp_potencial: boolean;
  nota: number | null;
  total_avaliacoes: number;
  provider: string;
  status_comercial: StatusComercial;
  score: number;
  contact_id: string | null;
  lead_id: string | null;
  do_not_contact: boolean;
  latitude: number | null;
  longitude: number | null;
  endereco: string | null;
  discovered_at: string;
}

export const COLUNAS_DO_PROSPECT =
  "id, nome, categoria, cidade, estado, telefone, website, whatsapp_potencial, " +
  "nota, total_avaliacoes, provider, status_comercial, score, contact_id, lead_id, " +
  "do_not_contact, latitude, longitude, endereco, discovered_at";
