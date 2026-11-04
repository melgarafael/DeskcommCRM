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
import { avisoVisivelPara, PAPEL_MINIMO_DA_CENTRAL, resolverDestinosDosAvisos } from "@/lib/ai/inbox-destino";
import { anexarLinkDePagamento } from "@/lib/cobranca/central";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/** Ordem da fila aberta: a camada de cima sai inteira antes da seguinte. */
const GRAVIDADES = ["critical", "warn", "info"] as const;
// Below the existing 10s browser transport budget; a stalled count must fail closed.
const PRAZO_DA_CONTAGEM_MS = 5_000;

const querySchema = z.object({
  status: z.enum(["open", "ack", "resolved", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole(PAPEL_MINIMO_DA_CENTRAL, { requestId, resource: "agent_inbox_items" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;
  // Aviso com destinatário (0689) só aparece para ele — na lista E no sino.
  const visivel = avisoVisivelPara(authz.user.id);

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
  // List and badge inherit the same channel/tenant RLS as retained episode recovery.
  const reader = await createClient();
  const buscar = (severity?: (typeof GRAVIDADES)[number]) => {
    let query = reader
      .from("agent_inbox_items")
      .select("id, kind, severity, title, body, ref_kind, ref_id, status, created_at")
      .eq("organization_id", org.orgId)
      .or(visivel)
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

  let openCount: number;
  try {
    const { count, error } = await reader
      .from("agent_inbox_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org.orgId)
      .or(visivel)
      .eq("status", "open")
      .abortSignal(AbortSignal.timeout(PRAZO_DA_CONTAGEM_MS));
    if (error || typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      return fail("unavailable", t("Falha ao carregar os avisos."), 503, { requestId });
    }
    openCount = count;
  } catch {
    return fail("unavailable", t("Falha ao carregar os avisos."), 503, { requestId });
  }

  const comDestino = await resolverDestinosDosAvisos(reader, org.orgId, org.role, data);
  const items = await anexarLinkDePagamento(admin, org.orgId, org.role, comDestino);
  return ok({ items, open_count: openCount }, { requestId });
}
