/**
 * GET /api/v1/ai/agents/assignable — destinos de atribuição que são AGENTES
 * (CRM Vivo Wave 1 / migration 0070): o par de /api/v1/team/assignable, que
 * lista os humanos.
 *
 * Por que uma rota nova em vez de reusar GET /api/v1/ai/agents: aquela é
 * manager+ (configuração de agente, com system_prompt e guardrails). Um `agent`
 * (vendedor) precisa apenas escolher o destino de um negócio — mesma exceção
 * deliberada e MÍNIMA que a rota de humanos já documenta. Exposto o mínimo: id,
 * nome e a versão PUBLICADA no momento da leitura.
 *
 * Esta rota é um PICKER, e só isso: agente desligado não deve receber negócio
 * novo. Quem é o dono ATUAL de um lead é outra pergunta e NÃO se responde aqui
 * — vem resolvido do board (`owner_agent`), sem esses filtros. Relaxar o filtro
 * daqui para "consertar" um nome que não aparece no card é consertar no lugar
 * errado.
 *
 * ⚠️ O filtro era `.eq("is_active", true)`, e ele errava nos DOIS sentidos —
 * porque `is_active` não é "está ligado" para `mcp_agent`, que é o que a tela
 * cria:
 *
 *   - **escondia quem atende:** "Novo agente" grava `is_active: false`
 *     (`app/app/ai/agents/[id]/_actions.ts`) e publicar nunca religa. Todo
 *     agente criado pela tela e publicado ficava fora deste picker enquanto
 *     respondia no WhatsApp;
 *   - **oferecia quem não atende:** pausar limpa `published_version_id` e
 *     deixa `is_active` de pé, então o agente pausado seguia listado como
 *     destino de negócio.
 *
 * A régua agora é `agenteAtende` (`lib/ai/agents/no-ar.ts`), a mesma da tela e
 * dos workers.
 *
 * Auth: cookie session; organization_id vem do JWT — nunca do body/query.
 * RLS-scoped (createClient), sem admin client: não há nada aqui que a RLS do
 * tenant não deva mostrar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { agenteAtende } from "@/lib/ai/agents/no-ar";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export interface AssignableAgent {
  agent_id: string;
  name: string;
  /** null quando o agente ainda não tem versão publicada. */
  version_number: number | null;
}

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const supabase = await createClient();
  const { data: agents, error } = await supabase
    .from("ai_agents")
    .select("id, name, published_version_id, kind, is_active, paused_at, archived_at")
    .eq("organization_id", orgId)
    .is("archived_at", null)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  const rows = (
    (agents ?? []) as Array<{
      id: string;
      name: string;
      published_version_id: string | null;
      kind: string | null;
      is_active: boolean | null;
      paused_at: string | null;
      archived_at: string | null;
    }>
  ).filter(agenteAtende);

  const publishedIds = rows.map((a) => a.published_version_id).filter((v): v is string => !!v);
  const versionById = new Map<string, number>();
  if (publishedIds.length > 0) {
    const { data: versions, error: versionsErr } = await supabase
      .from("ai_agent_versions")
      .select("id, version_number")
      .eq("organization_id", orgId)
      .in("id", publishedIds);
    if (versionsErr) return fail("internal_error", versionsErr.message, 500, { requestId });
    for (const v of (versions ?? []) as Array<{ id: string; version_number: number }>) {
      versionById.set(v.id, v.version_number);
    }
  }

  const result: AssignableAgent[] = rows.map((a) => ({
    agent_id: a.id,
    name: a.name,
    version_number: a.published_version_id
      ? (versionById.get(a.published_version_id) ?? null)
      : null,
  }));

  return ok(result, { requestId });
}
