/**
 * O FOLLOW-UP PERTENCE AO NEGÓCIO, NÃO AO CONTATO (#4191, item 2 do mantenedor).
 *
 * ─── O buraco que este arquivo fecha ────────────────────────────────────────
 *
 * `followup_enrollments` nasceu por CONTATO (`contact_id`) e não tem negócio. A
 * decisão de cobrar, no motor, também nunca perguntou ao negócio: um card
 * marcado como não comercial continuava recebendo os passos do roteiro, porque
 * nada no caminho do envio olhava para `crm_leads.nao_comercial_em`.
 *
 * A resposta fácil — bloquear o CONTATO — é a errada e o mantenedor foi
 * explícito: o mesmo contato pode ter dois negócios abertos (o cliente com dois
 * pedidos, o comprador e o financeiro do mesmo CNPJ), e calar o contato inteiro
 * silenciaria o negócio que continua vivo. Por isso a unidade aqui é o NEGÓCIO:
 *
 *   1. a inscrição passa a carregar o negócio (`lead_id`);
 *   2. a decisão de cobrar consulta ESSE negócio, e só ele;
 *   3. inscrição sem vínculo demonstrável (legado) CONTINUA como antes — não se
 *      inventa vínculo, e não se cala o contato por falta de prova.
 *
 * ─── Por que não basta filtrar na inscrição ─────────────────────────────────
 *
 * O negócio pode ser classificado DEPOIS de a inscrição nascer, e o roteiro
 * pode esperar dias até o próximo passo. Quem decide, portanto, é a leitura no
 * momento do disparo (`exigirFollowupComercial`), chamada pelo motor em
 * `assertServiceBoundary` — o mesmo ponto por onde TODO envio passa. A
 * classificação também não é apagada nem desfeita aqui: reverter devolve o
 * negócio ao comercial, e uma inscrição cancelada NÃO renasce (o silêncio é o
 * que a operação pediu; retomar exige uma demanda nova).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { ehNaoComercial } from "@/lib/leads/elegibilidade-comercial";

/**
 * O motivo gravado em `followup_enrollments.cancel_reason`. É o que a Central
 * mostra e o que o teste procura: cancelar por "atendimento encerrado" seria a
 * mentira que o motor já evita para as outras guardas.
 */
export const MOTIVO_DO_CANCELAMENTO_POR_CLASSIFICACAO = "Negócio classificado como não comercial";

/**
 * A recusa do envio. É `StaleServiceBoundaryError` de propósito: o motor já
 * trata essa família como "esta inscrição não pode mais mandar" (cancela e
 * registra o motivo), e um erro novo obrigaria a abrir um segundo caminho
 * idêntico — duas rotas para o mesmo desfecho divergem no primeiro ajuste.
 */
export class FollowupNaoComercialError extends StaleServiceBoundaryError {
  constructor() {
    super();
    this.name = "FollowupNaoComercialError";
    this.message = "negocio_nao_comercial";
  }
}

/** O que a decisão precisa saber. Nada além disto. */
export interface NegocioDoFollowup {
  /** `followup_enrollments.lead_id`. `null` = inscrição de antes da coluna. */
  leadId: string | null;
  /** `crm_leads.nao_comercial_em` do negócio vinculado. `null` = comercial. */
  naoComercialEm: string | null;
}

export type DecisaoDoFollowup =
  /** Cobra: o negócio está comercial, ou não há vínculo demonstrável (legado). */
  | { acao: "enviar"; porque: "negocio_comercial" | "sem_vinculo" }
  /** Não cobra: o negócio vinculado foi classificado como não comercial. */
  | { acao: "cancelar"; motivo: string };

/**
 * A regra, pura. A ORDEM importa:
 *
 * 1. sem `leadId`, não há vínculo — envia. Calar por falta de prova puniria o
 *    contato por uma coluna que a inscrição antiga nunca teve;
 * 2. com `leadId` e o negócio classificado, CANCELA — e o motivo nomeia a causa;
 * 3. com `leadId` e o negócio comercial, envia.
 *
 * O caso que o mantenedor cobrou está no teste: o contato com dois negócios
 * abertos, um classificado. A decisão é por negócio — o outro continua sendo
 * cobrado porque a decisão dele é OUTRA linha, com OUTRO `leadId`.
 */
export function decidirSobreOFollowup(negocio: NegocioDoFollowup): DecisaoDoFollowup {
  if (negocio.leadId === null) return { acao: "enviar", porque: "sem_vinculo" };
  if (ehNaoComercial({ nao_comercial_em: negocio.naoComercialEm })) {
    return { acao: "cancelar", motivo: MOTIVO_DO_CANCELAMENTO_POR_CLASSIFICACAO };
  }
  return { acao: "enviar", porque: "negocio_comercial" };
}

/**
 * O negócio da FRONTEIRA de atendimento: a demanda da conversa aponta para o
 * negócio dela, e só vale quando a demanda é do MESMO contato da fronteira —
 * demanda de outra pessoa não empresta o negócio.
 *
 * É o caminho para a inscrição que ainda não tem `lead_id` (as que nasceram
 * pelos gatilhos antes desta coluna, e as de fluxo que não passam pelo
 * formulário). Não é adivinhação: é o vínculo que o próprio atendimento já
 * gravou. Sem demanda, devolve `null` — e `null` significa "não sei", que a
 * régua trata como legado (envia), nunca como "pode calar".
 */
export async function resolverNegocioDaFronteira(
  db: SupabaseClient,
  boundary: ServiceBoundary | null | undefined,
): Promise<string | null> {
  const demandaId = boundary?.demanda_id ?? null;
  if (!boundary || !demandaId) return null;
  const { data, error } = await db
    .from("demandas")
    .select("lead_id, contact_id")
    .eq("organization_id", boundary.organization_id)
    .eq("id", demandaId)
    .maybeSingle();
  // Falha de leitura aqui NÃO é "sem vínculo": quem chama decide (o motor lança
  // e o tick tenta de novo). Devolver `null` engoliria um erro de infra como se
  // fosse legado — a classe de defeito que este repositório chama de "instrumento
  // quebrado devolve zero".
  if (error) throw new Error(`demanda_do_followup_nao_lida: ${error.message}`);
  const linha = data as { lead_id?: string | null; contact_id?: string | null } | null;
  if (!linha?.lead_id) return null;
  if (linha.contact_id !== boundary.contact_id) return null;
  return linha.lead_id;
}

/**
 * A GUARDA do disparo: chamada pelo motor antes de qualquer passo sair.
 *
 * `leadId` vem da coluna (`enrollment.lead_id`); quando ela é nula, tenta a
 * demanda da fronteira. Achou negócio classificado → lança
 * `FollowupNaoComercialError` e o motor cancela com o motivo certo.
 */
export async function exigirFollowupComercial(
  db: SupabaseClient,
  alvo: {
    organizationId: string;
    enrollmentId: string;
    leadId: string | null;
    boundary?: ServiceBoundary | null;
  },
): Promise<void> {
  const leadId = alvo.leadId ?? (await resolverNegocioDaFronteira(db, alvo.boundary ?? null));
  // Sem vínculo demonstrável: comportamento de antes. Não se inventa negócio e
  // não se cala o contato por falta de prova.
  if (leadId === null) return;

  const { data, error } = await db
    .from("crm_leads")
    .select("id, nao_comercial_em")
    .eq("organization_id", alvo.organizationId)
    .eq("id", leadId)
    .maybeSingle();
  if (error) throw new Error(`negocio_do_followup_nao_lido: ${error.message}`);
  // O negócio sumiu (apagado com a inscrição órfã): não há classificação a
  // respeitar, e quem decide o resto é a fronteira, não esta guarda.
  if (!data) return;

  const decisao = decidirSobreOFollowup({
    leadId,
    naoComercialEm: (data as { nao_comercial_em?: string | null }).nao_comercial_em ?? null,
  });
  if (decisao.acao === "cancelar") throw new FollowupNaoComercialError();
}
