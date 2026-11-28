/**
 * Valida o access token do chat de vendedor da OLX ANTES de gravar (issue #2927).
 *
 * ─── A validação É o registro do webhook ────────────────────────────────────
 *
 * A issue documenta UM aperto de mão com a conta do vendedor, e ele faz as duas
 * coisas de uma vez: `POST {api}/autoservice/v1/chat` com `{"webhook": "<url>"}`,
 * Authorization Bearer, que registra a entrega das mensagens na nossa rota e,
 * ao mesmo tempo, só responde 2xx para quem tem um access token válido (scope
 * `chat`). Não há, nesta documentação, um `/me` nem um `check_token` — então
 * inventar uma sonda seria exatamente o que a fatia 1 se recusou a fazer
 * ("não inventa endpoint").
 *
 * Gravar primeiro e descobrir depois é o que faz o operador achar que
 * conectou e só entender que não na primeira mensagem que não sai — por isso
 * esta chamada vem ANTES de qualquer escrita.
 *
 * ─── O que NÃO é fechado aqui ───────────────────────────────────────────────
 *
 * 1. A forma da RESPOSTA de sucesso não é documentada (a própria issue registra
 *    que a página de leads diverge da página de chat). O que se lê aqui é o
 *    status HTTP; corpo é ignorado de propósito.
 * 2. O exchange do OAuth (`client_id`/`client_secret` → access token) também não
 *    é documentado em fonte pública: quem conecta cola o ACCESS TOKEN que já
 *    obteve, e este módulo só prova que ele serve.
 */
import { chatDeVendedorApiBase } from "./credentials";

export type ValidacaoChatDeVendedor =
  | { ok: true; webhookRegistrado: true }
  | { ok: false; motivo: string };

/** Endpoint de registro do webhook, na forma que a issue #2927 documenta. */
export function urlDoRegistroDeWebhook(apiBase?: string): string {
  return `${chatDeVendedorApiBase(apiBase)}/autoservice/v1/chat`;
}

/** `Authorization: Bearer <access token>` — concatenação, nunca texto mágico. */
function cabecalhoDeAutorizacao(access: string): string {
  return "Bearer " + access;
}

export async function validarCredencialChatDeVendedor(input: {
  token: string;
  webhookUrl: string;
  apiBase?: string;
}): Promise<ValidacaoChatDeVendedor> {
  const token = input.token.trim();
  if (!token) return { ok: false, motivo: "Informe o access token da OLX." };
  if (!/^https:\/\//.test(input.webhookUrl)) {
    return { ok: false, motivo: "A URL de webhook precisa ser HTTPS." };
  }

  let r: Response;
  try {
    r = await fetch(urlDoRegistroDeWebhook(input.apiBase), {
      method: "POST",
      headers: { Authorization: cabecalhoDeAutorizacao(token), "Content-Type": "application/json" },
      body: JSON.stringify({ webhook: input.webhookUrl }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Rede caída não é token errado — dizer "token inválido" mandaria o
    // operador trocar um token que estava certo.
    return { ok: false, motivo: "Não foi possível falar com a OLX. Tente de novo." };
  }

  if (r.status === 401 || r.status === 403) {
    return { ok: false, motivo: "Token recusado pela OLX." };
  }
  if (!r.ok) return { ok: false, motivo: `A OLX respondeu ${r.status}.` };

  return { ok: true, webhookRegistrado: true };
}
