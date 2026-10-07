import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { canalDesativado } from "@/lib/channels/desativado";

export const dynamic = "force-dynamic";

/**
 * AÇÃO EM LOTE da Central de Conexões (issue #2387).
 *
 * `PATCH /api/v1/channel-sessions/disabled` pausa (ou retoma) VÁRIOS canais numa
 * só requisição. A janela de manutenção do rodízio de números (#1330) virava N
 * cliques contra a rota unitária `PATCH …/[id]/disabled` — e um número esquecido
 * era um canal seguindo sozinho no meio dos outros parados.
 *
 * ─── O que é REAPROVEITADO, e por isso não há migration nova ─────────────────
 *
 * Nada de lógica nova de estado: o mesmo caminho da rota unitária, por linha —
 * a RPC `fn_definir_canal_desativado` (migration 0545), que troca só a chave
 * `metadata.disabled` sem sobrescrever o resto, e que já filtra
 * `archived_at is null` no próprio `UPDATE` (a garantia de que um canal excluído
 * nunca é "pausado às escondidas"). `lib/channels/desativado.ts` segue sendo a
 * única leitura do estado.
 *
 * ─── As três contagens, e por que o audit é POR CANAL ─────────────────────────
 *
 * - `alterados` — mudaram AGORA: uma chamada de RPC e UM audit por canal, com o
 *   autor (`actorUserId`) e o MESMO `requestId` da requisição: N eventos da mesma
 *   operação, cada um nomeando a linha que mudou. Um audit só com "N canais"
 *   perde o `resourceId`, que é o que a auditoria de suporte lê.
 * - `jaEstavam` — já no estado alvo: SEM RPC e SEM audit. É o que faz a ação
 *   idempotente: repetir "Pausar todas" não regrava nada nem enche o histórico
 *   de eventos que não representam mudança (critério 3 da issue).
 * - `arquivados` — `archived_at` preenchido = canal excluído: fora da operação,
 *   nem erro, sem RPC e sem audit (critério 2). Exclusão se desfaz na tela de
 *   exclusão, não por pausa.
 *
 * `falharam` traz OS IDS (nunca sucesso falso, critério 5): id que não existe
 * nesta organização, RPC que devolveu erro e canal que a corrida arquivou entre
 * a leitura e a escrita (RPC devolvendo 0) caem todos aqui, na ordem pedida.
 *
 * ─── Por que a resposta é 200 mesmo com falha parcial ─────────────────────────
 *
 * Cada linha é uma operação INDEPENDENTE das outras (uma RPC por id, sem
 * transação de lote): 500 esconderia os canais que mudaram e devolveria só o
 * vermelho. O corpo declara a conta inteira (`alterados`/`jaEstavam`/
 * `arquivados`/`falharam`) e é a TELA quem traduz `falharam` em aviso de erro —
 * `frasesDoLoteDePausa` nunca monta toast de sucesso com falha preenchida.
 *
 * Escopo: mesma régua da rota unitária — papel admin (`requireRole("admin")`),
 * suporte somente-leitura barrado antes do service role, e a leitura filtrada
 * pela `organization_id` da sessão (nunca pelo body).
 */

/** Mesmo teto do lote de leads (`AT-06`): instalação típica tem dezenas. */
export const MAX_LOTE = 50;

const loteSchema = z
  .object({
    disabled: z.boolean(),
    ids: z.array(z.uuid()).min(1).max(MAX_LOTE),
  })
  .strict();

/** O que a ação em lote fez — a conta que o toast da tela divulga. */
export type ResultadoDoLoteDePausa = {
  /** Estado pedido (`true` = pausar, `false` = retomar). */
  disabled: boolean;
  /** Ids recebidos, depois de deduplicar. */
  pedidos: number;
  /** Mudaram agora (uma RPC e um audit por canal). */
  alterados: number;
  /** Já estavam no estado alvo: sem RPC, sem audit. */
  jaEstavam: number;
  /** Arquivados: fora da operação, sem erro. */
  arquivados: number;
  /** Ids que não saíram — na ordem em que foram pedidos. */
  falharam: string[];
};

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const auth = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!auth.ok) return auth.response;

  const parsed = loteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      "validation_failed",
      `Informe disabled e uma lista de 1 a ${MAX_LOTE} ids de canal.`,
      422,
      { requestId },
    );
  }

  // Id repetido no pedido não vira duas escritas nem dois audits: uma ação por
  // canal, e `pedidos` conta o que a tela realmente pediu.
  const ids = [...new Set(parsed.data.ids)];
  const { disabled } = parsed.data;

  const admin = createAdminClient();
  const { data: linhas, error } = await admin
    .from("channel_sessions")
    .select("id, metadata, archived_at")
    .eq("organization_id", auth.org.orgId)
    .in("id", ids);
  if (error) {
    return fail(
      "internal_error",
      "Não foi possível ler o estado dos canais. Verifique se o banco está atualizado.",
      500,
      { requestId },
    );
  }

  const alterados: string[] = [];
  const jaEstavam: string[] = [];
  const falharam = new Set<string>();
  const encontrados = new Set<string>();
  let arquivados = 0;

  for (const linha of linhas ?? []) {
    const id = String(linha.id);
    encontrados.add(id);
    if (linha.archived_at !== null) {
      // Excluído não pausa nem retoma: fora da operação, sem erro e sem audit.
      arquivados += 1;
      continue;
    }
    if (canalDesativado(linha.metadata) === disabled) {
      // Já no estado alvo: idempotência declarada, não repetida.
      jaEstavam.push(id);
      continue;
    }
    const { data: mudou, error: rpcError } = await admin.rpc("fn_definir_canal_desativado", {
      p_org: auth.org.orgId,
      p_canal: id,
      p_desativado: disabled,
    });
    // `mudou !== 1` cobre o canal arquivado/apagado na corrida entre a leitura
    // e a escrita: a RPC filtra `archived_at is null` e devolve 0 linha.
    if (rpcError || mudou !== 1) {
      falharam.add(id);
      continue;
    }
    alterados.push(id);
    void audit({
      action: disabled ? "channel.disabled" : "channel.enabled",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "channel_session",
      resourceId: id,
      requestId,
      metadata: { disabled },
    });
  }

  // Id que não voltou na leitura não existe nesta organização (ou nunca
  // existiu): falha nomeada, nunca sucesso falso.
  for (const id of ids) if (!encontrados.has(id)) falharam.add(id);

  return ok(
    {
      disabled,
      pedidos: ids.length,
      alterados: alterados.length,
      jaEstavam: jaEstavam.length,
      arquivados,
      falharam: ids.filter((id) => falharam.has(id)),
    } satisfies ResultadoDoLoteDePausa,
    { requestId },
  );
}
