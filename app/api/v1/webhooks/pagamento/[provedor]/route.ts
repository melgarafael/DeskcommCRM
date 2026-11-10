/**
 * POST /api/v1/webhooks/pagamento/[provedor] — o aviso de "pago" do CLIENTE FINAL
 * (issue #3509, degrau 1).
 *
 * ─── A ordem das guardas é a entrega ────────────────────────────────────────
 *
 * 1. Provedor fora da lista, ou módulo `link_de_pagamento` desligado → 404.
 * 2. Corpo grande demais → 413, antes de ler o corpo inteiro.
 * 3. PROVA DE ORIGEM → 401. O recebimento é achado pelo id que vem NA URL
 *    (`?r=`), lido por nome, e o segredo (`?t=` ou `X-Webhook-Token`) é
 *    conferido contra o hash DAQUELE recebimento. Recebimento inexistente
 *    responde igual a segredo errado: não confirmamos o que existe. Não há
 *    segredo da instalação: cada recebimento tem o seu (`lib/pagamentos/assinatura.ts`).
 * 4. Rosca de recusas por IP (o balde de quem não se autenticou) → 429.
 * 5. Só então o corpo é interpretado, e o único efeito é `confirmarPagamento`,
 *    que confere o VALOR e é compare-and-set.
 *
 * ─── O que o aviso NÃO faz ──────────────────────────────────────────────────
 *
 * Não relê o pagamento na API do provedor (`payment_check`): isso exige
 * credencial, que este degrau não tem. Doc 232 (A): o "pago" sem releitura vale
 * só enquanto não houver credencial do provedor; quando houver, a releitura
 * entra ANTES do compare-and-set e esta rota não muda de forma.
 *
 * ─── O que o aviso real da InfinitePay ensinou (31/10/2026) ────────────────
 *
 * Captura feita por terceiro com conta real, R$ 1,00 por Pix: (a) o aviso NÃO é
 * assinado; (b) o `order_nsu` que mandamos na criação não volta — o provedor
 * manda um UUID dele; (c) `settled` pode chegar ANTES de `paid`; (d) só o
 * `paid` traz `transaction_nsu`, `paid_amount`, `installments`,
 * `capture_method` e `receipt_url`. Em 03/11 (link do painel, resposta 500): o
 * `paid` chega 5 vezes em ~2 min com corpo idêntico, e os parâmetros que pusemos
 * na URL voltam em todas, em ordem que muda. Por isso: o segredo e o id do
 * recebimento vêm na URL e são lidos por nome, o `invoice_slug` é o id do
 * pagamento gravado na confirmação, e `settled` conta como pago — a ordem não é
 * garantida, e o compare-and-set garante o efeito único.
 *
 * Evento desconhecido → 200 e nada muda. Valor divergente → 200 e nada muda: a
 * reentrega não muda o valor, e insistir só gastaria as tentativas do provedor.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import {
  PARAMETRO_DO_RECEBIMENTO_NA_URL,
  PARAMETRO_DO_TOKEN_NA_URL,
  verificarOrigem,
} from "@/lib/pagamentos/assinatura";
import { confirmarPagamento, lerRecebimentoDoAviso } from "@/lib/pagamentos/confirmar";
import {
  EVENTOS_QUE_ENCERRAM,
  EVENTOS_QUE_PAGAM,
  LIMITE_DO_CORPO,
  TAMANHO_MAXIMO_DO_ID_EXTERNO,
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
    // Forma real medida na InfinitePay em 31/10/2026 (aviso de R$ 1,00 por Pix):
    // `event_type` + `invoice_slug` no corpo, `order_nsu` gerado POR ELES (o que
    // mandamos na criação não volta) e `transaction_nsu` só no `paid`.
    event_type: z.string().min(1).max(64).optional(),
    invoice_slug: z.string().min(1).max(256).optional(),
    transaction_nsu: z.string().min(1).max(256).optional(),
    order_nsu: z.string().min(1).max(256).optional(),
    invoice_type: z.string().min(1).max(64).optional(),
    capture_method: z.string().min(1).max(32).optional(),
    // O `paid` do link criado pelo PAINEL chega SEM `event_type` e SEM
    // `invoice_type`, mas com estes dois (medido em 31/10/2026). Declará-los é
    // documentar a forma; a inferência do evento é que usa.
    paid_amount: z.number().optional(),
    // O valor da cobrança em centavos (100 = R$ 1,00, medido em 31/10), em todo
    // aviso. É o que se compara com o registrado.
    amount: z.number().optional(),
    receipt_url: z.string().max(512).optional(),
    // Forma genérica que outros provedores usam (e a que já existia aqui).
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

  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "link_de_pagamento"))) {
    return fail("not_found", "Not found", 404, { requestId });
  }

  if (Number(req.headers.get("content-length") ?? "0") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }
  const corpo = await req.text();
  if (Buffer.byteLength(corpo, "utf8") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }

  // Lidos por NOME: o provedor devolve os parâmetros em ordem que muda.
  const recebimentoId = req.nextUrl.searchParams.get(PARAMETRO_DO_RECEBIMENTO_NA_URL);
  const lido = z.string().uuid().safeParse(recebimentoId).success
    ? await lerRecebimentoDoAviso(admin, provedor, recebimentoId!)
    : ({ ok: true, recebimento: null } as const);
  if (!lido.ok) {
    // 500 e o provedor reentrega: o banco não respondeu, nada foi decidido.
    return fail("internal_error", "Não foi possível ler o recebimento.", 500, { requestId });
  }
  const veredito = lido.recebimento
    ? verificarOrigem(req.headers, req.nextUrl.searchParams.get(PARAMETRO_DO_TOKEN_NA_URL), lido.recebimento.aviso_token_hash)
    : ({ ok: false, motivo: "token_invalido" } as const);
  if (!veredito.ok || !lido.recebimento) {
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
    // Nem corpo, nem URL, nem cabeçalho no log: a URL leva o segredo. O motivo
    // é tudo o que o dono precisa.
    logger.warn("[pagamentos.webhook] aviso recusado", {
      provedor,
      motivo: veredito.ok ? "token_invalido" : veredito.motivo,
    });
    return fail("unauthorized", "Aviso não reconhecido.", 401, { requestId });
  }
  const recebimento = lido.recebimento;

  let json: unknown;
  try {
    json = JSON.parse(corpo);
  } catch {
    // Origem conferida e não é JSON: recusar é a leitura segura.
    return fail("validation_failed", "Aviso inválido.", 400, { requestId });
  }
  const aviso = avisoSchema.safeParse(json);
  if (!aviso.success) {
    return fail("validation_failed", "Aviso inválido.", 400, { requestId });
  }

  const evento = eventoDoAviso(aviso.data);
  if (evento === "paid" && eventoDeclarado(aviso.data) === "") {
    // O link criado pelo PAINEL manda o `paid` sem dizer que é `paid`. Registrar
    // isto é o que separa "aceitamos" de "adivinhamos sem contar a ninguém".
    logger.info("[pagamentos.webhook] evento inferido pela forma do corpo", {
      provedor,
      inferido: "paid",
      marcadores: aviso.data.transaction_nsu ? "transaction_nsu" : "receipt_url",
    });
  }
  /**
   * O id do pagamento NO PROVEDOR é o `invoice_slug` — e isso é MEDIÇÃO: o
   * `order_nsu` que mandamos ao criar o link NÃO volta (o provedor manda um
   * UUID dele), e o `invoice_slug` é o único campo estável entre os avisos do
   * mesmo pagamento (`created`, `settled`, `paid`). Ele não ACHA o recebimento
   * (quem acha é o `?r=` da URL): ele é gravado na confirmação, e o índice
   * único impede o mesmo pagamento de confirmar dois recebimentos.
   */
  const idNoProvedor = (
    aviso.data.invoice_slug ??
    aviso.data.transaction_nsu ??
    aviso.data.data?.id ??
    aviso.data.id ??
    ""
  ).trim();

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
  if (idNoProvedor === "" || idNoProvedor.length > TAMANHO_MAXIMO_DO_ID_EXTERNO) {
    return fail("validation_failed", "Aviso sem o identificador do pagamento.", 400, { requestId });
  }

  const valorAvisado = aviso.data.amount ?? aviso.data.paid_amount;
  const r = await confirmarPagamento(admin, {
    recebimento,
    idNoProvedor,
    valorAvisadoCents: typeof valorAvisado === "number" && Number.isInteger(valorAvisado) ? valorAvisado : null,
    quando: new Date(),
  });
  if (!r.ok) {
    // 500 e o provedor reentrega. Nada foi marcado (ou foi marcado e a
    // reentrega é inofensiva, pelo compare-and-set).
    return fail("internal_error", r.message, r.status, { requestId });
  }
  if (r.efeito === "valor_divergente" || r.efeito === "id_ja_usado") {
    // 200: a reentrega traz o mesmo corpo e daria o mesmo veredito. O log da
    // confirmação diz qual recebimento, para o humano conferir no extrato.
    return ok({ ignorado: r.efeito }, { requestId });
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

/** O evento como o provedor DECLAROU no corpo ("" quando não declarou nenhum). */
function eventoDeclarado(dados: {
  event_type?: string;
  event?: string;
  type?: string;
  status?: string;
}): string {
  return normalizar(dados.event_type ?? dados.event ?? dados.type ?? dados.status ?? "");
}

/**
 * O evento do aviso, com a inferência do link criado pelo PAINEL.
 *
 * MEDIÇÃO (31/10/2026, dois links do painel e dois da API): o link criado pela
 * API manda `event_type` em todo aviso. O link criado pelo PAINEL manda o mesmo
 * `paid`, com o mesmo corpo, mas SEM `event_type` e SEM `invoice_type`. Com a
 * leitura anterior (só o campo declarado) esse aviso caía em `ignorado` e o
 * pagamento nunca era marcado — falha silenciosa, porque o provedor recebia 200.
 *
 * A inferência olha apenas marcadores que SÓ existem no `paid`: o `created` e o
 * `settled` trazem somente `amount`, e o `paid` traz `transaction_nsu` e
 * `receipt_url`. Corpo sem evento declarado E sem esses marcadores continua
 * ignorado: ausência de informação não é prova de pagamento.
 */
function eventoDoAviso(dados: {
  event_type?: string;
  event?: string;
  type?: string;
  status?: string;
  transaction_nsu?: string;
  receipt_url?: string;
}): string {
  const declarado = eventoDeclarado(dados);
  if (declarado !== "") return declarado;
  if (dados.transaction_nsu || dados.receipt_url) return "paid";
  return "";
}
