/**
 * POST /api/v1/webhooks/in/[token] — captação pública de leads.
 *
 * Mesmo padrão do webhook WAHA per-tenant: path_token resolve o tenant
 * (fonte confiável — nunca o body), loga em webhook_events_log e NÃO executa
 * ação síncrona além de criar o lead (motor de regras consome lead.created
 * via event_log). Aceita JSON e form-urlencoded na mesma URL.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createLeadHandler, moveLeadHandler, updateLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import { classificarLeadInicial, type ResultadoClassificacaoInicial } from "@/lib/leads/classificacao-inicial";
import type { CreateLeadInput } from "@/lib/schemas";
import { mapInboundPayload, extrairAtribuicaoDoInbound, verifyInboundSignature, type FieldMap } from "@/lib/webhooks/inbound";
import { HEADER_ASSINATURA_DE_ENTRADA } from "@/lib/webhooks/assinatura";
import { encontrarContatoPorTelefoneComNome } from "@/lib/channels/contato-por-telefone";
import {
  buildContactConsentGrant,
  buildContactConsentDenial,
  isRespondiPayload,
  mapRespondiPayload,
  respondiLeadTitle,
  type RespondiMapped,
} from "@/lib/webhooks/respondi";
import {
  isRdStationPayload,
  mapRdStationPayload,
  type RdStationMapped,
} from "@/lib/webhooks/rdstation";
import { isElementorPayload, mapElementorPayload, type ElementorMapped } from "@/lib/webhooks/elementor";
import {
  motivoDaRecusaDaCriacao,
  origemDaPagina,
  registrarCaptacao,
  type MotivoDaRecusa,
} from "@/lib/webhooks/captacao";
import { ipDoClienteParaInet } from "@/lib/http/ip-do-cliente";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { cardAbertoQueACaptacaoReusa } from "@/lib/automation/captacao-reusa-card-aberto";
import { ApiError } from "@/lib/api/types";
import { autorizarCaptacaoParaIA, camposDaCaptacao } from "@/lib/ai/elegibilidade/formulario";
import { autorizarContatoParaIA } from "@/lib/ai/elegibilidade/autorizacao";
import { kickLocalPipeline } from "@/lib/dev/kick-local-pipeline";
import {
  normalizarCamposNumericos,
  webhookFormFieldsSchema,
} from "@/lib/webhooks/formulario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

const RATE_LIMIT_PER_MIN = 60;

// ponytail: mirrors the default phone aliases in lib/webhooks/inbound.ts —
// duplicated (not exported there) only so the route can flag a phone-looking
// field that failed normalizePhoneBR, for observability. Keep in sync if that
// list changes.
const PHONE_ALIASES_FOR_LOGGING = ["phone", "telefone", "whatsapp", "celular", "phone_number", "tel"];

function findRawPhoneIfUnnormalized(payload: Record<string, unknown>, fieldMap: FieldMap): string | null {
  const aliases = [...(fieldMap.phone ?? []), ...PHONE_ALIASES_FOR_LOGGING];
  const lowered = new Map(Object.keys(payload).map((k) => [k.toLowerCase(), k]));
  for (const alias of aliases) {
    const key = lowered.get(alias.toLowerCase());
    if (key !== undefined) {
      const v = payload[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

/**
 * O que um lead JÁ GRAVADO tem de diferente do que este envio trouxe (#2316).
 *
 * Por CHAVE, e com o mesmo tratamento do merge atômico (`fn_lead_anotar_campos`):
 * o banco guarda `custom_fields` com tipos mistos — o campo numérico vira
 * número na coluna e string no envio —, então a comparação é pelo texto dos
 * dois lados. `100` gravado e `"100"` reenviado são o MESMO dado: um envio
 * assim é reenvio, não atualização.
 */
function camposQueMudaram(
  atuais: Record<string, unknown>,
  novos: Record<string, unknown>,
): Record<string, unknown> {
  const mudou: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(novos)) {
    if (String(atuais[chave] ?? "") !== String(valor)) mudou[chave] = valor;
  }
  return mudou;
}

/**
 * A etapa que este envio PEDIU (#2316), resolvida no funil do PRÓPRIO lead.
 *
 * `stage` é campo reservado do corpo (id ou nome — o nome é o que quem integra
 * tem em mãos), e só devolve o que anda para FRENTE: o webhook é um evento de
 * fora, e um evento velho (ou um campo fixo no formulário, que manda a mesma
 * etapa em todo envio) não pode puxar o card para trás. `null` = nada a mover.
 *
 * Uma leitura só, e ela faz as duas coisas: resolve o alvo (id ou nome) e
 * ordena os dois — `position` de `crm_stages` é a única régua de "para frente"
 * que o produto tem.
 *
 * O filtro de `organization_id` usa a organização JÁ resolvida pela fonte
 * (`path_token`, fonte confiável — nunca o body): o service role contorna a RLS
 * por desenho, então o escopo do tenant é declarado aqui (anti-pattern 10,
 * régua da R3 do gate de tenant).
 */
async function etapaAlvoDoEnvio(
  admin: SupabaseClient,
  organizationId: string,
  pipelineId: string,
  stageAtualId: string | null,
  indicado: string | null,
): Promise<string | null> {
  if (!indicado || !pipelineId) return null;
  const { data, error } = await admin
    .from("crm_stages")
    .select("id, name, position")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", pipelineId)
    .order("position", { ascending: true });
  if (error) {
    // Abrir o card não pode morrer por causa de um campo de etapa: o resto do
    // envio continua sendo aplicado e a recusa fica no log.
    logger.error("[webhooks.in] não foi possível ler as etapas do funil do lead", {
      pipelineId,
      errorCode: error.code,
      errorMessage: error.message,
    });
    return null;
  }
  const etapas = (data ?? []) as Array<{ id: string; name: string | null; position: number | null }>;
  const alvo =
    etapas.find((e) => e.id === indicado) ??
    etapas.find((e) => (e.name ?? "").trim().toLowerCase() === indicado.trim().toLowerCase());
  if (!alvo) {
    logger.warn("[webhooks.in] etapa pedida no envio não existe no funil do lead", {
      pipelineId,
      etapa: indicado,
    });
    return null;
  }
  const indiceAtual = etapas.findIndex((e) => e.id === stageAtualId);
  const indiceAlvo = etapas.findIndex((e) => e.id === alvo.id);
  if (indiceAtual < 0 || indiceAlvo <= indiceAtual) return null;
  return alvo.id;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await ctx.params;
  if (!token || token.length < 8) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const rl = await checkRateLimit(`webhook_in:${token}`, RATE_LIMIT_PER_MIN, 60);
  if (!rl.allowed) {
    return fail("rate_limited", "Too many requests.", 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }

  const admin = createAdminClient();
  const { data: source, error: srcErr } = await admin
    .from("webhook_sources")
    .select("id, name, organization_id, secret_encrypted, default_pipeline_id, default_stage_id, field_map, form_fields, redirect_to, is_active, authorize_ai_on_capture, update_existing_lead_on_capture, reuse_open_lead_on_capture")
    .eq("path_token", token)
    .maybeSingle();
  if (srcErr) return fail("internal_error", srcErr.message, 500, { requestId });
  if (!source || !source.is_active) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const rawBody = await req.text();
  const contentType = req.headers.get("content-type") ?? "";
  const isForm = contentType.includes("application/x-www-form-urlencoded");
  let payload: Record<string, unknown>;
  if (isForm) {
    payload = Object.fromEntries(new URLSearchParams(rawBody));
  } else {
    try {
      payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    } catch {
      return fail("invalid_request", "invalid_json", 400, { requestId });
    }
  }

  // A ORIGEM, lida uma vez e usada em todos os desfechos abaixo — inclusive nos
  // que recusam. Quem publicou um formulário que não está entrando precisa ver
  // que a batida CHEGOU e por que morreu; sem isto o registro só existe quando
  // deu certo, que é exatamente quando ninguém precisa dele.
  const origemDaCaptacao = {
    remoteIp: ipDoClienteParaInet(req.headers),
    userAgent: req.headers.get("user-agent"),
    origin: origemDaPagina(req.headers),
    requestId,
  };
  const fonteDaCaptacao = {
    organizationId: source.organization_id as string,
    webhookSourceId: source.id as string,
    sourceName: (source.name as string) ?? "Fonte sem nome",
  };

  const sigHeader = req.headers.get(HEADER_ASSINATURA_DE_ENTRADA);
  // secret cifrado at-rest (migration 0041). A fonte que TEM segredo exige
  // assinatura; se esta instalação não consegue decifrá-lo (chave mestra
  // ausente/trocada, dado corrompido), não há como conferir — e o que não se
  // confere não entra. Mesma regra da autenticação do WAHA
  // (lib/waha/webhook-auth.ts): falha FECHADA. O operador vê o motivo em
  // "Leads recebidos" e recadastra a assinatura da fonte.
  let sourceSecret: string | null = null;
  let recusa: MotivoDaRecusa | null = null;
  if (source.secret_encrypted) {
    sourceSecret = await decryptWebhookSecret(admin, source.secret_encrypted as unknown as string);
    if (sourceSecret === null) {
      logger.error("[webhooks.in] segredo da fonte não decifra — captação recusada até recadastrar a assinatura", {
        organizationId: source.organization_id,
        webhookSourceId: source.id,
        requestId,
      });
      recusa = "assinatura_indecifravel";
    } else if (!verifyInboundSignature(rawBody, sigHeader, sourceSecret)) {
      recusa = "assinatura_invalida";
    }
  }
  if (recusa) {
    await audit({
      action: "webhook.inbound_invalid_signature",
      organizationId: source.organization_id,
      resourceType: "webhook_source",
      resourceId: source.id,
      requestId,
      metadata: { reason: recusa },
    });
    await registrarCaptacao(admin, {
      ...fonteDaCaptacao,
      ...origemDaCaptacao,
      outcome: "recusado",
      rejectReason: recusa,
    });
    return fail("unauthenticated", "invalid_signature", 401, { requestId });
  }

  const headersJson: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k.startsWith("authorization") || k === "cookie") return;
    headersJson[key] = value;
  });
  await admin.from("webhook_events_log").insert({
    organization_id: source.organization_id,
    provider: "generic",
    webhook_path_token: token,
    http_method: "POST",
    headers: headersJson,
    raw_body: rawBody,
    payload_parsed: payload,
    signature_header: sigHeader ?? null,
    // Daqui só passa fonte sem segredo ou assinatura que conferiu.
    valid_signature: true,
    event_type: "lead_capture.received",
    external_id: null,
    status: "received",
    attempts: 0,
  });

  // Respondi manda `{ form: {...}, respondent: { answers: {...} } }` — dois
  // níveis aninhados que o mapeador genérico descarta por desenho (ele só lê
  // chave de topo). Detecta a forma UMA vez aqui; `respondiMapped` alimenta
  // tanto o idempotency key quanto o mapeamento de campos mais abaixo.
  const respondiMapped: RespondiMapped | null = isRespondiPayload(payload)
    ? mapRespondiPayload(payload)
    : null;

  // RD Station manda `{ leads: [ {...} ] }` — mesmo problema do Respondi (o
  // mapeador genérico só lê chave de topo). Detecta a forma UMA vez; alimenta
  // o idempotency key e o mapeamento de campos abaixo. Respondi tem
  // precedência: um payload nunca é dos dois.
  const rdStationMapped: RdStationMapped | null =
    respondiMapped === null && isRdStationPayload(payload)
      ? mapRdStationPayload(payload)
      : null;

  // Elementor Pro manda `fields[<id>][value]` (colchetes, uma linha por
  // propriedade) — mesmo problema: nenhuma chave de topo chama `nome`. Fica por
  // último na precedência porque a detecção é por forma estrita, e nenhum
  // payload é de duas origens.
  const elementorMapped: ElementorMapped | null =
    respondiMapped === null && rdStationMapped === null && isElementorPayload(payload)
      ? mapElementorPayload(payload)
      : null;

  // Idempotência (spec §5): `external_id` é campo reservado do envio — quem
  // integra via sistema (Zapier/n8n/loja) manda o ID único do disparo e o
  // reenvio automático (retry por timeout) NUNCA duplica o lead. O índice
  // uniq_crm_leads_org_source_external garante a corrida; aqui vai o fast-path.
  // Respondi não manda `external_id` de topo — manda `respondent.respondent_id`
  // aninhado; sem este fallback, um retry do Respondi (timeout, reenvio manual)
  // criaria um segundo lead para a mesma resposta de formulário.
  const externalIdRaw = payload["external_id"];
  const externalId =
    typeof externalIdRaw === "string" && externalIdRaw.trim()
      ? externalIdRaw.trim().slice(0, 255)
      // O MESMO corte do ramo acima. A assimetria era de uma linha e o desfecho
      // não: `uniq_crm_leads_org_source_external` é btree, e btree recusa chave
      // que não caiba em ~2.704 bytes. Medido em Postgres 17 real, com conteúdo
      // INCOMPRESSÍVEL (o pglz comprime `repeat('a')` e mascara o limite): a
      // partir de ~2.669 bytes o INSERT sai com sqlstate 54000, o handler
      // devolve 500 e NENHUM lead entra.
      //
      // Não é alcançável pelo Respondi real — o `respondent_id` do formulário é
      // uuid de 36 chars, ~60× abaixo do limiar. É higiene de simetria: dois
      // ramos do mesmo `?:` produzindo a mesma coluna com regras diferentes é o
      // tipo de coisa que só aparece quando alguém manda um corpo fabricado.
      : (respondiMapped?.externalId?.slice(0, 255) ??
        rdStationMapped?.externalId?.slice(0, 255) ??
        null);

  const respondWithLead = (leadId: string): NextResponse => {
    if (isForm && source.redirect_to) {
      return NextResponse.redirect(source.redirect_to as string, 303);
    }
    return ok({ lead_id: leadId }, { requestId });
  };

  /**
   * O lead que já existe com este `external_id` — com o que o reenvio precisa
   * para decidir entre ATUALIZAR (#2316) e reenvio comum: os campos que o card
   * já tem, o funil e a etapa onde ele está.
   *
   * Traz o CONTATO junto, e não só o id do lead: a linha de captação precisa do
   * vínculo para a LGPD alcançá-la. O gatilho de anonimização casa por
   * `contact_id` — uma captação gravada sem ele guarda nome, telefone e o
   * formulário inteiro de alguém que pediu anonimização, por 365 dias, enquanto
   * o produto afirma que a pessoa foi anonimizada.
   */
  type LeadExistente = {
    id: string;
    contactId: string | null;
    /**
     * A fonte que CRIOU este card (#2316). É a coluna durável
     * `crm_leads.webhook_source_id` (migration 0683), e não o histórico de
     * captação nem o `source_metadata`: o primeiro é podado em 365 dias e não
     * existe para os cards antigos, e o segundo é jsonb de terceiros.
     */
    webhookSourceId: string | null;
    title: string | null;
    customFields: Record<string, unknown>;
    pipelineId: string;
    stageId: string | null;
  };

  const COLUNAS_DO_CARD_POR_ID =
    "id, contact_id, webhook_source_id, title, custom_fields, pipeline_id, stage_id";
  const montarCardPorId = (data: Record<string, unknown>): LeadExistente => ({
    id: data.id as string,
    contactId: (data.contact_id as string | null) ?? null,
    webhookSourceId: (data.webhook_source_id as string | null) ?? null,
    title: (data.title as string | null) ?? null,
    customFields: (data.custom_fields as Record<string, unknown> | null) ?? {},
    pipelineId: (data.pipeline_id as string) ?? "",
    stageId: (data.stage_id as string | null) ?? null,
  });
  /**
   * O card que este `external_id` JÁ IDENTIFICA (#2316) — a régua que manda no
   * reenvio e no `stage` reservado.
   *
   * Duas leituras, nesta ordem (review do #3366):
   *
   * 1. `source = "webhook"`: o card que ESTA rota criou, com o índice único
   *    `uniq_crm_leads_org_source_external` por trás. É a busca de sempre e ela
   *    não muda;
   * 2. `webhook_source_id = <ESTA fonte>`: o card de OUTRA origem que ESTA
   *    fonte ADOPTOU e carimbou (#3357). O card da conversa nasce com
   *    `source = "whatsapp"` (`ORIGEM_DO_WHATSAPP`, em
   *    `lib/channels/origem-do-negocio.ts`), e o carimbo grava nele o `id` e a
   *    fonte — então o id gravado NUNCA é achado pela leitura 1. Sem esta
   *    segunda leitura o segundo envio do mesmo id não acha o card adotado, o
   *    envio cai na procura de card aberto de novo e, se o contato tiver outro
   *    card aberto mais novo, atualiza o card errado; o `stage` reservado
   *    (#2316) também morria ignorado neste caminho.
   *
   * A leitura 2 só roda quando a 1 devolve `null`, e é restrita à ESTA fonte:
   * `webhook_source_id` é justamente o que diz de quem é o carimbo, então um
   * card `source = "webhook"` de OUTRA fonte com o mesmo id não ganha da
   * ordenação.
   */
  const findLeadByExternalId = async (): Promise<LeadExistente | null> => {
    if (!externalId) return null;
    const { data } = await admin
      .from("crm_leads")
      .select(COLUNAS_DO_CARD_POR_ID)
      .eq("organization_id", source.organization_id)
      .eq("source", "webhook")
      .eq("external_id", externalId)
      .maybeSingle();
    if (data) return montarCardPorId(data);
    const { data: carimbado } = await admin
      .from("crm_leads")
      .select(COLUNAS_DO_CARD_POR_ID)
      .eq("organization_id", source.organization_id)
      .eq("webhook_source_id", source.id)
      .eq("external_id", externalId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return carimbado ? montarCardPorId(carimbado) : null;
  };

  const fieldMap = (source.field_map ?? {}) as FieldMap;
  // external_id não é dado do lead — sai do payload antes do mapeamento pra
  // não virar custom_field (o log de recebimento acima preserva o original).
  // `stage` é o OUTRO campo reservado (#2316): é o jeito de quem integra pedir
  // movimento de etapa no card que o `external_id` aponta, e ele só existe
  // nesse caminho — fora dele o envio não tem card para onde apontar.
  const { external_id: _reservedExternalId, stage: _reservedStage, ...payloadForMapping } = payload;
  /** O que o envio pediu de etapa, lido do corpo CRU. */
  const etapaPedida =
    typeof _reservedStage === "string" && _reservedStage.trim() ? _reservedStage.trim() : null;
  // O mapeamento vem ANTES da deduplicação (era depois) porque o histórico
  // registra os DADOS também do envio repetido — sem isso, o retry de uma
  // ferramenta apareceria na tela como uma linha sem nome nem telefone, e quem
  // olha não distinguiria "reenvio do mesmo lead" de "formulário vazio".
  // `mapInboundPayload` é puro, então adiantá-lo não muda desfecho nenhum.
  //
  // O `respondiMapped ??` é do PR #326: sem ele o payload aninhado do Respondi
  // volta a cair no mapeador genérico, que é o defeito que aquele PR conserta.
  // O `rdStationMapped ??` é a mesma figura para o envelope `leads[]` do RD
  // Station (achado 2026-09-08), e o `elementorMapped ??` para os campos em
  // colchetes do Elementor. Ordem: Respondi, RD Station, Elementor, genérico.
  const mapped =
    respondiMapped ??
    rdStationMapped ??
    elementorMapped ??
    mapInboundPayload(externalId ? payloadForMapping : payload, fieldMap);
  if (!mapped.phone) {
    const rawPhone = findRawPhoneIfUnnormalized(payload, fieldMap);
    if (rawPhone) mapped.source_metadata.raw_phone = rawPhone;
  }

  const camposConfigurados = webhookFormFieldsSchema.safeParse(source.form_fields ?? []);
  const tipagem = normalizarCamposNumericos(payload, camposConfigurados.success ? camposConfigurados.data : []);
  if (tipagem.invalidKeys.length > 0) {
    await registrarCaptacao(admin, {
      ...fonteDaCaptacao,
      ...origemDaCaptacao,
      capturedName: mapped.name,
      capturedPhone: mapped.phone,
      capturedEmail: mapped.email,
      fields: camposDaCaptacao(mapped.custom_fields, payload, source.authorize_ai_on_capture),
      utm: mapped.source_metadata,
      leadId: null,
      contactId: null,
      outcome: "recusado",
      rejectReason: "campo_numerico_invalido",
    });
    return fail("invalid_request", "A resposta de um campo numérico tem formato inválido.", 422, {
      requestId,
      details: { fields: tipagem.invalidKeys },
    });
  }
  Object.assign(mapped.custom_fields, tipagem.values);

  /** O que o formulário trouxe, do jeito que a tela de histórico mostra. */
  // O aceite é evidência de captação, não resposta comercial no card.
  if (source.authorize_ai_on_capture) {
    for (const key of ["ai_service_consent", "submission_status", "ai_service_consent_version"]) {
      delete mapped.custom_fields[key];
    }
  }

  const dadosDaCaptacao = {
    capturedName: mapped.name,
    capturedPhone: mapped.phone,
    capturedEmail: mapped.email,
    fields: camposDaCaptacao(mapped.custom_fields, payload, source.authorize_ai_on_capture),
    utm: mapped.source_metadata,
  };

  /**
   * O fecho de um reenvio: o `external_id` já aponta para um card (#2316).
   *
   * A régua tem DUAS perguntas antes da terceira, e as duas são portões:
   *
   * 1. a fonte tem a OPÇÃO LIGADA? Ela nasce DESLIGADA (`update_existing_lead_on_capture`,
   *    migration 0683) — atualizar card é integração entre sistemas, e a issue
   *    #2316 pediu a opção por fonte justamente por isto. Desligada, o envio
   *    repetido é o que sempre foi: `duplicado`, card intocado;
   * 2. o card é DESTA fonte? A busca é por organização + `external_id`, então
   *    sem esta pergunta a fonte A reescreveria o card que nasceu na B. `null`
   *    (card sem origem carimbada) também não deixa passar: na dúvida, não
   *    escreve.
   *
   * Passados os dois, a régua é o DADO, não o id:
   * - o envio trouxe campo NOVO (valor pago, área, etapa mais à frente) → o
   *   card é ATUALIZADO com o mesmo merge atômico do `updateLeadHandler` e a
   *   mesma etapa do `moveLeadHandler`, e o desfecho é `atualizado`;
   * - o envio repetiu o que já estava gravado → idempotência de sempre: nada
   *   muda, `duplicado`, 200 com o lead existente. A ferramenta que reenviou
   *   por timeout recebe sucesso e para de tentar.
   *
   * O portão 1 é o que protege a edição MANUAL: sem ele, o vendedor que corrige
   * o título ou um campo à mão e depois recebe um retry (ou um evento antigo)
   * da ferramenta tem a correção sobrescrita — a comparação é com o valor
   * atual, então o envio conta como "dado novo". Com a opção desligada, quem
   * não liga continua exatamente como antes do #2316.
   *
   * Serve para os DOIS caminhos que encontram o card — o fast-path de
   * deduplicação e a corrida do retry, em que o índice único derruba o segundo
   * INSERT. E nos DOIS o histórico é gravado com o vínculo do lead e do
   * contato: é a linha de captação que o gatilho de anonimização alcança.
   */
  const fecharReenvio = async (
    lead: LeadExistente,
    contactIdDoEnvio: string | null,
  ): Promise<NextResponse> => {
    /** O reenvio de sempre: nada muda no card, 200 com o lead existente. */
    const fecharComoReenvio = async (): Promise<NextResponse> => {
      await registrarCaptacao(admin, {
        ...fonteDaCaptacao,
        ...origemDaCaptacao,
        ...dadosDaCaptacao,
        leadId: lead.id,
        contactId: contactIdDoEnvio ?? lead.contactId,
        outcome: "duplicado",
      });
      return respondWithLead(lead.id);
    };

    // PORTÃO 1 — a opção é da fonte, e nasce desligada.
    if (!source.update_existing_lead_on_capture) return fecharComoReenvio();
    // PORTÃO 2 — só o card que ESTA fonte criou.
    if (lead.webhookSourceId !== source.id) return fecharComoReenvio();
    // PORTÃO 3 — card de titular ANONIMIZADO não recebe dado de volta. A
    // `fn_lgpd_cascade_redact_contact` limpa título, campos e tags do card, mas
    // mantém `external_id` e `webhook_source_id`: sem esta pergunta, o próximo
    // envio da integração passaria pelos portões 1 e 2, tudo pareceria "novo" e
    // o nome e os campos do titular voltariam — a anonimização é irreversível.
    // Leitura que falha também fecha como reenvio: na dúvida, não escreve.
    //
    // Fronteira: a anonimização também alcança o card por `crm_lead_links`
    // (`target_kind='contact'`), e este portão só olha o `contact_id`. Hoje
    // nada no produto grava esse vínculo; se passar a gravar, a causa raiz é
    // zerar `webhook_source_id` no passo 5 da `fn_lgpd_cascade_redact_contact`.
    if (lead.contactId) {
      const { data: titular, error: erroTitular } = await admin
        .from("contacts")
        .select("is_anonymized")
        .eq("organization_id", source.organization_id)
        .eq("id", lead.contactId)
        .maybeSingle();
      if (erroTitular || titular?.is_anonymized === true) return fecharComoReenvio();
    }

    const campos = camposQueMudaram(lead.customFields, mapped.custom_fields);
    // O título vem do nome só nos caminhos que usam o mapeador genérico (RD
    // Station e Elementor também): o Respondi tem formato próprio de título,
    // e compará-lo com o nome de hoje faria TODO retry do Respondi virar
    // "atualizado".
    const tituloMudou = !respondiMapped && !!mapped.name && mapped.name !== lead.title;
    const etapaAlvo = await etapaAlvoDoEnvio(
      admin,
      source.organization_id as string,
      lead.pipelineId,
      lead.stageId,
      etapaPedida,
    );

    // Mesmo envio repetido: nada é recriado — a ferramenta que reenviou recebe
    // sucesso e para de tentar.
    if (Object.keys(campos).length === 0 && !tituloMudou && etapaAlvo === null) {
      return fecharComoReenvio();
    }

    const ctxDoLead: HandlerCtx = {
      organization_id: source.organization_id,
      actor: { type: "webhook_source", id: source.id },
      requestId,
    };
    try {
      if (Object.keys(campos).length > 0 || tituloMudou) {
        await updateLeadHandler(admin, ctxDoLead, lead.id, {
          ...(tituloMudou && mapped.name ? { title: mapped.name } : {}),
          ...(Object.keys(campos).length > 0 ? { custom_fields: campos } : {}),
        });
      }
      if (etapaAlvo) {
        await moveLeadHandler(admin, ctxDoLead, lead.id, { to_stage_id: etapaAlvo });
      }
    } catch (err) {
      // O card JÁ existe e este envio veio de uma ferramenta que reenvia: a
      // recusa do UPDATE (régua de campos, contato de pessoal, etapa que o
      // funil não deixa) transformaria este card num loop de retry sem que
      // nada do dado novo chegasse. O que não pôde ser aplicado fica no log —
      // e o PRÓXIMO evento tenta de novo, porque o desfecho é do envio, não da
      // escrita. `registrarCaptacao` não lança, então a linha sai de qualquer
      // jeito, com o vínculo.
      logger.error("[webhooks.in] reenvio com dado novo não pôde atualizar o card", {
        organizationId: source.organization_id,
        webhookSourceId: source.id,
        leadId: lead.id,
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await registrarCaptacao(admin, {
      ...fonteDaCaptacao,
      ...origemDaCaptacao,
      ...dadosDaCaptacao,
      leadId: lead.id,
      contactId: contactIdDoEnvio ?? lead.contactId,
      outcome: "atualizado",
    });
    return respondWithLead(lead.id);
  };

  const deduped = await findLeadByExternalId();
  if (deduped) {
    return fecharReenvio(deduped, null);
  }

  if (!mapped.name && !mapped.phone && !mapped.email) {
    // O desfecho mais importante de registrar: quem colou o endereço num
    // formulário com nomes de campo que não reconhecemos recebe 400 e, até
    // aqui, NENHUM rastro na tela. A pessoa só sabia que "não chegou nada" —
    // sem saber que a batida chegou, nem com que campos.
    await registrarCaptacao(admin, {
      ...fonteDaCaptacao,
      ...origemDaCaptacao,
      // O payload CRU, e não `mapped.custom_fields`: o que quem depura precisa
      // ver é exatamente com que nomes os campos chegaram.
      fields: payload,
      outcome: "recusado",
      rejectReason: "sem_campo_mapeavel",
    });
    return fail("invalid_request", "Nenhum campo mapeável (nome/telefone/email).", 400, { requestId });
  }

  // Contato: upsert por telefone (se houver) — reusa a coluna E.164 canônica.
  // is_merged_into null: contato mesclado não deve ser reaproveitado (o índice
  // único uniq_contacts_org_phone só cobre a linha ativa por telefone).
  /**
   * O que ESTE envio afirma sobre consentimento — ou nada, que é o caso mais
   * importante de acertar.
   *
   * `detectedVia: "not_found"` significa que o formulário **não tem a pergunta**
   * de autorização. O mapeador devolve `granted: false` ali (leitura defensiva
   * correta: silêncio nunca vira concessão), mas isso não é a pessoa dizendo
   * "não" — é ninguém tendo perguntado. Carimbar recusa nesse caso bloquearia
   * a automação de todo formulário do Respondi que não faz a pergunta, que é
   * exatamente o erro que este PR existe para não cometer, um nível acima.
   *
   * `null` = este envio não afirma nada, e a coluna fica como está (no default,
   * ou no que um envio anterior gravou).
   */
  const consentDoEnvio = (() => {
    if (!respondiMapped) return null;
    if (respondiMapped.consent.detectedVia === "not_found") return null;
    const formId = respondiMapped.custom_fields.respondi_form_id ?? null;
    return respondiMapped.consent.granted
      ? buildContactConsentGrant(formId)
      : buildContactConsentDenial(formId);
  })();

  let contactId: string | undefined;
  // Nome do contato JÁ EXISTENTE que este envio casou (não o que acabou de
  // criar — um contato novo nunca conflita com ele mesmo). `undefined` =
  // ninguém existia antes; alimenta a checagem de conflito de identidade da
  // classificação inicial (lib/leads/classificacao-inicial.ts).
  let existingContactName: string | null | undefined;
  // Nasceu neste request? O INSERT já grava o consentimento com a forma certa;
  // a reconciliação abaixo existe só para quem JÁ era contato.
  let contatoNasceuAqui = false;
  if (mapped.phone) {
    /** O que os dois caminhos (telefone e e-mail) devolvem — um tipo só. */
    type ContatoAchado = { data: { id: string; name: string | null } | null };

    // ⚠️ QUAL GRAFIA VENCE é decidido por `escolherContatoCanonico`, e não pelo
    // banco. Isto era `.in(variantes).limit(1)` SEM `order by`: com as duas
    // grafias do mesmo celular ainda vivas — estado que a migration `0198`
    // admite ao chamar o próprio passo 3 de "piso de segurança para o unique" —
    // o Postgres devolvia qualquer uma das duas. A resposta do cliente entrava
    // no cadastro errado, o follow-up não a reconhecia, e a mesma pergunta saía
    // de novo.
    const selectActiveByPhone = async (): Promise<ContatoAchado> => ({
      data: await encontrarContatoPorTelefoneComNome(
        admin,
        source.organization_id,
        mapped.phone!,
      ),
    });

    // uniq_contacts_org_email (baseline.sql) é um SEGUNDO índice único parcial,
    // independente de uniq_contacts_org_phone — um INSERT pode colidir nele
    // mesmo com telefone inédito (mesma pessoa manda e-mail repetido, telefone
    // novo). email_normalized é coluna GERADA (`lower(trim(email))`), então a
    // comparação replica exatamente essa normalização — não `email` bruto.
    const selectActiveByEmail = (): PromiseLike<ContatoAchado> | null => {
      if (!mapped.email) return null;
      return admin
        .from("contacts")
        .select("id, name")
        .eq("organization_id", source.organization_id)
        .eq("email_normalized", mapped.email.trim().toLowerCase())
        .is("is_merged_into", null)
        .maybeSingle();
    };

    const { data: existing } = await selectActiveByPhone();
    if (existing) {
      contactId = existing.id as string;
      existingContactName = existing.name as string | null;
    } else {
      const { data: created, error: insertErr } = await admin
        .from("contacts")
        .insert({
          organization_id: source.organization_id,
          name: mapped.name ?? mapped.phone,
          phone_number: mapped.phone,
          email: mapped.email,
          source: "webhook",
          source_metadata: { ...mapped.source_metadata, webhook_source_id: source.id },
          // Consentimento explícito só quando o Respondi confirmou concessão —
          // recusa NUNCA vira concessão por omissão. E a recusa agora é
          // GRAVADA, não omitida: o DEFAULT da coluna já é `granted_at: null`,
          // então omitir deixava "nunca perguntamos" e "disse não" com a mesma
          // forma no banco, e quem lê para decidir envio não tinha como separar
          // os dois (ver buildContactConsentDenial).
          ...(consentDoEnvio ? { consent: consentDoEnvio } : {}),
        })
        .select("id")
        .maybeSingle();
      if (insertErr) {
        if (insertErr.code === "23505") {
          // Corrida OU duplicidade real: outro contato já existe com o mesmo
          // TELEFONE (corrida clássica: dois POSTs concorrentes) ou com o
          // mesmo E-MAIL (telefone inédito, e-mail repetido — o caso que
          // órfãava o lead antes desta linha, achado em 2026-08-25 rodando os
          // testes do fix do Respondi). Telefone primeiro — é o identificador
          // mais confiável do produto; e-mail só como fallback, e só quando o
          // payload realmente trouxe um.
          const { data: winnerByPhone } = await selectActiveByPhone();
          if (winnerByPhone) {
            contactId = winnerByPhone.id as string;
            existingContactName = winnerByPhone.name as string | null;
          } else {
            const byEmail = selectActiveByEmail();
            const { data: winnerByEmail } = byEmail ? await byEmail : { data: null };
            contactId = (winnerByEmail?.id as string | undefined) ?? undefined;
            existingContactName = (winnerByEmail?.name as string | null | undefined) ?? undefined;
          }
        } else {
          logger.error("[webhooks.inbound] contact insert failed", {
            webhookSourceId: source.id,
            organizationId: source.organization_id,
            errorCode: insertErr.code,
            errorMessage: insertErr.message,
          });
        }
      } else {
        contactId = (created?.id as string | undefined) ?? undefined;
        contatoNasceuAqui = contactId !== undefined;
      }
    }
  }

  /**
   * A ATRIBUIÇÃO DE ANÚNCIO do lead de formulário (issues #2317 e #3149).
   *
   * Quem anuncia para uma landing page com formulário não tinha a origem
   * estampada no contato: `fbclid`, `fbc`, `fbp`, `gclid`, `ad_id`, `adset_id` e
   * `campaign_id` viravam campo personalizado do card, e `lib/conversoes` não
   * sabia de que clique veio a venda.
   *
   * A entrada é `mapped.source_metadata`, e não o payload cru, para haver UM
   * caminho só: o mapeador GENÉRICO e os DEDICADOS (Elementor, RD Station,
   * Respondi) já entregam as chaves de anúncio ali — cada um lendo na forma do
   * seu fornecedor. Assim o extrator (`extrairAtribuicaoDoInbound`) é o mesmo
   * nos três, e um fornecedor novo não precisa de uma segunda regra aqui.
   *
   * A gravação é a MESMA função do clique-pro-WhatsApp
   * (`estamparAtribuicaoDoContato` → `fn_estampar_atribuicao_de_anuncio`), com a
   * guarda de primeiro toque no banco — sem regra paralela. A falha é tolerada
   * dentro dela: perder a atribuição é ruim, perder a captação é pior.
   *
   * Sem contato resolvido não há onde carimbar: o envio sem telefone (e sem
   * e-mail) segue criando o lead sem contato, como sempre.
   */
  if (contactId) {
    const atribuicao = extrairAtribuicaoDoInbound(mapped.source_metadata);
    if (atribuicao) {
      await estamparAtribuicaoDoContato(admin, source.organization_id, contactId, atribuicao);
    }
  }

  /**
   * O contato que JÁ EXISTIA também recebe a resposta DESTE envio.
   *
   * O bloco acima só grava consentimento no INSERT. Quem já era contato — a
   * segunda submissão da mesma pessoa, o lead que veio antes por outro canal —
   * ficava com a resposta anterior, ou com nenhuma. Vale nos dois sentidos, e
   * o pior é o segundo: quem CONCEDEU num envio e RECUSOU no seguinte
   * continuaria marcado como tendo concedido.
   *
   * Escreve o objeto inteiro (as 3 finalidades), como o INSERT: a coluna é um
   * mapa de finalidades e este webhook só capta `marketing`; `transactional` e
   * `profiling` seguem null como o default. Só para envio do Respondi — um
   * webhook genérico não pergunta consentimento e não tem o que afirmar.
   *
   * Falha aqui não derruba a captação: o contato já está resolvido e o lead
   * ainda vai entrar. Perder o carimbo é ruim; perder a captação é pior. Fica
   * no log, como as demais bordas desta rota.
   */
  if (consentDoEnvio && contactId && !contatoNasceuAqui) {
    const { error: eConsent } = await admin
      .from("contacts")
      .update({ consent: consentDoEnvio })
      .eq("id", contactId)
      .eq("organization_id", source.organization_id);
    if (eConsent) {
      logger.error("[webhooks.inbound] consent write failed", {
        webhookSourceId: source.id,
        organizationId: source.organization_id,
        contactId,
        error: eConsent.message,
      });
    }
  }

  // Classificação inicial (só Respondi por ora — os motivos de
  // desqualificação/revisão e o campo de orçamento são específicos do form
  // "Imobiliárias e Incorporadoras"; um webhook genérico não tem
  // `custom_fields.viable_investment_range` nem `consent` estruturado do
  // mesmo jeito). Escreve em `custom_fields` do PRÓPRIO lead sendo criado —
  // não dispara automação nenhuma, não manda mensagem: é dado, não ação.
  // "revisao_humana" (conflito de identidade, spam, incoerência de
  // investimento) também não bloqueia nada — quem controla envio é
  // guarda-do-contato.ts, que não lê classificação nenhuma.
  let classificacaoInicial: ResultadoClassificacaoInicial | null = null;
  if (respondiMapped) {
    classificacaoInicial = classificarLeadInicial({
      customFields: respondiMapped.custom_fields,
      phoneNormalizado: mapped.phone,
      consentGranted: respondiMapped.consent.granted,
      consentPerguntado: respondiMapped.consent.detectedVia !== "not_found",
      contatoExistente: existingContactName !== undefined ? { name: existingContactName } : null,
      nomeDoEnvio: mapped.name,
    });
    mapped.custom_fields.classificacao_inicial_status = classificacaoInicial.status;
    if (classificacaoInicial.status === "desqualificado") {
      mapped.custom_fields.classificacao_inicial_motivo = classificacaoInicial.motivo;
    } else if (classificacaoInicial.status === "revisao_humana") {
      mapped.custom_fields.classificacao_inicial_motivo = classificacaoInicial.motivo;
    } else {
      mapped.custom_fields.classificacao_inicial_classe = classificacaoInicial.classe;
      if (classificacaoInicial.percentual !== null) {
        mapped.custom_fields.classificacao_inicial_percentual = String(
          Math.round(classificacaoInicial.percentual),
        );
      }
    }
  }

  /**
   * ── O CONTATO CASADO JÁ TEM CARD ABERTO NESTE FUNIL: A CAPTAÇÃO O REUSA (#3101, #3357) ──
   *
   * O defeito medido em v1.86.0: a captação criava card NOVO em todo envio sem
   * `external_id`, mesmo quando o contato casado (por telefone ou e-mail) já
   * tinha negócio ABERTO no MESMO funil — um contato chegou a TRÊS cards
   * abertos no mesmo funil, e quem olha três cards do mesmo cliente não sabe
   * qual dos três a equipe está tocando.
   *
   * A régua é a MESMA que a ação `create_or_move_lead` já usa para o gatilho de
   * contato (#958): o negócio ABERTO do contato no funil da fonte é ATUALIZADO
   * com o que este envio trouxe e MOVIDO para a etapa da fonte quando ela está
   * à frente, em vez de nascer outro. O degrau é o mesmo módulo (`negocioAbertoDoContato`) — duas
   * implementações de "card aberto do contato" divergiriam na primeira mudança
   * de uma delas.
   *
   * Três portões, nesta ordem:
   *
   * 1. **é uma OPÇÃO DA FONTE, e nasce DESLIGADA** (migration 0722). Desligada,
   *    o comportamento de hoje não muda um byte — o envio cria o card como
   *    sempre criou. É o critério de aceite da issue: quem nunca ligar não vê
   *    diferença nenhuma;
   * 2. **o `external_id` QUE JÁ EXISTE manda** (#3357). Quando o id do envio já
   *    aponta para um card, quem responde é o `findLeadByExternalId` lá de cima
   *    e a régua de #2316 continua sendo a única: nem se chega a procurar card
   *    aberto. O id identifica o card, e é esse card que a atualização alcança —
   *    reusar OUTRO card ali trocaria a idempotência por envio (um lead por
   *    `external_id`) por uma atualização inesperada;
   * 3. **o card aberto é desta fonte (ou de nenhuma) e não responde por OUTRO
   *    id** (#3366; a pergunta do id só existe no envio COM id). Dois ids
   *    para o mesmo contato são DOIS cards por desenho (#2316): cada id tem a
   *    sua idempotência e o seu card. Um card carimbado com o id A não é
   *    adotado pelo envio do id B — o envio de B cria o card de B, como criava
   *    antes deste PR. Sem este portão o envio de B atualizava o card de A sem
   *    nunca ser gravado nele (o carimbo é compare-and-set) e o evento
   *    seguinte do id B ia atrás do card aberto MAIS NOVO do contato: o mesmo
   *    id podia trocar de alvo a cada card novo;
   * 4. **o card é o do contato NESTE funil** — escrever por cima do card aberto
   *    em OUTRO funil seria trocar de quadro sem passar pela transferência
   *    (#992), que encerra a origem com motivo próprio.
   *
   * O PRIMEIRO envio de um `external_id` INÉDITO é o caso que o #3357 mediu: o id
   * ainda não aponta para card nenhum, o contato tem o card da conversa aberto no
   * funil da fonte, e a captação abria um SEGUNDO card — um contato com dois
   * negócios abertos, o da conversa parado, e os eventos seguintes do mesmo id
   * mexendo só no card novo. Agora esse card aberto é adotado como qualquer
   * outro e o `external_id` é CARIMBADO nele (o bloco abaixo): daí em diante o id
   * aponta para o card que a equipe já está tocando, os envios seguintes caem no
   * fast-path do #2316 e a idempotência por id continua valendo. Sem o carimbo o
   * próximo evento abriria o segundo card de novo, um turno depois.
   *
   * Ligar a opção exige assinatura configurada na fonte — a mesma régua da
   * opção irmã (`lib/webhooks/assinatura-autorizacao.ts`), conferida no PATCH.
   *
   * Não há aqui o portão de titular anonimizado da opção irmã: o card é achado
   * pelo contato que ESTE envio casou, e a anonimização apaga telefone e e-mail
   * do contato (`fn_lgpd_cascade_redact_contact`) — um titular anonimizado não
   * casa com envio nenhum.
   *
   * O desfecho é `atualizado` — o mesmo vocabulário do #2316, que a migration
   * 0683 já aceita no CHECK —, e a linha de captação sai com o vínculo do lead e
   * do contato: é ela que o gatilho de anonimização alcança.
   */
  const cardAberto = await cardAbertoQueACaptacaoReusa(admin, {
    opcaoDaFonteLigada: Boolean(source.reuse_open_lead_on_capture),
    organizationId: source.organization_id as string,
    contactId: contactId ?? null,
    pipelineId: source.default_pipeline_id as string,
  });
  // O portão 3 do comentário acima, em duas perguntas (colunas lidas pelo
  // `negocioAbertoDoContato`):
  // - o card é desta fonte ou de nenhuma? Card de OUTRA fonte de webhook não é
  //   reusado — com ou sem id no envio;
  // - com id no envio: o card ainda não tem identidade de integração, ou já
  //   responde por ESTE id (a corrida de dois primeiros envios: o vencedor
  //   carimbou entre o `findLeadByExternalId` e esta leitura).
  const daFonteOuDeNenhuma =
    !cardAberto?.webhook_source_id || cardAberto.webhook_source_id === source.id;
  if (
    cardAberto &&
    daFonteOuDeNenhuma &&
    (!externalId || !cardAberto.external_id || cardAberto.external_id === externalId)
  ) {
    /**
     * O `external_id` DO ENVIO VAI PARA O CARD ADOTADO (#3357).
     *
     * Só se chega aqui com id INÉDITO: o `findLeadByExternalId` da linha de cima
     * já respondeu `null` para este id, e é este o PRIMEIRO envio que o traz. Sem
     * o carimbo, o card adotado ficaria sem identidade de integração e o evento
     * seguinte — o mesmo id — abriria o SEGUNDO card que a issue mediu: o card
     * da conversa parado ao lado do card do teste, um contato com dois negócios
     * abertos no mesmo funil.
     *
     * Carimbado, o vínculo fica igual ao de um card criado por esta rota: o
     * próximo envio cai no fast-path do #2316 e ATUALIZA este card em vez de
     * abrir outro. O desfecho deste envio não muda (`atualizado`).
     *
     * Compare-and-set (`.is("external_id", null)`): com o portão 3 lá de cima o
     * card já SEMPRE nasce aqui sem id — o que sobra é a CORRIDA de dois
     * primeiros envios simultâneos, que acham o mesmo card aberto ainda sem
     * identidade. O perdedor não reescreve o id do vencedor: trocar a
     * identidade faria o retry DO OUTRO abrir um terceiro card.
     *
     * Falha aqui é tolerada, como nas demais bordas desta rota: o card já está
     * adotado e o dado do envio entra nele logo abaixo. O que se perde, e só no
     * caso do índice único recusar (outra requisição carimbou primeiro), é a
     * idempotência DESTE id — o próximo envio casa no card do vencedor. Derrubar
     * a captação por causa do carimbo seria pior que perdê-lo.
     */
    if (externalId) {
      const { error: erroDoCarimbo } = await admin
        .from("crm_leads")
        .update({ external_id: externalId, webhook_source_id: source.id })
        .eq("organization_id", source.organization_id)
        .eq("id", cardAberto.id)
        .is("external_id", null);
      if (erroDoCarimbo) {
        logger.error("[webhooks.in] external_id do envio não pôde ser carimbado no card adotado", {
          organizationId: source.organization_id,
          webhookSourceId: source.id,
          leadId: cardAberto.id,
          requestId,
          error: erroDoCarimbo.message,
        });
      }
    }
    // Só o que MUDOU vai para o card — a MESMA comparação do reenvio (#2316).
    // O objeto inteiro desfaria a correção que a equipe fez à mão num campo
    // que este envio nem trouxe.
    const campos = camposQueMudaram(cardAberto.custom_fields, mapped.custom_fields);
    // O título segue a régua da opção irmã: escrito só quando o nome do envio
    // difere do que o card tem, e nunca no Respondi, que tem formato próprio
    // de título ("Empresa — Nome", `respondiLeadTitle`) — compará-lo com o nome
    // reescreveria o título a cada envio.
    const tituloMudou = !respondiMapped && !!mapped.name && mapped.name !== cardAberto.title;
    // A etapa é a MESMA em que o card novo nasceria (`default_stage_id`), e só
    // para a FRENTE: a etapa da fonte é fixa e chega em todo envio, e um card
    // que a equipe já levou adiante não pode voltar para o começo do funil.
    const etapaDestino = await etapaAlvoDoEnvio(
      admin,
      source.organization_id as string,
      source.default_pipeline_id as string,
      cardAberto.stage_id,
      source.default_stage_id as string | null,
    );
    const ctxDoCard: HandlerCtx = {
      organization_id: source.organization_id,
      actor: { type: "webhook_source", id: source.id },
      requestId,
    };
    try {
      if (Object.keys(campos).length > 0 || tituloMudou) {
        await updateLeadHandler(admin, ctxDoCard, cardAberto.id, {
          ...(tituloMudou && mapped.name ? { title: mapped.name } : {}),
          ...(Object.keys(campos).length > 0 ? { custom_fields: campos } : {}),
        });
      }
      if (etapaDestino) {
        await moveLeadHandler(admin, ctxDoCard, cardAberto.id, { to_stage_id: etapaDestino });
      }
    } catch (err) {
      // O card JÁ existe e o envio veio de uma ferramenta que reenvia: a
      // recusa do UPDATE (régua de campos, contato de pessoal, etapa que o
      // funil não deixa) transformaria o card num loop de retry de quem
      // integra sem que o dado novo chegasse. Mesma régua do reenvio (#2316):
      // o que não pôde ser aplicado fica no log, e `registrarCaptacao` não
      // lança — a linha sai de qualquer jeito, com o vínculo.
      logger.error("[webhooks.in] captação que reusa o card aberto não pôde atualizá-lo", {
        organizationId: source.organization_id,
        webhookSourceId: source.id,
        leadId: cardAberto.id,
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await registrarCaptacao(admin, {
      ...fonteDaCaptacao,
      ...origemDaCaptacao,
      ...dadosDaCaptacao,
      leadId: cardAberto.id,
      contactId: contactId ?? cardAberto.contact_id,
      outcome: "atualizado",
    });
    return respondWithLead(cardAberto.id);
  }

  const leadInput: CreateLeadInput & {
    custom_fields?: Record<string, unknown>;
    source_metadata?: Record<string, unknown>;
    external_id?: string;
    webhook_source_id?: string;
  } = {
    pipeline_id: source.default_pipeline_id,
    stage_id: source.default_stage_id,
    title: respondiMapped
      ? respondiLeadTitle(respondiMapped)
      : (mapped.name ?? mapped.phone ?? mapped.email ?? "Lead sem nome"),
    contact_id: contactId,
    tags: [],
    source: "webhook",
    custom_fields: mapped.custom_fields,
    source_metadata: { ...mapped.source_metadata, webhook_source_id: source.id },
    // A coluna que responde "de quem é este card" para a atualização por
    // integração (migration 0683). Vai junto do `source_metadata` porque é o
    // MESMO fato em dois lugares: o jsonb é o registro histórico do envio, e a
    // coluna é o que a régua lê — durável, tipada e indexada.
    webhook_source_id: source.id,
    ...(externalId ? { external_id: externalId } : {}),
  };

  let lead: Record<string, unknown>;
  try {
    lead = await createLeadHandler(
      admin,
      {
        organization_id: source.organization_id,
        actor: { type: "webhook_source", id: source.id },
        requestId,
      },
      leadInput,
      // O lead de formulário entra no funil mesmo com campo exigido em branco
      // (#2295) e mesmo com valor fora do `padrao` do campo (#2730): ver as
      // duas opções no handler.
      { exigirCamposDaEtapa: false, exigirPadraoDoCampo: false },
    );
  } catch (err) {
    if (err instanceof ApiError) {
      // Corrida do retry: dois POSTs simultâneos com o mesmo external_id
      // passam ambos pelo fast-path; o índice único derruba o segundo INSERT
      // (23505) — re-seleciona o vencedor e fecha com a MESMA régua de #2316:
      // dado novo atualiza o vencedor, payload idêntico segue idempotente.
      if (externalId && err.message?.includes("uniq_crm_leads_org_source_external")) {
        const vencedor = await findLeadByExternalId();
        if (vencedor) {
          // O contato desta requisição quando existe (foi resolvido acima);
          // o do vencedor como plano B — o que importa é a linha ter vínculo,
          // para o gatilho de anonimização alcançá-la.
          return fecharReenvio(vencedor, contactId ?? null);
        }
      }
      await registrarCaptacao(admin, {
        ...fonteDaCaptacao,
        ...origemDaCaptacao,
        ...dadosDaCaptacao,
        contactId: contactId ?? null,
        outcome: "recusado",
        // O rótulo diz o que REALMENTE falhou (#2297, caminho 4): o mesmo
        // `erro_ao_criar_lead` para tudo mentia sobre qualquer recusa que não
        // fosse de funil ou de etapa.
        rejectReason: motivoDaRecusaDaCriacao(err),
      });
      return fail(err.code, err.message ?? "erro", err.status, { requestId });
    }
    throw err;
  }

  await admin
    .from("webhook_sources")
    .update({ last_received_at: new Date().toISOString() })
    .eq("organization_id", source.organization_id)
    .eq("id", source.id);

  await audit({
    action: "webhook.lead_received",
    organizationId: source.organization_id,
    resourceType: "crm_lead",
    resourceId: String(lead.id),
    requestId,
    metadata: { webhook_source_id: source.id },
  });

  // Recusa de consentimento é sinal, não ausência de sinal (mesma regra da
  // timeline pra veto/handoff): registrada aqui pra quem olha o dossiê saber
  // POR QUE nenhuma automação de 1º toque disparou pra este lead — nunca pra
  // autorizar contato, só pra deixar a recusa visível.
  if (respondiMapped && !respondiMapped.consent.granted) {
    const atividade = await emitLeadActivity(admin, {
      organizationId: source.organization_id,
      leadId: String(lead.id),
      contactId: contactId ?? null,
      type: "consent_declined",
      sourceModule: "webhook",
      sourceId: source.id,
      actor: { type: "webhook_source", id: source.id },
      reason: "Respondente não concedeu consentimento de contato no formulário Respondi.",
      payload: {
        webhook_source_id: source.id,
        detected_via: respondiMapped.consent.detectedVia,
        raw_answer: respondiMapped.consent.rawAnswer,
      },
    });
    if (!atividade.ok) {
      logger.error("[webhooks.inbound] consent_declined activity failed", {
        webhookSourceId: source.id,
        organizationId: source.organization_id,
        leadId: String(lead.id),
        error: atividade.error,
      });
    }
  }

  // Classificação inicial: desqualificação e pedido de revisão humana também
  // são sinal, não ausência de sinal — mesmo raciocínio de consent_declined
  // acima. "classificado" com uma classe (A/B/C/D/nao_avaliado) NÃO gera
  // atividade própria: o valor já fica visível em custom_fields, e uma
  // classificação normal não é um evento que precisa de linha na timeline.
  if (classificacaoInicial && classificacaoInicial.status !== "classificado") {
    const tipo = classificacaoInicial.status === "desqualificado" ? "lead_disqualified" : "lead_needs_review";
    const atividadeClassificacao = await emitLeadActivity(admin, {
      organizationId: source.organization_id,
      leadId: String(lead.id),
      contactId: contactId ?? null,
      type: tipo,
      sourceModule: "webhook",
      sourceId: source.id,
      actor: { type: "webhook_source", id: source.id },
      reason:
        classificacaoInicial.status === "desqualificado"
          ? `Desqualificado na triagem inicial: ${classificacaoInicial.motivo}.`
          : `Revisão humana pedida na triagem inicial: ${classificacaoInicial.motivo}.`,
      payload: { webhook_source_id: source.id, motivo: classificacaoInicial.motivo },
    });
    if (!atividadeClassificacao.ok) {
      logger.error("[webhooks.inbound] classificacao_inicial activity failed", {
        webhookSourceId: source.id,
        organizationId: source.organization_id,
        leadId: String(lead.id),
        error: atividadeClassificacao.error,
      });
    }
  }
  await registrarCaptacao(admin, {
    ...fonteDaCaptacao,
    ...origemDaCaptacao,
    ...dadosDaCaptacao,
    leadId: String(lead.id),
    contactId: contactId ?? null,
    outcome: "criado",
  });

  // ELEGIBILIDADE DA IA (caso 1): uma submissão do Respondi é uma origem
  // elegível — autoriza o contato a ser atendido automaticamente. Só tem efeito
  // nos canais com o gate `allowlist` ligado; canal 'open' ignora a coluna.
  // Consent explicitamente NEGADO não autoriza (LGPD); `not_found` (o formulário
  // não pergunta) autoriza — mesma régua do `consentDoEnvio` acima.
  const consentNegado =
    respondiMapped != null &&
    respondiMapped.consent.detectedVia !== "not_found" &&
    !respondiMapped.consent.granted;
  if (source.authorize_ai_on_capture && contactId) {
    const autorizou = sourceSecret !== null && await autorizarCaptacaoParaIA(admin, {
      organizationId: source.organization_id, sourceId: source.id,
      leadId: String(lead.id), contactId, requestId,
    });
    const atividadeIA = await emitLeadActivity(admin, {
      organizationId: source.organization_id, leadId: String(lead.id), contactId,
      type: "note", sourceModule: "webhook", sourceId: source.id,
      actor: { type: "webhook_source", id: source.id },
      reason: autorizou
        ? "Atendimento por IA autorizado pelo consentimento explícito deste formulário."
        : "Este envio não concedeu nova autorização de IA. Confira o consentimento e o estado do contato antes de configurar o atendimento.",
      payload: { webhook_source_id: source.id, request_id: requestId, ai_authorized: autorizou },
    });
    if (!atividadeIA.ok) {
      logger.warn("[webhooks.inbound] autorização por formulário sem atividade", {
        organization_id: source.organization_id, request_id: requestId,
      });
    }
  } else if (!source.authorize_ai_on_capture && respondiMapped && contactId && !consentNegado) {
    const formId = respondiMapped.custom_fields.respondi_form_id ?? "form";
    const submissionId = respondiMapped.custom_fields.respondi_respondent_id ?? "s";
    await autorizarContatoParaIA(admin, {
      organizationId: source.organization_id,
      contactId,
      reason: `respondi:${formId}:${submissionId}`,
    });
  }

  // Captação: drena lead.created e inscreve no fluxo neste mesmo request.
  // Sem isto, numa instalação sem cron de 1 min (relógio HTTP), o gatilho fica pending.
  await kickLocalPipeline(
    admin,
    contactId
      ? { organizationId: source.organization_id, contactId }
      : undefined,
  );

  return respondWithLead(String(lead.id));
}
