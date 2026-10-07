/**
 * Canal DESATIVADO pelo operador — `channel_sessions.metadata.disabled`.
 *
 * ─── Desativado não é arquivado nem caído ────────────────────────────────────
 *
 * `archived_at` é exclusão (some da UI, desloga, revoga, descarta na borda) e
 * `status` (`WORKING/STOPPED/...`) é saúde do transporte, que o health-check
 * sobrescreve. Nenhum dos dois serve como "desliguei este canal": o primeiro é
 * destrutivo, o segundo é alheio à vontade do operador. O `disabled` é a
 * intenção declarada — gravado pela tela via `fn_definir_canal_desativado`
 * (migration 0545), que troca só esta chave sem tocar no resto do `metadata`.
 *
 * Lei do produto: **desativado nunca entra na inbox** — a entrega é gravada,
 * mas não aparece na lista, não dispara IA e não gera follow-up. Reativou,
 * tudo volta, sem reimportar nada (a derivação é dinâmica, sem carimbo).
 *
 * Leitura estrita de propósito: só o booleano `true` desliga. Ausente, nulo ou
 * qualquer outro valor = ligado (o comportamento de quem nunca tocou no
 * toggle, e de banco anterior à chave).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Chave em `channel_sessions.metadata` que desliga o canal. */
export const DISABLED_KEY = "disabled";

/** O metadata cru (jsonb) diz que o canal está desativado? */
export function canalDesativado(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== "object") return false;
  return (metadata as Record<string, unknown>)[DISABLED_KEY] === true;
}

/**
 * O EVENTO veio de um canal DESATIVADO? (#2329)
 *
 * Régua única dos efeitos INTERNOS de `message.received` — push, fluxo de
 * follow-up, gatilho de retorno e regra/webhook de automação. A lei do #2318
 * vale nos dois sentidos: o canal desligado não entra na inbox, não acorda a
 * IA, não envia… e também não REAGE. Nenhum destes efeitos chega ao cliente
 * (o envio deles seria recusado em `messages/_handler`), mas todos custam e
 * poluem: push no bolso, fluxo avançado, inscrição no retorno e um webhook
 * HTTP de SAÍDA saindo para fora.
 *
 * `fn_emit_message_event` já grava `channel_session_id` no payload — não há
 * leitura extra para descobrir de qual canal o evento veio.
 *
 * Sem `channel_session_id` → `false`: o evento não é de canal nenhum
 * (`lead.*`, `user.mentioned`, handoff) e passa inteiro, sem custo de ida.
 *
 * Leitura FALHA → `false` (abre). É o mesmo desfecho de
 * `idsDosCanaisDesativados`: esta leitura é lateral a um evento que já foi
 * gravado, e derrubar push/follow-up/automação da organização INTEIRA por um
 * erro transitório trocaria um vazamento pontual por um silêncio geral.
 * Falha fechada é para o caminho do envio — `messages/_handler`, que é quem
 * recusa com `channel_disabled`.
 */
export async function canalDoEventoDesativado(
  db: SupabaseClient,
  organizationId: string,
  payload: unknown,
): Promise<boolean> {
  const canal = canalDoPayload(payload);
  if (canal === null) return false;
  try {
    const { data } = await db.from("channel_sessions").select("metadata")
      .eq("organization_id", organizationId)
      .eq("id", canal)
      .maybeSingle();
    const linha = data as { metadata?: unknown } | null;
    // Linha ausente (canal de outra org, canal apagado) = não desativado: o
    // mesmo "leitura estrita" de `canalDesativado`, sem inventar estado.
    return canalDesativado(linha?.metadata);
  } catch {
    return false;
  }
}

/** `channel_session_id` do payload — só string não vazia vale como canal. */
function canalDoPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const canal = (payload as Record<string, unknown>).channel_session_id;
  return typeof canal === "string" && canal !== "" ? canal : null;
}

/**
 * Ids dos canais desativados da org — para excluir da inbox (lista + badges).
 * Lista vazia = nada desligado (o caso comum, uma ida curta que volta vazia).
 * Em erro de leitura, volta vazio e deixa a lista decidir: a inbox é caminho
 * de leitura, e esvaziá-la por falha transitória seria pior que o defeito.
 * (IA, follow-up e envio têm as próprias barreiras, que falham fechadas.)
 * O try/catch também cobre cliente sem `.filter` (dublês de teste): sem ele,
 * um stub estreito derrubaria a lista inteira com TypeError.
 */
export async function idsDosCanaisDesativados(
  db: SupabaseClient,
  organizationId: string,
): Promise<string[]> {
  try {
    const { data } = await db.from("channel_sessions").select("id")
      .eq("organization_id", organizationId)
      .filter("metadata->>disabled", "eq", "true");
    if (!Array.isArray(data)) return [];
    return data.map((r: { id: string }) => r.id);
  } catch {
    return [];
  }
}
