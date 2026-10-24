import { z } from "zod";

/**
 * O vocabulário dos clientes da agência (docs/agencia/SPEC-clientes.md, C3–C4).
 * Uma fonte só: a tela, o Zod e os testes leem daqui. As colunas `situacao` e
 * `tipo` têm CHECK no banco (migration 9004); `servicos` não, porque cresce.
 */
export const SITUACOES_DO_CLIENTE = [
  "prospeccao",
  "apresentacao",
  "fechamento",
  "aguardando",
  "ativo",
  "pausado",
  "encerrado",
  "perdido",
  "remarketing",
] as const;
export type SituacaoDoCliente = (typeof SITUACOES_DO_CLIENTE)[number];

export const ROTULO_DA_SITUACAO: Record<SituacaoDoCliente, string> = {
  prospeccao: "Prospecção",
  apresentacao: "Apresentação",
  fechamento: "Fechamento",
  aguardando: "Aguardando assinatura e pagamento",
  ativo: "Ativo",
  pausado: "Pausado",
  encerrado: "Encerrado",
  perdido: "Perdido",
  remarketing: "Remarketing",
};

/** Tom da etiqueta da situação: o que está em andamento, o que vale, o que parou. */
export const TOM_DA_SITUACAO: Record<SituacaoDoCliente, "neutro" | "andamento" | "ativo" | "parado"> = {
  prospeccao: "neutro",
  apresentacao: "andamento",
  fechamento: "andamento",
  aguardando: "andamento",
  ativo: "ativo",
  pausado: "parado",
  encerrado: "parado",
  perdido: "parado",
  remarketing: "neutro",
};

export const SERVICOS = [
  "gravacao",
  "edicao",
  "social_media",
  "trafego",
  "identidade_visual",
  "artes",
  "site",
  "automacao",
  "assessoria",
  "crm",
] as const;
export type Servico = (typeof SERVICOS)[number];

export const ROTULO_DO_SERVICO: Record<Servico, string> = {
  gravacao: "Gravação",
  edicao: "Edição de vídeo",
  social_media: "Social media",
  trafego: "Tráfego pago",
  identidade_visual: "Identidade visual",
  artes: "Artes e design",
  site: "Site",
  automacao: "Automação",
  assessoria: "Assessoria de marketing",
  crm: "CRM",
};

/** As quantidades do pacote, por mês. Lidas SEMPRE por este schema, nunca por caminho solto. */
export const QUANTIDADES = ["videos", "fotos", "artes", "posts"] as const;
export type Quantidade = (typeof QUANTIDADES)[number];

export const ROTULO_DA_QUANTIDADE: Record<Quantidade, string> = {
  videos: "Vídeos por mês",
  fotos: "Fotos por mês",
  artes: "Artes por mês",
  posts: "Posts por mês",
};

export const quantidadesSchema = z
  .object(Object.fromEntries(QUANTIDADES.map((q) => [q, z.number().int().min(0).max(999).optional()])) as Record<
    Quantidade,
    z.ZodOptional<z.ZodNumber>
  >)
  .strict();
export type Quantidades = z.infer<typeof quantidadesSchema>;

/** Lê o `jsonb` do banco sem confiar nele: chave estranha ou valor inválido somem. */
export function lerQuantidades(bruto: unknown): Quantidades {
  if (!bruto || typeof bruto !== "object") return {};
  const saida: Quantidades = {};
  for (const q of QUANTIDADES) {
    const v = (bruto as Record<string, unknown>)[q];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 999) saida[q] = v;
  }
  return saida;
}

export const TIPOS_DE_CONTRATACAO = ["recorrente", "avulsa"] as const;
export const SITUACOES_DA_CONTRATACAO = ["proposta", "ativa", "pausada", "encerrada"] as const;
