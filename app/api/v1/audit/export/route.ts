/**
 * GET /api/v1/audit/export — CSV export of audit entries (up to 10k rows).
 *
 * Same filters as /api/v1/audit. Lê em PÁGINAS de 1.000 (`max_rows` do
 * PostgREST), em ordem estável (`created_at`, `id`): o `.limit(10_000)` antigo
 * devolvia 1.000 linhas CALADAS — o cabeçalho prometia 10k e o arquivo saía
 * pela metade, sem aviso. Use sparingly.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { auditQuerySchema } from "@/lib/schemas/audit";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * Página = `max_rows` (1000, `supabase/config.toml`): pedir mais devolve 1000
 * caladas. O fim é provado pelo `count` exato ou por página VAZIA — página
 * curta não é fim numa instalação com `max_rows` menor que a página
 * (`lib/agenda/protecao-followup.ts`).
 */
const TAMANHO_DA_PAGINA = 1000;
const TETO_DO_EXPORT = 10_000;

const COLUNAS =
  "id, created_at, actor_user_id, action, resource_type, resource_id, request_id, actor_ip, metadata";

interface LinhaDeAuditoria {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string | null;
  actor_ip: string | null;
  metadata: unknown;
}

const HEADER = [
  "id",
  "created_at",
  "actor_user_id",
  "action",
  "resource_type",
  "resource_id",
  "request_id",
  "actor_ip",
  "metadata",
];

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "audit",
    allowPlatformAdmin: "leitura",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  // Force a high limit for export, ignore caller's `limit`.
  const parsed = auditQuerySchema.safeParse({ ...params, limit: undefined });
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const q = parsed.data;

  const supabase = await createClient();

  const rows: LinhaDeAuditoria[] = [];
  let totalNaJanela: number | null = null;
  let acabou = false;
  for (let pagina = 0; rows.length < TETO_DO_EXPORT && !acabou; pagina++) {
    const inicio = rows.length;
    let query = supabase
      .from("api_audit_log")
      .select(COLUNAS, pagina === 0 ? { count: "exact" } : undefined)
      .eq("organization_id", activeOrg.orgId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (q.actor_id) query = query.eq("actor_user_id", q.actor_id);
    if (q.action) query = query.ilike("action", `%${q.action}%`);
    if (q.resource_type) query = query.eq("resource_type", q.resource_type);
    if (q.from) query = query.gte("created_at", q.from);
    if (q.to) query = query.lte("created_at", q.to);

    // `range` fecha a cadeia (dispara a requisição) — depois dele só o `await`.
    // A última página pede só o que falta até o teto: com `max_rows` menor que a
    // página, uma faixa cheia passaria das 10.000 (10.200 com `max_rows` 300).
    const pedaco = Math.min(TAMANHO_DA_PAGINA, TETO_DO_EXPORT - inicio);
    query = query.range(inicio, inicio + pedaco - 1);

    const { data, error, count } = await query;
    if (error) return fail("internal_error", error.message, 500, { requestId });
    if (pagina === 0) totalNaJanela = count;
    const lote = (data ?? []) as unknown as LinhaDeAuditoria[];
    rows.push(...lote);
    acabou = lote.length === 0 || (totalNaJanela !== null && rows.length >= totalNaJanela);
  }

  const lines = [HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.created_at,
        r.actor_user_id,
        r.action,
        r.resource_type,
        r.resource_id,
        r.request_id,
        r.actor_ip,
        r.metadata,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  const csv = lines.join("\n") + "\n";
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      "X-Request-Id": requestId,
    },
  });
}
