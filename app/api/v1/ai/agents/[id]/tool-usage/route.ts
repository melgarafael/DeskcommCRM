/**
 * GET /api/v1/ai/agents/:id/tool-usage (manager+)
 *
 * O que cada capacidade do agente andou fazendo: quantas vezes foi usada,
 * quantas falharam, quantas vieram de teste e quando foi a última vez.
 *
 * Existe porque `api_audit_log` registrava toda chamada de tool desde a Spec 11
 * e nenhuma tela lia — log invisível é log morto (invariante 3 da doutrina do
 * sistema vivo). A agregação em si vive em `fn_agent_tool_usage` (migration
 * 0103); a leitura do que os números QUEREM DIZER vive em
 * `lib/ai/agents/uso-de-capacidades.ts`, pura e testada.
 *
 * Por que admin client: `audit_log_select` exige role `admin` no tenant, e esta
 * tela é de quem opera o agente (`manager`, mesma régua da aba de execuções).
 * Servir a leitura com o client do usuário devolveria zero linhas para um
 * manager — "nunca usada" indistinguível de "você não pode ver", que é o pior
 * tipo de mentira que uma tela pode contar. O que sai daqui é agregado: nome da
 * capacidade e contagens, nunca o `metadata` cru do audit (que carrega os
 * argumentos da chamada). `organization_id` vem do cookie via `requireRole` e
 * filtra explicitamente, como manda o CLAUDE.md para todo uso de service role.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  montarUsoDeCapacidades,
  resumirUso,
  termosSemResultado,
  type LinhaDeTermo,
  type LinhaDeUso,
} from "@/lib/ai/agents/uso-de-capacidades";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("manager", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const parsed = querySchema.safeParse({
    days: req.nextUrl.searchParams.get("days") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Janela inválida."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const janelaEmDias = parsed.data.days;
  const desde = new Date(Date.now() - janelaEmDias * 86_400_000).toISOString();

  const admin = createAdminClient();

  // O agente existe NESTA organização? Sem esta checagem o service role
  // responderia sobre agente de outro tenant.
  const { data: agente, error: erroAgente } = await admin
    .from("ai_agents")
    .select("id, published_version_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (erroAgente) return fail("internal_error", "Erro ao carregar o agente.", 500, { requestId });
  if (!agente) return fail("not_found", t("Agente não encontrado."), 404, { requestId });

  // O que está VALENDO: a versão publicada. Sem publicada, o rascunho mais
  // recente — é o que o humano tem na frente na aba de configuração.
  const { data: versao } = agente.published_version_id
    ? await admin
        .from("ai_agent_versions")
        .select("id, tool_ids, status, created_at")
        .eq("organization_id", activeOrg.orgId)
        .eq("id", agente.published_version_id)
        .maybeSingle()
    : await admin
        .from("ai_agent_versions")
        .select("id, tool_ids, status, created_at")
        .eq("organization_id", activeOrg.orgId)
        .eq("agent_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

  const ligadas = ((versao?.tool_ids as string[] | null) ?? []).filter(
    (t): t is string => typeof t === "string",
  );

  const { data: linhas, error: erroUso } = await admin.rpc("fn_agent_tool_usage", {
    p_organization_id: activeOrg.orgId,
    p_agent_id: id,
    p_since: desde,
  });
  if (erroUso) {
    return fail("internal_error", "Erro ao ler o uso das capacidades.", 500, { requestId });
  }

  // A leitura POR TERMO (#484, caminho 2): "crm_search_products falhou 12×" não
  // diz QUAL termo não foi encontrado. A irmã de `fn_agent_tool_usage` agrupa por
  // (`tool_name`, `metadata.termo`), que a tool passa a declarar (`termoBuscado`);
  // aqui vira a lista do que NÃO acharam, para o dono saber se falta cadastro ou
  // se a busca erra sempre no mesmo termo. Erro nesta leitura NÃO derruba a tela:
  // o uso por capacidade continua vindo, e a lista volta vazia.
  const { data: linhasPorTermo, error: erroTermo } = await admin.rpc(
    "fn_agent_tool_usage_por_termo",
    {
      p_organization_id: activeOrg.orgId,
      p_agent_id: id,
      p_since: desde,
    },
  );
  if (erroTermo) {
    logger.warn("leitura por termo do uso das capacidades falhou", {
      organization_id: activeOrg.orgId,
      agent_id: id,
      erro: erroTermo.message,
    });
  }
  const termos_sem_resultado = termosSemResultado(
    ((linhasPorTermo ?? []) as LinhaDeTermo[]).map((l) => ({
      tool_name: l.tool_name,
      termo: l.termo,
      total: Number(l.total),
      falhas: Number(l.falhas),
      ultima_vez: l.ultima_vez,
    })),
  );

  const capacidades = montarUsoDeCapacidades({
    ligadas,
    catalogo: TOOL_CATALOG.map((t) => ({
      name: t.name,
      rotulo: t.rotulo,
      o_que_toca: t.oQueToca,
      risco: t.risco,
    })),
    linhas: ((linhas ?? []) as LinhaDeUso[]).map((l) => ({
      tool_name: l.tool_name,
      total: Number(l.total),
      falhas: Number(l.falhas),
      em_teste: Number(l.em_teste),
      ultima_vez: l.ultima_vez,
    })),
    janelaEmDias,
    // Sem isto, uma configuração feita agora recebe "nunca usada nos últimos 30
    // dias, considere desligar" — conselho de desligar o que o dono acabou de
    // ligar.
    configuradaEm: (versao?.created_at as string | undefined) ?? null,
  });

  return ok(
    {
      janela_em_dias: janelaEmDias,
      versao_lida: versao
        ? { id: versao.id as string, status: versao.status as string }
        : null,
      resumo: resumirUso(capacidades),
      capacidades,
      // (#484, caminho 2) O que NÃO acharam, por termo, do mais problemático ao
      // menos. Vazio = ninguém buscou nada que não exista na janela.
      termos_sem_resultado,
    },
    { requestId },
  );
}
