/**
 * GET /api/v1/ai/followup-flows/:id/export — o fluxo como ARQUIVO (any member).
 *
 * Devolve, no envelope de sempre (`{ data }`), o arquivo que a importação
 * (`POST /api/v1/ai/followup-flows/import`) aceita: grafo, gatilho, política de
 * handoff e os NOMES das etapas/modelos/fluxos citados — o que deixa a
 * importação achar a coisa certa em outra conta. Formato e regras em
 * `lib/followup/portabilidade.ts`.
 *
 * O grafo exportado é o que a tela desenha: o rascunho, ou a versão no ar quando
 * não há rascunho (`rascunhoDoFluxo`). Fluxo sem grafo nenhum não tem o que
 * exportar (422) — um arquivo com canvas vazio não volta pela importação.
 *
 * Mesmo papel do `GET /:id` (viewer): o arquivo não contém nada que a tela do
 * fluxo já não mostre a quem pode abri-la. É leitura — não audita.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import { triggerConfigSchema } from "@/lib/followup/api-schemas";
import { idsCitados, montarArquivoDeFluxo, nomeDoArquivo } from "@/lib/followup/portabilidade";
import { nomesDaOrigem } from "@/lib/followup/portabilidade-db";
import { rascunhoDoFluxo } from "@/lib/followup/rascunho";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const SOURCE_COLUMNS =
  "id, name, draft_graph, trigger_config, handoff_policy, surface, active_version_id";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("viewer", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: origem, error: fetchErr } = await supabase
    .from("followup_flow_pointers")
    .select(SOURCE_COLUMNS)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!origem) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  const bruto = await rascunhoDoFluxo(
    supabase,
    origem as { draft_graph: unknown; active_version_id: string | null },
    activeOrg.orgId,
  );
  // Revalida em vez de confiar na coluna: `draft_graph` escrito por fora (SQL à
  // mão, versão antiga) que não passa no schema geraria um arquivo que a
  // importação recusa — melhor dizer agora, com o motivo.
  const grafo = flowGraphSchema.safeParse(bruto);
  if (!grafo.success) {
    return fail(
      "flow_empty",
      t(
        "Este fluxo ainda não tem caixas suficientes para exportar. Monte o fluxo no editor e salve antes.",
      ),
      422,
      { requestId },
    );
  }

  const gatilho = triggerConfigSchema.safeParse(origem.trigger_config ?? { kind: "manual" });

  let nomes;
  try {
    nomes = await nomesDaOrigem(
      supabase,
      activeOrg.orgId,
      idsCitados(grafo.data, gatilho.success ? gatilho.data : null),
    );
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "export_names_failed", 500, {
      requestId,
    });
  }

  const arquivo = montarArquivoDeFluxo(
    {
      name: String(origem.name),
      surface: (origem.surface as string | null) ?? null,
      handoff_policy: String(origem.handoff_policy ?? "pause"),
      trigger_config: origem.trigger_config,
      graph: grafo.data,
    },
    nomes,
    new Date(),
  );

  return ok({ file_name: nomeDoArquivo(String(origem.name)), file: arquivo }, { requestId });
}
