"use server";
/**
 * Os ACESSOS que um contato deu a servidores MCP externos (OAuth por contato,
 * migration 9095) — a seção da ficha do contato, só para `admin`.
 *
 * A lista mostra servidor, escopos, desde quando e último uso. O token nunca:
 * nem aqui, nem no log, nem na auditoria. "Revogar" chama o `revocation_endpoint`
 * do terceiro (RFC 7009, melhor esforço) e esvazia a credencial no banco.
 * Organização da SESSÃO; contato e credencial conferidos dentro dela.
 */
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import {
  listarAcessosDoContato,
  revogarCredencialPorId,
  type AcessoDoContato,
} from "@/lib/mcp/servidor-externo/do-agente/credencial";
import { lerServidor } from "@/lib/mcp/servidor-externo/do-agente/registro";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Resultado<T> =
  | { ok: true; data: T }
  | { ok: false; error: "unauthenticated" | "forbidden_tenant" | "forbidden_role" | "validation_failed" | "inexistente" };

async function exigirAdmin(escrita: boolean) {
  const user = await loadAuthUser();
  if (!user) return { ok: false as const, error: "unauthenticated" as const };
  if (escrita && supportWriteError(user.support)) return { ok: false as const, error: "forbidden_role" as const };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false as const, error: "forbidden_tenant" as const };
  if (ROLE_RANK[org.role] < ROLE_RANK.admin) return { ok: false as const, error: "forbidden_role" as const };
  return { ok: true as const, user, orgId: org.orgId };
}

export async function listarAcessosMcpDoContato(contactId: string): Promise<Resultado<AcessoDoContato[]>> {
  const g = await exigirAdmin(false);
  if (!g.ok) return g;
  if (!UUID.test(contactId)) return { ok: false, error: "validation_failed" };
  return { ok: true, data: await listarAcessosDoContato(createAdminClient(), g.orgId, contactId) };
}

export async function revogarAcessoMcpDoContato(
  contactId: string,
  credencialId: string,
): Promise<Resultado<{ revogadaNoTerceiro: boolean }>> {
  const g = await exigirAdmin(true);
  if (!g.ok) return g;
  if (!UUID.test(contactId) || !UUID.test(credencialId)) return { ok: false, error: "validation_failed" };
  const admin = createAdminClient();
  const { data } = await admin
    .from("contato_mcp_credenciais")
    .select("id, servidor_id")
    .eq("organization_id", g.orgId)
    .eq("contact_id", contactId)
    .eq("id", credencialId)
    .is("revogado_em", null)
    .maybeSingle();
  const linha = data as { id: string; servidor_id: string } | null;
  if (!linha) return { ok: false, error: "inexistente" };
  const servidor = await lerServidor(admin, g.orgId, linha.servidor_id);
  if (!servidor) return { ok: false, error: "inexistente" };
  const r = await revogarCredencialPorId(admin, servidor, linha.id);
  if (!r) return { ok: false, error: "inexistente" };

  await audit({
    action: "contact.mcp_acesso_revogado",
    actorUserId: g.user.id,
    organizationId: g.orgId,
    resourceType: "contact",
    resourceId: contactId,
    metadata: { servidor_id: servidor.id, motivo: "manual", revogada_no_terceiro: r.revogadaNoTerceiro },
  });
  revalidatePath(`/app/contacts/${contactId}`);
  return { ok: true, data: r };
}
