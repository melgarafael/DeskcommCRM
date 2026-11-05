/**
 * O aviso CRU do provedor de pagamento — o que chegou, gravado antes de decidir.
 *
 * O `raw_body` de `webhook_events_log` era o único lugar onde o aviso original
 * poderia sobreviver a uma falha, e até aqui ele guardava um corpo FABRICADO:
 * `"{}"` na recusa e `{id,type}` no ponteiro. Quando o provedor reentrega cinco
 * vezes e todas falham (`#3870`), o que sobrava era uma linha de log com o
 * motivo — nunca os bytes que o provedor mandou. Sem eles, "o reenvio chegou?"
 * e "o 401 foi assinatura errada ou segredo trocado?" não têm resposta.
 *
 * Esta função é o ponto único que grava o aviso. A rota de cobrança a chama em
 * todos os caminhos (recusa, cliente desconhecido, processamento); a rota de
 * pagamento do `#3590` deve chamar a MESMA, para o dono não ficar com dois
 * formatos de arquivo forense.
 *
 * ── O que ela NÃO faz ─────────────────────────────────────────────────────
 * Não interpreta o corpo (`raw_body` é o texto recebido, byte a byte), não
 * decide o desfecho do evento (só grava o `status` que a rota já decidiu) e não
 * imprime nada: o corpo tem e-mail e documento do cliente, então ele vai para o
 * banco — nunca para o `logger`.
 *
 * ── Idempotência ──────────────────────────────────────────────────────────
 * O índice `uniq_webhook_events_log_cobranca` (`(provider, external_id)`, parcial
 * para stripe/asaas) transforma a reentrega em `23505`. Nesse caso a linha que
 * já existe é devolvida — SEM regravar o corpo: ele é o mesmo (o provedor
 * reenvia o mesmo payload) e a linha pode estar `archived_at` preenchida pela
 * poda de D+7, onde regravar o corpo deixaria PII viva numa linha que a poda não
 * escolhe mais.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Cabeçalhos que NUNCA entram no arquivo: credencial (`asaas-access-token`,
 * `authorization`, chaves de API), sessão (`cookie`) e a assinatura — essa tem
 * coluna própria (`signature_header`) e, quando a origem não se autenticou, é
 * texto livre de quem chamou.
 */
const CABECALHOS_FORA = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "asaas-access-token",
  "stripe-signature",
  "x-api-key",
]);

/** O que a rota sabe sobre o aviso no instante em que ele é gravado. */
export interface AvisoDoProvedor {
  /** `stripe`, `asaas` — e, quando o `#3590` entrar, o provedor de pagamento. */
  provedor: string;
  /** Os bytes como chegaram (`await request.text()`), nunca `JSON.stringify` de nada. */
  corpo: string;
  /** `false` = a origem não se autenticou; os cabeçalhos dela não são gravados. */
  valida: boolean;
  headers: Headers;
  /** Só a coluna `signature_header` recebe isto, e só quando a assinatura vale. */
  assinatura: string | null;
  externalId: string | null;
  eventType: string | null;
  status: "received" | "error";
  erro?: string | null;
}

export type ResultadoDoAviso = { id: string; status: string } | "erro";

/** Os cabeçalhos do aviso, sem credencial — ou `null` quando a origem não se autenticou. */
export function cabecalhosDoAviso(headers: Headers, valida: boolean): Record<string, string> | null {
  if (!valida) return null;
  const guardados: Record<string, string> = {};
  headers.forEach((valor, nome) => {
    const chave = nome.toLowerCase();
    if (CABECALHOS_FORA.has(chave)) return;
    guardados[chave] = valor;
  });
  return guardados;
}

/**
 * Grava o aviso como chegou e devolve a linha (`id`, `status`).
 *
 * `"erro"` = o banco recusou por motivo que não é reentrega; quem chamou decide
 * o HTTP (a rota de cobrança responde 500 e o provedor reentrega).
 */
export async function registrarAviso(admin: SupabaseClient, aviso: AvisoDoProvedor): Promise<ResultadoDoAviso> {
  const { data, error } = await admin
    .from("webhook_events_log")
    .insert({
      organization_id: null,
      provider: aviso.provedor,
      raw_body: aviso.corpo,
      headers: cabecalhosDoAviso(aviso.headers, aviso.valida),
      signature_header: aviso.valida ? aviso.assinatura : null,
      valid_signature: aviso.valida,
      external_id: aviso.externalId,
      event_type: aviso.eventType,
      status: aviso.status,
      error_message: aviso.erro ?? null,
    })
    .select("id, status")
    .single();
  if (!error && data) return data as { id: string; status: string };
  if (error?.code !== "23505") return "erro";
  // Reentrega: a linha do evento já existe e o corpo dela já é o aviso cru.
  const { data: existente, error: erroDaLeitura } = await admin
    .from("webhook_events_log")
    .select("id, status")
    .eq("provider", aviso.provedor)
    .eq("external_id", aviso.externalId)
    .is("organization_id", null)
    .maybeSingle();
  if (erroDaLeitura || !existente) return "erro";
  return existente as { id: string; status: string };
}
