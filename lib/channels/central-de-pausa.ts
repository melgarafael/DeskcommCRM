/**
 * Quem APANHA a regra do `canal-pausado` no banco (issue #2389).
 *
 * A regra pura mora em `lib/channels/canal-pausado.ts`; este módulo é a parte
 * com I/O — leitura do item aberto, leitura do canal, e a escrita que a decisão
 * mandou. Existe separado porque SEIS caminhos precisam dele com a mesma conta:
 *
 *   * `PATCH …/channel-sessions/[id]/disabled` — pausar/retomar um canal;
 *   * `PATCH …/channel-sessions/disabled` — ação em lote (um item POR canal);
 *   * o cron `channel-pause-scheduler` — a janela de manutenção agendada (#2388),
 *     que pausa no início e retoma no fim pela mesma chave;
 *   * `DELETE|PATCH …/channel-sessions/[id]` — arquivar/excluir;
 *   * `disconnectSocialAccount` (Redes Sociais) e `despareaVoz` (voz) — os dois
 *     outros lugares que gravam `archived_at` em `channel_sessions`, via
 *     `fecharAvisoDePausaDoCanalArquivado`. Quem arquiva canal e não passa por
 *     aqui é reprovado por `tests/unit/arquivar-canal-fecha-aviso-de-pausa.test.ts`.
 *
 * Nos três últimos o canal já sumiu ou já está marcado, e o item resolve com
 * `canal_arquivado` — é a mesma régua do `canal-mudo-watcher` para canal que
 * não apareceu na varredura, e a razão de existir é a lição do #1023: aviso
 * cujo emissor some fica aberto para sempre.
 *
 * ── Best-effort, e por quê ──────────────────────────────────────────────────
 *
 * Esta chamada é LATERAL a uma operação que o operador pediu (pausar, retomar,
 * excluir). Uma falha de leitura aqui não pode desfazer a pausa nem devolver
 * 500 — a pausa já foi gravada pela RPC atômica. Por isso NUNCA lança: devolve
 * `falhou`, e quem chama pode logar. É o mesmo desfecho de
 * `resolverSaudeDaConexaoRemovida`, no handler de exclusão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  avaliarAvisoDePausa,
  KIND_CANAL_PAUSADO,
  TITULO_DO_AVISO_DE_PAUSA,
  type CanalAvaliado,
  type ItemDePausaAberto,
} from "@/lib/channels/canal-pausado";
import { logger } from "@/lib/logger";
import type { Idioma } from "@/lib/i18n/idiomas";

/** O que a sincronização fez — para a rota poder registrar no audit. */
export type DesfechoDaSincronizacaoDePausa =
  | "aberto"
  | "atualizado"
  | "resolvido"
  | "sem_mudanca"
  | "falhou";

interface CanalAlvo {
  id: string;
  organization_id: string;
}

/**
 * Lê, decide e escreve — um canal por chamada.
 *
 * `autor` é o nome (ou e-mail) de quem operou o toggle: é ele que o item cita,
 * porque "quem pausou" é a primeira pergunta de quem vê o aviso no outro turno.
 */
export async function sincronizarAvisoDePausa(
  db: SupabaseClient,
  canal: CanalAlvo,
  contexto: { autor: string; agora?: Date; idioma?: Idioma },
): Promise<DesfechoDaSincronizacaoDePausa> {
  try {
    const agora = contexto.agora ?? new Date();

    // O item vem PRIMEIRO: ele existe mesmo quando a linha do canal já sumiu
    // (exclusão), que é exatamente o caso em que precisa ser fechado.
    const { data: itemBruto, error: erroItem } = await db
      .from("agent_inbox_items")
      .select("id, body")
      .eq("organization_id", canal.organization_id)
      .eq("kind", KIND_CANAL_PAUSADO)
      .eq("status", "open")
      .eq("ref_id", canal.id)
      .limit(1)
      .maybeSingle();
    if (erroItem) {
      logger.warn("[canal-pausado] leitura do aviso aberto falhou", {
        detail: erroItem.message,
        channel_session_id: canal.id,
      });
      return "falhou";
    }
    const item = (itemBruto ?? null) as ItemDePausaAberto | null;

    const { data: linha, error: erroCanal } = await db
      .from("channel_sessions")
      .select("id, organization_id, display_name, phone_number, archived_at, metadata")
      .eq("organization_id", canal.organization_id)
      .eq("id", canal.id)
      .maybeSingle();
    if (erroCanal) {
      logger.warn("[canal-pausado] leitura do canal falhou", {
        detail: erroCanal.message,
        channel_session_id: canal.id,
      });
      return "falhou";
    }

    // Linha ausente = excluída (hard delete). O item não pode ficar apontando
    // para uma linha que a tela já não carrega.
    if (!linha) {
      if (!item) return "sem_mudanca";
      return (await fechar(db, item, resolverCorpo(item, "o canal foi arquivado")))
        ? "resolvido"
        : "falhou";
    }

    const decisao = avaliarAvisoDePausa(linha as CanalAvaliado, item, {
      autor: contexto.autor,
      agora,
      idioma: contexto.idioma,
    });

    if (decisao.acao === "nada") return "sem_mudanca";

    if (decisao.acao === "resolver") {
      return (await fechar(db, decisao.item, decisao.corpo)) ? "resolvido" : "falhou";
    }

    if (decisao.acao === "atualizar") {
      const { error } = await db
        .from("agent_inbox_items")
        .update({ title: decisao.titulo, body: decisao.corpo })
        .eq("id", decisao.item.id)
        // A trava: duas rodadas simultâneas não fecham/reescrevem o mesmo item
        // duas vezes. Mesmo desfecho do `status` no fechar do canal-mudo.
        .eq("status", "open");
      if (error) {
        logger.warn("[canal-pausado] atualização do aviso falhou", {
          detail: error.message,
          channel_session_id: canal.id,
        });
        return "falhou";
      }
      return "atualizado";
    }

    const { error } = await db.from("agent_inbox_items").insert({
      organization_id: (linha as CanalAvaliado).organization_id,
      kind: KIND_CANAL_PAUSADO,
      // `warn`, não `critical`: nada quebrou — o canal foi desligado de
      // propósito. `critical` gastaria o alarme que a Central reserva para o
      // que já custou dinheiro ou cliente. `info` ficaria abaixo da linha em
      // que a equipe olha, e este aviso existe justamente para quem não viu o
      // clique.
      severity: "warn",
      title: decisao.titulo,
      body: decisao.corpo,
      ref_kind: "channel_session",
      ref_id: canal.id,
    });
    // 23505 = outra rodada simultânea (duplo clique, lote + unitária) abriu o
    // aviso entre a nossa leitura e o nosso INSERT. O índice único parcial da
    // migration 0589 é quem garante "um canal pausado = um aviso"; aqui só
    // reconhecemos que o aviso já existe.
    if (error?.code === "23505") return "sem_mudanca";
    if (error) {
      logger.warn("[canal-pausado] abertura do aviso falhou", {
        detail: error.message,
        channel_session_id: canal.id,
      });
      return "falhou";
    }
    return "aberto";
  } catch (err) {
    logger.warn("[canal-pausado] sincronização interrompida", {
      channel_session_id: canal.id,
      organization_id: canal.organization_id,
      erro: err instanceof Error ? err.message : String(err),
    });
    return "falhou";
  }
}

/** O corpo de resolução do caminho em que a linha do canal já não existe. */
function resolverCorpo(item: ItemDePausaAberto, motivoLivel: string): string {
  const anterior = (item.body ?? "").trim();
  const linha = `Resolvido pelo sistema: ${motivoLivel}.`;
  return anterior === "" ? linha : `${anterior}\n\n${linha}`;
}

/**
 * Fecha o item, com a trava de `status` no filtro: duas rodadas simultâneas
 * (duas abas, ou retoma em lote) não fecham o mesmo item duas vezes.
 */
async function fechar(
  db: SupabaseClient,
  item: ItemDePausaAberto,
  corpo: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("agent_inbox_items")
    .update({ status: "resolved", body: corpo })
    .eq("id", item.id)
    .eq("status", "open")
    .select("id")
    .maybeSingle();
  if (error) {
    logger.warn("[canal-pausado] fechamento do aviso falhou", {
      detail: error.message,
      inbox_item_id: item.id,
    });
    return false;
  }
  return data !== null;
}

/** Título do item — exportado para os testes de rota não repetirem a string. */
export const TITULO = TITULO_DO_AVISO_DE_PAUSA;

/**
 * Para quem ARQUIVA o canal fora das rotas de `channel-sessions` (Redes Sociais,
 * voz). Chame DEPOIS de gravar `archived_at`: com a linha arquivada a regra só
 * resolve (`canal_arquivado`), e o autor nunca entra no corpo — por isso não é
 * pedido a quem chama.
 */
export function fecharAvisoDePausaDoCanalArquivado(
  db: SupabaseClient,
  canal: CanalAlvo,
): Promise<DesfechoDaSincronizacaoDePausa> {
  return sincronizarAvisoDePausa(db, canal, { autor: "o sistema" });
}
