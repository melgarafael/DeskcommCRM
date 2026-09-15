/**
 * Valida uma credencial do canal oficial ANTES de gravá-la.
 *
 * Mora aqui por duas razões que se somam: a catraca (`scripts/lint-channels.ts`)
 * proíbe nome de provider fora de `lib/channels/` — ela me pegou com a chamada à
 * Graph API dentro da rota — e a rota não deve saber com quem fala. Ela pergunta
 * "essa credencial presta?"; quem sabe como responder é o canal.
 *
 * Gravar primeiro e descobrir depois é o que faz o operador achar que conectou e só
 * entender que não na primeira mensagem que não sai, com o lead esperando do outro
 * lado. Esta é a mesma chamada que provou o ambiente na Fase 3b.
 */
import { graphVersion } from "@/lib/graph-version";

export type ValidacaoCredencial =
  | { ok: true; displayPhoneNumber: string | null; verifiedName: string | null; qualityRating: string | null }
  | { ok: false; motivo: string };

export async function validateMetaCredentials(input: {
  phoneNumberId: string;
  token: string;
  /**
   * Quando informado, a validação também pergunta se o número PERTENCE a esta WABA
   * (issue #850, fatia F1). Opcional para não quebrar quem só quer saber se a
   * credencial responde.
   */
  wabaId?: string;
  graphVersion?: string;
}): Promise<ValidacaoCredencial> {
  const version = input.graphVersion ?? graphVersion();
  try {
    const res = await fetch(
      `https://graph.facebook.com/${version}/${input.phoneNumberId}` +
        `?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { Authorization: `Bearer ${input.token}` } },
    );
    const body = (await res.json().catch(() => ({}))) as {
      display_phone_number?: string;
      verified_name?: string;
      quality_rating?: string;
      error?: { message?: string; error_data?: { details?: string } };
    };

    if (!res.ok || body.error) {
      return {
        ok: false,
        // O `details` é o que distingue token vencido de número errado de permissão
        // faltando. Sem ele o operador só sabe que "não deu".
        motivo: body.error?.error_data?.details ?? body.error?.message ?? `http_${res.status}`,
      };
    }

    // ─── O número pertence à WABA informada? ────────────────────────────────
    // A checagem acima só pergunta se o NÚMERO responde à credencial. Conectar com
    // o par trocado (número de uma conta e id de outra) grava uma sessão que ENVIA
    // mas cujo webhook nunca chega: a Meta entrega na WABA à qual o número de fato
    // pertence, e nenhuma rota desta instalação atende lá. É a pergunta que o
    // override da fatia F1 torna obrigatória — ele aponta o webhook de um número
    // pelo id, e o id não carrega a WABA. Quem responde é a Meta, não o operador.
    if (input.wabaId) {
      const pertence = await numeroPertenceAWaba({
        wabaId: input.wabaId,
        phoneNumberId: input.phoneNumberId,
        token: input.token,
        version,
      });
      if (!pertence.ok) return { ok: false, motivo: pertence.motivo };
    }

    return {
      ok: true,
      displayPhoneNumber: body.display_phone_number ?? null,
      verifiedName: body.verified_name ?? null,
      qualityRating: body.quality_rating ?? null,
    };
  } catch (err) {
    // Rede caída não é credencial ruim — o motivo precisa dizer isso, senão o
    // operador troca um token que estava certo.
    return { ok: false, motivo: `rede indisponível: ${err instanceof Error ? err.message : "erro"}` };
  }
}

/**
 * Este número está na lista de números DESTA WABA?
 *
 * `GET /{waba_id}/phone_numbers` é a única resposta direta que a Meta dá à pergunta
 * — o id do número não carrega a conta à qual pertence. Lista vazia é tratada como
 * "não pertence" com motivo próprio: credencial sem permissão na WABA devolve 200
 * com `data: []`, e dizer "não pertence" seria apontar o dedo para o operador
 * quando o problema é a credencial (mesma distinção de motivo da validação acima).
 */
async function numeroPertenceAWaba(input: {
  wabaId: string;
  phoneNumberId: string;
  token: string;
  version: string;
}): Promise<{ ok: true } | { ok: false; motivo: string }> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${input.version}/${input.wabaId}/phone_numbers?fields=id&limit=200`,
      { headers: { Authorization: `Bearer ${input.token}` } },
    );
    const body = (await res.json().catch(() => ({}))) as {
      data?: Array<{ id?: string }>;
      error?: { message?: string; error_data?: { details?: string } };
    };

    if (!res.ok || body.error) {
      return {
        ok: false,
        motivo:
          body.error?.error_data?.details ?? body.error?.message ?? `a Meta respondeu http_${res.status} ao listar os números da WABA`,
      };
    }

    const ids = (body.data ?? []).map((n) => n.id).filter((id): id is string => Boolean(id));
    if (ids.length === 0) {
      return {
        ok: false,
        motivo: `a WABA ${input.wabaId} não devolveu nenhum número — confira se a credencial tem acesso a esta conta no painel da Meta`,
      };
    }
    if (!ids.includes(input.phoneNumberId)) {
      return {
        ok: false,
        motivo: `o número ${input.phoneNumberId} não pertence à WABA ${input.wabaId} — confira no painel da Meta a qual conta o número está ligado`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, motivo: `rede indisponível: ${err instanceof Error ? err.message : "erro"}` };
  }
}
