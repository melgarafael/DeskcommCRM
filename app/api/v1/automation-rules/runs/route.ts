/**
 * GET /api/v1/automation-rules/runs?limit=50 — histórico de execuções da ORG
 * inteira (cross-rule), desc. Usado pela aba Atividade (timeline global).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "automation_rules",
    role: "manager",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "automation_rules_runs_da_org", requestId);
  if (teto) return teto;

  const rawLimit = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT, MAX_LIMIT);

  const supabase = authz.supabase;

  // Sessão: o embed fica como estava (a RLS da sessão já limita as duas tabelas).
  if (authz.via === "session") {
    const { data, error } = await supabase
      .from("automation_rule_runs")
      .select("*, automation_rules(name)")
      .eq("organization_id", authz.organizationId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return fail("internal_error", error.message, 500, { requestId });
    return ok(data ?? [], { requestId });
  }

  // Token: o cliente é o admin, sem RLS, e um embed `automation_rules(name)` sairia
  // sem o filtro de organização. Por isso as execuções vêm numa consulta, e o nome
  // de cada regra, em outra, filtrada pela organização do token.
  const { data: execucoes, error } = await supabase
    .from("automation_rule_runs")
    .select("*")
    .eq("organization_id", authz.organizationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const linhas = execucoes ?? [];
  const idsDasRegras = [...new Set(linhas.map((linha) => String(linha.rule_id)))];
  const nomes = new Map<string, string>();
  if (idsDasRegras.length > 0) {
    const { data: regras, error: erroRegras } = await supabase
      .from("automation_rules")
      .select("id, name")
      .eq("organization_id", authz.organizationId)
      .in("id", idsDasRegras);
    if (erroRegras) return fail("internal_error", erroRegras.message, 500, { requestId });
    for (const regra of regras ?? []) nomes.set(String(regra.id), String(regra.name));
  }

  return ok(
    linhas.map((linha) => {
      const nome = nomes.get(String(linha.rule_id));
      return { ...linha, automation_rules: nome === undefined ? null : { name: nome } };
    }),
    { requestId },
  );
}
