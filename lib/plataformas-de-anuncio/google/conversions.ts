/**
 * O transporte de conversões do Google Ads.
 *
 * Irmão declarado de `../meta/conversions.ts`: mesmo contrato
 * (`TransporteDeConversao`), mesma disciplina de não vazar o nome do endpoint
 * para fora deste arquivo. O que muda é a identidade e o ciclo de vida do
 * token.
 *
 * ─── A diferença que mais custaria esquecer: o access token não é gravado ──
 *
 * A Meta guarda um token que dura meses; o Google Ads expira em ~1h. Por isso
 * `credenciais.ts` devolve um REFRESH token (`credencial.google.refreshToken`),
 * e é ESTE arquivo — não `credenciais.ts`, que é agnóstico — quem troca ele
 * por um access token, a cada envio, chamando `renovarToken`. Cachear o
 * access token entre envios pouparia uma chamada de rede, mas introduziria um
 * relógio para errar; o transporte hoje envia no máximo algumas vezes por
 * minuto (uma venda por vez), então o custo de sempre renovar é desprezível
 * perto do risco de um cache que expira no meio de um envio.
 *
 * Upload legado exige partialFailure=true e inspeção do resultado por item.
 * Conexões novas podem usar Data Manager, com protocolo consultado pelo worker.
 *
 * ─── O que este arquivo NÃO valida: a idade do evento ───────────────────────
 *
 * A Meta documenta um teto de 7 dias, medido e escrito em código. O Google
 * Ads também recusa evento velho demais, mas a janela exata varia por tipo de
 * conversão e já mudou de valor no passado — sem uma medição própria contra a
 * API de verdade, fixar um número aqui seria inventar uma certeza que não
 * temos. Este transporte deixa o PRÓPRIO Google recusar (`permanente`, com o
 * `message` dele) em vez de adivinhar um teto e escondê-lo do operador atrás
 * de um `sem_atribuicao` que não existe.
 */
import { z } from "zod";
import { identificadorParaUpload } from "./identificadores";
import { enviarDataManager, consultarDataManager } from "./data-manager";
import { logger } from "@/lib/logger";
import { configuracaoDoGoogleAds } from "./config";
import { renovarToken } from "./token";
import { VERSAO_DA_API_DO_GOOGLE_ADS } from "./versao-da-api";
import type {
  ConversaoOffline,
  CredencialDeConversao,
  ResultadoDeEnvio,
  TransporteDeConversao,
} from "../types";

const ENDERECO_BASE = "https://googleads.googleapis.com";

const TEMPO_LIMITE_MS = 10_000;

/** Só dígitos — a tela pode receber com hífen (é como o Google Ads exibe), a API não aceita. */
function soDigitos(v: string): string {
  return v.replace(/\D/g, "");
}

/**
 * `yyyy-MM-dd HH:mm:ss+00:00` — o formato exato que a API exige, em UTC.
 * `Date` já guarda o instante absoluto; só falta escrever no formato certo.
 */
function formatarDataDeConversao(quando: Date): string {
  const p = (n: number, tam = 2) => String(n).padStart(tam, "0");
  return (
    `${quando.getUTCFullYear()}-${p(quando.getUTCMonth() + 1)}-${p(quando.getUTCDate())} ` +
    `${p(quando.getUTCHours())}:${p(quando.getUTCMinutes())}:${p(quando.getUTCSeconds())}+00:00`
  );
}

interface ErroDoGoogle {
  code?: number;
  status?: string;
  message?: string;
}

function lerErro(bruto: unknown): ErroDoGoogle {
  if (typeof bruto !== "object" || bruto === null) return {};
  const r = bruto as Record<string, unknown>;
  const erro = r.error;
  if (typeof erro !== "object" || erro === null) return {};
  const e = erro as Record<string, unknown>;
  return {
    code: typeof e.code === "number" ? e.code : undefined,
    status: typeof e.status === "string" ? e.status : undefined,
    message: typeof e.message === "string" ? e.message : undefined,
  };
}

/**
 * O corpo do erro, lido como o Google o manda — ou um motivo que alguém
 * consegue ler quando ele NÃO vem em JSON.
 *
 * Quando a versão da API foi desativada (ou o endereço está errado), o Google
 * responde 404 com uma página HTML inteira. Copiar esse HTML para `detalhe`
 * punha 400 caracteres de marcação na tela de Conversões, e a pista que
 * importava — "a versão pode ter saído do ar" — não aparecia em lugar nenhum.
 */
function lerCorpoDeErro(status: number, texto: string): ErroDoGoogle {
  try {
    return lerErro(JSON.parse(texto));
  } catch {
    const pista =
      status === 404
        ? ` — endereço não encontrado; a versão ${VERSAO_DA_API_DO_GOOGLE_ADS} da API pode ter sido desativada pelo Google`
        : "";
    return { message: `o Google respondeu HTTP ${status} sem o formato de erro esperado${pista}` };
  }
}

/**
 * `RESOURCE_EXHAUSTED` (cota) e `UNAVAILABLE` (instabilidade do lado do
 * Google) se resolvem sozinhos — o mesmo raciocínio do 613 da Meta. O resto —
 * token revogado, ação de conversão errada, gclid velho demais — precisa de
 * alguém mexendo na configuração.
 */
function classificaErro(status: number, corpo: ErroDoGoogle): ResultadoDeEnvio {
  if (status >= 500) {
    return { tipo: "transitorio", detalhe: `${status}: ${corpo.message ?? "erro do servidor"}` };
  }
  if (corpo.status === "RESOURCE_EXHAUSTED" || corpo.status === "UNAVAILABLE" || status === 429) {
    return { tipo: "transitorio", detalhe: `${corpo.status ?? status}: ${corpo.message ?? ""}` };
  }
  return { tipo: "permanente", detalhe: corpo.message ?? `HTTP ${status} sem corpo legível` };
}

const respostaUpload = z.object({
  partialFailureError: z
    .object({
      code: z.number().optional(),
      details: z
        .array(
          z
            .object({
              errors: z.array(z.object({ errorCode: z.record(z.string(), z.string()) })).optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .optional(),
  results: z.array(z.object({ conversionAction: z.string().min(1).optional() })).optional(),
});

export function lerResultadoDoUpload(bruto: unknown): ResultadoDeEnvio {
  const lida = respostaUpload.safeParse(bruto);
  if (!lida.success)
    return {
      tipo: "transitorio",
      detalhe: "Google devolveu uma resposta inválida; envio não confirmado.",
    };
  const erro = lida.data.partialFailureError;
  if (erro && (erro.code || erro.details?.length)) {
    const codigos =
      erro.details?.flatMap((d) => d.errors ?? []).flatMap((e) => Object.values(e.errorCode)) ?? [];
    const transitorio = codigos.some((c) =>
      [
        "INTERNAL_ERROR",
        "RESOURCE_EXHAUSTED",
        "RESOURCE_TEMPORARILY_EXHAUSTED",
        "UNAVAILABLE",
      ].includes(c),
    );
    const motivo = codigos
      .filter((c) => /^[A-Z_]+$/.test(c))
      .join(", ")
      .slice(0, 300);
    return {
      tipo: transitorio ? "transitorio" : "permanente",
      detalhe: `Google rejeitou a conversão: ${motivo || "consulte os diagnósticos da conta"}.`,
    };
  }
  if (lida.data.results?.length !== 1 || !lida.data.results[0]?.conversionAction)
    return { tipo: "transitorio", detalhe: "Google não confirmou o resultado da conversão." };
  return { tipo: "ok" };
}

async function enviar(
  credencial: CredencialDeConversao,
  conversao: ConversaoOffline,
): Promise<ResultadoDeEnvio> {
  if (credencial.google?.api === "data_manager") return enviarDataManager(credencial, conversao);
  const google = credencial.google;
  if (!google) {
    // Inalcançável em uso normal: `credenciais.ts` só monta este campo para
    // `google_ads`, e o registry só chama este transporte para essa
    // plataforma. Fica como defeito de programação, não como caso de negócio.
    return { tipo: "permanente", detalhe: "credencial sem dados do Google Ads" };
  }

  const app = configuracaoDoGoogleAds();
  if (!app) {
    return {
      tipo: "permanente",
      detalhe: "instalação sem GOOGLE_ADS_OAUTH_CLIENT_ID/SECRET ou GOOGLE_ADS_DEVELOPER_TOKEN",
    };
  }

  const renovacao = await renovarToken(app, google.refreshToken, { agora: new Date() });
  if (!renovacao.ok) {
    // `invalid_grant` é o refresh token revogado — a organização precisa
    // reconectar pela tela. Qualquer outro motivo de troca de token também
    // não se resolve tentando de novo sem intervenção.
    return { tipo: "permanente", detalhe: `renovação de token falhou: ${renovacao.detalhe}` };
  }

  const customerId = soDigitos(google.customerId);
  const corpo = {
    conversions: [
      {
        ...identificadorParaUpload(
          conversao.identificadoresGoogle ?? { gclid: conversao.cliqueDeOrigem },
        ),
        conversionAction: `customers/${customerId}/conversionActions/${google.conversionActionId}`,
        conversionDateTime: formatarDataDeConversao(conversao.ocorridoEm),
        ...(conversao.valorCentavos !== null
          ? {
              conversionValue: conversao.valorCentavos / 100,
              currencyCode: conversao.moeda.toUpperCase(),
            }
          : {}),
        // Dedup do lado do Google — mesmo papel do `event_id` da Meta.
        orderId: conversao.eventoId,
      },
    ],
    partialFailure: true,
  };

  const url = `${ENDERECO_BASE}/${VERSAO_DA_API_DO_GOOGLE_ADS}/customers/${customerId}:uploadClickConversions`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${renovacao.token.access_token}`,
    "developer-token": app.developerToken,
  };
  if (google.loginCustomerId) headers["login-customer-id"] = soDigitos(google.loginCustomerId);

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch (erro) {
    return {
      tipo: "transitorio",
      detalhe: erro instanceof Error ? erro.message : "falha de rede",
    };
  }

  if (resposta.ok) {
    return lerResultadoDoUpload(await resposta.json().catch(() => null));
  }

  const texto = await resposta.text().catch(() => "");
  const corpoErro = lerCorpoDeErro(resposta.status, texto);

  logger.warn("[conversoes.google] envio recusado", {
    status: resposta.status,
    googleStatus: corpoErro.status,
    leadId: conversao.leadId,
  });

  return classificaErro(resposta.status, corpoErro);
}

export const transporteGoogle: TransporteDeConversao = {
  plataforma: "google_ads",
  enviar,
  consultar: consultarDataManager,
};

/** Exportados para o teste vigiar as regras sem falar com a rede. */
export const INTERNOS = {
  formatarDataDeConversao,
  classificaErro,
  lerCorpoDeErro,
  soDigitos,
} as const;
