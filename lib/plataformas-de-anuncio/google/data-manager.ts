/** Data Manager: aceite da requisição e conclusão assíncrona são estados distintos. */
import { z } from "zod";
import type { ConversaoOffline, CredencialDeConversao, ResultadoDeEnvio } from "../types";
import { configuracaoDoGoogleAds } from "./config";
import { renovarToken } from "./token";

const BASE = "https://datamanager.googleapis.com/v1";
const texto = z.string().min(1);
const recebimento = z.object({ requestId: texto });
const diagnostico = z.object({
  requestStatusPerDestination: z.array(
    z.object({
      requestStatus: z.string(),
      destination: z.object({
        operatingAccount: z.object({ accountId: texto }),
        productDestinationId: texto,
      }),
      errorInfo: z
        .object({ errorCounts: z.array(z.object({ reason: z.string() })).optional() })
        .optional(),
      warningInfo: z.object({ warningCounts: z.array(z.unknown()).optional() }).optional(),
    }),
  ),
});

export function montarEvento(credencial: CredencialDeConversao, conversao: ConversaoOffline) {
  const google = credencial.google!;
  const conta = (id: string) => ({ accountType: "GOOGLE_ADS", accountId: id.replace(/\D/g, "") });
  return {
    destinations: [
      {
        operatingAccount: conta(google.customerId),
        ...(google.loginCustomerId ? { loginAccount: conta(google.loginCustomerId) } : {}),
        productDestinationId: google.conversionActionId,
      },
    ],
    events: [
      {
        transactionId: conversao.eventoId,
        eventTimestamp: conversao.ocorridoEm.toISOString(),
        eventSource: "MESSAGE",
        adIdentifiers: conversao.identificadoresGoogle ?? { gclid: conversao.cliqueDeOrigem },
        ...(conversao.valorCentavos !== null
          ? {
              conversionValue: conversao.valorCentavos / 100,
              currency: conversao.moeda.toUpperCase(),
            }
          : {}),
      },
    ],
    // Não inventa consentimento nem envia dados pessoais para preencher ausência de clique.
  };
}

function erroHttp(status: number): ResultadoDeEnvio {
  if (status === 429 || status >= 500)
    return {
      tipo: "transitorio",
      detalhe: `Google temporariamente indisponível (HTTP ${status}).`,
    };
  return {
    tipo: "permanente",
    detalhe: `Google recusou a operação (HTTP ${status}). Confira a Data Manager API no projeto Google Cloud, a autorização e a conta/ação de conversão.`,
  };
}

async function chamar(
  credencial: CredencialDeConversao,
  caminho: string,
  corpo?: unknown,
): Promise<{ ok: true; corpo: unknown } | { ok: false; resultado: ResultadoDeEnvio }> {
  const app = configuracaoDoGoogleAds("data_manager");
  if (!app || !credencial.google)
    return {
      ok: false,
      resultado: {
        tipo: "permanente",
        detalhe: "Configure o aplicativo OAuth do Google nesta instalação.",
      },
    };
  const token = await renovarToken(app, credencial.google.refreshToken, { agora: new Date() });
  if (!token.ok)
    return {
      ok: false,
      resultado: {
        tipo: token.motivo === "resposta_invalida" ? "transitorio" : "permanente",
        detalhe:
          "Não foi possível renovar a autorização do Google. Tente novamente ou reconecte a conta.",
      },
    };
  try {
    const resposta = await fetch(`${BASE}/${caminho}`, {
      method: corpo ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token.token.access_token}`,
        "content-type": "application/json",
      },
      ...(corpo ? { body: JSON.stringify(corpo) } : {}),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!resposta.ok) return { ok: false, resultado: erroHttp(resposta.status) };
    return { ok: true, corpo: await resposta.json() };
  } catch {
    return {
      ok: false,
      resultado: {
        tipo: "transitorio",
        detalhe:
          "Sem resposta legível do Google. Nova tentativa será feita com o mesmo identificador da venda.",
      },
    };
  }
}

export async function enviarDataManager(
  credencial: CredencialDeConversao,
  conversao: ConversaoOffline,
): Promise<ResultadoDeEnvio> {
  const resposta = await chamar(credencial, "events:ingest", montarEvento(credencial, conversao));
  if (!resposta.ok) return resposta.resultado;
  const lida = recebimento.safeParse(resposta.corpo);
  if (!lida.success)
    return {
      tipo: "transitorio",
      detalhe: "Google não devolveu o protocolo. O envio ainda não foi confirmado.",
    };
  return {
    tipo: "processando",
    protocolo: lida.data.requestId,
    detalhe: "Google recebeu a requisição e ainda está processando a conversão.",
  };
}

export async function consultarDataManager(
  credencial: CredencialDeConversao,
  protocolo: string,
): Promise<ResultadoDeEnvio> {
  const resposta = await chamar(
    credencial,
    `requestStatus:retrieve?${new URLSearchParams({ requestId: protocolo })}`,
  );
  if (!resposta.ok) return resposta.resultado;
  const lida = diagnostico.safeParse(resposta.corpo);
  if (!lida.success || lida.data.requestStatusPerDestination.length !== 1) {
    return {
      tipo: "transitorio",
      detalhe: "Google ainda não devolveu um diagnóstico reconhecido para esta conversão.",
    };
  }
  const status = lida.data.requestStatusPerDestination[0]!;
  if (
    status.destination.operatingAccount.accountId !==
      credencial.google?.customerId.replace(/\D/g, "") ||
    status.destination.productDestinationId !== credencial.google.conversionActionId
  ) {
    return {
      tipo: "permanente",
      detalhe:
        "A conexão mudou de conta ou ação desde o envio. Restaure o destino original para consultar o protocolo; a venda não foi reenviada.",
    };
  }
  if (status.requestStatus === "SUCCESS") {
    const avisos = status.warningInfo?.warningCounts?.length ?? 0;
    return {
      tipo: "ok",
      detalhe: `Processamento concluído pelo Google${avisos ? " com avisos; consulte os diagnósticos da conta" : ""}. A atribuição deve ser conferida no gerenciador de anúncios.`,
    };
  }
  if (status.requestStatus === "FAILED" || status.requestStatus === "PARTIAL_SUCCESS") {
    // Só códigos enumerados, sem mensagem remota que possa repetir dados do cliente.
    const codigos = status.errorInfo?.errorCounts
      ?.map((e) => e.reason)
      .filter((c) => /^[A-Z_]+$/.test(c))
      .join(", ")
      .slice(0, 300);
    return {
      tipo: "permanente",
      rejeicaoConfirmada: true,
      detalhe: `Google concluiu o processamento com rejeição: ${codigos || status.requestStatus}. Consulte os diagnósticos da conta.`,
    };
  }
  return {
    tipo: "processando",
    protocolo,
    detalhe: "Aguardando conclusão do processamento pelo Google.",
  };
}
