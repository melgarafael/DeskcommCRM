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
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { carregaRadarDeRisco, RADAR_MIN_HOURS_PADRAO } from "@/lib/leads/radar-de-risco";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  min_hours: z.coerce.number().int().min(0).max(2000).default(RADAR_MIN_HOURS_PADRAO),
});

export type { AtRiskLead } from "@/lib/leads/radar-de-risco";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "leads_at_risk" });
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
  const { limit, min_hours } = parsed.data;

  try {
    const radar = await carregaRadarDeRisco(await createClient(), {
      organizationId: org.orgId,
      humanRole: org.role,
      limit,
      minHours: min_hours,
    });
    return ok(radar, { requestId });
  } catch {
    return fail("internal_error", t("Falha ao carregar o radar."), 500, { requestId });
  }
}
