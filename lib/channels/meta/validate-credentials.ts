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
