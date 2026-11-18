/**
 * O DONO DA CARTEIRA NA IMPORTAÇÃO (A23 parte 2, #4888).
 *
 * Depois que o lote grava, os contatos que ELE criou entram na carteira do dono
 * escolhido, com a origem `importacao`. A coluna `contacts.carteira_user_id` é
 * fora do que `authenticated` grava: a única porta é `fn_definir_carteira_do_cliente`
 * (service role, com o ator passado de fora). É por ela que isto passa — nunca um
 * UPDATE direto —, e é ela que decide a posse: o Atendente só é dono dele mesmo,
 * e só do contato que criou nesta importação (migration 9421); gerente e admin
 * escolhem qualquer membro ativo.
 *
 * Só entram os contatos CRIADOS pelo lote (`source_metadata.import_batch_id`). Um
 * contato que já existia e foi reencontrado numa corrida não muda de dono por causa
 * de uma planilha.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

type SB = SupabaseClient;

export interface ResultadoDaCarteiraDoLote {
  definidos: number;
  falhas: number;
}

/** Quantas chamadas à função em paralelo: o lote vai até 2.000 contatos. */
const PARALELO = 10;

export async function definirCarteiraDoLote(
  admin: SB,
  opts: { organizationId: string; batchId: string; atorId: string; donoId: string },
): Promise<ResultadoDaCarteiraDoLote> {
  const { data, error } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", opts.organizationId)
    .eq("source", "import_csv")
    .eq("created_by_user_id", opts.atorId)
    .eq("source_metadata->>import_batch_id", opts.batchId)
    .is("carteira_user_id", null);
  if (error) {
    logger.warn("importacao_b2b.carteira_leitura_falhou", {
      organization_id: opts.organizationId,
      batch_id: opts.batchId,
      detail: error.message.slice(0, 160),
    });
    return { definidos: 0, falhas: -1 };
  }

  const ids = ((data ?? []) as Array<{ id: string }>).map((c) => c.id);
  let definidos = 0;
  let falhas = 0;
  for (let i = 0; i < ids.length; i += PARALELO) {
    const lote = ids.slice(i, i + PARALELO);
    const respostas = await Promise.all(
      lote.map((contactId) =>
        admin.rpc("fn_definir_carteira_do_cliente", {
          p_org: opts.organizationId,
          p_actor: opts.atorId,
          p_contact: contactId,
          p_dono: opts.donoId,
          p_origem: "importacao",
        }),
      ),
    );
    for (const r of respostas) {
      if (r.error) {
        falhas += 1;
        logger.warn("importacao_b2b.carteira_recusada", {
          organization_id: opts.organizationId,
          batch_id: opts.batchId,
          detail: r.error.message.slice(0, 160),
        });
      } else {
        definidos += 1;
      }
    }
  }
  return { definidos, falhas };
}
