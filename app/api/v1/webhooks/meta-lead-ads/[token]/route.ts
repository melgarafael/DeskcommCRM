/**
 * POST /api/v1/webhooks/meta-lead-ads/[token] — o lead do formulário instantâneo
 * da Meta (Lead Ads) entrando no funil (issue #3768, fatia 1).
 *
 * ═══ O QUE ESTA ROTA É, E O QUE ELA NÃO É ═══
 *
 * É a PORTA: resolve o tenant pelo `path_token` da fonte de captação que já
 * existe (`webhook_sources`), confere a assinatura do provedor em FALHA FECHADA
 * e entrega o corpo ao parser puro (`lib/leads/lead-ads/payload.ts`), que diz
 * quais leads entraram e quais foram descartados com motivo. A escrita fica em
 * `lib/leads/lead-ads/entrada.ts`.
 *
 * NÃO é a conexão com a Meta: tela de OAuth, escolha de página, listagem de
 * formulários e sincronização de campanhas estão FORA desta fatia (declarado no
 * fio da issue). Também não há `GET` de handshake aqui: a verificação de
 * assinatura da assinatura do app (`hub.challenge`) é do webhook da instalação
 * (`app/api/v1/webhooks/meta/[token]`, que já a serve em texto puro) e pertence à
 * fatia de conexão. Sem credencial real, esta rota é provada por FIXTURE.
 *
 * ═══ POR QUE 200 EM TANTA COISA ═══
 *
 * A Meta reentrega o que não recebe 2xx, em backoff. 4xx/5xx, portanto, é uma
 * AFIRMAÇÃO: "este corpo ainda pode dar certo, tente de novo". Ela é verdadeira
 * para falha nossa (500) e para JSON quebrado (400), e é FALSA para tudo o que
 * esta rota recusa de propósito — evento que não é leadgen, lead sem as
 * respostas, reentrega do mesmo `leadgen_id`. Recusar essas com erro faria a
 * Meta martelar para sempre um corpo que nunca vai melhorar, e é o mesmo
 * raciocínio escrito no cabeçalho de `webhooks/meta/[token]`.
 *
 * ═══ O QUE A ASSINATURA PROTEGE, E CONTRA QUEM ═══
 *
 * O `path_token` resolve o TENANT, mas não é credencial de origem: quem o
 * descobrisse escreveria lead em nome de qualquer um. A assinatura HMAC-SHA-256
 * do corpo cru, com o segredo da fonte, é o que prova que o corpo veio de quem
 * tem o App Secret da Meta — e o segredo NAO é gravado em claro
 * (`webhook_sources.secret_encrypted`, cifrado pela mesma GUC do resto do
 * produto). Segredo que não pôde ser decifrado RECUSA: "não dá para conferir" é
 * o mesmo que "não confere" (`lib/webhooks/secrets.ts`).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import {
  CABECALHO_DA_ASSINATURA_DA_META,
  assinaturaDaMetaConfere,
  entregaDentroDaJanela,
} from "@/lib/leads/lead-ads/assinatura";
import { entradaDoLeadDoFormulario, type FonteDoLeadAds } from "@/lib/leads/lead-ads/entrada";
import { lerLeadsDoFormularioMeta } from "@/lib/leads/lead-ads/payload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

/**
 * Teto do corpo. O formulário da Meta é pequeno (três a vinte respostas), então
 * 1 MB é folga larga — e é o mesmo teto da cobrança, para não existirem dois
 * números de "aviso grande demais" no produto.
 */
const LIMITE_DO_CORPO = 1_048_576;

export async function POST(req: NextRequest, { params }: RouteCtx) {
  const requestId = randomUUID();
  const { token } = await params;
  const admin = createAdminClient();

  // O tenant vem da FONTE, nunca do corpo: quem chama é público, e um
  // `organization_id` no payload seria escrita na empresa que o atacante
  // escolhesse.
  const { data: fonte, error: erroDaFonte } = await admin
    .from("webhook_sources")
    .select(
      "id, name, organization_id, secret_encrypted, default_pipeline_id, default_stage_id, is_active",
    )
    .eq("path_token", token)
    .maybeSingle();
  if (erroDaFonte) {
    logger.error("[lead-ads] fonte do webhook não pôde ser lida", {
      request_id: requestId,
      error_code: erroDaFonte.code,
    });
    return fail("internal_error", "Não foi possível ler a fonte.", 500, { requestId });
  }
  if (!fonte || fonte.is_active !== true) {
    // 404 para token desconhecido E para fonte desligada, com a mesma frase: a
    // diferença entre "não existe" e "existe e está desligada" é informação de
    // quem opera, e não de quem chama.
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  if (Number(req.headers.get("content-length") ?? "0") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }
  const corpo = await req.text();
  if (Buffer.byteLength(corpo, "utf8") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }

  // ─── A PORTA: assinatura, e depois janela ──────────────────────────────────
  //
  // A assinatura vem PRIMEIRO e sobre o corpo CRU — antes de qualquer parse,
  // porque parsear corpo não confiável para depois recusá-lo é trabalho de
  // graça, e porque a janela só é confiável DEPOIS que se sabe que o corpo é de
  // quem diz ser (o `entry[].time` está dentro do que foi assinado).
  const segredo = fonte.secret_encrypted
    ? await decryptWebhookSecret(admin, fonte.secret_encrypted as string)
    : null;
  const recusaDaAssinatura = assinaturaDaMetaConfere(
    corpo,
    req.headers.get(CABECALHO_DA_ASSINATURA_DA_META),
    segredo,
  );
  if (recusaDaAssinatura !== null) {
    // Rastro com o MOTIVO e sem o corpo: o corpo é de quem não se autenticou, e
    // ele pode carregar PII de terceiro. Sem org também — não há tenant provado
    // do outro lado desta linha.
    logger.warn("[lead-ads] entrega recusada na assinatura", {
      request_id: requestId,
      webhook_source_id: fonte.id,
      motivo: recusaDaAssinatura,
    });
    return fail("unauthorized", recusaDaAssinatura, 401, { requestId });
  }

  const leitura = lerLeadsDoFormularioMeta(corpo);
  if (!leitura.ok) {
    // 400 e não 200: JSON fora do contrato não é "evento que não nos interessa",
    // é o fio ter mudado — e o 200 generoso desta rota existe para o segundo
    // caso, não para o primeiro.
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  const agora = new Date();
  for (const lead of leitura.leads) {
    const recusaDaJanela = entregaDentroDaJanela(lead.entradaEm, agora);
    if (recusaDaJanela !== null) {
      // Recusa do lote INTEIRO, e não só do lead velho: uma entrega com um
      // sinal fora de tempo não é parcialmente confiável. Nada é escrito.
      logger.warn("[lead-ads] entrega recusada na janela", {
        request_id: requestId,
        webhook_source_id: fonte.id,
        motivo: recusaDaJanela,
        leadgen_id: lead.leadgenId,
      });
      return fail("unauthorized", recusaDaJanela, 401, { requestId });
    }
  }

  for (const descartado of leitura.descartados) {
    // O descarte é NOMEADO e fica registrado: um lead que a Meta avisou e não
    // entrou é a informação que quem opera a campanha precisa ter. Silêncio aqui
    // faria "não chegou nada" e "chegou sem as respostas" terem a mesma cara.
    logger.warn("[lead-ads] lead descartado antes da escrita", {
      request_id: requestId,
      webhook_source_id: fonte.id,
      leadgen_id: descartado.leadgenId,
      motivo: descartado.motivo,
    });
  }

  const fonteDoLead: FonteDoLeadAds = {
    id: fonte.id as string,
    organizationId: fonte.organization_id as string,
    nome: (fonte.name as string | null) ?? "Formulário da Meta",
    funilId: fonte.default_pipeline_id as string,
    etapaId: fonte.default_stage_id as string,
  };

  const leads: Array<{
    leadgen_id: string;
    desfecho: string;
    lead_id: string | null;
    contato_id: string | null;
  }> = [];
  for (const lead of leitura.leads) {
    try {
      const resultado = await entradaDoLeadDoFormulario(admin, fonteDoLead, lead, requestId);
      leads.push({
        leadgen_id: resultado.leadgenId,
        desfecho: resultado.desfecho,
        lead_id: resultado.leadId,
        contato_id: resultado.contatoId,
      });
    } catch (erro) {
      // A recusa já está em `webhook_lead_captures` (com o motivo de gente) e no
      // log; o status é o do erro para que quem depura a fonte veja qual é. 200
      // aqui esconderia um funil apagado atrás de "recebido".
      if (erro instanceof ApiError) {
        return fail(erro.code, erro.message ?? "recusado", erro.status, { requestId });
      }
      throw erro;
    }
  }

  return ok(
    {
      recebido: true,
      leads,
      // Vazio na entrega boa: é a lista que responde "a Meta avisou e não
      // entrou" sem obrigar ninguém a abrir o log.
      ignorados: leitura.descartados.map((d) => ({
        leadgen_id: d.leadgenId,
        motivo: d.motivo,
      })),
    },
    { requestId },
  );
}
