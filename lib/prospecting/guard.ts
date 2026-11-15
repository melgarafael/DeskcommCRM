import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deriveLgpdFromContact,
  isLegalBasisValid,
} from "@/lib/agent-engine/guardrails/lgpd/legal-basis";
import { ehContatoDaEquipe } from "@/lib/contacts/tags-da-equipe";
import { ehContatoInterno } from "@/lib/contacts/tags-internas";
import { recusaRegistrada } from "@/lib/lgpd/recusa-registrada";
import { tagsDaEquipeDaOrg, tagsInternasDaOrg } from "@/lib/schemas/settings";
import { ProspectingError } from "./provider";

export interface ProspectingDelivery {
  organizationId: string;
  candidateId: string;
  conversationId: string;
}
/** O que a guarda lê do contato. As três últimas marcas faltavam até o PR desta régua. */
export interface ContatoDaProspeccao {
  is_blocked?: boolean;
  force_human?: boolean;
  is_anonymized: boolean;
  source: string | null;
  consent: Record<string, unknown> | null;
  /** Ficha "Pessoal": a casa não envia nada a ela, nem pelo encontro (`readStopFlags`). */
  is_personal?: boolean;
  /** "Sempre atendimento humano" (issue 2379): a marca PERMANENTE que nenhuma origem reabre. */
  ai_opt_out?: boolean;
  tags?: readonly string[] | null;
}

/** As listas de etiqueta da organização que vetam a abordagem fria. */
export interface EtiquetasQueVetam {
  internas: readonly string[];
  daEquipe: readonly string[];
}

const SEM_ETIQUETAS: EtiquetasQueVetam = { internas: [], daEquipe: [] };

/**
 * POR QUE este contato não pode receber a abordagem fria — ou `null`, se pode.
 *
 * A frase é o motivo que a tela mostra embaixo da empresa (`candidate.error`).
 *
 * As três marcas do fim (pessoal, sempre humano e as etiquetas) são as mesmas
 * do stop do envio do agente (`readStopFlags`, `before-send.ts`), que a
 * abordagem fria NÃO atravessa: ela sai pelo handler de mensagens com a guarda
 * desta casa. Sem elas aqui, o "sempre humano" recebia a mensagem
 * (`autorizarContatoParaIA` devolve `autorizou:false` e o worker só olhava `ok`)
 * e a ficha pessoal chegava ao 403 do handler, que não é `ProspectingError`
 * e PAUSAVA a campanha inteira como "Falha inesperada".
 *
 * A etiqueta interna é a régua de `ehContatoInterno`, a mesma que
 * `sqlContatoInterno` escreve em SQL; aqui ela roda em JS porque a guarda lê
 * pela REST (`SupabaseClient`), não por `pg`. A da equipe (#3534) entra junto:
 * ela deixa o sócio ser atendido quando ESCREVE, mas uma abordagem fria de
 * venda para ele é o mesmo engano.
 */
export function motivoDoVetoDoContato(
  contact: ContatoDaProspeccao,
  etiquetas: EtiquetasQueVetam = SEM_ETIQUETAS,
): string | null {
  if (contact.is_blocked) return "Contato bloqueado.";
  if (contact.is_anonymized) return "Contato anonimizado (LGPD).";
  // As duas frases são as que a casa já usa para a mesma marca: a do 403 do
  // handler de mensagens (`_handler.ts`) e a da tela da conversa. Uma marca,
  // um texto, uma tradução no dicionário.
  if (contact.is_personal) return "Contato marcado como pessoal.";
  if (contact.ai_opt_out) return "Contato marcado como sempre atendimento humano.";
  if (contact.force_human) return "Contato passado para atendimento humano.";
  if (ehContatoInterno(contact.tags, etiquetas.internas))
    return "Contato interno (marcado por etiqueta).";
  if (ehContatoDaEquipe(contact.tags, etiquetas.daEquipe))
    return "Contato da equipe (marcado por etiqueta).";
  // Nos dois formatos, `declined_at` da captação e `granted: false` da ficha.
  if (recusaRegistrada(contact.consent)) return "O contato recusou mensagens de marketing.";
  if (!isLegalBasisValid(deriveLgpdFromContact(contact, true).legalBasis))
    return "Sem base legal (LGPD) registrada para abordar este contato.";
  return null;
}

export function contactMayBeProspected(
  contact: ContatoDaProspeccao,
  etiquetas: EtiquetasQueVetam = SEM_ETIQUETAS,
) {
  return motivoDoVetoDoContato(contact, etiquetas) === null;
}

/** As duas listas, lidas da linha da organização; linha ausente: ninguém casa. */
function etiquetasDaOrganizacao(settings: unknown): EtiquetasQueVetam {
  return { internas: tagsInternasDaOrg(settings), daEquipe: tagsDaEquipeDaOrg(settings) };
}

const COLUNAS_DO_CONTATO = "is_blocked,force_human,is_anonymized,source,consent,is_personal,ai_opt_out,tags";

/** A leitura da organização que a guarda precisa: só as listas de etiqueta. */
function lerOrganizacao(db: SupabaseClient, organizationId: string) {
  return db.from("organizations").select("settings").eq("id", organizationId).maybeSingle();
}
/**
 * A conferência das marcas do contato ANTES de o worker reservar a vaga do número.
 *
 * Com o veto de contato no escopo do candidato, a campanha não pausa mais na
 * primeira empresa vetada: a fila segue. Mas a guarda cheia roda DEPOIS da
 * transação que grava `attempted_at`, `next_send_at` (intervalo + jitter) e o
 * `recordSend` do número, e cada vetada gastaria uma vaga do teto diário e do
 * aquecimento, mais um intervalo inteiro, sem mandar nada. Esta leitura barra a
 * marca antes do gasto.
 *
 * Devolve o motivo, ou `null`. Leitura que falha ou contato que não volta
 * devolvem `null` DE PROPÓSITO: quem falha fechado é a guarda cheia, que roda
 * logo depois e pausa a campanha com "dados indisponíveis". Esta não substitui
 * aquela: a marca pode mudar entre as duas, e a cheia continua no caminho.
 */
export async function vetoDoContatoAntesDaVaga(
  db: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<string | null> {
  const [contact, organizacao] = await Promise.all([
    db
      .from("contacts")
      .select(COLUNAS_DO_CONTATO)
      .eq("organization_id", organizationId)
      .eq("id", contactId)
      .maybeSingle(),
    lerOrganizacao(db, organizationId),
  ]);
  if (contact.error || organizacao.error || !contact.data) return null;
  return motivoDoVetoDoContato(
    contact.data as ContatoDaProspeccao,
    etiquetasDaOrganizacao(organizacao.data?.settings),
  );
}

/** Rechecked after model generation and immediately before the provider effect. */
export async function assertProspectingDelivery(db: SupabaseClient, ctx: ProspectingDelivery) {
  const { data: candidate, error } = await db
    .from("prospecting_candidates")
    .select("campaign_id,contact_id,status,conversation_id")
    .eq("organization_id", ctx.organizationId)
    .eq("id", ctx.candidateId)
    .maybeSingle();
  if (
    error ||
    !candidate ||
    candidate.status !== "sending" ||
    candidate.conversation_id !== ctx.conversationId
  )
    // DO CANDIDATO: esta abordagem específica foi cancelada ou já não vale.
    throw new ProspectingError("Abordagem cancelada ou indisponível.", 409, "candidato");
  const [campaign, contact, conversation, organizacao] = await Promise.all([
    db
      .from("prospecting_campaigns")
      .select("status")
      .eq("organization_id", ctx.organizationId)
      .eq("id", candidate.campaign_id)
      .maybeSingle(),
    db
      .from("contacts")
      .select(COLUNAS_DO_CONTATO)
      .eq("organization_id", ctx.organizationId)
      .eq("id", candidate.contact_id)
      .maybeSingle(),
    db
      .from("conversations")
      .select("status,last_inbound_at,last_outbound_at,assigned_to_user_id,bot_silenced_until")
      .eq("organization_id", ctx.organizationId)
      .eq("id", ctx.conversationId)
      .eq("contact_id", candidate.contact_id)
      .maybeSingle(),
    lerOrganizacao(db, ctx.organizationId),
  ]);
  if (
    campaign.error ||
    contact.error ||
    conversation.error ||
    organizacao.error ||
    campaign.data?.status !== "running" ||
    !contact.data ||
    !conversation.data
  )
    throw new ProspectingError("Campanha pausada ou dados indisponíveis.", 409);
  // O VETO DO CONTATO é dele, não da campanha: ficha pessoal, sempre humano,
  // etiqueta interna, bloqueio, recusa ou base legal valem para ESTA pessoa, e
  // tentar a próxima da lista não repete o problema. Escopo `candidato`: a
  // empresa sai com o motivo e a campanha segue `running`.
  const veto = motivoDoVetoDoContato(
    contact.data as ContatoDaProspeccao,
    etiquetasDaOrganizacao(organizacao.data?.settings),
  );
  if (veto) throw new ProspectingError(veto, 409, "candidato");
  const c = conversation.data;
  // A CONVERSA QUE DEIXOU DE SER FRIA fica como estava, com escopo `campanha`:
  // é o controle do defeito das bolhas do #2680
  // (`prospeccao-bolhas-com-guarda-real.test.ts`), e mudar o escopo aqui
  // esconderia uma repetição da guarda cheia numa bolha seguinte.
  if (
    c.last_inbound_at ||
    c.last_outbound_at ||
    c.assigned_to_user_id ||
    ["closed", "resolved", "archived", "claimed"].includes(c.status) ||
    c.bot_silenced_until === "infinity" ||
    (c.bot_silenced_until && Date.parse(c.bot_silenced_until) > Date.now())
  )
    throw new ProspectingError(
      "Contato já atendido, assumido por humano ou sem autorização para esta abordagem.",
      409,
    );
}

export interface ProspectingContinuation {
  organizationId: string;
  candidateId: string;
  conversationId: string;
}
/**
 * A conferência LEVE das bolhas SEGUINTES da MESMA abordagem.
 *
 * Por que não `assertProspectingDelivery` de novo: ela recusa conversa com
 * `last_outbound_at` preenchido — e quem o preenche é o NOSSO PRÓPRIO envio da
 * primeira bolha (`app/api/v1/messages/_handler.ts`, o `conversationUpdate` do
 * fim do envio). Repetida na segunda bolha, ela recusa com 409 e, como o
 * `ProspectingError` é `campanha` por padrão, o tick PAUSA a campanha no
 * primeiro contato: a pessoa recebe só a primeira bolha — sem a saída — e o
 * `prospecting.approach_sent` não é auditado embora uma mensagem tenha saído.
 * Medido na revisão do PR #2680.
 *
 * O que continua valendo entre bolhas: se a pessoa RESPONDEU (inclusive
 * "PARAR"), se o contato virou bloqueado/sem base legal, ou se um humano
 * assumiu a conversa, a abordagem PARA. Mas para SÓ naquele candidato
 * (`escopo: "candidato"`): a campanha não tem defeito nenhum ali, e pausá-la
 * custaria a lista inteira por causa de uma pessoa que respondeu — que é,
 * aliás, o desfecho que a campanha procura.
 *
 * `last_outbound_at` fica DE FORA de propósito, e é a diferença inteira em
 * relação à guarda cheia: ele é a marca da nossa própria bolha anterior, não um
 * sinal de que a conversa deixou de ser fria.
 */
export async function assertProspectingContinuation(
  db: SupabaseClient,
  ctx: ProspectingContinuation,
) {
  const { data: candidate, error } = await db
    .from("prospecting_candidates")
    .select("contact_id,status,conversation_id")
    .eq("organization_id", ctx.organizationId)
    .eq("id", ctx.candidateId)
    .maybeSingle();
  if (
    error ||
    !candidate ||
    candidate.status !== "sending" ||
    candidate.conversation_id !== ctx.conversationId
  )
    // DO CANDIDATO: esta abordagem específica foi cancelada ou já não vale.
    throw new ProspectingError("Abordagem cancelada ou indisponível.", 409, "candidato");
  const [contact, conversation, organizacao] = await Promise.all([
    db
      .from("contacts")
      .select(COLUNAS_DO_CONTATO)
      .eq("organization_id", ctx.organizationId)
      .eq("id", candidate.contact_id)
      .maybeSingle(),
    db
      .from("conversations")
      .select("status,last_inbound_at,assigned_to_user_id,bot_silenced_until")
      .eq("organization_id", ctx.organizationId)
      .eq("id", ctx.conversationId)
      .eq("contact_id", candidate.contact_id)
      .maybeSingle(),
    lerOrganizacao(db, ctx.organizationId),
  ]);
  if (
    contact.error ||
    conversation.error ||
    organizacao.error ||
    !contact.data ||
    !conversation.data
  )
    // DO CANDIDATO: a guarda cheia já passou por este mesmo candidato instantes
    // antes da primeira bolha, então o que sobra aqui é a linha dele.
    throw new ProspectingError(
      "Contato indisponível para continuar a abordagem.",
      409,
      "candidato",
    );
  const c = conversation.data;
  // Aqui a conversa vem ANTES do contato: quem responde "PARAR" no meio fica
  // bloqueado E com resposta, e o motivo certo é o de sempre, "a pessoa
  // respondeu". Os dois ramos já eram do candidato.
  if (
    c.last_inbound_at ||
    c.assigned_to_user_id ||
    ["closed", "resolved", "archived", "claimed"].includes(c.status) ||
    c.bot_silenced_until === "infinity" ||
    (c.bot_silenced_until && Date.parse(c.bot_silenced_until) > Date.now())
  )
    throw new ProspectingError(
      "A pessoa respondeu ou o atendimento foi assumido; a abordagem parou aqui.",
      409,
      "candidato",
    );
  const veto = motivoDoVetoDoContato(
    contact.data as ContatoDaProspeccao,
    etiquetasDaOrganizacao(organizacao.data?.settings),
  );
  if (veto) throw new ProspectingError(veto, 409, "candidato");
}
