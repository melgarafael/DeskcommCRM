/**
 * Os botões de um modelo aprovado, lidos do espelho (`meta_templates`) na hora
 * do envio — para a mensagem gravar o que o cliente recebeu
 * (`lib/messaging/botoes-do-modelo.ts`).
 *
 * Nunca lança e nunca barra: é dado de EXIBIÇÃO. Sem espelho, com erro de
 * leitura ou sem botões, o envio segue igual e a mensagem só não mostra as
 * opções. Quem confere a definição de verdade é `conferirDefinicao`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { botoesDoModelo } from "@/lib/messaging/botoes-do-modelo";

import { linhaDoEspelho, type ChaveDaDefinicao } from "./linha-do-espelho";

export async function botoesDaDefinicao(db: SupabaseClient, chave: ChaveDaDefinicao): Promise<string[]> {
  if (!chave.name || !chave.language) return [];
  try {
    const { data, error } = await linhaDoEspelho<{ components: unknown }>(db, "components", chave);
    if (error || !data) return [];
    return botoesDoModelo(data.components);
  } catch {
    return [];
  }
}
