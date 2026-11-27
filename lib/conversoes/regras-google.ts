/**
 * As regras de conversão do Google Ads por ETAPA do funil (migration 0436).
 *
 * Uma regra diz: "quando um negócio entrar nesta etapa, mande esta ação de
 * conversão". O vocabulário — categorias, canais e o nome do evento no
 * livro-razão — mora aqui, uma vez, e a tela, a action e o consumidor leem
 * daqui. Os CHECK da tabela repetem as mesmas listas: são a segunda linha de
 * defesa, não a fonte.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * As categorias que o Google Ads aceita numa ação de conversão
 * (`ConversionActionCategory`). O rótulo é o que a pessoa lê; o valor é o que
 * vai para a API e para a coluna `category`.
 */
export const CATEGORIAS_DE_CONVERSAO = [
  { valor: "DEFAULT", rotulo: "Padrão" },
  { valor: "CONTACT", rotulo: "Contato (conversa, ligação, e-mail)" },
  { valor: "SUBMIT_LEAD_FORM", rotulo: "Envio de formulário de lead" },
  { valor: "IMPORTED_LEAD", rotulo: "Lead importado" },
  { valor: "QUALIFIED_LEAD", rotulo: "Lead qualificado" },
  { valor: "CONVERTED_LEAD", rotulo: "Lead convertido" },
  { valor: "REQUEST_QUOTE", rotulo: "Pedido de orçamento" },
  { valor: "BOOK_APPOINTMENT", rotulo: "Agendamento" },
  { valor: "PURCHASE", rotulo: "Compra" },
  { valor: "SIGNUP", rotulo: "Cadastro" },
  { valor: "SUBSCRIBE_PAID", rotulo: "Assinatura paga" },
  { valor: "BEGIN_CHECKOUT", rotulo: "Início de checkout" },
  { valor: "ADD_TO_CART", rotulo: "Adicionou ao carrinho" },
  { valor: "PHONE_CALL_LEAD", rotulo: "Lead por ligação" },
  { valor: "STORE_VISIT", rotulo: "Visita à loja" },
  { valor: "STORE_SALE", rotulo: "Venda em loja física" },
  { valor: "PAGE_VIEW", rotulo: "Visualização de página" },
  { valor: "DOWNLOAD", rotulo: "Download" },
  { valor: "GET_DIRECTIONS", rotulo: "Pedido de rota" },
  { valor: "OUTBOUND_CLICK", rotulo: "Clique de saída" },
  { valor: "ENGAGEMENT", rotulo: "Engajamento" },
] as const;

export type CategoriaDeConversao = (typeof CATEGORIAS_DE_CONVERSAO)[number]["valor"];

export const VALORES_DE_CATEGORIA = CATEGORIAS_DE_CONVERSAO.map((c) => c.valor) as [
  CategoriaDeConversao,
  ...CategoriaDeConversao[],
];

/** Por onde o negócio entrou. "whatsapp" = tem conversa vinculada. */
export const CANAIS_DE_ENTRADA = [
  { valor: "todos", rotulo: "Todos os canais" },
  { valor: "whatsapp", rotulo: "Só WhatsApp" },
  { valor: "outros", rotulo: "Só fora do WhatsApp" },
] as const;

export type CanalDeEntrada = (typeof CANAIS_DE_ENTRADA)[number]["valor"];

/** O que fazer com o negócio ganho que não tem valor (coluna `google_purchase_value_mode`). */
export const MODOS_DE_VALOR_DA_VENDA = ["obrigatorio", "quando_houver", "nunca"] as const;
export type ModoDeValorDaVenda = (typeof MODOS_DE_VALOR_DA_VENDA)[number];

/** O evento de etapa legado da 0402 — mantém o nome para não reenviar o que já foi. */
export const EVENTO_DE_QUALIFICACAO_LEGADO = "QualifiedLead";

const PADRAO_DO_EVENTO_DE_ETAPA = /^Etapa:[0-9a-f-]{36}$/;

/** A chave do livro-razão para uma regra NOVA de etapa. */
export function eventoDaEtapa(stageId: string): `Etapa:${string}` {
  return `Etapa:${stageId}`;
}

/** É um evento que o consumidor de etapa atende (legado ou novo)? */
export function ehEventoDeEtapa(nome: unknown): nome is string {
  return (
    typeof nome === "string" &&
    (nome === EVENTO_DE_QUALIFICACAO_LEGADO || PADRAO_DO_EVENTO_DE_ETAPA.test(nome))
  );
}

export interface RegraDeConversaoGoogle {
  id: string;
  stageId: string;
  eventName: string;
  label: string;
  googleActionId: string;
  googleCustomerId?: string | null;
  googleLoginCustomerId?: string | null;
  category: CategoriaDeConversao;
  includedInConversions: boolean;
  channel: CanalDeEntrada;
  enabled: boolean;
  configuredAt: string;
}

interface LinhaDaRegra {
  id: string;
  stage_id: string;
  event_name: string;
  label: string;
  google_action_id: string;
  google_customer_id: string | null;
  google_login_customer_id: string | null;
  category: string;
  included_in_conversions: boolean;
  channel: string;
  enabled: boolean;
  configured_at: string;
}

const COLUNAS =
  "id, stage_id, event_name, label, google_action_id, google_customer_id, google_login_customer_id, category, included_in_conversions, channel, enabled, configured_at";

function paraRegra(l: LinhaDaRegra): RegraDeConversaoGoogle {
  return {
    id: l.id,
    stageId: l.stage_id,
    eventName: l.event_name,
    label: l.label,
    googleActionId: l.google_action_id,
    googleCustomerId: l.google_customer_id ?? null,
    googleLoginCustomerId: l.google_login_customer_id ?? null,
    category: (VALORES_DE_CATEGORIA as readonly string[]).includes(l.category)
      ? (l.category as CategoriaDeConversao)
      : "DEFAULT",
    includedInConversions: l.included_in_conversions,
    channel: CANAIS_DE_ENTRADA.some((c) => c.valor === l.channel)
      ? (l.channel as CanalDeEntrada)
      : "todos",
    enabled: l.enabled,
    configuredAt: l.configured_at,
  };
}

/** Todas as regras da organização, para a tela. Lança em falha de leitura. */
export async function listarRegrasGoogle(
  admin: SupabaseClient,
  organizationId: string,
): Promise<RegraDeConversaoGoogle[]> {
  const { data, error } = await admin
    .from("google_ads_conversion_rules")
    .select(COLUNAS)
    .eq("organization_id", organizationId);
  if (error) throw new Error("Não foi possível ler as regras de conversão do Google.");
  return ((data ?? []) as LinhaDaRegra[]).map(paraRegra);
}

/** As regras da etapa: o consumidor escolhe uma pelo clique, sem fanout. */
export async function lerRegrasDaEtapa(
  admin: SupabaseClient,
  organizationId: string,
  stageId: string,
): Promise<RegraDeConversaoGoogle[]> {
  const { data, error } = await admin
    .from("google_ads_conversion_rules")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("stage_id", stageId);
  if (error) throw new Error("Não foi possível ler a regra de conversão da etapa.");
  return ((data ?? []) as LinhaDaRegra[]).map(paraRegra);
}

/** A igualdade explícita vence; a regra global é apenas a alternativa legada. */
export function selecionarRegraGoogle(
  regras: RegraDeConversaoGoogle[],
  contaDoClique: string | undefined,
): RegraDeConversaoGoogle | null {
  const ligadas = regras.filter((regra) => regra.enabled);
  return (
    ligadas.find((regra) => regra.googleCustomerId === contaDoClique) ??
    ligadas.find((regra) => regra.googleCustomerId == null) ??
    null
  );
}

/**
 * O negócio entrou pelo WhatsApp? A resposta é "tem conversa vinculada" — o
 * vínculo que o nascimento do lead grava (`crm_lead_links`, `target_kind =
 * conversation`). Lança em falha de leitura.
 */
export async function canalDoLead(
  admin: SupabaseClient,
  organizationId: string,
  leadId: string,
): Promise<"whatsapp" | "outros"> {
  const { data, error } = await admin
    .from("crm_lead_links")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("lead_id", leadId)
    .eq("target_kind", "conversation")
    .limit(1);
  if (error) throw new Error("Não foi possível ler o canal de entrada do negócio.");
  return (data ?? []).length > 0 ? "whatsapp" : "outros";
}

/** O canal do negócio atende o filtro da regra? */
export function canalAtende(regra: CanalDeEntrada, doLead: "whatsapp" | "outros"): boolean {
  return regra === "todos" || regra === doLead;
}
