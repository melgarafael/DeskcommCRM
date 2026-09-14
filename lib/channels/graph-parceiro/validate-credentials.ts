/**
 * Valida o token do Datafy ANTES de gravar a sessão.
 *
 * Duas chamadas, e as duas importam:
 *
 *  1. `GET /me` — descobre `phone_number_id`, `waba_id` e `business_id` a partir
 *     do token. É o que permite a conexão ser SÓ com o token (decisão do dono):
 *     o operador não precisa caçar o id do número no painel.
 *  2. `GET /v1/{phone_number_id}` — confirma que o número responde e traz
 *     `display_phone_number`/`verified_name`, para a tela mostrar QUAL número foi
 *     conectado em vez de um "conectado" anônimo.
 *
 * Gravar primeiro e descobrir depois é o que faz o operador achar que conectou e
 * só entender que não na primeira mensagem que não sai.
 */
import { graphPartnerRootUrl } from "./credentials";

export type ValidacaoGraphPartner =
  | {
      ok: true;
      phoneNumberId: string;
      wabaId: string;
      businessId: string | null;
      displayPhoneNumber: string | null;
      verifiedName: string | null;
      qualityRating: string | null;
    }
  | { ok: false; motivo: string };

export async function validateGraphPartnerCredentials(input: {
  token: string;
  rootUrl?: string;
}): Promise<ValidacaoGraphPartner> {
  const token = input.token.trim();
  if (!token) return { ok: false, motivo: "Informe o token do Datafy." };

  const root = (input.rootUrl?.trim() || graphPartnerRootUrl()).replace(/\/+$/, "");

  let me: Response;
  try {
    me = await fetch(`${root}/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Rede caída não é token errado — dizer "token inválido" mandaria o
    // operador trocar um token que estava certo.
    return { ok: false, motivo: "Não foi possível falar com o Datafy. Tente de novo." };
  }

  if (me.status === 401 || me.status === 403) {
    return { ok: false, motivo: "Token recusado pelo Datafy." };
  }
  if (!me.ok) return { ok: false, motivo: `Datafy respondeu ${me.status}.` };

  const corpo = (await me.json().catch(() => null)) as {
    phone_number_id?: unknown;
    waba_id?: unknown;
    business_id?: unknown;
    error?: { message?: string };
  } | null;

  const phoneNumberId = typeof corpo?.phone_number_id === "string" ? corpo.phone_number_id : null;
  const wabaId = typeof corpo?.waba_id === "string" ? corpo.waba_id : null;
  if (!phoneNumberId || !wabaId) {
    return { ok: false, motivo: "O token não devolveu o número nem a conta (WABA)." };
  }

  // O número responde? `error` no corpo com HTTP 200 é comportamento real da
  // Graph API, por isso a checagem olha os dois.
  let displayPhoneNumber: string | null = null;
  let verifiedName: string | null = null;
  let qualityRating: string | null = null;
  try {
    const numero = await fetch(
      `${root}/v1/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
    );
    const detalhe = (await numero.json().catch(() => null)) as {
      display_phone_number?: unknown;
      verified_name?: unknown;
      quality_rating?: unknown;
      error?: unknown;
    } | null;
    if (numero.ok && !detalhe?.error) {
      displayPhoneNumber =
        typeof detalhe?.display_phone_number === "string" ? detalhe.display_phone_number : null;
      verifiedName = typeof detalhe?.verified_name === "string" ? detalhe.verified_name : null;
      qualityRating = typeof detalhe?.quality_rating === "string" ? detalhe.quality_rating : null;
    }
  } catch {
    // O `/me` já provou o essencial; o perfil do número é enfeite da tela.
  }

  return {
    ok: true,
    phoneNumberId,
    wabaId,
    businessId: typeof corpo?.business_id === "string" ? corpo.business_id : null,
    displayPhoneNumber,
    verifiedName,
    qualityRating,
  };
}
