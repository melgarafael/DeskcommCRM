/**
 * Valida o token do Datafy ANTES de gravar a sessão (recorte do #1130, @vgamkt).
 *
 * Duas chamadas, e as duas importam:
 *
 *  1. `GET /me` — descobre `phone_number_id` e `waba_id` a partir do token. É o
 *     que permite a conexão ser SÓ com o token: o operador não caça o id do
 *     número no painel, e não há erro de digitação possível nesse campo.
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
      displayPhoneNumber: string | null;
      verifiedName: string | null;
    }
  | { ok: false; motivo: string };

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function validateGraphPartnerCredentials(input: {
  token: string;
  rootUrl?: string;
}): Promise<ValidacaoGraphPartner> {
  const token = input.token.trim();
  if (!token) return { ok: false, motivo: "Informe o token do Datafy." };

  const root = (input.rootUrl?.trim() || graphPartnerRootUrl()).replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}` };

  let me: Response;
  try {
    me = await fetch(`${root}/me`, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    // Rede caída não é token errado — dizer "token inválido" mandaria o
    // operador trocar um token que estava certo.
    return { ok: false, motivo: "Não foi possível falar com o Datafy. Tente de novo." };
  }

  if (me.status === 401 || me.status === 403) {
    return { ok: false, motivo: "Token recusado pelo Datafy." };
  }
  if (!me.ok) return { ok: false, motivo: `O Datafy respondeu ${me.status}.` };

  const corpo = (await me.json().catch(() => null)) as Record<string, unknown> | null;
  const phoneNumberId = texto(corpo?.phone_number_id);
  const wabaId = texto(corpo?.waba_id);
  if (!phoneNumberId || !wabaId) {
    return { ok: false, motivo: "O token não devolveu o número nem a conta (WABA)." };
  }

  // O número responde? `error` no corpo com HTTP 200 é comportamento real da
  // Graph API, por isso a checagem olha os dois. Falhar aqui não recusa: o
  // `/me` já provou o essencial, e o perfil do número é o que a tela mostra.
  let displayPhoneNumber: string | null = null;
  let verifiedName: string | null = null;
  try {
    const numero = await fetch(
      `${root}/v1/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`,
      { headers, signal: AbortSignal.timeout(15_000) },
    );
    const detalhe = (await numero.json().catch(() => null)) as Record<string, unknown> | null;
    if (numero.ok && !detalhe?.error) {
      displayPhoneNumber = texto(detalhe?.display_phone_number);
      verifiedName = texto(detalhe?.verified_name);
    }
  } catch {
    // Ver acima: o perfil é enfeite da tela, não prova da credencial.
  }

  return { ok: true, phoneNumberId, wabaId, displayPhoneNumber, verifiedName };
}
