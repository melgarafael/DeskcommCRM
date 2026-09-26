/**
 * Épico Operação Visível (F1) — central de avisos do agente.
 * GET → agent_inbox_items da org (default: abertos). Abertos: os mais graves
 * primeiro e, entre iguais, os mais recentes; resolvidos/todos: mais recente
 * primeiro (é histórico, não fila).
 * Itens de plataforma (organization_id null) são do operador do sistema, não
 * do tenant — nunca entram aqui.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { resolverDestinosDosAvisos } from "@/lib/ai/inbox-destino";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/** Ordem da fila aberta: a camada de cima sai inteira antes da seguinte. */
const GRAVIDADES = ["critical", "warn", "info"] as const;

const querySchema = z.object({
  status: z.enum(["open", "ack", "resolved", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_inbox_items" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { status, limit } = parsed.data;

  const admin = createAdminClient();
  const buscar = (severity?: (typeof GRAVIDADES)[number]) => {
    let query = admin
      .from("agent_inbox_items")
      .select("id, kind, severity, title, body, ref_kind, ref_id, status, created_at")
      .eq("organization_id", org.orgId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (status !== "all") query = query.eq("status", status);
    if (severity) query = query.eq("severity", severity);
    return query;
  };
  // Ordenar em memória os N mais recentes esconderia um crítico mais antigo
  // que não coube nos N: a fila aberta é buscada POR CAMADA de gravidade.
  // ponytail: até 3×limit linhas lidas para devolver `limit`; consulta
  // sequencial que para quando enche, se um dia pesar.
  const resultados = await Promise.all(
    status === "open" ? GRAVIDADES.map((g) => buscar(g)) : [buscar()],
  );
  if (resultados.some((r) => r.error)) {
    return fail("internal_error", t("Falha ao carregar os avisos."), 500, { requestId });
  }
  const data = resultados.flatMap((r) => r.data ?? []).slice(0, limit);

  const { count: openCount } = await admin
    .from("agent_inbox_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org.orgId)
    .eq("status", "open");

  const items = await resolverDestinosDosAvisos(await createClient(), org.orgId, org.role, data);
  return ok({ items, open_count: openCount ?? 0 }, { requestId });
}
