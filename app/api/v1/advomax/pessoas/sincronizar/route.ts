import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { canonicalPhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import { parseDialablePhone } from "@/lib/messaging/contact-card";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type PessoaAdvomax = {
  codigo: number;
  nome: string;
  email?: string | null;
  telefone?: string | null;
  cliente: boolean;
};

export function prepararClientesAdvomax(pessoas: PessoaAdvomax[]) {
  return pessoas
    .filter((p) => p.cliente && p.telefone?.trim() && Number.isSafeInteger(p.codigo) && p.codigo > 0)
    .flatMap((p) => {
      const digits = p.telefone!.replace(/\D/g, "");
      const comPais = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
      const telefone = parseDialablePhone(comPais);
      return telefone ? [{ ...p, telefone: canonicalPhoneBR(telefone) }] : [];
    });
}

const PAGE_SIZE = 200;

async function pessoasDoAdvomax(email: string, organizationId: string, offset: number): Promise<PessoaAdvomax[] | null> {
  const base = process.env.ADVOMAX_API_URL?.replace(/\/$/, "");
  const key = process.env.ADVOMAX_CRM_INTEGRATION_KEY?.trim();
  if (!base || !key) return null;

  const params = new URLSearchParams({ somenteClientes: "true", offset: String(offset), limite: String(PAGE_SIZE) });
  const response = await fetch(`${base}/integracoes/crm/pessoas?${params}`, {
    headers: {
      "X-CRM-Integration-Key": key,
      "X-CRM-User-Email": email,
      "X-CRM-Organization-Id": organizationId,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) return null;
  const page = await response.json().catch(() => null);
  if (!Array.isArray(page) || page.length > PAGE_SIZE || !page.every((p) =>
    p && typeof p === "object" && Number.isSafeInteger(p.codigo) && typeof p.nome === "string" &&
    typeof p.cliente === "boolean" && (p.telefone == null || typeof p.telefone === "string")
  )) return null;
  return page;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "advomax_people_sync" });
  if (!authz.ok) return authz.response;

  const offset = Number(req.nextUrl.searchParams.get("offset") ?? "0");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000 || offset % PAGE_SIZE !== 0) {
    return fail("validation_failed", "Página inválida.", 422, { requestId });
  }

  const pessoas = await pessoasDoAdvomax(authz.user.email, authz.org.orgId, offset);
  if (!pessoas) return fail("bad_gateway", "Não foi possível sincronizar os clientes do Advomax.", 502, { requestId });

  const candidatos = prepararClientesAdvomax(pessoas);
  const admin = createAdminClient();
  const codigos = candidatos.map((p) => p.codigo);
  const variantes = [...new Set(candidatos.flatMap((p) => phoneLookupVariants(p.telefone)))];

  const [{ data: links, error: linksError }, { data: contatos, error: contactsError }] = await Promise.all([
    codigos.length
      ? admin.from("advomax_contact_links").select("pessoa_codigo,contact_id").eq("organization_id", authz.org.orgId).in("pessoa_codigo", codigos)
      : Promise.resolve({ data: [], error: null }),
    variantes.length
      ? admin.from("contacts").select("id,phone_number").eq("organization_id", authz.org.orgId).is("is_merged_into", null).in("phone_number", variantes)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (linksError || contactsError) return fail("internal_error", "Não foi possível conferir os contatos existentes.", 500, { requestId });

  const ligados = new Set((links ?? []).map((row) => Number(row.pessoa_codigo)));
  const porTelefone = new Map<string, string>();
  for (const row of contatos ?? []) {
    for (const variante of phoneLookupVariants(row.phone_number ?? "")) porTelefone.set(variante, row.id);
  }

  let criados = 0;
  let vinculados = 0;
  let conflitos = 0;
  for (const pessoa of candidatos) {
    if (ligados.has(pessoa.codigo)) continue;
    let contactId = phoneLookupVariants(pessoa.telefone).map((v) => porTelefone.get(v)).find(Boolean);
    if (!contactId) {
      const { data: contato, error } = await admin.from("contacts").insert({
        organization_id: authz.org.orgId,
        created_by_user_id: authz.user.id,
        name: pessoa.nome,
        display_name: pessoa.nome,
        email: pessoa.email?.trim() || null,
        phone_number: pessoa.telefone,
        source: "advomax",
        source_metadata: { advomax_pessoa_codigo: pessoa.codigo },
        consent: {},
        tags: [],
      }).select("id").single();
      if (error?.code === "23505") { conflitos += 1; continue; }
      if (error || !contato) return fail("internal_error", "Não foi possível gravar um contato.", 500, { requestId });
      const createdContactId = contato.id as string;
      contactId = createdContactId;
      criados += 1;
      for (const variante of phoneLookupVariants(pessoa.telefone)) porTelefone.set(variante, createdContactId);
    }
    const { error: linkError } = await admin.from("advomax_contact_links").insert({
      organization_id: authz.org.orgId,
      contact_id: contactId,
      pessoa_codigo: pessoa.codigo,
      status: "linked",
      authority_source: "advomax",
      last_synced_at: new Date().toISOString(),
      created_by: authz.user.id,
    });
    if (linkError?.code === "23505") conflitos += 1;
    else if (linkError) return fail("internal_error", "Não foi possível vincular um contato.", 500, { requestId });
    else vinculados += 1;
  }

  await audit({
    action: "contact.advomax_linked",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "advomax_contact_sync",
    metadata: { encontrados: candidatos.length, criados, vinculados, conflitos },
    requestId,
  });
  return ok({ encontrados: candidatos.length, criados, vinculados, conflitos, has_more: pessoas.length === PAGE_SIZE, next_offset: offset + pessoas.length }, { requestId });
}
