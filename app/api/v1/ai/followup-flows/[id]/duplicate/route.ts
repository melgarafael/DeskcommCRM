import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/:id/duplicate — clona o ponteiro (manager+).
 *
 * Copia rascunho (ou a versão no ar, se o rascunho estiver vazio), gatilho e
 * política de handoff. A cópia nasce SEMPRE `draft`, sem `active_version_id`:
 * duplicar não publica e não passa a mandar mensagem. Inscrições, versões e
 * vínculo com agente ficam no original — armar o clone no agente é o mesmo
 * passo extra da instalação de modelo.
 *
 * Nome recebe sufixo " (cópia)" (ou " (cópia N)" se o primeiro já existir).
 *
 * Sessão OU token de integração (Spec 33, R1): `config:write` e papel admin
 * (`tokenRole`). A organização sai de `authz.organizationId` e, no ramo do
 * token, o cliente é a service role: todo `organization_id` abaixo é escrito à
 * mão e é a única barreira entre duas organizações.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { nomeDaCopia } from "@/lib/followup/nome-da-copia";
import { rascunhoDoFluxo } from "@/lib/followup/rascunho";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const SOURCE_COLUMNS =
  "id, name, draft_graph, trigger_config, handoff_policy, send_when_assigned, surface, active_version_id";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "followup_flows",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "followup_flows", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { organizationId } = authz;
  const actorUserId = authz.actor.type === "user" ? authz.actor.id : null;

  const supabase = authz.supabase;
  const { data: origem, error: fetchErr } = await supabase
    .from("followup_flow_pointers")
    .select(SOURCE_COLUMNS)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!origem) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  const { data: nomes, error: nomesErr } = await supabase
    .from("followup_flow_pointers")
    .select("name")
    .eq("organization_id", organizationId);
  if (nomesErr) return fail("internal_error", nomesErr.message, 500, { requestId });

  const draft_graph = await rascunhoDoFluxo(
    supabase,
    origem as { draft_graph: unknown; active_version_id: string | null },
    organizationId,
  );

  const nome = nomeDaCopia(
    String(origem.name),
    (nomes ?? []).map((r) => String((r as { name: string }).name)),
  );

  const { data: copia, error: insErr } = await supabase
    .from("followup_flow_pointers")
    .insert({
      organization_id: organizationId,
      name: nome,
      status: "draft",
      draft_graph,
      trigger_config: origem.trigger_config,
      handoff_policy: origem.handoff_policy,
      // #3974 — a opção do fluxo viaja com a cópia; duplicar não pode voltar ao default sem avisar.
      send_when_assigned: origem.send_when_assigned === true,
      surface: origem.surface ?? "followup",
    })
    .select("*")
    .single();

  if (insErr || !copia) {
    if (insErr?.code === "23505") {
      return fail("conflict", t("Já existe um fluxo com este nome."), 409, { requestId });
    }
    return fail("internal_error", insErr?.message ?? "followup_flow_duplicate_failed", 500, {
      requestId,
    });
  }

  void audit({
    action: "followup_flow.duplicated",
    actorUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId,
    resourceType: "followup_flow_pointer",
    resourceId: copia.id,
    requestId,
    metadata: { source_pointer_id: id, name: nome },
  });

  return ok(copia, { requestId, status: 201 });
}
