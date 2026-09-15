/**
 * O webhook do NÚMERO, registrado no app da Meta (issue #850, fatia F1).
 *
 * Mora aqui pela mesma razão que `validate-credentials.ts`: a catraca
 * (`scripts/lint-channels.ts`) proíbe chamada à Graph API fora de `lib/channels/`,
 * e a rota não deve saber com quem fala. A rota pede "registre o webhook deste
 * número"; quem sabe como é este módulo.
 *
 * ─── Por que POR NÚMERO, e não por WABA ─────────────────────────────────────
 * A prioridade da Meta é: override do número → override da WABA → URL do app.
 * O canal no CRM é o NÚMERO (`channel_sessions.meta_phone_number_id` é a chave da
 * conexão), e duas organizações da mesma instalação podem ter números da MESMA
 * WABA — override por WABA mandaria a entrega de uma para a URL da outra.
 *
 * ─── Por que isto é consequência, e não pré-requisito, da conexão ───────────
 * A conexão já funcionava sem este passo (o operador colava a URL à mão no painel
 * da Meta). Aqui o CRM passa a fazer sozinho o que dependia de cópia manual: o
 * produto é self-host para quem NÃO programa. Se o registro falhar, a conexão
 * CONTINUA — o desfecho volta para a tela com o motivo e um botão de tentar de
 * novo, porque desfazer um canal que já envia mensagem por causa do webhook seria
 * trocar um problema por dois.
 *
 * ─── O que NÃO cabe aqui, de propósito ──────────────────────────────────────
 * `message_template_status_update` NÃO aceita override na Meta — ele continua indo
 * para a URL do app. É limite da plataforma, não escolha deste módulo (issue #850).
 */
import { graphVersion } from "@/lib/graph-version";

/** Qual das duas chamadas da Meta falhou. A tela mostra isto junto do motivo. */
export type EtapaDoWebhook = "inscricao_na_waba" | "configuracao_do_numero";

export type DesfechoDoWebhook =
  | { ok: true; url: string | null }
  | { ok: false; etapa: EtapaDoWebhook; motivo: string };

interface RespostaDaGraph {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * O motivo que o operador lê. A Meta devolve o detalhe útil em
 * `error_data.details` (a mensagem genérica costuma ser "Invalid parameter"): sem
 * ele a tela diz "não deu", que não é diagnóstico.
 */
function motivoDoErro(res: RespostaDaGraph): string {
  const b = res.body as { error?: { message?: string; error_data?: { details?: string } } } | null;
  return (
    b?.error?.error_data?.details ??
    b?.error?.message ??
    (res.status === 0 ? "rede indisponível" : `http_${res.status}`)
  );
}

async function postNaGraph(url: string, token: string, corpo: unknown): Promise<RespostaDaGraph> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(corpo),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    // Rede caída não é credencial ruim: o motivo precisa dizer isso, senão o
    // operador troca um token que estava certo (mesma lição de `validate-credentials`).
    return {
      ok: false,
      status: 0,
      body: { error: { message: `rede indisponível: ${err instanceof Error ? err.message : "erro"}` } },
    };
  }
}

/** A URL que ESTA instalação publica para o webhook desta sessão de canal. */
export function urlDeCallbackDaSessao(base: string, webhookPathToken: string): string {
  return `${base.replace(/\/+$/, "")}/api/v1/webhooks/meta/${webhookPathToken}`;
}

/**
 * Inscreve o app na WABA e aponta o webhook DESTE número para `callbackUrl`.
 *
 * As duas chamadas são sequenciais e a primeira é pré-requisito da segunda: sem a
 * inscrição na WABA a Meta não entrega nada, e o override sozinho daria a impressão
 * de canal pronto. O desfecho diz qual etapa falhou.
 */
export async function registrarWebhookDoNumero(input: {
  phoneNumberId: string;
  wabaId: string;
  token: string;
  callbackUrl: string;
  verifyToken: string;
}): Promise<DesfechoDoWebhook> {
  const versao = graphVersion();

  const inscricao = await postNaGraph(
    `https://graph.facebook.com/${versao}/${input.wabaId}/subscribed_apps`,
    input.token,
    {},
  );
  if (!inscricao.ok) {
    return { ok: false, etapa: "inscricao_na_waba", motivo: motivoDoErro(inscricao) };
  }

  const configuracao = await postNaGraph(
    `https://graph.facebook.com/${versao}/${input.phoneNumberId}`,
    input.token,
    {
      webhook_configuration: {
        override_callback_uri: input.callbackUrl,
        verify_token: input.verifyToken,
      },
    },
  );
  if (!configuracao.ok) {
    return { ok: false, etapa: "configuracao_do_numero", motivo: motivoDoErro(configuracao) };
  }

  return { ok: true, url: input.callbackUrl };
}

/**
 * Devolve o número à URL do app (override vazio).
 *
 * Usado quando o canal é arquivado — a exclusão rotaciona o `webhook_path_token`, e
 * sem isto a Meta seguiria entregando numa URL morta (404 para sempre, sem erro do
 * nosso lado).
 */
export async function desfazerWebhookDoNumero(input: {
  phoneNumberId: string;
  token: string;
}): Promise<DesfechoDoWebhook> {
  const resposta = await postNaGraph(
    `https://graph.facebook.com/${graphVersion()}/${input.phoneNumberId}`,
    input.token,
    { webhook_configuration: { override_callback_uri: "" } },
  );
  if (!resposta.ok) {
    return { ok: false, etapa: "configuracao_do_numero", motivo: motivoDoErro(resposta) };
  }
  return { ok: true, url: null };
}
