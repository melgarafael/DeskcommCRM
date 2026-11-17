/**
 * #4340 (segunda metade) — o roteador acompanha a troca de número.
 *
 * O roteador é ancorado em `ai_routers.channel_session_id`. Quando o número é
 * arquivado e outro nasce, nada liga os dois: `channel_sessions` não guarda
 * "este substitui aquele", e publicar a versão do agente no número novo não diz
 * que o roteador deve seguir (um roteador tem N membros). Quem sabe que B
 * substitui A é o operador — e a tela de roteadores já denuncia o caso desde o
 * #4348. Esta função é o gesto explícito: mover o roteador INTEIRO (nome,
 * intenções, destinos, reserva) para o número novo, com cerca e com auditoria.
 *
 * Regras (todas provadas em `mover-roteador-de-numero.test.ts`):
 *   1. o número ATUAL tem de estar arquivado/ausente — esta porta não serve
 *      para trocar um número vivo de lugar;
 *   2. o número NOVO tem de ser da mesma organização, vivo e sem roteador;
 *   3. a linha é atualizada (o trigger da 0085 registra old/new) e o audit
 *      `ai.router_channel_moved` guarda "de X para Y" com quem moveu;
 *   4. repetir com o mesmo número é no-op, sem audit duplicado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { queryTolerantToMissingArchived, type DbErrorLike } from "@/lib/channels/archived";

export type CodigoDaMudancaDeNumero =
  | "router_not_found"
  | "numero_atual_ainda_ativo"
  | "numero_novo_invalido"
  | "numero_novo_ja_tem_roteador"
  | "update_failed";

export type ResultadoDaMudancaDeNumero =
  | {
      ok: true;
      /** Sessão de onde o roteador saiu. */
      de: string;
      /** Sessão para onde ele foi (ou onde já estava). */
      para: string;
      /** `false` quando já estava no número pedido — no-op, sem auditoria. */
      movido: boolean;
    }
  | { ok: false; code: CodigoDaMudancaDeNumero };

export interface QuemMoveu {
  userId?: string | null;
  apiTokenId?: string | null;
  requestId?: string | null;
}

interface CanalLido {
  id: string;
  archived_at?: string | null;
}

/**
 * `true` quando o canal não recebe mais conversas. Ausência da linha conta como
 * removido: não há para onde as mensagens irem.
 */
function canalArquivado(
  leitura: { data: CanalLido | null; error: DbErrorLike | null; schemaOutdated: boolean },
): { arquivado: boolean; erro: boolean } {
  if (leitura.error) return { arquivado: false, erro: true };
  if (!leitura.data) return { arquivado: true, erro: false };
  // Sem a coluna (migration 0106 não rodou), nada está arquivado — mesma régua
  // de `lib/channels/archived.ts`.
  if (leitura.schemaOutdated) return { arquivado: false, erro: false };
  return { arquivado: (leitura.data.archived_at ?? null) !== null, erro: false };
}

export async function moverRoteadorParaNumero(
  db: SupabaseClient,
  params: {
    organizationId: string;
    routerId: string;
    novoChannelSessionId: string;
    quemMoveu?: QuemMoveu;
  },
): Promise<ResultadoDaMudancaDeNumero> {
  const { organizationId, routerId, novoChannelSessionId } = params;

  const { data: router, error: erroRouter } = await db
    .from("ai_routers")
    .select("id, name, channel_session_id")
    .eq("id", routerId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (erroRouter || !router) return { ok: false, code: "router_not_found" };

  const linha = router as { id: string; name: string; channel_session_id: string };
  const de = linha.channel_session_id;
  if (de === novoChannelSessionId) {
    return { ok: true, de, para: novoChannelSessionId, movido: false };
  }

  const leituraDoAtual = await queryTolerantToMissingArchived(
    () =>
      db
        .from("channel_sessions")
        .select("id, archived_at")
        .eq("organization_id", organizationId)
        .eq("id", de)
        .maybeSingle(),
    () =>
      db
        .from("channel_sessions")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("id", de)
        .maybeSingle(),
  );
  const atual = canalArquivado(leituraDoAtual as never);
  if (atual.erro) return { ok: false, code: "update_failed" };
  if (!atual.arquivado) return { ok: false, code: "numero_atual_ainda_ativo" };

  const leituraDoNovo = await queryTolerantToMissingArchived(
    () =>
      db
        .from("channel_sessions")
        .select("id, archived_at")
        .eq("organization_id", organizationId)
        .eq("id", novoChannelSessionId)
        .maybeSingle(),
    () =>
      db
        .from("channel_sessions")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("id", novoChannelSessionId)
        .maybeSingle(),
  );
  if (leituraDoNovo.error || !leituraDoNovo.data) {
    return { ok: false, code: "numero_novo_invalido" };
  }
  if (canalArquivado(leituraDoNovo as never).arquivado) {
    return { ok: false, code: "numero_novo_invalido" };
  }

  const { data: ocupantes, error: erroOcupantes } = await db
    .from("ai_routers")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("channel_session_id", novoChannelSessionId)
    .limit(1);
  if (erroOcupantes) return { ok: false, code: "update_failed" };
  if ((ocupantes ?? []).length > 0) {
    return { ok: false, code: "numero_novo_ja_tem_roteador" };
  }

  const { error: erroUpdate } = await db
    .from("ai_routers")
    .update({ channel_session_id: novoChannelSessionId })
    .eq("id", routerId)
    .eq("organization_id", organizationId);
  if (erroUpdate) {
    // O índice parcial da 0085 (`1 ativo por sessão`) pode fechar a corrida
    // entre a checagem acima e este UPDATE. Mesmo desfecho do PATCH: 409.
    if (erroUpdate.code === "23505") {
      return { ok: false, code: "numero_novo_ja_tem_roteador" };
    }
    return { ok: false, code: "update_failed" };
  }

  // O trigger da 0085 já grava old/new da linha; esta entrada é a que responde
  // "quem moveu e entre quais números" no painel de auditoria.
  void audit({
    action: "ai.router_channel_moved",
    actorUserId: params.quemMoveu?.userId ?? null,
    actorApiTokenId: params.quemMoveu?.apiTokenId ?? null,
    organizationId,
    resourceType: "ai_router",
    resourceId: routerId,
    requestId: params.quemMoveu?.requestId ?? null,
    metadata: { de, para: novoChannelSessionId, router_name: linha.name },
  });

  return { ok: true, de, para: novoChannelSessionId, movido: true };
}
