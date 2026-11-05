/**
 * POST /api/v1/webhooks/cobranca/[provedor] — o aviso do provedor de pagamento
 * (spec da cobrança do revendedor §7c, §2.4).
 *
 * O aviso só ACORDA a leitura: a rota confere a assinatura no corpo CRU, grava
 * o aviso COMO CHEGOU (`raw_body` = os bytes recebidos, `#3870`) e emite
 * `cobranca.sinal` para a empresa dona do cliente. Quem decide é `sincronizar`,
 * que relê na API. Duplicado `processed` → 200 sem reemitir; linha que ficou
 * `received`/`error` → segue de novo (reemitir é inofensivo: o consumidor relê).
 * Cliente desconhecido → `error` e 200: a reconciliação cura. Falha no emit →
 * 503, e o provedor reentrega — a linha com o corpo cru fica na tabela.
 *
 * O corpo é gravado em TODO caminho que decide algo, inclusive na recusa: era
 * justamente ali que se perguntava "o que chegou?" e a linha respondia `"{}"`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { registrarAviso } from "@/lib/cobranca/aviso-cru";
import { segredoDoWebhook } from "@/lib/cobranca/configuracao";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { adaptador } from "@/lib/cobranca/provedores";
import type { SinalDoWebhook } from "@/lib/cobranca/provedores/contrato";
import { PROVEDORES_DE_COBRANCA } from "@/lib/cobranca/vocabulario";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const LIMITE_DO_CORPO = 1_048_576;
const RECUSAS_POR_MINUTO = 120;
/** Avisos VÁLIDOS do Asaas de cliente que não existe aqui, por IP: o teto do token vazado. */
const DESCONHECIDOS_POR_MINUTO = 120;

type Rota = { params: Promise<{ provedor: string }> };

export async function POST(req: NextRequest, { params }: Rota) {
  const requestId = randomUUID();
  const naoExiste = () => fail("not_found", "Not found", 404, { requestId });
  const { provedor: bruto } = await params;
  const provedor = PROVEDORES_DE_COBRANCA.find((p) => p === bruto);
  if (!provedor) return naoExiste();
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca"))) return naoExiste();
  const segredo = await segredoDoWebhook(provedor);
  if (!segredo) return naoExiste();
  // Só a Stripe ASSINA (o cabeçalho é assinatura, não credencial). O Asaas manda o
  // token estático no `asaas-access-token` — a credencial inteira, que nunca é
  // gravada (spec §2.4). Ler `stripe-signature` de um aviso do Asaas gravaria o
  // que quem chamou quisesse.
  const assinatura = provedor === "stripe" ? req.headers.get("stripe-signature") : null;

  if (Number(req.headers.get("content-length") ?? "0") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }
  const corpo = await req.text();
  if (Buffer.byteLength(corpo, "utf8") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }

  /**
   * O único ponto que grava o aviso. `sinal === null` = a origem não se
   * autenticou: o corpo vai inteiro, mas cabeçalho e assinatura não, porque ali
   * eles são texto livre de quem chamou (e o token do Asaas mora num deles).
   */
  const gravar = (sinal: SinalDoWebhook | null, status: "received" | "error", erro: string | null = null) =>
    registrarAviso(admin, {
      provedor,
      corpo,
      valida: sinal !== null,
      headers: req.headers,
      assinatura: sinal === null ? null : assinatura,
      externalId: sinal?.eventoId ?? null,
      eventType: sinal?.tipo ?? null,
      status,
      erro,
    });

  const sinal = adaptador(provedor).verificarWebhook(corpo, req.headers, segredo, new Date());
  if (!sinal) {
    // Só RECUSAS contam no limite: aviso válido nunca leva 429, porque é ele que
    // reativa quem pagou. O balde é o IP (forjar só troca de balde); sem proxy à
    // frente, um balde único — só recusas o dividem, então não bloqueia ninguém.
    // ponytail: as leituras do módulo e do segredo acontecem antes do limite
    // (sub-ms); um cache do segredo resolve se a inundação pesar.
    const balde = ipDoCliente(req.headers) ?? "sem-proxy";
    const taxa = await checkRateLimit(`cobranca-webhook-recusado:${balde}`, RECUSAS_POR_MINUTO, 60);
    if (!taxa.allowed) {
      return fail("rate_limited", "Muitos avisos recusados seguidos.", 429, { requestId, headers: { "Retry-After": "60" } });
    }
    logger.warn("cobranca.webhook_recusado", { provedor, motivo: "assinatura_invalida" });
    // Recusa de segurança deixa rastro que o dono VÊ: a Visão geral conta estas
    // linhas (Task 38). Um segredo trocado à mão faria todo aviso voltar 401 em
    // silêncio, e a Stripe desativaria o endpoint em 3 dias. O corpo vai COMO
    // CHEGOU — é o único caso em que "o que chegou?" não tem outra fonte —, mas
    // sem cabeçalhos nem assinatura, que aqui são texto livre de quem não se
    // autenticou; a retenção de 90 dias poda.
    const recusa = await gravar(null, "error", motivoDaRecusa(corpo));
    if (recusa === "erro") logger.error("cobranca.recusa_nao_gravada", { provedor });
    return fail("unauthorized", "Assinatura inválida.", 401, { requestId });
  }

  const agora = new Date().toISOString();
  // A leitura da empresa não decide nada sobre o aviso: ela só diz para quem
  // emitir. Se ela estourar, o corpo cru tem de estar gravado mesmo assim —
  // senão o 500 leva o aviso embora sem deixar rastro.
  let dona: { organization_id: string } | null = null;
  try {
    const consulta = sinal.clienteRef
      ? await admin
          .from("cobranca_assinaturas")
          .select("organization_id")
          .eq("provedor", provedor)
          .eq("provedor_cliente_id", sinal.clienteRef)
          .maybeSingle()
      : { data: null, error: null };
    if (consulta.error) {
      await gravar(sinal, "error", "falha_ao_identificar_empresa");
      return fail("internal_error", "Não foi possível identificar a empresa.", 500, { requestId });
    }
    dona = consulta.data as { organization_id: string } | null;
  } catch (erro) {
    await gravar(sinal, "error", "falha_ao_identificar_empresa");
    throw erro;
  }
  const org = dona?.organization_id ?? null;
  if (!org && provedor === "asaas") {
    // O token do Asaas é estático: vazado, ele assina avisos de clientes que não
    // existem, e cada um viraria uma linha nova. Acima do balde, 200 SEM gravar:
    // 429 faria o Asaas interromper a fila, e com ela os avisos verdadeiros; o
    // que for de verdade, a reconciliação cura. Cliente conhecido nunca entra aqui.
    // Chave GLOBAL por provedor, não por IP: o IP é o primeiro salto do
    // x-forwarded-for, que quem tem o token controla — um IP por aviso daria um
    // balde novo a cada um. O custo: o atacante pode empurrar para fora outros
    // avisos de cliente DESCONHECIDO, e esses a reconciliação cura.
    const taxa = await checkRateLimit(`cobranca-webhook-desconhecido:${provedor}`, DESCONHECIDOS_POR_MINUTO, 60);
    if (!taxa.allowed) return ok({ ignorado: "limite_de_desconhecidos" }, { requestId });
  }

  const linha = await gravar(sinal, "received");
  if (linha === "erro") {
    logger.error("cobranca.aviso_nao_gravado", { provedor });
    return fail("internal_error", "Não foi possível registrar o aviso.", 500, { requestId });
  }
  if (linha.status === "processed") return ok({ duplicado: true }, { requestId });
  if (!org) {
    await admin
      .from("webhook_events_log")
      .update({ status: "error", error_message: "cliente_desconhecido", processed_at: agora })
      .eq("id", linha.id)
      .is("organization_id", null);
    return ok({ ignorado: "cliente_desconhecido" }, { requestId });
  }

  const { error: erroDoSinal } = await admin.rpc("emit_event", {
    p_event_type: "cobranca.sinal",
    p_entity_kind: "organization",
    p_entity_id: org,
    p_payload: { provedor, evento_id: sinal.eventoId, tipo: sinal.tipo },
    p_metadata: { origem: "webhook_cobranca" },
    p_organization_id: org,
  });
  if (erroDoSinal) {
    logger.error("cobranca.sinal_nao_emitido", { organization_id: org, provedor, codigo: erroDoSinal.code ?? null });
    return fail("unavailable", "Tente de novo em instantes.", 503, { requestId });
  }
  await admin
    .from("webhook_events_log")
    .update({ status: "processed", processed_at: agora })
    .eq("id", linha.id)
    .is("organization_id", null);
  return ok({ recebido: true }, { requestId });
}

/**
 * O motivo da recusa que a linha pode afirmar SEM mentir: o corpo vazio, o
 * corpo que não é JSON — e, com JSON na mão, a assinatura (que é o que o
 * adaptador conferiu para dizer não).
 *
 * Um corpo que não é JSON nunca vira 500 mudo: a Stripe não manda isso, então a
 * recusa é a leitura segura, com o corpo cru na tabela para quem for investigar.
 */
function motivoDaRecusa(corpo: string): string {
  if (corpo.trim() === "") return "corpo_vazio";
  try {
    JSON.parse(corpo);
  } catch {
    return "corpo_malformado";
  }
  return "assinatura_invalida";
}
