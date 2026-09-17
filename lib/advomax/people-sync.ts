import type { createAdminClient } from "@/lib/supabase/admin";
import { canonicalPhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import { parseDialablePhone } from "@/lib/messaging/contact-card";
import { z } from "zod";

export type PessoaAdvomax = {
  codigo: number;
  nome: string;
  email?: string | null;
  telefone?: string | null;
  cliente: boolean;
};

export type PessoaSyncStats = {
  encontrados: number;
  criados: number;
  atualizados: number;
  vinculados: number;
  ignorados: number;
  conflitos: number;
};

export const PEOPLE_PAGE_SIZE = 200;
const PHONE_LOOKUP_BATCH_SIZE = 60;
const emailSchema = z.string().trim().email().max(254);

export async function buscarPessoasAdvomax(email: string, organizationId: string, offset: number): Promise<PessoaAdvomax[] | null> {
  const base = process.env.ADVOMAX_API_URL?.replace(/\/$/, "");
  const key = process.env.ADVOMAX_CRM_INTEGRATION_KEY?.trim();
  if (!base || !key) return null;
  const params = new URLSearchParams({ somenteClientes: "true", offset: String(offset), limite: String(PEOPLE_PAGE_SIZE) });
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
  if (!Array.isArray(page) || page.length > PEOPLE_PAGE_SIZE || !page.every((p) =>
    p && typeof p === "object" && Number.isSafeInteger(p.codigo) && typeof p.nome === "string" &&
    typeof p.cliente === "boolean" && (p.telefone == null || typeof p.telefone === "string") &&
    (p.email == null || typeof p.email === "string")
  )) return null;
  return page;
}

export function prepararClientesAdvomax(pessoas: PessoaAdvomax[]) {
  return pessoas
    .filter((p) => p.cliente && Number.isSafeInteger(p.codigo) && p.codigo > 0)
    .map((p) => {
      const digits = p.telefone?.replace(/\D/g, "") ?? "";
      if (!digits) return { ...p, telefone: null };
      const comPais = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
      const telefone = parseDialablePhone(comPais);
      return { ...p, telefone: telefone ? canonicalPhoneBR(telefone) : null };
    });
}

export function emailValidoOuNull(email: string | null | undefined): string | null {
  const resultado = emailSchema.safeParse(email);
  return resultado.success ? resultado.data : null;
}

export function lotesDeTelefones(telefones: string[]): string[][] {
  const lotes: string[][] = [];
  for (let i = 0; i < telefones.length; i += PHONE_LOOKUP_BATCH_SIZE) {
    lotes.push(telefones.slice(i, i + PHONE_LOOKUP_BATCH_SIZE));
  }
  return lotes;
}

type Admin = ReturnType<typeof createAdminClient>;
type LinkRow = { pessoa_codigo: number; contact_id: string; status?: string };
type ContactRow = {
  id: string;
  name: string | null;
  display_name: string | null;
  email: string | null;
  phone_number: string | null;
  source: string | null;
  source_metadata: Record<string, unknown> | null;
  is_anonymized?: boolean;
};

/**
 * Syncs one Gestão page. Advomax is authoritative only for contacts explicitly
 * created by this sync; manually linked CRM contacts keep their local fields.
 */
export async function sincronizarClientesAdvomax(
  admin: Admin,
  organizationId: string,
  userId: string | null,
  pessoas: PessoaAdvomax[],
): Promise<PessoaSyncStats | { error: string }> {
  const candidatos = prepararClientesAdvomax(pessoas);
  const origemPorCodigo = new Map(pessoas.map((pessoa) => [pessoa.codigo, pessoa]));
  const codigos = candidatos.map((p) => p.codigo);
  const variantes = [...new Set(candidatos.flatMap((p) => p.telefone ? phoneLookupVariants(p.telefone) : []))];
  const linksPromise = codigos.length
    ? admin.from("advomax_contact_links").select("pessoa_codigo,contact_id,status")
      .eq("organization_id", organizationId).in("pessoa_codigo", codigos)
    : Promise.resolve({ data: [], error: null });
  const contatosResultados = await Promise.all(lotesDeTelefones(variantes).map((lote) =>
    admin.from("contacts").select("id,phone_number,name,display_name,email,source,source_metadata,is_anonymized")
      .eq("organization_id", organizationId).is("is_merged_into", null).in("phone_number", lote),
  ));
  const { data: links, error: linksError } = await linksPromise;
  const contactsError = contatosResultados.find((resultado) => resultado.error)?.error;
  if (linksError || contactsError) return { error: "Não foi possível conferir os contatos existentes." };

  const typedLinks = (links ?? []) as LinkRow[];
  const linkedContactIds = [...new Set(typedLinks.map((row) => row.contact_id))];
  const linkedContactsResult = linkedContactIds.length
    ? await admin.from("contacts").select("id,phone_number,name,display_name,email,source,source_metadata,is_anonymized")
      .eq("organization_id", organizationId).in("id", linkedContactIds)
    : { data: [], error: null };
  if (linkedContactsResult.error) return { error: "Não foi possível conferir os contatos vinculados." };

  const contatos = contatosResultados.flatMap((resultado) => resultado.data ?? []) as unknown as ContactRow[];
  const linkedContacts = (linkedContactsResult.data ?? []) as unknown as ContactRow[];
  const contatoPorId = new Map(linkedContacts.map((row) => [row.id, row]));
  const porTelefone = new Map<string, string | null>();
  for (const row of contatos) {
    for (const variante of phoneLookupVariants(row.phone_number ?? "")) {
      if (!porTelefone.has(variante)) {
        porTelefone.set(variante, row.id);
      } else if (porTelefone.get(variante) !== row.id) {
        // Keep an ambiguous number ambiguous even when a third duplicate is found.
        porTelefone.set(variante, null);
      }
    }
  }
  const linkPorPessoa = new Map(typedLinks.map((row) => [Number(row.pessoa_codigo), row]));
  const agora = new Date().toISOString();
  const stats: PessoaSyncStats = { encontrados: candidatos.length, criados: 0, atualizados: 0, vinculados: 0, ignorados: 0, conflitos: 0 };

  for (const pessoa of candidatos) {
    const link = linkPorPessoa.get(pessoa.codigo);
    if (link) {
      if (link.status !== "linked") { stats.ignorados++; continue; }
      const contato = contatoPorId.get(link.contact_id);
      if (!contato || contato.is_anonymized) { stats.conflitos++; continue; }
      if (contato.source_metadata?.advomax_pessoa_codigo === pessoa.codigo) {
        const origem = origemPorCodigo.get(pessoa.codigo);
        const telefoneBruto = origem?.telefone;
        const telefoneInvalido = typeof telefoneBruto === "string" && telefoneBruto.trim() !== "" && pessoa.telefone === null;
        const emailBruto = origem?.email;
        const emailInformado = typeof emailBruto === "string" ? emailBruto.trim() : "";
        const email = emailBruto === undefined ? contato.email : emailValidoOuNull(emailBruto);
        const emailInvalido = emailBruto != null && emailInformado !== "" && email === null;
        if (telefoneInvalido) stats.conflitos++;
        if (emailInvalido) stats.conflitos++;
        const patch: Record<string, unknown> = {};
        if (contato.name !== pessoa.nome) patch.name = pessoa.nome;
        if (contato.display_name !== pessoa.nome) patch.display_name = pessoa.nome;
        if (!telefoneInvalido && contato.phone_number !== pessoa.telefone) patch.phone_number = pessoa.telefone;
        if (pessoa.email !== undefined && !emailInvalido && contato.email !== email) patch.email = email;
        if (Object.keys(patch).length) {
          const { error } = await admin.from("contacts").update(patch).eq("id", contato.id).eq("organization_id", organizationId);
          if (error?.code === "23505") { stats.conflitos++; continue; }
          if (error) return { error: "Não foi possível atualizar um contato." };
          stats.atualizados++;
        }
      } else {
        stats.ignorados++;
      }
      const { error: linkSyncError } = await admin.from("advomax_contact_links").update({ last_synced_at: agora })
        .eq("organization_id", organizationId).eq("pessoa_codigo", pessoa.codigo).eq("contact_id", link.contact_id);
      if (linkSyncError) return { error: "Não foi possível atualizar um vínculo." };
      continue;
    }

    const resultadosTelefone = pessoa.telefone
      ? phoneLookupVariants(pessoa.telefone).map((variant) => porTelefone.get(variant))
      : [];
    if (resultadosTelefone.includes(null)) {
      stats.conflitos++;
      continue;
    }
    const contactId = resultadosTelefone.find((id): id is string => Boolean(id));
    let resolvedContactId = contactId;
    if (!resolvedContactId) {
      const { data: contato, error } = await admin.from("contacts").insert({
        organization_id: organizationId,
        created_by_user_id: userId,
        name: pessoa.nome,
        display_name: pessoa.nome,
        email: emailValidoOuNull(pessoa.email),
        phone_number: pessoa.telefone,
        source: "advomax",
        source_metadata: { advomax_pessoa_codigo: pessoa.codigo },
        consent: {},
        tags: [],
      }).select("id").single();
      if (error?.code === "23505") { stats.conflitos++; continue; }
      if (error || !contato) return { error: "Não foi possível gravar um contato." };
      resolvedContactId = contato.id as string;
      stats.criados++;
      if (pessoa.telefone) {
        for (const variante of phoneLookupVariants(pessoa.telefone)) porTelefone.set(variante, resolvedContactId);
      }
    }
    const { error: linkError } = await admin.from("advomax_contact_links").insert({
      organization_id: organizationId,
      contact_id: resolvedContactId,
      pessoa_codigo: pessoa.codigo,
      status: "linked",
      authority_source: "advomax",
      last_synced_at: agora,
      created_by: userId,
    });
    if (linkError?.code === "23505") stats.conflitos++;
    else if (linkError) return { error: "Não foi possível vincular um contato." };
    else stats.vinculados++;
  }
  return stats;
}
