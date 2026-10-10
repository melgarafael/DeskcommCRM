/**
 * As regras de conversão da Meta por ETAPA do funil (migration 0524).
 *
 * Uma regra diz: "quando um negócio entrar nesta etapa, mande este evento padrão
 * da Meta". É o par das regras do Google (`regras-google.ts`), com duas
 * diferenças que vêm da plataforma: não há "ação de conversão" a criar na conta
 * — o evento é um NOME da lista padrão — e a chave no livro-razão tem prefixo
 * próprio (`MetaEtapa:`), para a mesma etapa poder avisar as duas plataformas.
 *
 * O vocabulário mora aqui, uma vez; o CHECK da tabela repete a lista como
 * segunda linha de defesa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelConversionInput } from "@/lib/channels/types";

/**
 * Os eventos padrão que a Meta aceita também em conversão de conversa
 * (`action_source = business_messaging`), que é por onde sai quem veio do
 * anúncio clique-para-WhatsApp. Lista fechada: um nome fora dela seria aceito
 * como evento personalizado e não alimentaria a otimização padrão.
 */
export const EVENTOS_DA_META = [
  { valor: "LeadSubmitted", rotulo: "Lead enviado" },
  { valor: "QualifiedLead", rotulo: "Lead qualificado" },
  { valor: "InitiateCheckout", rotulo: "Início de compra (orçamento)" },
  { valor: "AddToCart", rotulo: "Adicionou ao carrinho" },
  { valor: "ViewContent", rotulo: "Viu o conteúdo" },
] as const;

export type EventoDaMeta = (typeof EVENTOS_DA_META)[number]["valor"];

export const VALORES_DE_EVENTO_DA_META = EVENTOS_DA_META.map((e) => e.valor) as [
  EventoDaMeta,
  ...EventoDaMeta[],
];

/**
 * Os eventos de etapa que o canal sabe repassar (`ChannelConversionInput`) — um
 * recorte de `EVENTOS_DA_META`. Mora aqui, e não no envio, para o texto da
 * pendência (`MOTIVO_LEGIVEL.evento_fora_do_canal`) listar a MESMA coisa que o
 * envio aceita, com os rótulos da tela.
 */
export const EVENTOS_DE_ETAPA_NO_CANAL = [
  "InitiateCheckout",
  "LeadSubmitted",
  "AddToCart",
] as const satisfies readonly (ChannelConversionInput["event"] & EventoDaMeta)[];

export function ehEventoDaMeta(valor: unknown): valor is EventoDaMeta {
  return (
    typeof valor === "string" && (VALORES_DE_EVENTO_DA_META as readonly string[]).includes(valor)
  );
}

export function rotuloDoEventoDaMeta(valor: string): string {
  return EVENTOS_DA_META.find((e) => e.valor === valor)?.rotulo ?? valor;
}

/**
 * A sugestão para uma etapa, pelo nome — o "Usar o recomendado" da tela. Só
 * sugere; quem liga e salva é a pessoa. Etapa sem nome reconhecível fica sem
 * sugestão, e nunca se sugere evento para etapa de ganho (a compra já vai).
 */
export function eventoRecomendadoParaMeta(nomeDaEtapa: string): EventoDaMeta | null {
  const nome = nomeDaEtapa.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (/orcament|proposta|cotac/.test(nome)) return "InitiateCheckout";
  if (/agend|consulta|visita|reuniao/.test(nome)) return "LeadSubmitted";
  if (/qualific|interess|diagnost/.test(nome)) return "QualifiedLead";
  return null;
}

const PADRAO_DO_EVENTO_DE_ETAPA_META = /^MetaEtapa:[0-9a-f-]{36}$/;

/** A chave do livro-razão para a regra da Meta numa etapa. */
export function eventoDaEtapaMeta(stageId: string): `MetaEtapa:${string}` {
  return `MetaEtapa:${stageId}`;
}

/** É um evento que o consumidor de etapa da Meta atende? */
export function ehEventoDeEtapaMeta(nome: unknown): nome is `MetaEtapa:${string}` {
  return typeof nome === "string" && PADRAO_DO_EVENTO_DE_ETAPA_META.test(nome);
}

export interface RegraDeConversaoMeta {
  id: string;
  stageId: string;
  eventName: string;
  metaEvent: EventoDaMeta;
  enabled: boolean;
  configuredAt: string;
}

interface LinhaDaRegra {
  id: string;
  stage_id: string;
  event_name: string;
  meta_event: string;
  enabled: boolean;
  configured_at: string;
}

const COLUNAS = "id, stage_id, event_name, meta_event, enabled, configured_at";

/** Linha com evento fora da lista (versão futura, dado corrompido) não vira regra. */
function paraRegra(l: LinhaDaRegra): RegraDeConversaoMeta | null {
  if (!ehEventoDaMeta(l.meta_event)) return null;
  return {
    id: l.id,
    stageId: l.stage_id,
    eventName: l.event_name,
    metaEvent: l.meta_event,
    enabled: l.enabled,
    configuredAt: l.configured_at,
  };
}

/** Todas as regras da organização, para a tela. Lança em falha de leitura. */
export async function listarRegrasMeta(
  admin: SupabaseClient,
  organizationId: string,
): Promise<RegraDeConversaoMeta[]> {
  const { data, error } = await admin
    .from("meta_ads_conversion_rules")
    .select(COLUNAS)
    .eq("organization_id", organizationId);
  if (error) throw new Error("Não foi possível ler as regras de conversão da Meta.");
  return ((data ?? []) as LinhaDaRegra[])
    .map(paraRegra)
    .filter((r): r is RegraDeConversaoMeta => r !== null);
}

/** A regra da etapa, ou null. Lança em falha de leitura (o consumidor reagenda). */
export async function lerRegraMetaDaEtapa(
  admin: SupabaseClient,
  organizationId: string,
  stageId: string,
): Promise<RegraDeConversaoMeta | null> {
  const { data, error } = await admin
    .from("meta_ads_conversion_rules")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("stage_id", stageId)
    .maybeSingle();
  if (error) throw new Error("Não foi possível ler a regra de conversão da etapa.");
  return data ? paraRegra(data as LinhaDaRegra) : null;
}
