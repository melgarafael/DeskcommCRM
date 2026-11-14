/**
 * GET /api/v1/pipelines/exportar — os FUNIS da organização ativa, com as
 * etapas, como arquivo (issue #1995, fatia 2).
 *
 * ─── Por que rota nova, e não parâmetro na de respostas rápidas ─────────────
 *
 * O envelope é o mesmo, mas o RECURSO é outro: `manager` em `crm_pipelines`,
 * outro recorte de leitura (duas tabelas) e outro nome de arquivo. Um
 * `?tipo=` na rota de `message-templates` faria a autorização, o audit e o
 * recorte de cada tipo morarem num arquivo só — e o primeiro tipo novo
 * (automação, agente) teria de mexer na rota do primeiro. Rotas separadas,
 * envelope compartilhado (`lib/templates/blueprint-de-funis.ts`).
 *
 * ─── O recorte ──────────────────────────────────────────────────────────────
 *
 * Só funil VIVO (`is_archived = false`) e só etapa viva. Arquivado é histórico
 * do destino, não configuração: reimportá-lo recriaria no destino um quadro que
 * a origem escondeu da lista. O que não viaja está listado no cabeçalho do
 * módulo (slug, posição, marcas exclusivas, vocabulário, ajustes finos da
 * etapa).
 *
 * ─── O teto vale para funis E para etapas ───────────────────────────────────
 *
 * `TETO_DE_ITENS_DO_BLUEPRINT` é o teto de ITENS do envelope — aqui, funis. O
 * import recusa um funil com mais de 200 etapas pelo mesmo motivo `itens`, e
 * exportar um arquivo que o import recusaria é entregar um arquivo quebrado:
 * a recusa é aqui, com o limite na mão.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { TETO_DE_ITENS_DO_BLUEPRINT } from "@/lib/templates/blueprint";
import {
  blueprintDeFunis,
  nomeDoArquivoDeFunis,
  type EtapaExportavel,
  type FunilExportavel,
} from "@/lib/templates/blueprint-de-funis";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", {
    requestId,
    resource: "crm_pipelines",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const supabase = await createClient();
  const { data: funis, error } = await supabase
    .from("crm_pipelines")
    .select("id, name, description, position")
    .eq("organization_id", authz.org.orgId)
    // Arquivado é histórico do destino, não configuração.
    .eq("is_archived", false)
    .order("position", { ascending: true })
    .order("id", { ascending: true })
    // Um a mais que o teto: basta para saber que passou, sem ler a tabela toda.
    .limit(TETO_DE_ITENS_DO_BLUEPRINT + 1);

  if (error) {
    return fail("internal_error", t("Erro ao exportar funis."), 500, { requestId });
  }

  const linhas = (funis ?? []) as unknown as FunilExportavel[];

  // Arquivo vazio não é blueprint: quem importa não teria o que aplicar, e a
  // tela mostraria "importei zero" como se tivesse dado certo. 409 porque o
  // pedido está certo e o ESTADO é que não tem o que exportar.
  if (linhas.length === 0) {
    return fail("state_conflict", t("Não há funis para exportar."), 409, { requestId });
  }

  // Acima do teto o import recusaria o próprio arquivo — a recusa é aqui.
  if (linhas.length > TETO_DE_ITENS_DO_BLUEPRINT) {
    return fail(
      "state_conflict",
      t(
        "O blueprint leva até 200 funis, e esta organização tem mais do que isso. Nada foi exportado.",
      ),
      409,
      { requestId, details: { teto: TETO_DE_ITENS_DO_BLUEPRINT } },
    );
  }

  const { data: etapas, error: erroDasEtapas } = await supabase
    .from("crm_stages")
    .select("pipeline_id, name, color, is_won, is_lost, position")
    .eq("organization_id", authz.org.orgId)
    .eq("is_archived", false)
    .in(
      "pipeline_id",
      linhas.map((funil) => funil.id),
    )
    // A ordem do quadro é a informação que mais se perde numa migração.
    .order("position", { ascending: true })
    .order("id", { ascending: true });

  if (erroDasEtapas) {
    return fail("internal_error", t("Erro ao exportar funis."), 500, { requestId });
  }

  const linhasDeEtapa = (etapas ?? []) as unknown as EtapaExportavel[];
  const totalPorFunil = new Map<string, number>();
  for (const etapa of linhasDeEtapa) {
    totalPorFunil.set(etapa.pipeline_id, (totalPorFunil.get(etapa.pipeline_id) ?? 0) + 1);
  }

  // Funil sem etapa ATIVA é quadro morto no destino, e o import recusa um
  // funil sem etapa pelo motivo `itens` — exportar assim seria entregar um
  // arquivo que nenhuma instalação aceita. A recusa é aqui, e é do ESTADO.
  if (linhas.some((funil) => (totalPorFunil.get(funil.id) ?? 0) === 0)) {
    return fail(
      "state_conflict",
      t(
        "Há um funil sem etapas ativas nesta organização, e o blueprint de funis não cria quadro sem coluna. Nada foi exportado.",
      ),
      409,
      { requestId },
    );
  }

  if ([...totalPorFunil.values()].some((total) => total > TETO_DE_ITENS_DO_BLUEPRINT)) {
    return fail(
      "state_conflict",
      t(
        "O blueprint leva até 200 etapas por funil, e esta organização tem um funil com mais do que isso. Nada foi exportado.",
      ),
      409,
      { requestId, details: { teto: TETO_DE_ITENS_DO_BLUEPRINT } },
    );
  }

  const blueprint = blueprintDeFunis(linhas, linhasDeEtapa);

  await audit({
    action: "pipeline.exported",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "crm_pipeline",
    resourceId: null,
    requestId,
    metadata: {
      // QUANTOS funis e etapas — nunca nome de funil nem de etapa.
      total: blueprint.itens.length,
      etapas: linhasDeEtapa.length,
      versao: blueprint.versao,
      tipo: blueprint.tipo,
    },
  });

  return new Response(JSON.stringify(blueprint, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nomeDoArquivoDeFunis()}"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  });
}
