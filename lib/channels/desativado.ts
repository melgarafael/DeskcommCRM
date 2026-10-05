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
