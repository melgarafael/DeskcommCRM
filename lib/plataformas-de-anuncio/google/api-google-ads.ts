/**
 * Chamadas à API do Google Ads que NÃO são envio de conversão (0436): criar e
 * listar ações de conversão, ler métricas de campanha e os recursos de mensagem
 * do WhatsApp.
 *
 * O envio continua no Data Manager (`data-manager.ts`) ou no upload antigo
 * (`conversions.ts`). O que mora aqui exige duas coisas que o envio não exige:
 * o developer token da INSTALAÇÃO e o escopo `adwords` na autorização da
 * organização. Quando falta uma delas, a resposta diz qual — a tela mostra o
 * que fazer em vez de um erro genérico.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { configuracaoDoGoogleAds } from "./config";
import { renovarToken } from "./token";
import { VERSAO_DA_API_DO_GOOGLE_ADS } from "./versao-da-api";

const BASE = "https://googleads.googleapis.com";
const PRAZO_MS = 15_000;

export type FalhaDaApiGoogle =
  | "sem_developer_token"
  | "sem_conexao"
  | "cifra_indisponivel"
  | "reconectar"
  | "sem_permissao"
  | "recusado"
  | "transitorio";

export type RespostaDaApiGoogle<T> =
  { ok: true; dados: T } | { ok: false; falha: FalhaDaApiGoogle; detalhe: string };

export interface ConexaoGoogleParaApi {
  refreshToken: string;
  customerId: string;
  loginCustomerId: string | null;
}

const soDigitos = (v: string) => v.replace(/\D/g, "");

/** Lê a autorização e a conta da organização. Nunca devolve o token para o browser. */
export async function lerConexaoGoogleParaApi(
  admin: SupabaseClient,
  organizationId: string,
): Promise<RespostaDaApiGoogle<ConexaoGoogleParaApi>> {
  const { data, error } = await admin
    .from("ad_platform_connections")
    .select("google_refresh_token_encrypted, google_customer_id, google_login_customer_id")
    .eq("organization_id", organizationId)
    .eq("platform", "google_ads")
    .maybeSingle();
  if (error) return { ok: false, falha: "transitorio", detalhe: "Leitura da conexão falhou." };
  const linha = data as {
    google_refresh_token_encrypted: string | null;
    google_customer_id: string | null;
    google_login_customer_id: string | null;
  } | null;
  if (!linha?.google_refresh_token_encrypted || !linha.google_customer_id)
    return {
      ok: false,
      falha: "sem_conexao",
      detalhe: "Conecte o Google e informe a conta de anúncios primeiro.",
    };
  const refreshToken = await decryptWebhookSecret(admin, linha.google_refresh_token_encrypted);
  if (!refreshToken)
    return {
      ok: false,
      falha: "cifra_indisponivel",
      detalhe: "A instalação está sem a chave mestra de criptografia.",
    };
  return {
    ok: true,
    dados: {
      refreshToken,
      customerId: soDigitos(linha.google_customer_id),
      loginCustomerId: linha.google_login_customer_id
        ? soDigitos(linha.google_login_customer_id)
        : null,
    },
  };
}

const erroDoGoogle = z.object({
  error: z
    .object({
      code: z.number().optional(),
      status: z.string().optional(),
      message: z.string().optional(),
      details: z.array(z.unknown()).optional(),
    })
    .passthrough(),
});

/** Traduz a recusa do Google no que a pessoa precisa fazer. */
export function classificarRecusa(
  status: number,
  corpo: unknown,
): { falha: FalhaDaApiGoogle; detalhe: string } {
  const lido = erroDoGoogle.safeParse(corpo);
  const mensagem = lido.success ? (lido.data.error.message ?? "") : "";
  const bruto = JSON.stringify(corpo ?? "");
  if (status === 429 || status >= 500)
    return {
      falha: "transitorio",
      detalhe: `Google indisponível agora (HTTP ${status}). Tente de novo.`,
    };
  if (/SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(bruto))
    return {
      falha: "reconectar",
      detalhe:
        "A autorização do Google não inclui o Google Ads. Clique em Reconectar e autorize de novo.",
    };
  if (/DEVELOPER_TOKEN_NOT_APPROVED|DEVELOPER_TOKEN_PROHIBITED/.test(bruto))
    return {
      falha: "sem_developer_token",
      detalhe:
        "O developer token desta instalação ainda não foi aprovado pelo Google para contas reais.",
    };
  if (status === 401 || status === 403 || /USER_PERMISSION_DENIED|CUSTOMER_NOT_ENABLED/.test(bruto))
    return {
      falha: "sem_permissao",
      detalhe:
        "O Google recusou o acesso a esta conta. Confira o Customer ID, a conta de gerente (MCC) e se a conta autorizada tem acesso a ela.",
    };
  return {
    falha: "recusado",
    detalhe: mensagem.slice(0, 300) || `Google recusou (HTTP ${status}).`,
  };
}

async function chamar(
  conexao: ConexaoGoogleParaApi,
  caminho: string,
  corpo: unknown,
): Promise<RespostaDaApiGoogle<unknown>> {
  const app = configuracaoDoGoogleAds("google_ads");
  if (!app)
    return {
      ok: false,
      falha: "sem_developer_token",
      detalhe:
        "Esta instalação não tem GOOGLE_ADS_DEVELOPER_TOKEN. Sem ele, só é possível informar o ID da ação à mão.",
    };
  const token = await renovarToken(app, conexao.refreshToken, { agora: new Date() });
  if (!token.ok)
    return {
      ok: false,
      falha: token.motivo === "resposta_invalida" ? "transitorio" : "reconectar",
      detalhe: "Não foi possível renovar a autorização do Google. Tente de novo ou reconecte.",
    };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token.token.access_token}`,
    "developer-token": app.developerToken,
  };
  if (conexao.loginCustomerId) headers["login-customer-id"] = conexao.loginCustomerId;
  let resposta: Response;
  try {
    resposta = await fetch(
      `${BASE}/${VERSAO_DA_API_DO_GOOGLE_ADS}/customers/${conexao.customerId}/${caminho}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(PRAZO_MS),
        cache: "no-store",
      },
    );
  } catch {
    return { ok: false, falha: "transitorio", detalhe: "Sem resposta do Google. Tente de novo." };
  }
  const json = await resposta.json().catch(() => null);
  if (!resposta.ok) {
    const recusa = classificarRecusa(resposta.status, json);
    logger.warn("[google-ads.api] chamada recusada", {
      caminho: caminho.split(":")[0],
      status: resposta.status,
      falha: recusa.falha,
    });
    return { ok: false, ...recusa };
  }
  return { ok: true, dados: json };
}

// ── Ações de conversão ──────────────────────────────────────────────────────

export interface AcaoDeConversao {
  id: string;
  nome: string;
  categoria: string;
  tipo: string;
  status: string;
  primaria: boolean;
}

const linhaDeAcao = z.object({
  conversionAction: z
    .object({
      id: z.union([z.string(), z.number()]).transform(String),
      name: z.string().default(""),
      category: z.string().default("DEFAULT"),
      type: z.string().default(""),
      status: z.string().default(""),
      primaryForGoal: z.boolean().optional(),
    })
    .passthrough(),
});

/** Só as ações que aceitam importação offline de cliques (`UPLOAD_CLICKS`). */
export async function listarAcoesDeConversao(
  conexao: ConexaoGoogleParaApi,
): Promise<RespostaDaApiGoogle<AcaoDeConversao[]>> {
  const resposta = await chamar(conexao, "googleAds:search", {
    query:
      "SELECT conversion_action.id, conversion_action.name, conversion_action.category, conversion_action.type, conversion_action.status, conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.type = 'UPLOAD_CLICKS' AND conversion_action.status != 'REMOVED' ORDER BY conversion_action.name",
  });
  if (!resposta.ok) return resposta;
  const resultados = z
    .object({ results: z.array(z.unknown()).optional() })
    .safeParse(resposta.dados);
  const acoes = (resultados.success ? (resultados.data.results ?? []) : []).flatMap((r) => {
    const l = linhaDeAcao.safeParse(r);
    if (!l.success) return [];
    const a = l.data.conversionAction;
    return [
      {
        id: a.id,
        nome: a.name,
        categoria: a.category,
        tipo: a.type,
        status: a.status,
        primaria: a.primaryForGoal ?? false,
      },
    ];
  });
  return { ok: true, dados: acoes };
}

/** Sufixo curto contra colisão de nome com ações que já existem na conta. */
export function sufixoDaAcao(aleatorio: () => number = Math.random): string {
  const alfabeto = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += alfabeto[Math.floor(aleatorio() * alfabeto.length)];
  return s;
}

export async function criarAcaoDeConversao(
  conexao: ConexaoGoogleParaApi,
  pedido: { nome: string; categoria: string; incluirEmConversoes: boolean; sufixo?: string },
): Promise<RespostaDaApiGoogle<{ id: string; nome: string }>> {
  const nome = `${pedido.nome.trim().slice(0, 80)} #${pedido.sufixo ?? sufixoDaAcao()}`;
  const resposta = await chamar(conexao, "conversionActions:mutate", {
    operations: [
      {
        create: {
          name: nome,
          type: "UPLOAD_CLICKS",
          category: pedido.categoria,
          status: "ENABLED",
          primaryForGoal: pedido.incluirEmConversoes,
          countingType: "ONE_PER_CLICK",
          valueSettings: { alwaysUseDefaultValue: false, defaultValue: 0 },
        },
      },
    ],
  });
  if (!resposta.ok) return resposta;
  const lida = z
    .object({ results: z.array(z.object({ resourceName: z.string() })).min(1) })
    .safeParse(resposta.dados);
  const id = lida.success
    ? /conversionActions\/(\d+)$/.exec(lida.data.results[0]!.resourceName)?.[1]
    : null;
  if (!id)
    return {
      ok: false,
      falha: "transitorio",
      detalhe: "O Google não devolveu o ID da ação criada.",
    };
  return { ok: true, dados: { id, nome } };
}

// ── Métricas de campanha ────────────────────────────────────────────────────

export interface CampanhaGoogle {
  id: string;
  nome: string;
  status: string;
  moeda?: string;
  fuso?: string;
  impressoes: number;
  cliques: number;
  custo: number;
  conversoes: number;
}

const linhaDeCampanha = z.object({
  customer: z.object({
    currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
    timeZone: z.string().optional(),
  }).optional(),
  campaign: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().default(""),
    status: z.string().default(""),
  }),
  metrics: z
    .object({
      impressions: z.union([z.string(), z.number()]).optional(),
      clicks: z.union([z.string(), z.number()]).optional(),
      costMicros: z.union([z.string(), z.number()]).optional(),
      conversions: z.union([z.string(), z.number()]).optional(),
    })
    .default({}),
});

const numero = (v: string | number | undefined) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Datas em YYYY-MM-DD, no fuso da conta de anúncios (é como o Google agrega). */
export async function lerCampanhas(
  conexao: ConexaoGoogleParaApi,
  periodo: { de: string; ate: string },
): Promise<RespostaDaApiGoogle<CampanhaGoogle[]>> {
  const data = /^\d{4}-\d{2}-\d{2}$/;
  if (!data.test(periodo.de) || !data.test(periodo.ate))
    return { ok: false, falha: "recusado", detalhe: "Período inválido." };
  const resposta = await chamar(conexao, "googleAds:search", {
    query: `SELECT customer.currency_code, customer.time_zone, campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${periodo.de}' AND '${periodo.ate}' AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC LIMIT 200`,
  });
  if (!resposta.ok) return resposta;
  const resultados = z
    .object({ results: z.array(linhaDeCampanha).optional() })
    .safeParse(resposta.dados);
  if (!resultados.success) {
    return { ok: false, falha: "transitorio", detalhe: "O Google devolveu um relatório de campanhas que não pôde ser lido." };
  }
  const campanhas = (resultados.data.results ?? []).map(({ campaign, customer, metrics }) => ({
    id: campaign.id,
    nome: campaign.name,
    status: campaign.status,
    ...(customer?.currencyCode && { moeda: customer.currencyCode }),
    ...(customer?.timeZone && { fuso: customer.timeZone }),
    impressoes: numero(metrics.impressions),
    cliques: numero(metrics.clicks),
    custo: numero(metrics.costMicros) / 1_000_000,
    conversoes: numero(metrics.conversions),
  }));
  return { ok: true, dados: campanhas };
}

// ── Recursos de mensagem (WhatsApp) ─────────────────────────────────────────

export interface RecursoDeMensagem {
  id: string;
  nome: string;
  mensagemInicial: string;
  telefone: string | null;
}

const linhaDeRecurso = z.object({
  asset: z
    .object({
      id: z.union([z.string(), z.number()]).transform(String),
      name: z.string().optional(),
      businessMessageAsset: z
        .object({
          starterMessage: z.string().optional(),
          whatsappInfo: z
            .object({ countryCode: z.string().optional(), phoneNumber: z.string().optional() })
            .optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
});

/**
 * Os recursos de mensagem para WhatsApp da conta (`BUSINESS_MESSAGE`). O Google
 * restringe este recurso por lista de permissão na API: conta fora dela recebe
 * recusa, e a tela explica — o código de origem manual continua funcionando.
 */
export async function listarRecursosDeMensagem(
  conexao: ConexaoGoogleParaApi,
): Promise<RespostaDaApiGoogle<RecursoDeMensagem[]>> {
  const resposta = await chamar(conexao, "googleAds:search", {
    query:
      "SELECT asset.id, asset.name, asset.business_message_asset.starter_message, asset.business_message_asset.whatsapp_info.country_code, asset.business_message_asset.whatsapp_info.phone_number FROM asset WHERE asset.type = 'BUSINESS_MESSAGE'",
  });
  if (!resposta.ok) return resposta;
  const resultados = z
    .object({ results: z.array(z.unknown()).optional() })
    .safeParse(resposta.dados);
  const recursos = (resultados.success ? (resultados.data.results ?? []) : []).flatMap((r) => {
    const l = linhaDeRecurso.safeParse(r);
    const msg = l.success ? l.data.asset.businessMessageAsset?.starterMessage?.trim() : "";
    if (!l.success || !msg) return [];
    const w = l.data.asset.businessMessageAsset?.whatsappInfo;
    return [
      {
        id: l.data.asset.id,
        nome: l.data.asset.name ?? msg.slice(0, 40),
        mensagemInicial: msg,
        telefone: w?.phoneNumber ? `${w.countryCode ?? ""}${w.phoneNumber}` : null,
      },
    ];
  });
  return { ok: true, dados: recursos };
}
