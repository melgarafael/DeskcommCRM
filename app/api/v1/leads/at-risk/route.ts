/**
 * Radar de Risco (desilhamento C1 — doutrina do sistema vivo). GET → demandas
 * ABERTAS (`crm_leads.status='open'`) que esfriaram, para o humano ver o que está
 * morrendo sem ninguém olhar. Enriquece com follow-up agendado (`cron_jobs` kind='at')
 * — se a IA prometeu voltar, a demanda está "em voo", não abandonada. Ver
 * docs/doctrine/sistema-vivo.md.
 *
 * A montagem do radar vive em `lib/leads/radar-de-risco.ts`, compartilhada com a
 * capacidade que a IA usa para consultar quem esfriou (IA 360 · wave 2): a tela e
 * o agente têm de dizer a MESMA coisa sobre o mesmo negócio.
 *
 * Client de sessão preserva RLS; organização e papel vêm de requireRole, nunca do body.
 *
 * COM TOKEN (`mcp:read`, `agent`; Spec 33, R2, receita B): o ramo do Bearer chama a
 * mesma montagem com a service role e a organização da LINHA DO TOKEN, sem
 * `humanRole`: a visão é a da organização inteira, a mesma da capacidade MCP do
 * radar. `carregaRadarDeRisco` filtra `organization_id` em toda consulta. A
 * sessão segue byte a byte igual (`requireRole("agent")`, client de sessão).
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { Role } from "@/lib/auth/types";
import { carregaRadarDeRisco, RADAR_MIN_HOURS_PADRAO } from "@/lib/leads/radar-de-risco";
import { extractBearer } from "@/lib/mcp/auth";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  min_hours: z.coerce.number().int().min(0).max(2000).default(RADAR_MIN_HOURS_PADRAO),
});

export type { AtRiskLead } from "@/lib/leads/radar-de-risco";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (extractBearer(req.headers.get("authorization"))) {
    const dual = await resolveAuthDual(req, {
      requestId,
      resource: "leads_at_risk",
      role: "agent",
      scope: "mcp:read",
      // Sem `humanRole` o radar devolve a organização inteira; na sessão o agent
      // só vê o que a RLS libera. O token lê tudo, então exige `manager`.
      tokenRole: "manager",
    });
    if (!dual.ok) return dual.response;
    const teto = await tetoDeEscritaDoToken(dual, "leads_at_risk", requestId);
    if (teto) return teto;
    return responder(req, requestId, async () => dual.supabase, dual.organizationId, undefined, (texto) =>
      traduzir(texto, dual.idioma ?? IDIOMA_PADRAO),
    );
  }

  const authz = await requireRole("agent", { requestId, resource: "leads_at_risk" });
  if (!authz.ok) return authz.response;
  return responder(
    req,
    requestId,
    () => createClient(),
    authz.org.orgId,
    authz.org.role,
    (texto) => traduzir(texto, authz.user.idioma),
  );
}

/** O corpo do GET, igual nos dois modos: só o cliente, a organização e o papel mudam. */
async function responder(
  req: NextRequest,
  requestId: string,
  abrirDb: () => Promise<SupabaseClient>,
  organizationId: string,
  humanRole: Role | undefined,
  t: (texto: string) => string,
): Promise<Response> {
  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { limit, min_hours } = parsed.data;

  try {
    const radar = await carregaRadarDeRisco(await abrirDb(), {
      organizationId,
      ...(humanRole ? { humanRole } : {}),
      limit,
      minHours: min_hours,
    });
    return ok(radar, { requestId });
  } catch {
    return fail("internal_error", t("Falha ao carregar o radar."), 500, { requestId });
  }
}
