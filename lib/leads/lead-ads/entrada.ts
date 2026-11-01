/**
 * O LEAD DO FORMULÁRIO DA META ENTRA NO FUNIL — contato, card e rastro.
 *
 * ═══ O QUE ESTA PEÇA FAZ, EM ORDEM, E POR QUE NESSA ORDEM ═══
 *
 *   1. **`leadgen_id` já entrou?** A pergunta vem PRIMEIRO, antes de qualquer
 *      escrita. A Meta reentrega o que não recebeu 2xx, e o retry dela chega em
 *      segundos — se o contato fosse resolvido antes desta pergunta, uma
 *      reentrega criaria o cadastro e só então descobriria o card existente. A
 *      resposta continua 200 (o provedor precisa dela para parar de reenviar) e
 *      carrega o marcador `duplicado`, como em `webhooks/cobranca/[provedor]`.
 *   2. **contato**: reaproveitado pelo TELEFONE normalizado, e só quando não há
 *      nenhum pelo e-mail. É a régua de `app/api/v1/webhooks/in/[token]` — a
 *      captação por formulário desta casa —, e a de `lib/leads/nascimento-do-lead.ts`
 *      no que importa: o telefone é o identificador que o produto já trata como
 *      principal, e um segundo cadastro para a mesma pessoa é o defeito que a
 *      fusão de fichas passa o resto do ano desfazendo.
 *   3. **o card**, por `createLeadHandler` — o escritor canônico de criação de
 *      negócio (`POST /api/v1/leads`, MCP, planilha, automação e a captação
 *      pública). Ir por ele, e não por um INSERT aqui, é o que faz este caminho
 *      herdar as réguas de etapa, dono, posição na coluna, `lead.created`,
 *      auditoria e timeline. Um segundo escritor divergiria no primeiro conserto.
 *   4. **o rastro**: `webhook_lead_captures`, a tabela durável que a tela "Leads
 *      recebidos" lê. `webhook_events_log` (arquivo forense) NÃO é usado nesta
 *      fatia: o CHECK de `provider` dele é uma lista fechada, com os transportes
 *      de canal e os provedores de cobrança que o produto já atende, e acrescentar
 *      "meta_ads" exigiria migration — que esta fatia declara fora de escopo. O
 *      valor de canal oficial que a lista já tem se refere a MENSAGENS, não a
 *      formulário; usá-lo no arquivo de auditoria seria mentira, e é por isso que
 *      o rastro vai para a tabela de captação.
 *
 * ═══ O QUE O CARD CARREGA DE ORIGEM (o "espírito" de lib/leads/) ═══
 *
 * `crm_leads.source = "meta_ads"` — o MESMO vocabulário de
 * `ROTULO_DE_ANUNCIO` em `lib/leads/nascimento-do-lead.ts`, onde "Meta_ads" é o
 * rótulo que o Kanban sabe desenhar ao lado do título quando o funil o cadastra
 * em `canonical_tags`. A tag vai junto (a marca entra sempre; o destaque é
 * opt-in do operador — a mesma divisão de lá).
 *
 * `source_metadata` guarda o FUNIL DE PROVA: `form_id`, `page_id`, `ad_id`,
 * `campaign_id` e o `leadgen_id`. É o que responde "de qual anúncio veio este
 * lead" sem uma chamada à Graph API, e é o dado que a tela de campanha vai ler
 * quando ela existir. `ad_platform` vai no contato E no card porque é a chave
 * que `lib/leads/origem-do-contato.ts` lê para dizer de onde veio — e ele
 * também marca `semPosicionamentoDeAnuncio`, que é verdade para formulário: a
 * Meta não expõe posicionamento por lead.
 *
 * ═══ SEM MIGRATION, E O QUE ISSO CUSTA ═══
 *
 * Tudo aqui escreve em coluna que já existe: `crm_leads.external_id` (com o
 * índice único `uniq_crm_leads_org_source_external` por trás, que é quem fecha a
 * CORRIDA de duas entregas simultâneas), `crm_leads.webhook_source_id`,
 * `contacts.phone_number`/`email`, `webhook_lead_captures`. Nada de tabela nova,
 * de coluna nova ou de configuração nova: o funil e a etapa vêm da fonte de
 * captação que o operador já cadastra hoje (`webhook_sources.default_pipeline_id`
 * e `default_stage_id`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ApiError } from "@/lib/api/types";
import { encontrarContatoPorTelefoneComNome } from "@/lib/channels/contato-por-telefone";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { logger } from "@/lib/logger";
import { motivoDaRecusaDaCriacao, registrarCaptacao } from "@/lib/webhooks/captacao";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import type { LeadDoFormulario } from "./payload";

/**
 * O `source` do contato e do card. Um valor só, num lugar só: ele é lido pelo
 * mapa de rótulos do Kanban e pela ficha do contato, e duas cópias divergiriam
 * na primeira mudança de nome.
 */
export const ORIGEM_DO_LEAD_ADS = "meta_ads";

/**
 * O rótulo que o card mostra. É a MESMA string de `ROTULO_DE_ANUNCIO.meta_ads`
 * (`lib/leads/nascimento-do-lead.ts`): o ponto ao lado do título só acende se a
 * organização cadastrar este rótulo em `crm_pipelines.settings.canonical_tags`,
 * e um rótulo diferente do de lá nunca acenderia.
 */
export const ROTULO_DO_LEAD_ADS = "Meta_ads";

/** A fonte de captação, do jeito que a rota a resolve pelo `path_token`. */
export interface FonteDoLeadAds {
  id: string;
  organizationId: string;
  nome: string;
  funilId: string;
  etapaId: string;
}

export type DesfechoDoLead = "criado" | "duplicado";

export interface ResultadoDaEntrada {
  leadgenId: string;
  desfecho: DesfechoDoLead;
  leadId: string | null;
  contatoId: string | null;
}

/** O mínimo do card que a reentrega precisa para responder sem escrever nada. */
interface CardExistente {
  id: string;
  contactId: string | null;
}

/**
 * O card que este `leadgen_id` já identifica — a régua da idempotência.
 *
 * Media pela tripla `(organization_id, source, external_id)`, que é EXATAMENTE a
 * do índice único `uniq_crm_leads_org_source_external`. Medir por outra
 * combinação (só `external_id`, por exemplo) acharia card de outro tenant e
 * responderia "duplicado" para um lead que nunca entrou aqui.
 */
async function cardPeloLeadgenId(
  admin: SupabaseClient,
  organizationId: string,
  leadgenId: string,
): Promise<CardExistente | null> {
  const { data } = await admin
    .from("crm_leads")
    .select("id, contact_id")
    .eq("organization_id", organizationId)
    .eq("source", ORIGEM_DO_LEAD_ADS)
    .eq("external_id", leadgenId)
    .maybeSingle();
  if (!data) return null;
  return {
    id: (data as { id: string }).id,
    contactId: (data as { contact_id: string | null }).contact_id ?? null,
  };
}

/**
 * O contato desta pessoa: o que já existe, ou um novo.
 *
 * ─── Telefone primeiro, e-mail depois ──────────────────────────────────────
 *
 * Duas buscas e não uma porque são dois índices únicos diferentes
 * (`uniq_contacts_org_phone` e `uniq_contacts_org_email`), e um envio pode colidir
 * no segundo mesmo com telefone inédito. `encontrarContatoPorTelefoneComNome` é a
 * busca da casa: ela cobre as duas grafias do nono dígito e os números extras de
 * `contact_phones`, e devolve sempre a MESMA ficha — uma segunda régua de
 * telefone aqui divergiria da ingestão de canal na primeira correção.
 *
 * ─── O que este caminho NÃO faz (declarado) ────────────────────────────────
 *
 * Não completa a ficha do contato reaproveitado com o telefone/e-mail que faltava
 * (o #3719 faz isso na captação pública, com quatro guardas). Aqui o contato
 * reaproveitado é usado como está: completar ficha é escrita em cadastro alheio
 * ao evento, e esta fatia não a faz sem a mesma decisão de produto escrita.
 */
async function contatoDoLead(
  admin: SupabaseClient,
  organizationId: string,
  lead: LeadDoFormulario,
): Promise<{ id: string | null; criado: boolean }> {
  if (lead.telefone) {
    const achado = await encontrarContatoPorTelefoneComNome(admin, organizationId, lead.telefone);
    if (achado) return { id: achado.id, criado: false };
  }

  if (lead.email) {
    const { data } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", organizationId)
      // `email_normalized` é coluna GERADA (`lower(trim(email))`) — comparar pelo
      // `email` cru erraria por caixa/espaço, que é o defeito que a coluna veio
      // evitar.
      .eq("email_normalized", lead.email.trim().toLowerCase())
      .is("is_merged_into", null)
      .maybeSingle();
    if (data) return { id: (data as { id: string }).id, criado: false };
  }

  const { data: criado, error } = await admin
    .from("contacts")
    .insert({
      // O tenant DECLARADO ONDE A LINHA NASCE (R1 da régua de service role): a
      // rota é pública, então o `organization_id` vem do `path_token` resolvido
      // pela fonte, nunca do corpo.
      organization_id: organizationId,
      name: lead.nome ?? lead.telefone ?? lead.email,
      // A forma canônica, e não o texto do formulário: `contacts_phone_e164_format`
      // recusa qualquer coisa fora de `+\d{8,15}`, e um INSERT recusado aqui
      // viraria um card sem contato.
      phone_number: lead.telefone ? canonicalPhoneBR(lead.telefone) : null,
      email: lead.email,
      source: ORIGEM_DO_LEAD_ADS,
      source_metadata: {
        ad_platform: ORIGEM_DO_LEAD_ADS,
        meta_lead_ads: metadadosDoLeadAds(lead),
      },
    })
    .select("id")
    .maybeSingle();

  if (!error && criado) return { id: (criado as { id: string }).id, criado: true };

  if (error && error.code === "23505") {
    // Corrida (dois POSTs do mesmo lead na mesma janela) ou o e-mail já era de
    // outro contato ativo. O vencedor é relido e a captação segue com ELE — quem
    // já existe não é sobrescrito, e um card órfão é pior que um card no
    // cadastro que acabou de ganhar a corrida.
    if (lead.telefone) {
      const achado = await encontrarContatoPorTelefoneComNome(admin, organizationId, lead.telefone);
      if (achado) return { id: achado.id, criado: false };
    }
    if (lead.email) {
      const { data: porEmail } = await admin
        .from("contacts")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("email_normalized", lead.email.trim().toLowerCase())
        .is("is_merged_into", null)
        .maybeSingle();
      if (porEmail) return { id: (porEmail as { id: string }).id, criado: false };
    }
  }

  // Falha de CADASTRO não pode engolir o lead: o card nasce sem contato, que é
  // um estado que a tela mostra e alguém conserta — melhor que perder a pessoa
  // que preencheu o formulário e pagou o clique.
  logger.error("[lead-ads] contato do formulário não pôde ser criado", {
    organization_id: organizationId,
    leadgen_id: lead.leadgenId,
    error_code: error?.code ?? null,
    error_message: error?.message ?? "insert sem linha devolvida",
  });
  return { id: null, criado: false };
}

/** O que identifica o FORMULÁRIO, e não a pessoa — vai em `source_metadata`. */
function metadadosDoLeadAds(lead: LeadDoFormulario): Record<string, unknown> {
  return {
    leadgen_id: lead.leadgenId,
    form_id: lead.formId,
    page_id: lead.pageId,
    ad_id: lead.adId,
    campaign_id: lead.campaignId,
    created_time: lead.criadoEm,
  };
}

/** O título do card: o nome que a pessoa escreveu, com o resto como plano B. */
function tituloDoCard(lead: LeadDoFormulario): string {
  if (lead.nome && lead.nome.trim() !== "") return lead.nome;
  // Sem nome, o card precisa dizer de ONDE veio — um quadro de anônimos iguais
  // não é operável. É a mesma escolha de `nascimento-do-lead`, que cai em
  // "Novo contato pelo …".
  if (lead.telefone) return lead.telefone;
  if (lead.email) return lead.email;
  return "Lead do formulário da Meta";
}

/**
 * Registra o recebimento na fonte — é o "último recebimento" que a tela de
 * captação mostra. Falha aqui não derruba a entrada: o dado do lead é o que
 * importa, e o carimbo é conveniência de tela.
 */
async function marcarRecebimentoDaFonte(
  admin: SupabaseClient,
  fonte: FonteDoLeadAds,
): Promise<void> {
  const { error } = await admin
    .from("webhook_sources")
    .update({ last_received_at: new Date().toISOString() })
    .eq("organization_id", fonte.organizationId)
    .eq("id", fonte.id);
  if (error) {
    logger.warn("[lead-ads] último recebimento da fonte não foi carimbado", {
      organization_id: fonte.organizationId,
      webhook_source_id: fonte.id,
      error_code: error.code,
    });
  }
}

/**
 * O CARIMBO DE ATRASO da linha de captação (fatia 1-bis).
 *
 * A porta não recusa mais entrega velha: a plataforma reentrega por horas, e
 * recusar uma reentrega assinada perdia o lead de vez. O que sobra é o RASTRO —
 * quantos segundos o sinal tinha quando foi processado —, e ele vai no `utm` da
 * linha, que é o jsonb de origem da captação (não tem coluna própria, e criar uma
 * custaria migration por um número que só serve de diagnóstico).
 *
 * `undefined` quando o aviso não traz o instante (`entry[].time`): sem instante
 * não há idade, e gravar `0` diria "chegou na hora", que é diferente de "não sei".
 */
function utmDoRastro(atrasoSegundos: number | null | undefined): Record<string, string> | undefined {
  if (atrasoSegundos === null || atrasoSegundos === undefined) return undefined;
  return { recebido_com_atraso_segundos: String(atrasoSegundos) };
}

/**
 * Um lead do formulário → contato + card + histórico. Idempotente por
 * `leadgen_id`.
 *
 * Lança `ApiError` quando o card não pôde nascer (funil/etapa da fonte sumiram,
 * contato pessoal, régua de campos) — quem chama decide o status, e a recusa já
 * foi registrada em `webhook_lead_captures` antes de subir. Silêncio aqui seria
 * "não chegou nada" na tela, que é a pergunta errada.
 */
export async function entradaDoLeadDoFormulario(
  admin: SupabaseClient,
  fonte: FonteDoLeadAds,
  lead: LeadDoFormulario,
  requestId: string,
  /** O rastro da entrega (idade do sinal), opcional: ver `utmDoRastro`. */
  rastro: { atrasoSegundos?: number | null } = {},
): Promise<ResultadoDaEntrada> {
  const organizationId = fonte.organizationId;
  /** O mesmo carimbo em TODAS as linhas desta entrada — criado, duplicado ou recusado. */
  const utm = utmDoRastro(rastro.atrasoSegundos);

  // 1 · a reentrega do provedor morre aqui, sem escrever nada.
  const existente = await cardPeloLeadgenId(admin, organizationId, lead.leadgenId);
  if (existente) {
    logger.info("[lead-ads] leadgen_id já entrou — reentrega ignorada", {
      organization_id: organizationId,
      leadgen_id: lead.leadgenId,
      lead_id: existente.id,
    });
    await registrarCaptacao(admin, {
      organizationId,
      webhookSourceId: fonte.id,
      sourceName: fonte.nome,
      leadId: existente.id,
      contactId: existente.contactId,
      outcome: "duplicado",
      capturedName: lead.nome,
      capturedPhone: lead.telefone,
      capturedEmail: lead.email,
      fields: lead.campos,
      requestId,
      utm,
    });
    return {
      leadgenId: lead.leadgenId,
      desfecho: "duplicado",
      leadId: existente.id,
      contatoId: existente.contactId,
    };
  }

  // 2 · o contato desta pessoa.
  const contato = await contatoDoLead(admin, organizationId, lead);

  // 3 · o card, pelo escritor canônico.
  //
  // `source_metadata` do card e do contato são o MESMO fato em dois lugares: o
  // contato é a ficha (dura entre negócios), o card é a origem DESTE nascimento
  // — a doutrina DIRC-D que `garantirLeadDaConversa` já segue ao copiar em vez
  // de referenciar.
  const camposDoCard = {
    pipeline_id: fonte.funilId,
    stage_id: fonte.etapaId,
    title: tituloDoCard(lead),
    contact_id: contato.id ?? undefined,
    tags: [ROTULO_DO_LEAD_ADS],
    source: ORIGEM_DO_LEAD_ADS,
    custom_fields: lead.campos,
    source_metadata: {
      webhook_source_id: fonte.id,
      ad_platform: ORIGEM_DO_LEAD_ADS,
      meta_lead_ads: metadadosDoLeadAds(lead),
    },
    // O par que fecha a CORRIDA: duas entregas simultâneas passam as duas pelo
    // passo 1, e o índice único derruba o segundo INSERT (23505). Sem a coluna
    // aqui, a idempotência dependeria só do `select` — que não é atômico.
    external_id: lead.leadgenId,
    webhook_source_id: fonte.id,
  } satisfies Parameters<typeof createLeadHandler>[2];

  let card: { id: string };
  try {
    card = (await createLeadHandler(
      admin,
      {
        organization_id: organizationId,
        // O ator é a FONTE, não um usuário: quem chamou foi a Meta, por um token
        // de fonte. É o mesmo `actor` da captação pública, e é o que a auditoria
        // e a timeline mostram no card.
        actor: { type: "webhook_source", id: fonte.id },
        requestId,
      },
      camposDoCard,
      // As três isenções da captação por formulário, com o mesmo motivo escrito
      // em `app/api/v1/webhooks/in/[token]`: recusar perderia o lead de quem
      // preencheu o anúncio pago — a régua volta na primeira edição humana.
      { exigirCamposDaEtapa: false, exigirPadraoDoCampo: false, manterForaDaLista: true },
    )) as { id: string };
  } catch (erro) {
    const codigo = (erro as ApiError | undefined)?.code ?? "";
    const mensagem = erro instanceof Error ? erro.message : String(erro);

    // A corrida perdida NÃO é recusa: é a reentrega chegando junto com a
    // primeira. O vencedor é relido e a resposta é `duplicado`, com 200 — o
    // provedor precisa dela para parar de reenviar.
    if (mensagem.includes("uniq_crm_leads_org_source_external")) {
      const vencedor = await cardPeloLeadgenId(admin, organizationId, lead.leadgenId);
      if (vencedor) {
        await registrarCaptacao(admin, {
          organizationId,
          webhookSourceId: fonte.id,
          sourceName: fonte.nome,
          leadId: vencedor.id,
          contactId: vencedor.contactId ?? contato.id,
          outcome: "duplicado",
          capturedName: lead.nome,
          capturedPhone: lead.telefone,
          capturedEmail: lead.email,
          fields: lead.campos,
          requestId,
          utm,
        });
        return {
          leadgenId: lead.leadgenId,
          desfecho: "duplicado",
          leadId: vencedor.id,
          contatoId: vencedor.contactId ?? contato.id,
        };
      }
    }

    await registrarCaptacao(admin, {
      organizationId,
      webhookSourceId: fonte.id,
      sourceName: fonte.nome,
      contactId: contato.id,
      outcome: "recusado",
      // O rótulo diz o que REALMENTE falhou (a régua de `motivoDaRecusaDaCriacao`,
      // a mesma da captação pública): "funil e etapa da fonte" só é verdade para
      // os códigos que são sobre funil e etapa.
      rejectReason: motivoDaRecusaDaCriacao(erro),
      capturedName: lead.nome,
      capturedPhone: lead.telefone,
      capturedEmail: lead.email,
      fields: lead.campos,
      requestId,
      utm,
    });
    logger.error("[lead-ads] o card do formulário não nasceu", {
      organization_id: organizationId,
      leadgen_id: lead.leadgenId,
      codigo,
      error: mensagem.slice(0, 160),
    });
    throw erro;
  }

  // 4 · o rastro durável, DEPOIS do card: a linha referencia `lead_id`, e uma
  // captura apontando para card que não existe é dado que mente.
  await registrarCaptacao(admin, {
    organizationId,
    webhookSourceId: fonte.id,
    sourceName: fonte.nome,
    leadId: card.id,
    contactId: contato.id,
    outcome: "criado",
    capturedName: lead.nome,
    capturedPhone: lead.telefone,
    capturedEmail: lead.email,
    fields: lead.campos,
    requestId,
    utm,
  });

  await marcarRecebimentoDaFonte(admin, fonte);

  return {
    leadgenId: lead.leadgenId,
    desfecho: "criado",
    leadId: card.id,
    contatoId: contato.id,
  };
}
