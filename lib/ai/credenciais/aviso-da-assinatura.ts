/**
 * Quem APANHA a regra da assinatura desconectada no banco (#3371, fatia 2).
 *
 * A regra pura mora em `./assinatura-desconectada.ts`; este módulo é a parte com
 * I/O — o item aberto da organização, e a escrita que a decisão mandou. Existe
 * separado porque DOIS caminhos precisam dele com a mesma conta:
 *
 *   * o seam do turno (`lib/agent-engine/edge/llm/run-model-call.ts`), quando o
 *     provedor devolve 401 com sinal de expiração E a renovação foi recusada —
 *     é ele que ABRE;
 *   * a rota que recebe o login novo (`…/credentials/[id]/revalidate`), quando a
 *     conta volta — é ela que FECHA, sem clique de ninguém.
 *
 * ── Best-effort, e por quê ──────────────────────────────────────────────────
 *
 * A abertura acontece LATERAL a um turno que já falhou; o fechamento, lateral a
 * uma revalidação que já deu certo. Falha aqui não pode desfazer nada nem
 * devolver 500 — devolve `falhou` e o chamador loga. Mesma doutrina do
 * `lib/channels/central-de-pausa.ts` (#2389).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  avaliarAvisoDaAssinatura,
  KIND_ASSINATURA_DESCONECTADA,
  type ItemDaAssinaturaAberto,
  type SituacaoDaAssinatura,
} from "./assinatura-desconectada";
import { logger } from "@/lib/logger";

export type DesfechoDoAvisoDaAssinatura =
  | "aberto"
  | "atualizado"
  | "resolvido"
  | "sem_mudanca"
  | "falhou";

/**
 * Lê o item aberto da organização, decide e escreve.
 *
 * `recusa` é o motivo da fatia 3. `null` significa "não é queda de login" — e
 * aí nada é aberto, porque reconectar a conta não consertaria uma falha de rede.
 */
export async function sincronizarAvisoDaAssinatura(
  db: SupabaseClient,
  situacao: SituacaoDaAssinatura & { organizationId: string },
): Promise<DesfechoDoAvisoDaAssinatura> {
  try {
    const { data: itemBruto, error: erroItem } = await db
      .from("agent_inbox_items")
      .select("id, body")
      .eq("organization_id", situacao.organizationId)
      .eq("kind", KIND_ASSINATURA_DESCONECTADA)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (erroItem) {
      logger.warn("[assinatura] leitura do aviso aberto falhou", {
        detail: erroItem.message,
        organization_id: situacao.organizationId,
      });
      return "falhou";
    }
    const item = (itemBruto ?? null) as ItemDaAssinaturaAberto | null;

    const decisao = avaliarAvisoDaAssinatura(
      { conectada: situacao.conectada, recusa: situacao.recusa },
      item,
    );
    if (decisao.acao === "nada") return "sem_mudanca";

    if (decisao.acao === "resolver") {
      const { data, error } = await db
        .from("agent_inbox_items")
        .update({ status: "resolved", body: decisao.corpo })
        .eq("id", decisao.item.id)
        // A trava: duas rodadas simultâneas não fecham o mesmo item duas vezes.
        .eq("status", "open")
        .select("id")
        .maybeSingle();
      if (error) {
        logger.warn("[assinatura] fechamento do aviso falhou", {
          detail: error.message,
          inbox_item_id: decisao.item.id,
        });
        return "falhou";
      }
      return data !== null ? "resolvido" : "sem_mudanca";
    }

    if (decisao.acao === "atualizar") {
      const { error } = await db
        .from("agent_inbox_items")
        .update({ title: decisao.titulo, body: decisao.corpo })
        .eq("id", decisao.item.id)
        .eq("status", "open");
      if (error) {
        logger.warn("[assinatura] atualização do aviso falhou", {
          detail: error.message,
          organization_id: situacao.organizationId,
        });
        return "falhou";
      }
      return "atualizado";
    }

    const { error } = await db.from("agent_inbox_items").insert({
      organization_id: situacao.organizationId,
      kind: KIND_ASSINATURA_DESCONECTADA,
      // `critical`, e não `warn` como o canal pausado: aqui o cliente já está
      // sem resposta, e é exatamente o alarme que a Central reserva para o que
      // já custou cliente.
      severity: "critical",
      status: "open",
      title: decisao.titulo,
      body: decisao.corpo,
      // Sem `ref_kind`/`ref_id` de propósito: o conserto não é uma linha do
      // banco, é reconectar a conta em IA › Credenciais — e é lá que o botão da
      // Central leva (`lib/ai/inbox-destino.ts`).
    });
    // 23505 = outra rodada simultânea abriu o aviso entre a leitura e o INSERT.
    // O índice único parcial da migration 9027 é quem garante "um incidente =
    // um aviso"; aqui só reconhecemos que ele já existe.
    if (error?.code === "23505") return "sem_mudanca";
    if (error) {
      logger.warn("[assinatura] abertura do aviso falhou", {
        detail: error.message,
        organization_id: situacao.organizationId,
      });
      return "falhou";
    }
    return "aberto";
  } catch (err) {
    logger.warn("[assinatura] sincronização do aviso interrompida", {
      organization_id: situacao.organizationId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return "falhou";
  }
}

/** O aviso fecha sozinho quando o login volta — chamado pela rota do login. */
export function fecharAvisoDaAssinatura(
  db: SupabaseClient,
  organizationId: string,
): Promise<DesfechoDoAvisoDaAssinatura> {
  return sincronizarAvisoDaAssinatura(db, {
    organizationId,
    conectada: true,
    recusa: null,
  });
}
