/**
 * GET /api/v1/prospecting/:id/exportar — a LISTA DA CAMPANHA de volta para quem
 * opera, em CSV (issue #4360).
 *
 * ─── O que faltava ──────────────────────────────────────────────────────────
 *
 * A prospecção só importava: a busca no Maps e a planilha entram, a tela mostra
 * os candidatos, e não havia porta de saída. Quem buscou 80 empresas, iniciou a
 * campanha e quis a MESMA lista com outra estratégia (outro agente, outro
 * número, outra instrução) ficava sem caminho — nem para reusar aqui, nem para
 * levar a lista embora.
 *
 * ─── Por que a lista NÃO ABORDADA, e não a campanha inteira ─────────────────
 *
 * Quem já recebeu mensagem não volta: o contato e o negócio já existem no CRM e
 * a triagem de qualquer campanha nova recusa a empresa com "Contato já existe
 * no CRM" (`store.ts`, `triarCandidato`). Um CSV com quem já foi abordado
 * prometeria uma reimportação que não acontece — e o arquivo é o que a pessoa
 * vai reimportar. A régua mora em `lib/prospecting/exportar.ts` (`naoAbordada`)
 * e é a MESMA que a tela usa para contar as empresas do botão.
 *
 * ─── Por que CSV e não "duplicar campanha" ──────────────────────────────────
 *
 * MEDIDO: `prospecting_candidates` tem `unique (organization_id, place_id)` e o
 * índice `prospecting_phone_once_org on (organization_id, phone)`
 * (`supabase/baseline.sql:35628`). A mesma empresa só pode estar em UMA campanha
 * por organização: copiar as linhas para uma campanha nova passa pelo
 * `insert ... on conflict do nothing` de `gravarCandidatos` e grava zero linha,
 * sem erro. Duplicar exige decisão de produto sobre essa unicidade — e sobre o
 * contato/negócio que o modo `on_start` cria para a fila inteira ao iniciar. O
 * PR da fatia declara a medição; esta rota entrega a saída que não depende dela.
 *
 * ─── É LEITURA ──────────────────────────────────────────────────────────────
 *
 * Dois `select` e nada mais: nenhum contato, campanha ou candidato é criado.
 * Exportar é devolver o que a tela mostra — o registro de que a lista saiu fica
 * na auditoria (`prospecting.exported`), com CONTAGEM, nunca com o conteúdo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { comIdDaRequisicao, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  csvDaLista,
  naoAbordada,
  nomeDoArquivoDaLista,
  resumoDaLista,
  type CandidatoDaLista,
} from "@/lib/prospecting/exportar";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mesmo teto da tela (o GET de candidatos lê 5.000 linhas): o arquivo não é maior que a lista. */
const TETO_DA_LEITURA = 5_000;
const headers = { "Cache-Control": "no-store" };

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  // A MESMA porta do resto da prospecção (sessão de admin ou token com leitura):
  // a lista de empresas é a base da área, e a saída dela não pode ser mais
  // aberta que a entrada.
  const auth = await resolveAuthDual(req, {
    requestId,
    resource: "prospecting",
    role: "admin",
    scope: "mcp:read",
  });
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "Campanha inválida.", 400, { requestId, headers });

  const org = auth.organizationId;
  const db = getRequestPool();

  // Organização vem da AUTENTICAÇÃO, nunca da URL: campanha de outra conta é
  // "não encontrada", e não 403 (que já diria que ela existe).
  const campanha = (
    await db.query<{ id: string; name: string }>(
      "select id,name from prospecting_campaigns where organization_id=$1 and id=$2",
      [org, id],
    )
  ).rows[0];
  if (!campanha)
    return fail("not_found", "Campanha não encontrada.", 404, { requestId, headers });

  const candidatos = (
    await db.query<CandidatoDaLista>(
      "select status,attempted_at,phone,data from prospecting_candidates where organization_id=$1 and campaign_id=$2 order by created_at,id limit $3",
      [org, campanha.id, TETO_DA_LEITURA],
    )
  ).rows;

  const pendentes = candidatos.filter(naoAbordada);
  const { total, nao_abordadas } = resumoDaLista(candidatos);
  if (pendentes.length === 0)
    // Arquivo só com cabeçalho não explica nada a quem abriu a planilha; a tela
    // também não oferece o botão nesse caso. O estado é que não tem o que
    // exportar, não o pedido.
    return fail(
      "validation_failed",
      "Nenhuma empresa desta campanha ainda pode ser abordada — não há lista para baixar. Quem já recebeu mensagem fica de fora do arquivo.",
      422,
      { requestId, headers },
    );

  await audit({
    action: "prospecting.exported",
    organizationId: org,
    actorUserId: auth.actor.type === "user" ? auth.actor.id : null,
    actorApiTokenId: auth.apiTokenId ?? null,
    resourceType: "prospecting",
    resourceId: campanha.id,
    requestId,
    metadata: { campaign_id: campanha.id, total, nao_abordadas },
  });

  return comIdDaRequisicao(
    new Response(csvDaLista(pendentes), {
      status: 200,
      headers: {
        // `;` + BOM + CRLF: o que o Excel em português abre em colunas e o que a
        // importação de planilha lê de volta (mesmo formato do "Baixar modelo").
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${nomeDoArquivoDaLista(campanha.name, new Date())}"`,
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
        ...(total >= TETO_DA_LEITURA ? { "X-Lista-Truncada": "true" } : {}),
      },
    }),
    requestId,
  );
}
