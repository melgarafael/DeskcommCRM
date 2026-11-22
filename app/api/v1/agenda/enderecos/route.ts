import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { juntarEnderecos, normalizarEndereco, TETO_DE_ENDERECO } from "@/lib/agenda/enderecos";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { extractBearer } from "@/lib/mcp/auth";
import { createClient } from "@/lib/supabase/server";

const busca = z.object({ q: z.string().max(100).optional() });
const corpo = z.object({
  address: z.string().trim().min(1).max(TETO_DE_ENDERECO),
});

/**
 * Quem chama: a sessão (cookie) ou o token. O cliente do banco só é criado
 * DEPOIS da validação do corpo, como antes: pedido inválido não abre conexão.
 */
type Origem = {
  organizationId: string;
  actorUserId: string | null;
  apiTokenId: string | null;
  db: () => Promise<SupabaseClient>;
};

function ilike(q: string | undefined): string | undefined {
  const termo = q?.replace(/[%_]/g, "").trim();
  return termo ? `%${termo}%` : undefined;
}

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  if (extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, { requestId, resource: "agenda", role: "agent", scope: "mcp:read" });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "agenda_enderecos", requestId); if (teto) return teto;
    return listar(req, requestId, {
      organizationId: authz.organizationId,
      actorUserId: null,
      apiTokenId: authz.apiTokenId ?? null,
      db: async () => authz.supabase,
    });
  }
  const auth = await requireRole("agent", { requestId, resource: "agenda" });
  if (!auth.ok) return auth.response;
  return listar(req, requestId, {
    organizationId: auth.org.orgId,
    actorUserId: auth.user.id,
    apiTokenId: null,
    db: () => createClient(),
  });
}

async function listar(req: Request, requestId: string, origem: Origem): Promise<Response> {
  const input = busca.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!input.success) return fail("validation_failed", "Confira a busca.", 422, { requestId });

  const db = await origem.db();
  const org = origem.organizationId;
  const like = ilike(input.data.q);

  const salvosQ = db.from("calendar_locations").select("address").eq("organization_id", org);
  const tiposQ = db
    .from("calendar_event_types")
    .select("location_details")
    .eq("organization_id", org)
    .not("location_details", "is", null);
  const usadosQ = db
    .from("calendar_appointments")
    .select("location_details")
    .eq("organization_id", org)
    .not("location_details", "is", null);

  const [salvos, tipos, usados] = await Promise.all([
    (like ? salvosQ.ilike("address", like) : salvosQ).order("address").limit(50),
    (like ? tiposQ.ilike("location_details", like) : tiposQ).limit(50),
    (like ? usadosQ.ilike("location_details", like) : usadosQ)
      .order("starts_at", { ascending: false })
      .limit(50),
  ]);
  if (salvos.error || tipos.error || usados.error) {
    return fail("internal_error", "Não foi possível carregar os endereços.", 500, { requestId });
  }

  return ok(
    {
      addresses: juntarEnderecos(
        (salvos.data ?? []).map((l) => l.address),
        [
          ...(tipos.data ?? []).map((t) => t.location_details ?? ""),
          ...(usados.data ?? []).map((a) => a.location_details ?? ""),
        ],
        input.data.q ?? "",
      ),
    },
    { requestId },
  );
}

export async function POST(req: NextRequest) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  if (extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, { requestId, resource: "agenda", role: "agent", scope: "mcp:write" });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "agenda_enderecos", requestId); if (teto) return teto;
    return criar(req, requestId, {
      organizationId: authz.organizationId,
      actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
      apiTokenId: authz.apiTokenId ?? null,
      db: async () => authz.supabase,
    });
  }
  const auth = await requireRole("agent", { requestId, resource: "agenda" });
  if (!auth.ok) return auth.response;
  return criar(req, requestId, {
    organizationId: auth.org.orgId,
    actorUserId: auth.user.id,
    apiTokenId: null,
    db: () => createClient(),
  });
}

async function criar(req: Request, requestId: string, origem: Origem): Promise<Response> {
  const parsed = corpo.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Confira o endereço.", 422, { requestId });

  const address = normalizarEndereco(parsed.data.address);
  const db = await origem.db();
  const { data, error } = await db
    .from("calendar_locations")
    .insert({
      organization_id: origem.organizationId,
      address,
      // Coluna nullable no baseline: o token não tem pessoa, então o autor é nulo.
      created_by: origem.actorUserId,
    })
    .select("address")
    .single();

  if (error?.code === "23505") {
    return ok({ address, already_saved: true }, { requestId });
  }
  if (error) {
    return fail("internal_error", "Não foi possível salvar o endereço.", 500, { requestId });
  }

  void audit({
    action: "agenda.endereco_salvo",
    organizationId: origem.organizationId,
    actorUserId: origem.actorUserId,
    actorApiTokenId: origem.apiTokenId,
    requestId,
    resourceType: "calendar_location",
    metadata: { address },
  });
  return ok({ address: data?.address ?? address, already_saved: false }, { status: 201, requestId });
}
