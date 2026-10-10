/**
 * POST /api/v1/cobranca/assinatura/checkout — o botão "Assinar" (spec da
 * cobrança do revendedor §7b). Três fases, e nenhuma chamada ao provedor
 * dentro de transação:
 *   1. reserva curta (compare-and-set em `checkout_expira_em`): link ainda
 *      válido é devolvido de novo; outro clique em curso → 409;
 *   2. fora de transação: assinatura já viva no provedor → 409 com o link;
 *      senão cliente (nome legal e e-mail de quem clicou; o documento não é
 *      guardado) e checkout hospedado, com o teste grátis que ainda resta;
 *   3. grava provedor, modo, cliente e link. Falha na fase 2 libera a reserva.
 * O retry do mesmo clique cai na fase 1 e recebe o MESMO link: a idempotência
 * é do estado, e a `Idempotency-Key` segue ao provedor como chave dele.
 * Empresa suspensa também assina (o hub leva aqui). A org vem da sessão.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { provedorDaInstalacao } from "@/lib/cobranca/configuracao";
import { documentoDoPagador, exigeDocumento } from "@/lib/cobranca/documento";
import { limiteDoProvedorPorOrg, recusaDoProvedor } from "@/lib/cobranca/falhas";
import { adaptador, modoDoProvedor } from "@/lib/cobranca/provedores";
import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";
import { urlDoHub, urlDoPainelDaEmpresa } from "@/lib/cobranca/url";
import type { EstadoDaAssinatura, Intervalo, ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const RESERVA_MS = 2 * 60_000;
const VALIDADE_PADRAO_MS = 24 * 3_600_000;
const corpoSchema = z.strictObject({
  /** Só um destino nomeado (nunca uma URL livre: sem redirecionamento aberto). */
  volta: z.enum(["hub"]).optional(),
  /** CPF ou CNPJ de quem paga, com ou sem máscara. Vai direto ao provedor e NÃO é guardado (spec §2.3, LGPD). */
  documento: z.string().max(32).optional(),
});

interface Lida {
  plano_id: string;
  estado: EstadoDaAssinatura;
  trial_ate: string | null;
  provedor: ProvedorDeCobranca | null;
  provedor_cliente_id: string | null;
  checkout_url: string | null;
  checkout_expira_em: string | null;
}

export async function POST(req: NextRequest) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "cobranca_assinaturas", permiteOrgSuspensa: true });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca"))) return fail("not_found", "Not found", 404, { requestId });
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }
  const orgId = authz.org.orgId;
  const recusar = (status: number, code: string, message: string, details?: unknown) =>
    fail(code, message, status, { requestId, ...(details === undefined ? {} : { details }) });
  const corpo = corpoSchema.safeParse(await req.json().catch(() => ({})));
  if (!corpo.success) return recusar(400, "validation_failed", "Pedido inválido.", corpo.error.flatten());
  const urlDeVolta = corpo.data.volta === "hub" ? urlDoHub() : urlDoPainelDaEmpresa();
  const documento = corpo.data.documento === undefined ? null : documentoDoPagador(corpo.data.documento);
  if (corpo.data.documento !== undefined && documento === null) {
    return recusar(422, "documento_invalido", "Confira o CPF ou CNPJ: os dígitos não batem.");
  }

  const { data, error } = await admin
    .from("cobranca_assinaturas")
    .select("plano_id, estado, trial_ate, provedor, provedor_cliente_id, checkout_url, checkout_expira_em")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return recusar(500, "internal_error", "Não foi possível ler a assinatura.");
  const lida = data as Lida | null;
  if (!lida) return recusar(404, "not_found", "Sua empresa não tem plano de cobrança.");

  const agora = new Date();
  const expira = lida.checkout_expira_em === null ? null : Date.parse(lida.checkout_expira_em);
  if (lida.checkout_url && expira !== null && expira > agora.getTime()) return ok({ url: lida.checkout_url }, { requestId });
  if (!lida.checkout_url && expira !== null && expira > agora.getTime()) {
    return recusar(409, "checkout_em_preparo", "Já estamos gerando o seu link de pagamento. Aguarde alguns segundos.");
  }
  const provedor = lida.provedor ?? (await provedorDaInstalacao());
  if (!provedor) return recusar(409, "provedor_nao_conectado", "O administrador do sistema ainda não conectou a cobrança.");
  if (exigeDocumento(provedor, lida.provedor_cliente_id !== null) && documento === null) {
    return recusar(422, "documento_obrigatorio", "Informe o CPF ou CNPJ de quem paga: o provedor de pagamento exige para emitir a cobrança.");
  }
  if (!(await limiteDoProvedorPorOrg(orgId))) {
    return fail("rate_limited", "Muitas tentativas seguidas. Aguarde um minuto e tente de novo.", 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }

  // Fase 1: a reserva. Quem chegar junto perde o compare-and-set. O ISO dela é a
  // "posse": liberar e gravar o link filtram por ele, para uma requisição lenta
  // não soltar nem sobrescrever a reserva de outra.
  const reserva = new Date(agora.getTime() + RESERVA_MS).toISOString();
  const { data: reservada, error: erroDaReserva } = await admin
    .from("cobranca_assinaturas")
    .update({ checkout_url: null, checkout_expira_em: reserva })
    .eq("organization_id", orgId)
    .or(`checkout_expira_em.is.null,checkout_expira_em.lt."${agora.toISOString()}"`)
    .select("organization_id")
    .maybeSingle();
  if (erroDaReserva) return recusar(500, "internal_error", "Não foi possível reservar o pagamento.");
  if (!reservada) return recusar(409, "checkout_em_preparo", "Já estamos gerando o seu link de pagamento. Aguarde alguns segundos.");

  try {
    const url = await gerarCheckout(admin, orgId, lida, provedor, {
      reserva,
      email: authz.user.email,
      documento,
      chaveIdempotencia: chave ?? randomUUID(),
      actorUserId: authz.user.id,
      requestId,
      urlDeVolta,
    });
    if ("vivo" in url) {
      await liberarReserva(admin, orgId, reserva);
      if (url.vivo === null) {
        // Assinatura viva sem fatura pagável agora (ex.: pausada): nunca uma frase que promete um link.
        return recusar(
          409,
          "sem_link_de_pagamento",
          "Não há cobrança aberta para pagar agora. Atualize o cartão em Gerenciar pagamento: a próxima tentativa sai sozinha.",
        );
      }
      return recusar(409, "pagamento_em_andamento", "Você já tem um pagamento em andamento. Use o link para concluir.", { link_de_pagamento: url.vivo });
    }
    return ok({ url: url.url }, { requestId });
  } catch (e) {
    await liberarReserva(admin, orgId, reserva);
    if (!(e instanceof ErroDoProvedor)) {
      // Defeito nosso (banco, adaptador, link não gravado): envelope e X-Request-Id, e só o nome/código no log.
      logger.error("cobranca: checkout falhou fora do provedor", {
        requestId,
        organizationId: orgId,
        erro: e instanceof Error ? e.name : "desconhecido",
        // As nossas ("cobranca: …") só levam o código do PostgREST: separam reserva perdida de incidente de banco.
        motivo: e instanceof Error && e.message.startsWith("cobranca:") ? e.message : null,
        codigo: (e as { code?: unknown } | null)?.code ?? null,
      });
      return recusar(500, "internal_error", "Não foi possível gerar o link de pagamento. Tente de novo em instantes.");
    }
    if (e.codigo === "invalid_cpfCnpj") {
      // Dígitos certos e o Asaas recusou (o CNPJ alfanumérico, por exemplo): é o
      // documento, e quem clicou consegue resolver. Nunca o 502 "fale com quem administra".
      return recusar(422, "documento_recusado", "O provedor de pagamento não aceitou este CPF ou CNPJ. Confira o número ou informe outro documento.");
    }
    const r = recusaDoProvedor(e);
    return recusar(r.status, r.code, r.message);
  }
}

/** Não lança: a reserva que não sai expira sozinha em RESERVA_MS, mas fica no log (o próximo clique vê `checkout_em_preparo`). */
async function liberarReserva(admin: SupabaseClient, orgId: string, reserva: string): Promise<void> {
  try {
    const { error } = await admin
      .from("cobranca_assinaturas")
      .update({ checkout_expira_em: null })
      .eq("organization_id", orgId)
      .eq("checkout_expira_em", reserva)
      .is("checkout_url", null);
    if (error) logger.error("cobranca: reserva do checkout não liberada", { organizationId: orgId, codigo: error.code });
  } catch (e) {
    logger.error("cobranca: reserva do checkout não liberada", { organizationId: orgId, erro: e instanceof Error ? e.name : "desconhecido" });
  }
}

/** Fases 2 e 3. Lança `ErroDoProvedor` (quem chama libera a reserva) ou erro de banco. */
async function gerarCheckout(
  admin: SupabaseClient,
  orgId: string,
  lida: Lida,
  provedor: ProvedorDeCobranca,
  quem: { reserva: string; email: string; documento: string | null; chaveIdempotencia: string; actorUserId: string; requestId: string; urlDeVolta: string },
): Promise<{ url: string } | { vivo: string | null }> {
  const ad = adaptador(provedor);
  if (lida.provedor_cliente_id) {
    const situacao = await ad.lerSituacao({ clienteRef: lida.provedor_cliente_id });
    if (situacao.assinaturasVivas > 0) return { vivo: situacao.linkDePagamento };
  }
  const [org, plano] = await Promise.all([
    admin.from("organizations").select("legal_name, display_name").eq("id", orgId).maybeSingle(),
    admin.from("cobranca_planos").select("id, nome, preco_cents, intervalo").eq("id", lida.plano_id).maybeSingle(),
  ]);
  if (org.error || plano.error || !plano.data) throw new Error("cobranca: empresa ou plano ilegível no checkout");
  const nomes = org.data as { legal_name: string | null; display_name: string } | null;
  const p = plano.data as { id: string; nome: string; preco_cents: number; intervalo: Intervalo };
  const clienteRef =
    lida.provedor_cliente_id ??
    (await ad.garantirCliente({ id: orgId, nome: nomes?.legal_name || nomes?.display_name || orgId, email: quem.email, documento: quem.documento }));
  if (provedor === "asaas" && lida.provedor_cliente_id === null) {
    // O Asaas manda o SUBSCRIPTION_CREATED DURANTE o POST /subscriptions: sem o
    // cliente gravado antes, o aviso não acha a empresa (cliente_desconhecido) e a
    // Visão geral acusa um problema que não existe. A Stripe só cria a assinatura
    // depois do pagamento, e nela a fase 3 basta. Mesmo compare-and-set da reserva.
    const { data: comCliente, error: erroDoCliente } = await admin
      .from("cobranca_assinaturas")
      .update({ provedor, modo: await modoDoProvedor(provedor), provedor_cliente_id: clienteRef, updated_at: new Date().toISOString() })
      .eq("organization_id", orgId)
      .eq("checkout_expira_em", quem.reserva)
      .is("checkout_url", null)
      .select("organization_id")
      .maybeSingle();
    if (erroDoCliente || !comCliente) throw new Error(`cobranca: cliente do Asaas não gravado (${erroDoCliente?.code ?? "reserva_perdida"})`);
  }
  const inicio = await ad.iniciarAssinatura({
    clienteRef,
    orgId,
    plano: { id: p.id, nome: p.nome, precoCents: p.preco_cents, intervalo: p.intervalo },
    trialAte: lida.estado === "trial" && lida.trial_ate ? new Date(lida.trial_ate) : null,
    urlDeVolta: quem.urlDeVolta,
    chaveIdempotencia: quem.chaveIdempotencia,
  });
  const modo = await modoDoProvedor(provedor);
  const { data: gravada, error } = await admin
    .from("cobranca_assinaturas")
    .update({
      provedor,
      modo,
      provedor_cliente_id: clienteRef,
      // O Asaas cria a assinatura no Assinar (ACTIVE, à espera do 1º pagamento): sem a
      // referência, a troca de plano no teste grátis não chegaria a ele (troca.ts).
      // A Stripe devolve null, e a escrita dela fica como era.
      ...(inicio.assinaturaRef ? { provedor_assinatura_id: inicio.assinaturaRef } : {}),
      checkout_url: inicio.url,
      checkout_expira_em: (inicio.expiraEm ?? new Date(Date.now() + VALIDADE_PADRAO_MS)).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", orgId)
    .eq("checkout_expira_em", quem.reserva)
    .is("checkout_url", null)
    // O link vale só para o plano com que foi gerado.
    .eq("plano_id", lida.plano_id)
    .select("organization_id")
    .maybeSingle();
  if (error || !gravada) throw new Error(`cobranca: link de pagamento não gravado (${error?.code ?? "reserva_perdida"})`);
  void audit({
    action: "cobranca.checkout_iniciado",
    actorUserId: quem.actorUserId,
    organizationId: orgId,
    resourceType: "cobranca_assinatura",
    resourceId: orgId,
    requestId: quem.requestId,
    metadata: { provedor, modo, plano_id: p.id },
  });
  return { url: inicio.url };
}
