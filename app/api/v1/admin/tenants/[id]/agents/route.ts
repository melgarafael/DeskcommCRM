/**
 * O agente publicado de um tenant — a única leitura que faltava para a carteira.
 *
 * ─── Por que esta rota existe ──────────────────────────────────────────────
 *
 * `admin/usage` já entrega custo por cliente e `admin/tenants/[id]/health` já
 * entrega saúde (inclusive gasto de IA contra o teto). Nenhuma das duas responde
 * a pergunta que o operador faz antes de falar com o cliente: *qual agente está
 * publicado nele, e em que versão*. Sem isso a carteira lista clientes sem dizer
 * se estão atendendo.
 *
 * ─── Por que não reusa o MCP ───────────────────────────────────────────────
 *
 * O catálogo de tools é escopado por organização do token — ele responde pelo
 * tenant, não pela carteira. A visão de plataforma é outra pergunta e outra
 * guarda (`requirePlatformAdmin`), e é por isso que ela vive em `admin/`.
 *
 * ─── O que ele NÃO faz ─────────────────────────────────────────────────────
 *
 * Não publica, não edita, não duplica. É leitura. A escrita desta capacidade é
 * a fase B da spec 19 e ainda não existe — de propósito.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requirePlatformAdmin, type PlatformAdminContext } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

const paramsSchema = z.object({ id: z.string().uuid() });

/** A versão que o motor executa. `draft` nunca aparece aqui como publicada. */
export interface TenantAgentVersion {
  id: string;
  version_number: number;
  status: string;
  provider: string;
  model: string;
  published_at: string | null;
  provisioning_origin: string | null;
}

export interface TenantAgent {
  id: string;
  name: string;
  kind: string;
  is_active: boolean;
  is_default: boolean;
  priority: number;
  published_version_id: string | null;
  /**
   * `null` quando o agente não tem publicada — e isso é um valor de verdade,
   * não um erro: um agente em rascunho é exatamente o que o operador precisa
   * ver na carteira antes de dizer ao cliente que está no ar.
   */
  published_version: TenantAgentVersion | null;
}

export interface TenantAgentsResponse {
  organization_id: string;
  agents: TenantAgent[];
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) {
    return fail("validation_error", "Invalid tenant id", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const orgId = parsed.data.id;

  const admin = createAdminClient();

  // O tenant existe? Sem esta pergunta, organização inexistente devolveria
  // "lista vazia" — que a tela leria como "cliente sem agente" em vez de
  // "cliente que não existe".
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id")
    .eq("id", orgId)
    .maybeSingle();
  if (orgError) {
    return fail("db_error", "Failed to fetch organization", 500, { requestId });
  }
  if (!org) {
    return fail("not_found", "Organization not found", 404, { requestId });
  }

  // `archived_at is null` porque agente arquivado não atende — e listá-lo faria
  // o operador anunciar ao cliente um agente que não responde ninguém.
  const { data: agents, error: agentsError } = await admin
    .from("ai_agents")
    .select("id, name, kind, is_active, is_default, priority, published_version_id")
    .eq("organization_id", orgId)
    .is("archived_at", null)
    .order("priority", { ascending: false });
  if (agentsError) {
    return fail("db_error", "Failed to fetch agents", 500, { requestId });
  }

  const idsDeVersao = [
    ...new Set(
      (agents ?? [])
        .map((a) => a.published_version_id as string | null)
        .filter((v): v is string => v !== null),
    ),
  ];

  const versoes: Record<string, TenantAgentVersion> = {};
  if (idsDeVersao.length > 0) {
    // O `eq("organization_id")` aqui não é redundante: com service role, o
    // isolamento é responsabilidade desta rota. Sem ele, um id de versão
    // vazado de outra organização seria servido como se fosse deste cliente.
    const { data: linhas, error: versoesError } = await admin
      .from("ai_agent_versions")
      .select("id, version_number, status, provider, model, published_at, provisioning_origin")
      .eq("organization_id", orgId)
      .in("id", idsDeVersao);
    if (versoesError) {
      return fail("db_error", "Failed to fetch agent versions", 500, { requestId });
    }
    for (const linha of linhas ?? []) {
      versoes[linha.id as string] = linha as TenantAgentVersion;
    }
  }

  const lista: TenantAgent[] = (agents ?? []).map((a) => {
    const id = a.published_version_id as string | null;
    return {
      id: a.id as string,
      name: a.name as string,
      kind: a.kind as string,
      is_active: a.is_active as boolean,
      is_default: a.is_default as boolean,
      priority: a.priority as number,
      published_version_id: id,
      published_version: id ? (versoes[id] ?? null) : null,
    };
  });

  // Toda leitura de `admin/` é auditada neste repo, e o motivo vale aqui: o
  // operador acabou de olhar o agente que atende os clientes de outra pessoa.
  void audit({
    action: "platform_admin.tenant_agents_viewed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: { agents: lista.length },
  });

  return ok<TenantAgentsResponse>({ organization_id: orgId, agents: lista }, { requestId });
}
