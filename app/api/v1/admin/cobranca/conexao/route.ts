/**
 * POST /api/v1/admin/cobranca/conexao — a ÚNICA escritora do provedor e das
 * credenciais da cobrança (spec da cobrança do revendedor §7a, §10).
 *
 * Ordem, e o porquê de cada passo vir antes do seguinte:
 *   1. portões (escrita de platform admin, chave ligada, corpo);
 *   2. endereço https público — sem ele o provedor não entrega aviso;
 *   3. a cifra do servidor — o webhook novo apaga o antigo, então o segredo
 *      novo PRECISA caber no banco antes de o provedor ser tocado;
 *   4. a guarda das assinaturas pagas (D-8): nem outro provedor, nem chave de
 *      teste no lugar da de produção, nem chave de OUTRA conta do mesmo
 *      provedor (um cliente que já paga tem de existir na conta da chave nova);
 *   5. testar a chave DIGITADA (nada é gravado antes de o provedor aceitá-la);
 *   6. publicação (teste → produção) só confirmada: quem assinou em teste
 *      volta ao teste grátis (D-7);
 *   7. criar o aviso de pagamento novo (no Asaas sem a API de avisos: devolver
 *      URL, token e eventos UMA vez, para o dono cadastrar à mão), gravar cifrado e SÓ ENTÃO apagar os
 *      antigos (gravação que falha desfaz o novo); converter; na publicação,
 *      apagar o aviso do modo de teste com a chave velha; auditar só os 4
 *      últimos e avisar todo dono com acesso total.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { chaveDoProvedor, provedorDaInstalacao, segredoDoWebhook } from "@/lib/cobranca/configuracao";
import { avisarTrocaDeChave } from "@/lib/cobranca/emails";
import { adaptador, modoDoProvedor } from "@/lib/cobranca/provedores";
import { baseDeTesteDaCobranca } from "@/lib/cobranca/provedores/base-de-teste";
import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";
import { aplicarRegua } from "@/lib/cobranca/sincronizar";
import { urlDoWebhookDaCobranca } from "@/lib/cobranca/url";
import { PROVEDORES_DE_COBRANCA, type ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { encryptKey } from "@/lib/crypto/aes_gcm";
import { env } from "@/lib/env";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { estadoParaTela, gravarPelaTela, voltarAoAmbiente } from "@/lib/instalacao/config";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z.strictObject({
  provedor: z.enum(PROVEDORES_DE_COBRANCA),
  chave: z.string().trim().min(10).max(300),
  confirmar_publicacao: z.boolean().optional(),
});

/** Onde mora a credencial de cada provedor (cifrada; a tela vê só os 4 últimos). */
const CREDENCIAIS: Record<ProvedorDeCobranca, { chave: string; segredo: string }> = {
  stripe: { chave: "STRIPE_SECRET_KEY", segredo: "STRIPE_WEBHOOK_SECRET" },
  asaas: { chave: "ASAAS_API_KEY", segredo: "ASAAS_WEBHOOK_TOKEN" },
};

type MotivoDaRecusa = "chave_invalida" | "sem_permissao" | "provedor_fora" | "modo_divergente";
const MOTIVO_DA_RECUSA: Record<ProvedorDeCobranca, Record<MotivoDaRecusa, string>> = {
  stripe: {
    chave_invalida: "O provedor não aceitou esta chave. Confira se copiou a chave secreta inteira.",
    sem_permissao:
      "Esta chave não tem permissão para cobrar. Use a chave secreta, ou uma restrita com acesso a clientes, assinaturas, faturas, checkout, portal e avisos (webhooks).",
    provedor_fora: "O provedor de pagamento não respondeu. Tente de novo em alguns minutos.",
    modo_divergente: "Com o endereço de teste ligado, só vale a chave de teste (sk_test_ ou rk_test_).",
  },
  asaas: {
    chave_invalida: "O Asaas não aceitou esta chave. Confira se copiou a chave de API inteira (começa com $aact_).",
    sem_permissao: "Esta chave do Asaas não tem permissão para cobrar. Gere uma chave nova no Asaas, em Integrações › Chaves de API.",
    provedor_fora: "O Asaas não respondeu. Tente de novo em alguns minutos.",
    modo_divergente: "Com o endereço de teste ligado, só vale a chave do sandbox do Asaas ($aact_hmlg_).",
  },
};

const DIA_MS = 86_400_000;

export async function POST(req: NextRequest) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  let ctx: PlatformAdminContext;
  try {
    ctx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca"))) return fail("not_found", "Not found", 404, { requestId });

  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", "Informe o provedor e a chave secreta.", 400, { requestId, details: corpo.error.flatten() });
  }
  const { provedor, chave, confirmar_publicacao } = corpo.data;
  const nomes = CREDENCIAIS[provedor];
  // Chave antiga do Asaas, ainda válida, mas sem a marca do ambiente: não dá para
  // saber se é sandbox ou produção. "Confira se copiou inteira" seria mentira para
  // quem copiou certo; a frase diz o que fazer.
  if (provedor === "asaas" && /^\$aact_(?!prod_|hmlg_)/.test(chave)) {
    return fail(
      "chave_recusada",
      "Esta chave do Asaas é do formato antigo, sem a marca de teste ou produção. Gere uma chave nova no Asaas, em Integrações › Chaves de API, e cole aqui.",
      422,
      { requestId, details: { motivo: "chave_formato_antigo" } },
    );
  }

  const url = urlDoWebhookDaCobranca(env.NEXT_PUBLIC_APP_URL ?? "", provedor, baseDeTesteDaCobranca() !== null);
  if (!url) {
    return fail("url_publica_invalida", "Seu sistema precisa estar num endereço https público para receber avisos de pagamento.", 422, { requestId });
  }
  try {
    encryptKey("sonda-da-cifra");
  } catch {
    return fail(
      "unavailable",
      "Configure a chave de cifra do servidor (AI_CRED_AES_KEY) antes de conectar: sem ela a chave de cobrança não pode ser guardada.",
      503,
      { requestId },
    );
  }

  const lidas = await contarAssinaturasComProvedor(admin);
  if (lidas === "erro") return fail("internal_error", "Não foi possível conferir as assinaturas.", 500, { requestId });
  const { contagem, umCliente } = lidas;
  const atual = await provedorDaInstalacao();
  const pagasNoAtual = atual === null ? 0 : (contagem.get(`${atual}:producao`) ?? 0);
  if (atual !== null && atual !== provedor && pagasNoAtual > 0) {
    return fail(
      "provedor_com_assinaturas",
      "Há empresas pagando de verdade pelo provedor atual. Trocar de provedor deixaria essas assinaturas sem leitura.",
      409,
      { requestId, details: { assinaturas_de_producao: pagasNoAtual } },
    );
  }

  const ad = adaptador(provedor, { chave: async () => chave });
  let teste: Awaited<ReturnType<typeof ad.testarChave>>;
  try {
    teste = await ad.testarChave();
  } catch (e) {
    return falhaDoProvedor(e, requestId);
  }
  if (!teste.ok) return fail("chave_recusada", MOTIVO_DA_RECUSA[provedor][teste.motivo], 422, { requestId, details: { motivo: teste.motivo } });
  const pagas = contagem.get(`${provedor}:producao`) ?? 0;
  if (teste.modo === "teste" && pagas > 0) {
    return fail(
      "provedor_com_assinaturas",
      "Há empresas pagando de verdade com a chave de produção. Uma chave de teste deixaria essas assinaturas sem leitura.",
      409,
      { requestId, details: { assinaturas_de_producao: pagas } },
    );
  }
  // Chave de OUTRA conta do mesmo provedor, no mesmo modo de quem já assinou:
  // a leitura de todas essas empresas pararia (ninguém suspenso, ninguém
  // reativado), e o aviso da conta antiga passaria a levar 401. Um cliente
  // que já paga tem de existir na conta da chave nova.
  const mesmoModo = contagem.get(`${provedor}:${teste.modo}`) ?? 0;
  const clienteConhecido = umCliente.get(`${provedor}:${teste.modo}`);
  if (mesmoModo > 0 && clienteConhecido !== undefined) {
    let existe: boolean;
    try {
      existe = await ad.clienteExiste(clienteConhecido);
    } catch (e) {
      return falhaDoProvedor(e, requestId);
    }
    if (!existe) {
      void audit({
        actorUserId: ctx.user.id, actingAsPlatformAdmin: true, bypassedRls: true, resourceType: "platform_config", requestId,
        action: "cobranca.provedor_conectado",
        metadata: { provedor, modo: teste.modo, resultado: "recusada_outra_conta", last4_novo: chave.slice(-4) },
      });
      return fail(
        "chave_de_outra_conta",
        `Esta chave é de outra conta. As ${mesmoModo} empresas que já assinaram estão na conta atual e ficariam sem leitura. Use a chave da mesma conta.`,
        409,
        { requestId, details: { assinaturas: mesmoModo } },
      );
    }
  }
  const deTeste = contagem.get(`${provedor}:teste`) ?? 0;
  if (teste.modo === "producao" && deTeste > 0 && confirmar_publicacao !== true) {
    return fail(
      "publicacao_requer_confirmacao",
      "Empresas que assinaram em modo de teste voltam para o teste grátis quando você publicar.",
      409,
      { requestId, details: { assinaturas_de_teste: deTeste } },
    );
  }

  let preparo: Awaited<ReturnType<typeof ad.prepararWebhook>>;
  try {
    preparo = await ad.prepararWebhook(url, ctx.user.email ?? "");
  } catch (e) {
    return falhaDoProvedor(e, requestId);
  }
  // Asaas sem a API de avisos: o token já foi sorteado pelo adaptador; o dono o
  // cadastra à mão com a URL e os eventos que a resposta devolve UMA vez. Não há
  // endpoint nosso no provedor para confirmar nem desfazer.
  const { segredo: segredoNovo, automatico, webhook } =
    "segredo" in preparo
      ? { segredo: preparo.segredo, automatico: preparo, webhook: "automatico" as const }
      : { segredo: preparo.manual.segredo, automatico: null, webhook: { manual: preparo.manual } };

  const last4Antigo = (await estadoParaTela(nomes.chave, true)).last4;
  // Lidos ANTES de gravar: na publicação, a chave de teste velha apaga o aviso do modo de teste.
  const modoAnterior = await modoDoProvedor(provedor);
  const chaveVelha = await chaveDoProvedor(provedor);
  const chaveAnterior = modoAnterior === "teste" && teste.modo === "producao" ? chaveVelha : null;
  // Lidos ANTES de gravar: se uma gravação falhar, as já feitas voltam ao que eram.
  const gravacoes = [
    [nomes.chave, chave, true, chaveVelha],
    [nomes.segredo, segredoNovo, true, await segredoDoWebhook(provedor)],
    ["COBRANCA_PROVEDOR", provedor, false, atual],
  ] as const;
  const gravadas: Array<(typeof gravacoes)[number]> = [];
  for (const g of gravacoes) {
    const [nome, valor, ehSegredo] = g;
    const gravado = await gravarPelaTela(nome, valor, { ehSegredo, ator: ctx.user.id });
    if (!gravado.ok) {
      logger.error("cobranca.conexao_nao_gravada", { chave: nome, motivo: gravado.motivo });
      // Chave nova com segredo velho leria os avisos da conta errada: desfaz o que já entrou.
      let restaurada = true;
      for (const [n, , segredo, antes] of gravadas) {
        const volta = antes === null ? await voltarAoAmbiente(n) : await gravarPelaTela(n, antes, { ehSegredo: segredo, ator: ctx.user.id });
        if (!volta.ok) {
          restaurada = false;
          logger.error("cobranca.conexao_nao_restaurada", { chave: n, motivo: volta.motivo });
        }
      }
      // Se a volta falhou, a credencial MUDOU sem passar pelo caminho feliz: auditar e avisar os donos (o "Se não foi você" do §7a).
      if (!restaurada) {
        void audit({ actorUserId: ctx.user.id, actingAsPlatformAdmin: true, bypassedRls: true, resourceType: "platform_config", requestId,
          action: "cobranca.provedor_conectado",
          metadata: { provedor, modo: teste.modo, resultado: "gravacao_incompleta", last4_antigo: last4Antigo, last4_novo: chave.slice(-4) } });
        await avisarTrocaDeChave(admin, { antigo: last4Antigo, novo: chave.slice(-4) });
      }
      // Com tudo restaurado, o antigo, com o segredo que voltou ao banco, segue valendo: some só o novo.
      await automatico?.desfazer().catch((e: unknown) =>
        logger.warn("cobranca.webhook_novo_nao_desfeito", { codigo: e instanceof ErroDoProvedor ? e.codigo : "desconhecido" }),
      );
      return fail(
        "internal_error",
        restaurada
          ? "A chave foi aceita pelo provedor, mas não foi possível guardá-la. Nada mudou; conecte de novo."
          : "A chave foi aceita pelo provedor, mas foi guardada só em parte e a anterior não pôde ser restaurada. Conecte de novo agora.",
        500,
        { requestId },
      );
    }
    gravadas.push(g);
  }
  // ponytail: se apagar os antigos falhar, eles ficam (recusados com 401 e
  // contados na Visão geral) até a próxima conexão, que os apaga.
  if (automatico) {
    await automatico.confirmar().catch((e: unknown) =>
      logger.warn("cobranca.webhook_antigo_nao_apagado", { codigo: e instanceof ErroDoProvedor ? e.codigo : "desconhecido" }),
    );
  } else {
    // Manual: o aviso desta URL que já existia no Asaas (automático de antes, ou
    // cadastrado à mão) leva o token VELHO e passaria a levar 401 em laço até o
    // Asaas parar a fila. Tenta apagá-lo, DEPOIS de o token novo estar gravado;
    // a conta que não deixa criar talvez não deixe apagar, e isso não muda o 200:
    // a tela manda editar o aviso que existir.
    await ad.removerWebhooks(url).catch((e: unknown) =>
      logger.warn("cobranca.webhook_manual_antigo_nao_apagado", { codigo: e instanceof ErroDoProvedor ? e.codigo : "desconhecido" }),
    );
  }
  if (chaveAnterior !== null) {
    await adaptador(provedor, { chave: async () => chaveAnterior })
      .removerWebhooks(url)
      .catch((e: unknown) =>
        logger.warn("cobranca.webhook_de_teste_nao_apagado", { codigo: e instanceof ErroDoProvedor ? e.codigo : "desconhecido" }),
      );
  }

  // A credencial já mudou: auditar e avisar os donos AQUI, antes de publicar, que pode falhar.
  const quem = { actorUserId: ctx.user.id, actingAsPlatformAdmin: true, bypassedRls: true, resourceType: "platform_config", requestId };
  void audit({
    ...quem,
    action: "cobranca.provedor_conectado",
    metadata: { provedor, modo: teste.modo, last4_antigo: last4Antigo, last4_novo: chave.slice(-4), webhook: automatico ? "automatico" : "manual" },
  });
  await avisarTrocaDeChave(admin, { antigo: last4Antigo, novo: chave.slice(-4) });

  const publicacao = { convertidas: 0 };
  if (teste.modo === "producao" && deTeste > 0) {
    try {
      await publicar(admin, provedor, publicacao);
    } catch (e) {
      logger.error("cobranca.publicacao_incompleta", { erro: e instanceof Error ? e.message : "desconhecido" });
      // As já convertidas mudaram de verdade: o 500 também fica auditado, com quantas foram.
      void audit({ ...quem, action: "cobranca.modo_publicado", metadata: { provedor, convertidas: publicacao.convertidas, resultado: "publicacao_incompleta" } });
      return fail("internal_error", "A chave foi conectada, mas nem todas as empresas de teste voltaram ao teste grátis. Conecte de novo para terminar.", 500, { requestId });
    }
  }

  const publicadas = publicacao.convertidas;
  if (publicadas > 0) void audit({ ...quem, action: "cobranca.modo_publicado", metadata: { provedor, convertidas: publicadas } });
  // No ramo manual o corpo leva o token do aviso em claro, mostrado UMA vez: nada de cache.
  return ok({ modo: teste.modo, webhook, publicadas }, { requestId, headers: { "cache-control": "no-store, max-age=0" } });
}

function falhaDoProvedor(e: unknown, requestId: string) {
  // O adaptador pode lançar ZodError/TypeError (resposta fora do formato, URL ruim): nunca 500 cru.
  if (!(e instanceof ErroDoProvedor)) {
    logger.error("cobranca.provedor_resposta_inesperada", { erro: e instanceof Error ? e.name : "desconhecido" });
    return fail("provedor_recusou", "O provedor de pagamento respondeu algo inesperado. Confira a chave e tente de novo.", 502, { requestId });
  }
  if (e.codigo === "resource_missing" || e.codigo === "idempotency_error") {
    return fail("provedor_recusou", "O provedor não encontrou o recurso pedido ou recusou a repetição do pedido. Confira se a chave é da conta certa e tente de novo.", 502, { requestId });
  }
  return e.transitorio
    ? fail("provedor_indisponivel", "O provedor de pagamento não respondeu. Nada foi gravado; tente de novo.", 503, { requestId })
    : fail("provedor_recusou", "O provedor de pagamento recusou o pedido. Confira a conta e as permissões da chave.", 502, { requestId });
}

/**
 * `${provedor}:${modo}` → quantas linhas, e um cliente de cada (a sonda da
 * chave de outra conta). As com provedor são as que alguém ainda pode estar pagando.
 */
async function contarAssinaturasComProvedor(
  admin: SupabaseClient,
): Promise<{ contagem: Map<string, number>; umCliente: Map<string, string> } | "erro"> {
  const { data, error } = await admin
    .from("cobranca_assinaturas")
    .select("provedor, modo, provedor_cliente_id")
    .not("provedor", "is", null);
  if (error) return "erro";
  const contagem = new Map<string, number>();
  const umCliente = new Map<string, string>();
  for (const l of (data ?? []) as Array<{ provedor: string; modo: string | null; provedor_cliente_id: string | null }>) {
    const k = `${l.provedor}:${l.modo}`;
    contagem.set(k, (contagem.get(k) ?? 0) + 1);
    if (l.provedor_cliente_id && !umCliente.has(k)) umCliente.set(k, l.provedor_cliente_id);
  }
  return { contagem, umCliente };
}

/**
 * D-7: quem assinou em teste volta ao teste grátis com os dias do plano; a régua reativa quem estava suspensa.
 * Conta em `feito` a cada conversão, para que uma falha no meio ainda diga quantas mudaram.
 */
async function publicar(admin: SupabaseClient, provedor: ProvedorDeCobranca, feito: { convertidas: number }): Promise<void> {
  const { data, error } = await admin
    .from("cobranca_assinaturas")
    .select("organization_id, plano_id")
    .eq("provedor", provedor)
    .eq("modo", "teste");
  if (error) throw new Error(`assinaturas de teste ilegíveis (${error.code ?? "sem_codigo"})`);
  const linhas = (data ?? []) as Array<{ organization_id: string; plano_id: string }>;
  if (linhas.length === 0) return;
  const { data: planos, error: erroDosPlanos } = await admin
    .from("cobranca_planos")
    .select("id, trial_dias")
    .in("id", [...new Set(linhas.map((l) => l.plano_id))]);
  if (erroDosPlanos) throw new Error(`planos ilegíveis (${erroDosPlanos.code ?? "sem_codigo"})`);
  const dias = new Map(((planos ?? []) as Array<{ id: string; trial_dias: number }>).map((p) => [p.id, p.trial_dias]));
  for (const l of linhas) {
    const agora = new Date();
    const { data: feita, error: erroDaConversao } = await admin
      .from("cobranca_assinaturas")
      .update({
        estado: "trial",
        trial_ate: new Date(agora.getTime() + (dias.get(l.plano_id) ?? 0) * DIA_MS).toISOString(),
        provedor: null, modo: null, provedor_cliente_id: null, provedor_assinatura_id: null,
        checkout_url: null, checkout_expira_em: null, vencida_desde: null, proximo_vencimento: null,
        ultimo_aviso: null, ultimo_aviso_em: null, link_de_pagamento: null, relida_em: null,
        assinaturas_vivas: 0, cancela_no_fim: false, ultimo_erro: null, ultimo_erro_em: null,
        updated_at: agora.toISOString(),
      })
      .eq("organization_id", l.organization_id)
      .eq("modo", "teste")
      .select("organization_id")
      .maybeSingle();
    if (erroDaConversao) throw new Error(`conversão falhou (${erroDaConversao.code ?? "sem_codigo"})`);
    if (!feita) continue;
    feito.convertidas += 1;
    await aplicarRegua(admin, l.organization_id);
  }
}
