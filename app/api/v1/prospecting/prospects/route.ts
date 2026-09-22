/**
 * GET /api/v1/prospecting/prospects — a tabela (§14 do plano).
 *
 * Filtros: categoria, cidade, estado, com_telefone, com_website,
 * com_whatsapp, nota_min, avaliacoes_min, origem(provider), status_comercial,
 * so_sem_cliente (ainda não é cliente), busca (nome/telefone/cidade/website).
 * "ja_e_cliente" sai por coluna computada: contact vinculado OU match por
 * telefone/email com contacts (batch, não N+1).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DO_PROSPECT, STATUS_COMERCIAL } from "@/lib/schemas/prospeccao";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "business_prospects" });
  if (!authz.ok) return authz.response;

  const p = req.nextUrl.searchParams;
  const categoria = p.get("categoria")?.trim() ?? "";
  const cidade = p.get("cidade")?.trim() ?? "";
  const estado = p.get("estado")?.trim() ?? "";
  const status = p.get("status")?.trim() ?? "";
  const origem = p.get("origem")?.trim() ?? "";
  const busca = p.get("busca")?.trim() ?? "";
  const comTelefone = p.get("com_telefone") === "true";
  const semTelefone = p.get("sem_telefone") === "true";
  const comWebsite = p.get("com_website") === "true";
  const semWebsite = p.get("sem_website") === "true";
  const comWhatsapp = p.get("com_whatsapp") === "true";
  const notaMin = Number(p.get("nota_min") ?? 0) || 0;
  const avalMin = Number(p.get("avaliacoes_min") ?? 0) || 0;
  const soSemCliente = p.get("so_sem_cliente") === "true";
  const limite = Math.min(200, Math.max(1, Number(p.get("limite") ?? 50) || 50));

  const supabase = await createClient();
  let q = supabase
    .from("business_prospects")
    .select(COLUNAS_DO_PROSPECT)
    .eq("organization_id", authz.org.orgId)
    .eq("bloqueado", false);

  if (categoria) q = q.eq("categoria", categoria);
  if (cidade) q = q.ilike("cidade", `%${cidade}%`);
  if (estado) q = q.eq("estado", estado.toUpperCase());
  if (status !== "" && (STATUS_COMERCIAL as readonly string[]).includes(status)) {
    q = q.eq("status_comercial", status);
  }
  if (origem) q = q.eq("provider", origem);
  if (comTelefone) q = q.not("telefone_normalizado", "is", null);
  if (semTelefone) q = q.is("telefone_normalizado", null);
  if (comWebsite) q = q.not("website", "is", null);
  if (semWebsite) q = q.is("website", null);
  if (comWhatsapp) q = q.eq("whatsapp_potencial", true);
  if (notaMin > 0) q = q.gte("nota", notaMin);
  if (avalMin > 0) q = q.gte("total_avaliacoes", avalMin);
  if (soSemCliente) q = q.is("contact_id", null);
  if (busca) {
    q = q.or(`nome.ilike.%${busca}%,telefone.ilike.%${busca}%,cidade.ilike.%${busca}%,website.ilike.%${busca}%`);
  }

  const { data, error } = await q.order("score", { ascending: false }).limit(limite);
  if (error) return fail("internal_error", "Erro ao listar prospects.", 500, { requestId });

  const linhas = (data ?? []) as unknown as {
    id: string;
    contact_id: string | null;
    telefone: string | null;
    email: string | null;
  }[];

  // "Já é cliente": vínculo OU match por telefone/email com contacts.
  // Em lote (2 queries), nunca N+1.
  const fones = [...new Set(linhas.map((l) => l.telefone).filter(Boolean))] as string[];
  const emails = [...new Set(linhas.map((l) => l.email).filter(Boolean))] as string[];
  const clientes = new Set<string>();
  if (fones.length > 0 || emails.length > 0) {
    const conds: string[] = [];
    if (fones.length > 0) {
      const canonicos = [...new Set(fones.map((f) => canonicalPhoneBR(f)))];
      conds.push(`phone_number.in.(${canonicos.join(",")})`);
    }
    if (emails.length > 0) conds.push(`email.in.(${emails.join(",")})`);
    const { data: contatos } = await supabase
      .from("contacts")
      .select("phone_number, email")
      .eq("organization_id", authz.org.orgId)
      .or(conds.join(","))
      .limit(2000);
    const fonesCli = new Set(((contatos ?? []) as { phone_number: string | null }[]).map((c) => c.phone_number).filter(Boolean));
    const emailsCli = new Set(((contatos ?? []) as { email: string | null }[]).map((c) => c.email).filter(Boolean));
    for (const l of linhas) {
      if (l.contact_id) {
        clientes.add(l.id);
        continue;
      }
      if (l.telefone && fonesCli.has(canonicalPhoneBR(l.telefone))) clientes.add(l.id);
      else if (l.email && emailsCli.has(l.email)) clientes.add(l.id);
    }
  } else {
    for (const l of linhas) if (l.contact_id) clientes.add(l.id);
  }

  return ok(
    linhas.map((l) => ({ ...l, ja_e_cliente: clientes.has(l.id) })),
    { requestId },
  );
}
