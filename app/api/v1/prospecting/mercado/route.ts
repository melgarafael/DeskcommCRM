/**
 * GET /api/v1/prospecting/mercado — análise de mercado e penetração (§§22–24).
 *
 * Totais (empresas, com telefone/site, prospects, clientes), por cidade e por
 * categoria, e penetração: clientes existentes (contatos com pedido) vs
 * descobertas. "Cliente" aqui = contato que já comprou — medido, não
 * declarado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "business_prospects" });
  if (!authz.ok) return authz.response;

  const cidade = req.nextUrl.searchParams.get("cidade")?.trim() ?? "";
  const supabase = await createClient();

  let q = supabase
    .from("business_prospects")
    .select("cidade, estado, categoria, telefone_normalizado, website, contact_id")
    .eq("organization_id", authz.org.orgId)
    .eq("bloqueado", false)
    .limit(10000);
  if (cidade) q = q.ilike("cidade", `%${cidade}%`);
  const { data, error } = await q;
  if (error) return fail("internal_error", "Erro ao agregar o mercado.", 500, { requestId });

  const linhas = (data ?? []) as unknown as {
    cidade: string | null;
    estado: string | null;
    categoria: string | null;
    telefone_normalizado: string | null;
    website: string | null;
    contact_id: string | null;
  }[];

  // Clientes: contatos com pedido (medido via commercial_orders).
  const { data: pedidos } = await supabase
    .from("commercial_orders")
    .select("contact_id")
    .eq("organization_id", authz.org.orgId)
    .neq("status", "cancelado")
    .not("contact_id", "is", null)
    .limit(10000);
  const contatosClientes = new Set(
    ((pedidos ?? []) as { contact_id: string }[]).map((p) => p.contact_id),
  );

  const porCidade = new Map<string, { empresas: number; clientes: number }>();
  const porCategoria = new Map<string, number>();
  let comTelefone = 0;
  let comWebsite = 0;
  let prospects = 0;

  for (const l of linhas) {
    if (l.telefone_normalizado) comTelefone++;
    if (l.website) comWebsite++;
    if (!l.contact_id) prospects++;
    const chaveCidade = `${l.cidade ?? "?"}${l.estado ? `/${l.estado}` : ""}`;
    const c = porCidade.get(chaveCidade) ?? { empresas: 0, clientes: 0 };
    c.empresas++;
    porCidade.set(chaveCidade, c);
    if (l.categoria) porCategoria.set(l.categoria, (porCategoria.get(l.categoria) ?? 0) + 1);
  }

  // Penetração por cidade: clientes = prospects vinculados a contato comprador.
  const { data: vinculados } = await supabase
    .from("business_prospects")
    .select("cidade, estado, contact_id")
    .eq("organization_id", authz.org.orgId)
    .eq("bloqueado", false)
    .not("contact_id", "is", null)
    .limit(10000);
  for (const v of ((vinculados ?? []) as { cidade: string | null; estado: string | null; contact_id: string }[])) {
    if (!contatosClientes.has(v.contact_id)) continue;
    const chave = `${v.cidade ?? "?"}${v.estado ? `/${v.estado}` : ""}`;
    const c = porCidade.get(chave) ?? { empresas: 0, clientes: 0 };
    c.clientes++;
    porCidade.set(chave, c);
  }

  // Telefones de prospects que batem com comprador sem vínculo formal.
  const fonesProspects = [...new Set(linhas.map((l) => l.telefone_normalizado).filter(Boolean))] as string[];
  let clientesExtras = 0;
  if (fonesProspects.length > 0) {
    const { data: contatos } = await supabase
      .from("contacts")
      .select("id, phone_number")
      .eq("organization_id", authz.org.orgId)
      .in("phone_number", fonesProspects.map((f) => canonicalPhoneBR(f)))
      .limit(5000);
    const idsCompradores = new Set(
      ((contatos ?? []) as { id: string }[]).map((c) => c.id).filter((id) => contatosClientes.has(id)),
    );
    clientesExtras = idsCompradores.size;
  }

  const cidades = [...porCidade.entries()]
    .map(([cidade, v]) => ({
      cidade,
      empresas: v.empresas,
      clientes: v.clientes,
      penetracao_pct: v.empresas === 0 ? 0 : Math.round((v.clientes / v.empresas) * 1000) / 10,
      potencial: Math.max(0, v.empresas - v.clientes),
    }))
    .sort((a, b) => b.empresas - a.empresas)
    .slice(0, 50);

  return ok(
    {
      totais: {
        empresas: linhas.length,
        com_telefone: comTelefone,
        com_website: comWebsite,
        prospects,
        clientes_vinculados: [...porCidade.values()].reduce((s, c) => s + c.clientes, 0),
        clientes_extras_por_telefone: clientesExtras,
      },
      por_cidade: cidades,
      por_categoria: [...porCategoria.entries()]
        .map(([categoria, empresas]) => ({ categoria, empresas }))
        .sort((a, b) => b.empresas - a.empresas)
        .slice(0, 30),
    },
    { requestId },
  );
}
