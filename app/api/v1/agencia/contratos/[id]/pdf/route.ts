import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { contextoLiberado } from "@/lib/agencia/acesso";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { renderContratoPdf } from "@/lib/agencia/contratos/pdf";
import { fail } from "@/lib/api/wrappers";
import { marcaDaSaida } from "@/lib/branding/saida";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** O PDF do contrato, sempre do texto guardado (docs/agencia/SPEC-contratos.md, K2). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const { id } = await params;
  const ctx = await contextoLiberado();
  if (!ctx) return fail("unauthorized", "Entre na área da agência.", 401, { requestId });
  if (!ctx.permissoes.has("contratos.gerenciar")) return fail("forbidden", "Você não tem permissão para contratos.", 403, { requestId });
  if (!/^[0-9a-f-]{36}$/.test(id)) return fail("not_found", "Contrato não encontrado.", 404, { requestId });
  const { data } = await createAdminClient()
    .from("agencia_contratos")
    .select("cliente_id, titulo, texto, agencia_clientes(nome, razao_social)")
    .eq("id", id)
    .maybeSingle();
  const c = data as { cliente_id: string; titulo: string; texto: string; agencia_clientes: { nome: string; razao_social: string | null } | null } | null;
  if (!c || !podeVerCliente(await carregarAlcance(ctx), c.cliente_id)) return fail("not_found", "Contrato não encontrado.", 404, { requestId });
  const marca = await marcaDaSaida(null);
  const pdf = await renderContratoPdf({
    texto: c.texto,
    titulo: c.titulo,
    contratante: c.agencia_clientes?.razao_social || c.agencia_clientes?.nome || "Contratante",
    contratada: marca.nome,
  });
  const arquivo = `${c.titulo.normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "contrato"}.pdf`;
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${arquivo}"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  });
}
