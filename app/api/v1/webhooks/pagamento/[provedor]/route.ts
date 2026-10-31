/**
 * POST /api/v1/webhooks/pagamento/[provedor] — o aviso de "pago" do CLIENTE FINAL
 * (issue #3509, degrau 1).
 *
 * ─── A ordem das guardas é a entrega ────────────────────────────────────────
 *
 * 1. Provedor fora da lista → 404 (não confirmamos o que existe).
 * 2. SEM SEGREDO CONFIGURADO → 503 dizendo qual chave falta, e NADA acontece.
 *    A tentação é responder 200 para "não perder o aviso". Ela é o defeito: o
 *    provedor para de reentregar o que ele acha que já chegou, e o pagamento
 *    some para sempre, com o log dizendo "recebido". Falhar alto é o único
 *    desfecho honesto.
 * 3. Corpo grande demais → 413, antes de ler o corpo inteiro.
 * 4. ASSINATURA, sobre o corpo CRU → 401. É o item que a issue #3509 chama de
 *    "não pode ficar para depois": sem ela, um POST de qualquer pessoa marca
 *    pagamento e move negócio.
 * 5. Rosca de recusas por IP (o balde de quem não se autenticou) → 429.
 * 6. Só então o corpo é interpretado, e ainda assim o único efeito é
 *    `confirmarPagamento`, que é compare-and-set.
 *
 * ─── O que o aviso NÃO faz ──────────────────────────────────────────────────
 *
 * Não relê o pagamento na API do provedor (`payment_check`): isso exige
 * credencial, que este degrau não tem. É a diferença declarada para o desenho
 * da issue — aqui a confiança vem da ASSINATURA, não da releitura. Quando a
 * credencial existir, a releitura entra ANTES do compare-and-set e esta rota
 * não muda de forma.
 *
 * Evento desconhecido → 200 e nada muda. Id desconhecido → 200 e nada muda: não
 * é erro do provedor (pode ser pagamento de outra instalação), e a conciliação
 * futura é quem cura.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { verificarAssinatura } from "@/lib/pagamentos/assinatura";
import { confirmarPagamento } from "@/lib/pagamentos/confirmar";
import { configuracaoDoRecebimento } from "@/lib/pagamentos/configuracao";
import {
  EVENTOS_QUE_ENCERRAM,
  EVENTOS_QUE_PAGAM,
  LIMITE_DO_CORPO,
  ehProvedorDeRecebimento,
} from "@/lib/pagamentos/vocabulario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Recusas por minuto por IP. Aviso VÁLIDO nunca entra neste balde. */
const RECUSAS_POR_MINUTO = 120;

/**
 * A forma do aviso, TOLERANTE e mínima.
 *
 * A issue registra que a InfinitePay está em transição entre dois fluxos e não
 * documenta o enum de eventos (pergunta 3). Ler só o que é estável — o id do
 * pagamento e o nome do evento — é o que evita "suportar" um formato que a
 * gente inventou. Nome de campo novo entra aqui quando o provedor publicar.
 */
const avisoSchema = z
  .object({
    id: z.string().min(1).max(256).optional(),
    event: z.string().min(1).max(64).optional(),
    type: z.string().min(1).max(64).optional(),
    status: z.string().min(1).max(64).optional(),
    data: z.object({ id: z.string().min(1).max(256).optional() }).loose().optional(),
  })
  .loose();

interface Contexto {
  params: Promise<{ provedor: string }>;
}

export async function POST(req: NextRequest, ctx: Contexto) {
  const requestId = randomUUID();
  const { provedor: bruto } = await ctx.params;
  if (!ehProvedorDeRecebimento(bruto)) {
    return fail("not_found", "Not found", 404, { requestId });
  }
  const provedor = bruto;

  const { segredo, chave } = await configuracaoDoRecebimento();
  if (!segredo) {
    logger.error("[pagamentos.webhook] aviso recusado: segredo não configurado", { provedor });
    return fail("unavailable", "O aviso de pagamento não está configurado nesta instalação.", 503, {
      requestId,
      // Diz o QUE falta e ONDE: sem isso o operador vê 503 para sempre e não
      // tem como saber que a chave existe no painel.
      details: { falta: chave, onde: "Painel → Cobrança" },
    });
  }

  if (Number(req.headers.get("content-length") ?? "0") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }
  const corpo = await req.text();
  if (Buffer.byteLength(corpo, "utf8") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }

  const veredito = verificarAssinatura(corpo, req.headers, segredo, new Date());
  if (!veredito.ok) {
    // O balde é o IP de quem NÃO se autenticou. Sem proxy à frente, é um balde
    // só — e só recusas o dividem, então não bloqueia ninguém de verdade.
    const balde = ipDoCliente(req.headers) ?? "sem-proxy";
    const taxa = await checkRateLimit(`pagamento-webhook-recusado:${balde}`, RECUSAS_POR_MINUTO, 60);
    if (!taxa.allowed) {
      return fail("rate_limited", "Muitos avisos recusados seguidos.", 429, {
        requestId,
        headers: { "Retry-After": "60" },
      });
    }
    // Nem corpo nem cabeçalho no log: o corpo é de quem não se autenticou, e o
    // cabeçalho é a assinatura dele. O motivo é tudo o que o dono precisa.
    logger.warn("[pagamentos.webhook] aviso recusado", { provedor, motivo: veredito.motivo });
    return fail("unauthorized", "Assinatura inválida.", 401, { requestId });
  }

  let json: unknown;
  try {
    json = JSON.parse(corpo);
  } catch {
    // Assinado e não é JSON: recusar é a leitura segura (o desenho da Stripe em
    // `lib/cobranca/provedores/stripe.ts`).
    return fail("validation_failed", "Aviso inválido.", 400, { requestId });
  }
  const aviso = avisoSchema.safeParse(json);
  if (!aviso.success) {
    return fail("validation_failed", "Aviso inválido.", 400, { requestId });
  }

  const evento = normalizar(aviso.data.event ?? aviso.data.type ?? aviso.data.status ?? "");
  const externalId = (aviso.data.data?.id ?? aviso.data.id ?? "").trim();

  if (evento === "" || !(EVENTOS_QUE_PAGAM as readonly string[]).includes(evento)) {
    // Inclui os eventos de encerramento: estorno e cancelamento são fatia
    // seguinte, e "não implementado" tem de ser IGNORADO, nunca virar `paga`.
    const encerra = (EVENTOS_QUE_ENCERRAM as readonly string[]).includes(evento);
    logger.info("[pagamentos.webhook] evento sem efeito neste degrau", {
      provedor,
      evento: evento === "" ? "ausente" : evento,
      encerramento: encerra,
    });
    return ok({ ignorado: true, evento: evento === "" ? null : evento }, { requestId });
  }
  if (externalId === "") {
    return fail("validation_failed", "Aviso sem o identificador do pagamento.", 400, { requestId });
  }

  const r = await confirmarPagamento(createAdminClient(), {
    provedor,
    externalId,
    quando: new Date(),
  });
  if (!r.ok) {
    // 500 e o provedor reentrega. Nada foi marcado (ou foi marcado e a
    // reentrega é inofensiva, pelo compare-and-set).
    return fail("internal_error", r.message, r.status, { requestId });
  }
  if (r.efeito === "desconhecido") {
    logger.info("[pagamentos.webhook] pagamento de outra origem", { provedor });
    return ok({ ignorado: "desconhecido" }, { requestId });
  }
  if (r.efeito === "duplicado") {
    // Reentrega do MESMO evento: 200 sem efeito. 409 faria o provedor insistir.
    return ok({ duplicado: true, status: r.status }, { requestId });
  }

  // Só quem venceu o compare-and-set chega aqui: uma linha por pagamento.
  await audit({
    action: "pagamento.confirmado",
    actorUserId: null,
    organizationId: r.recebimento.organization_id,
    resourceType: "pagamento_recebimento",
    resourceId: r.recebimento.id,
    requestId,
    metadata: {
      actor_type: "webhook_source",
      provedor,
      valor_cents: r.recebimento.valor_cents,
      moeda: r.recebimento.moeda,
      lead_id: r.recebimento.lead_id,
      negocio: r.movido.moveu ? "movido" : r.movido.motivo,
    },
  });

  logger.info("[pagamentos.webhook] pagamento confirmado", {
    provedor,
    organization_id: r.recebimento.organization_id,
    moveu: r.movido.moveu,
    ...(r.movido.moveu ? {} : { motivo_do_nao_movimento: r.movido.motivo }),
  });
  return ok(
    {
      recebido: true,
      status: "paga",
      negocio: r.movido.moveu ? "movido" : r.movido.motivo,
    },
    { requestId },
  );
}

function normalizar(evento: string): string {
  return evento.trim().toLowerCase();
}
