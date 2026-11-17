/**
 * GET  /api/v1/campaign-suppressions — quem está fora de toda campanha.
 * POST /api/v1/campaign-suppressions — põe um número na lista.
 *
 * ═══ O que esta lista NÃO é ═══
 *
 * Não é opt-out. O opt-out é do TITULAR e vive em `contacts.is_blocked`, e ele
 * cala o produto inteiro para aquela pessoa. Esta lista é decisão de quem OPERA
 * ("não mande campanha para este número") e não toca no atendimento: se a pessoa
 * escrever, o agente responde como sempre.
 *
 * O telefone entra como HASH. A resposta devolve só os últimos dígitos — o
 * suficiente para quem cadastrou reconhecer a linha, sem transformar a lista de
 * "não mandar" num segundo lugar onde telefone de gente mora.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { enderecoValido, finalDoEndereco, hashDoEndereco } from "@/lib/campanhas/exclusoes";
import { criarExclusaoSchema } from "@/lib/campanhas/schemas";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLUNAS = "id, contact_id, address_tail, reason, source, created_at, created_by";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "campaign_suppressions",
    role: "manager",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "campaign_suppressions_lista", requestId);
  if (teto) return teto;
  const org = { orgId: authz.organizationId };

  const supabase = authz.supabase;
  const { data, error } = await supabase
    .from("campaign_suppressions")
    .select(COLUNAS)
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "campaign_suppressions",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "campaign_suppressions_criar", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const org = { orgId: authz.organizationId };
  const autor = authz.actor.type === "user" ? authz.actor.id : null;

  const parsed = criarExclusaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Informe um telefone."), 422, { requestId });
  }
  const { address, reason, contact_id } = parsed.data;

  if (!enderecoValido(address)) {
    return fail(
      "validation_failed",
      t("Telefone fora do formato de envio — use o número com DDI e DDD."),
      422,
      { requestId },
    );
  }

  const admin = createAdminClient();
  // O contato do corpo é conferido na organização ANTES de gravar, na sessão e no
  // token: o cliente admin não passa pela RLS, e a chave estrangeira simples não
  // confere organização. Sem isto, a supressão nasceria amarrada a contato alheio.
  if (contact_id) {
    const { data: contato, error: erroContato } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", org.orgId)
      .eq("id", contact_id)
      .maybeSingle();
    if (erroContato) return fail("internal_error", erroContato.message, 500, { requestId });
    if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });
  }
  const { data, error } = await admin
    .from("campaign_suppressions")
    .insert({
      organization_id: org.orgId,
      contact_id: contact_id ?? null,
      recipient_address_hash: hashDoEndereco(address),
      address_tail: finalDoEndereco(address),
      reason: reason ?? null,
      source: "manual",
      created_by: autor,
    })
    .select(COLUNAS)
    .single();
  if (error) {
    // Já estar na lista é o resultado que a pessoa queria: responder 409 aqui
    // faria uma ação idempotente parecer erro.
    if (error.code === "23505") {
      return ok({ ja_estava: true }, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: "campaign.suppression_added",
    actorUserId: autor,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: org.orgId,
    resourceType: "campaign_suppression",
    resourceId: (data as unknown as { id: string }).id,
    requestId,
    // Sem telefone no audit: os últimos dígitos bastam para reconhecer a linha.
    metadata: { final: finalDoEndereco(address) },
  });

  return ok(data, { requestId, status: 201 });
}
