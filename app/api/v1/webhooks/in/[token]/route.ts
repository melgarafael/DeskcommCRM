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

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { classificarLeadInicial, type ResultadoClassificacaoInicial } from "@/lib/leads/classificacao-inicial";
import type { CreateLeadInput } from "@/lib/schemas";
import { mapInboundPayload, verifyInboundSignature, type FieldMap } from "@/lib/webhooks/inbound";
import { encontrarContatoPorTelefoneComNome } from "@/lib/channels/contato-por-telefone";
import {
  buildContactConsentGrant,
  buildContactConsentDenial,
  isRespondiPayload,
  mapRespondiPayload,
  respondiLeadTitle,
  type RespondiMapped,
} from "@/lib/webhooks/respondi";
import { origemDaPagina, registrarCaptacao } from "@/lib/webhooks/captacao";
import { ipDoClienteParaInet } from "@/lib/http/ip-do-cliente";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { ApiError } from "@/lib/api/types";
import { autorizarContatoParaIA } from "@/lib/ai/elegibilidade/autorizacao";
import { kickLocalPipeline } from "@/lib/dev/kick-local-pipeline";

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
    .select("id, name, organization_id, secret_encrypted, default_pipeline_id, default_stage_id, field_map, redirect_to, is_active")
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

  const sigHeader = req.headers.get("x-deskcomm-signature");
  // secret cifrado at-rest (migration 0041). Decrypt falhou (chave da GUC
  // ausente/trocada)? Precedente WAHA: pula a validação em vez de derrubar a
  // captação — secret aqui é defesa opcional, não gate de disponibilidade.
  let sourceSecret: string | null = null;
  let hmacSkipped = false;
  if (source.secret_encrypted) {
    sourceSecret = await decryptWebhookSecret(admin, source.secret_encrypted as unknown as string);
    if (sourceSecret === null) hmacSkipped = true;
  }
  const validSignature = sourceSecret ? verifyInboundSignature(rawBody, sigHeader, sourceSecret) : null;
  if (sourceSecret && !validSignature) {
    await audit({
      action: "webhook.inbound_invalid_signature",
      organizationId: source.organization_id,
      resourceType: "webhook_source",
      resourceId: source.id,
      requestId,
    });
    await registrarCaptacao(admin, {
      ...fonteDaCaptacao,
      ...origemDaCaptacao,
      outcome: "recusado",
      rejectReason: "assinatura_invalida",
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
    // hmacSkipped (decrypt indisponível) conta como "não validado mas aceito",
    // igual ao webhook WAHA — o feed da UI não pinta de vermelho.
    valid_signature: validSignature ?? true,
    event_type: hmacSkipped ? "lead_capture.received_hmac_skipped" : "lead_capture.received",
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
      : (respondiMapped?.externalId?.slice(0, 255) ?? null);

  const respondWithLead = (leadId: string): NextResponse => {
    if (isForm && source.redirect_to) {
      return NextResponse.redirect(source.redirect_to as string, 303);
    }
    return ok({ lead_id: leadId }, { requestId });
  };

  // Traz o CONTATO junto, e não só o id do lead: a linha de captação precisa do
  // vínculo para a LGPD alcançá-la. O gatilho de anonimização casa por
  // `contact_id` — uma captação `duplicado` gravada sem ele guarda nome,
  // telefone e o formulário inteiro de alguém que pediu anonimização, por 365
  // dias, enquanto o produto afirma que a pessoa foi anonimizada.
  const findLeadByExternalId = async (): Promise<{ id: string; contactId: string | null } | null> => {
    if (!externalId) return null;
    const { data } = await admin
      .from("crm_leads")
      .select("id, contact_id")
      .eq("organization_id", source.organization_id)
      .eq("source", "webhook")
      .eq("external_id", externalId)
      .maybeSingle();
    if (!data) return null;
    return { id: data.id as string, contactId: (data.contact_id as string | null) ?? null };
  };

  const fieldMap = (source.field_map ?? {}) as FieldMap;
  // external_id não é dado do lead — sai do payload antes do mapeamento pra
  // não virar custom_field (o log de recebimento acima preserva o original).
  const { external_id: _reservedExternalId, ...payloadForMapping } = payload;
  // O mapeamento vem ANTES da deduplicação (era depois) porque o histórico
  // registra os DADOS também do envio repetido — sem isso, o retry de uma
  // ferramenta apareceria na tela como uma linha sem nome nem telefone, e quem
  // olha não distinguiria "reenvio do mesmo lead" de "formulário vazio".
  // `mapInboundPayload` é puro, então adiantá-lo não muda desfecho nenhum.
  //
  // O `respondiMapped ??` é do PR #326: sem ele o payload aninhado do Respondi
  // volta a cair no mapeador genérico, que é o defeito que aquele PR conserta.
  const mapped =
    respondiMapped ?? mapInboundPayload(externalId ? payloadForMapping : payload, fieldMap);
  if (!mapped.phone) {
    const rawPhone = findRawPhoneIfUnnormalized(payload, fieldMap);
    if (rawPhone) mapped.source_metadata.raw_phone = rawPhone;
  }

  /** O que o formulário trouxe, do jeito que a tela de histórico mostra. */
  const dadosDaCaptacao = {
    capturedName: mapped.name,
    capturedPhone: mapped.phone,
    capturedEmail: mapped.email,
    fields: mapped.custom_fields,
    utm: mapped.source_metadata,
  };

  const deduped = await findLeadByExternalId();
  if (deduped) {
    // Mesmo envio repetido: 200 com o lead existente, nada é recriado — a
    // ferramenta que reenviou recebe sucesso e para de tentar.
    await registrarCaptacao(admin, {
      ...fonteDaCaptacao,
      ...origemDaCaptacao,
      ...dadosDaCaptacao,
      leadId: deduped.id,
      contactId: deduped.contactId,
      outcome: "duplicado",
    });
    return respondWithLead(deduped.id);
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
          source_metadata: { webhook_source_id: source.id, ...mapped.source_metadata },
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

  const leadInput: CreateLeadInput & {
    custom_fields?: Record<string, unknown>;
    source_metadata?: Record<string, unknown>;
    external_id?: string;
  } = {
    pipeline_id: source.default_pipeline_id,
    stage_id: source.default_stage_id,
    title: respondiMapped
      ? respondiLeadTitle(respondiMapped)
      : (mapped.name ?? mapped.phone ?? mapped.email ?? "Lead sem nome"),
    contact_id: contactId,
    currency: "BRL",
    tags: [],
    source: "webhook",
    custom_fields: mapped.custom_fields,
    source_metadata: { webhook_source_id: source.id, ...mapped.source_metadata },
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
    );
  } catch (err) {
    if (err instanceof ApiError) {
      // Corrida do retry: dois POSTs simultâneos com o mesmo external_id
      // passam ambos pelo fast-path; o índice único derruba o segundo INSERT
      // (23505) — re-seleciona o vencedor e responde idempotente.
      if (externalId && err.message?.includes("uniq_crm_leads_org_source_external")) {
        const vencedor = await findLeadByExternalId();
        if (vencedor) {
          await registrarCaptacao(admin, {
            ...fonteDaCaptacao,
            ...origemDaCaptacao,
            ...dadosDaCaptacao,
            leadId: vencedor.id,
            // O contato desta requisição quando existe (foi resolvido acima);
            // o do lead vencedor como plano B — o que importa é a linha ter
            // vínculo, para o gatilho de anonimização alcançá-la.
            contactId: contactId ?? vencedor.contactId,
            outcome: "duplicado",
          });
          return respondWithLead(vencedor.id);
        }
      }
      await registrarCaptacao(admin, {
        ...fonteDaCaptacao,
        ...origemDaCaptacao,
        ...dadosDaCaptacao,
        contactId: contactId ?? null,
        outcome: "recusado",
        rejectReason: "erro_ao_criar_lead",
      });
      return fail(err.code, err.message ?? "erro", err.status, { requestId });
    }
    throw err;
  }

  await admin
    .from("webhook_sources")
    .update({ last_received_at: new Date().toISOString() })
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
  if (respondiMapped && contactId && !consentNegado) {
    const formId = respondiMapped.custom_fields.respondi_form_id ?? "form";
    const submissionId = respondiMapped.custom_fields.respondi_respondent_id ?? "s";
    await autorizarContatoParaIA(admin, {
      organizationId: source.organization_id,
      contactId,
      reason: `respondi:${formId}:${submissionId}`,
    });
  }

  // Captação: drena lead.created e inscreve no fluxo neste mesmo request.
  // Sem isto, em prod (Vercel Hobby sem cron de 1 min) o gatilho fica pending.
  await kickLocalPipeline(
    admin,
    contactId
      ? { organizationId: source.organization_id, contactId }
      : undefined,
  );

  return respondWithLead(String(lead.id));
}
