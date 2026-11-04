/**
 * GET/POST /api/v1/phone-numbers — números/DID de voz da org ativa.
 *
 * Espelha app/api/v1/calls/route.ts: `manager`+, RLS-scoped (createClient,
 * não admin), audit no create. `trunk_endpoint` nunca vem do body — é infra
 * compartilhada (mesmo Asterisk pra toda a plataforma hoje), não escolha da
 * organização; grava o valor de VOIP_TRUNK_ENDPOINT.
 */
import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createPhoneNumberSchema } from "@/lib/schemas/phone-numbers";
import { validateRequest } from "@/lib/schemas/_validate";
import { createClient } from "@/lib/supabase/server";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { autorDe, existeNaOrganizacao } from "@/lib/api/token-operacao";
import { extractBearer } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

// COLUMNS carrega o embed (join) pra LISTAGEM. Numa insert().select() o
// supabase-js não infere bem o tipo do embed junto da mutação -- MUTATION_COLUMNS
// devolve só as colunas próprias; o front reconsulta a lista via
// invalidateQueries de qualquer forma, então o `agent` populado chega no
// próximo GET, não precisa vir na resposta da mutação.
const COLUMNS =
  "id, number, label, routing_mode, default_ai_agent_id, is_active, created_at, " +
  "agent:ai_agents(id, name)";
const MUTATION_COLUMNS =
  "id, number, label, routing_mode, default_ai_agent_id, is_active, created_at";

/**
 * Com Bearer: `mcp:read` e papel `manager`, o da sessão. Sem o embed do agente
 * (`agent:ai_agents`): a service role não passa pela RLS e a chave estrangeira não
 * confere organização. O nome do agente vem de consulta própria da organização.
 */
async function listarPeloToken(req: NextRequest, requestId: string): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "phone_numbers",
    role: "manager",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "phone_numbers_list", requestId);
  if (teto) return teto;

  const { data, error } = await authz.supabase
    .from("phone_numbers")
    .select(MUTATION_COLUMNS)
    .eq("organization_id", authz.organizationId)
    .order("created_at", { ascending: true });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const linhas = data ?? [];
  const idsDeAgente = linhas
    .map((l) => l.default_ai_agent_id as string | null)
    .filter((id): id is string => typeof id === "string");
  const agentes = new Map<string, { id: string; name: string }>();
  if (idsDeAgente.length > 0) {
    const { data: ags } = await authz.supabase
      .from("ai_agents")
      .select("id, name")
      .eq("organization_id", authz.organizationId)
      .in("id", idsDeAgente);
    for (const a of ags ?? []) {
      agentes.set(a.id as string, { id: a.id as string, name: a.name as string });
    }
  }
  return ok(
    linhas.map((l) => {
      const agenteId = l.default_ai_agent_id as string | null;
      return { ...l, agent: agenteId ? (agentes.get(agenteId) ?? null) : null };
    }),
    { requestId },
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (extractBearer(req.headers.get("authorization"))) return listarPeloToken(req, requestId);
  const authz = await requireRole("manager", { requestId, resource: "phone_numbers" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("phone_numbers")
    .select(COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: true });

  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

/**
 * Com Bearer: `mcp:write` e papel `manager`. O agente padrão do corpo (se houver)
 * tem de ser da organização do token. Corpo, troncal e 23505 seguem as da sessão.
 */
async function criarPeloToken(req: NextRequest, requestId: string): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "phone_numbers",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "phone_numbers_create", requestId);
  if (teto) return teto;
  const organizationId = authz.organizationId;

  let input;
  try {
    input = await validateRequest(createPhoneNumberSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const trunkEndpoint = process.env.VOIP_TRUNK_ENDPOINT;
  if (!trunkEndpoint) {
    return fail("voip_nao_configurado", "Troncal de voz não configurado no servidor.", 500, { requestId });
  }
  const agenteId = input.default_ai_agent_id;
  if (agenteId && !(await existeNaOrganizacao(authz.supabase, "ai_agents", organizationId, agenteId))) {
    return fail("not_found", "Agente não encontrado.", 404, { requestId });
  }

  const { data: row, error } = await authz.supabase
    .from("phone_numbers")
    .insert({
      organization_id: organizationId,
      number: input.number,
      label: input.label ?? null,
      trunk_endpoint: trunkEndpoint,
      routing_mode: input.routing_mode,
      default_ai_agent_id: input.default_ai_agent_id ?? null,
      is_active: input.is_active,
    })
    .select(MUTATION_COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("numero_ja_cadastrado", "Esse número já está cadastrado.", 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  await audit({
    action: "phone_number.created",
    actorUserId: autorDe(authz),
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId,
    resourceType: "phone_numbers",
    resourceId: row.id,
    requestId,
    metadata: { number: input.number },
  });

  return ok(row, { status: 201, requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  // Guarda de EFEITO do acompanhamento administrativo, ANTES do RBAC e do
  // client de service role: quem está só ACOMPANHANDO a organização de outra
  // pessoa não escreve por ela. Sem esta linha, um acompanhamento somente
  // leitura originava ligação, cadastrava número e trocava a credencial do
  // tronco — em nome do cliente, com a trilha apontando para ele.
  const acompanhamentoNegado = await requireSupportWrite();
  if (acompanhamentoNegado) return acompanhamentoNegado;

  const requestId = randomUUID();
  if (extractBearer(req.headers.get("authorization"))) return criarPeloToken(req, requestId);
  const authz = await requireRole("manager", { requestId, resource: "phone_numbers" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(createPhoneNumberSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const trunkEndpoint = process.env.VOIP_TRUNK_ENDPOINT;
  if (!trunkEndpoint) {
    return fail("voip_nao_configurado", "Troncal de voz não configurado no servidor.", 500, { requestId });
  }

  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("phone_numbers")
    .insert({
      organization_id: activeOrg.orgId,
      number: input.number,
      label: input.label ?? null,
      trunk_endpoint: trunkEndpoint,
      routing_mode: input.routing_mode,
      default_ai_agent_id: input.default_ai_agent_id ?? null,
      is_active: input.is_active,
    })
    .select(MUTATION_COLUMNS)
    .single();

  if (error) {
    // uniq em `number` é GLOBAL (uma linha do trunk único, não por org) — 23505
    // aqui quase sempre é "esse DID já pertence a outra organização".
    if (error.code === "23505") {
      return fail("numero_ja_cadastrado", "Esse número já está cadastrado.", 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  await audit({
    action: "phone_number.created",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "phone_numbers",
    resourceId: row.id,
    requestId,
    metadata: { number: input.number },
  });

  return ok(row, { status: 201, requestId });
}
