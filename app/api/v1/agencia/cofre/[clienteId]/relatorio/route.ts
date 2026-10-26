import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { contextoLiberado } from "@/lib/agencia/acesso";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { decifrarSenha, registrarVisualizacao } from "@/lib/agencia/cofre/cofre";
import { renderRelatorioDeAcessos } from "@/lib/agencia/cofre/relatorio";
import { formatarDataHora } from "@/lib/agencia/tarefas/regras";
import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { marcaDaSaida } from "@/lib/branding/saida";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * O relatório de acessos em PDF (docs/agencia/SPEC-cofre-e-formulario.md, F7).
 * Sessão de quem está na área da agência + `cofre.ver_senhas` + alcançar o
 * cliente. Cada geração fica registrada no cofre e na auditoria; o PDF não é
 * guardado em lugar nenhum.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ clienteId: string }> }) {
  const requestId = randomUUID();
  const { clienteId } = await params;
  const ctx = await contextoLiberado();
  if (!ctx) return fail("unauthorized", "Entre na área da agência.", 401, { requestId });
  if (!ctx.permissoes.has("cofre.ver_senhas")) return fail("forbidden", "Você não tem permissão para ver senhas.", 403, { requestId });
  if (!/^[0-9a-f-]{36}$/.test(clienteId) || !podeVerCliente(await carregarAlcance(ctx), clienteId)) {
    return fail("not_found", "Cliente não encontrado.", 404, { requestId });
  }
  const db = createAdminClient();
  const [{ data: cliente }, { data: itens }, marca] = await Promise.all([
    db.from("agencia_clientes").select("nome").eq("id", clienteId).maybeSingle(),
    db
      .from("agencia_cofre_itens")
      .select("id, rotulo, login, extra, senha_ct, senha_iv, senha_tag")
      .eq("cliente_id", clienteId)
      .order("plataforma")
      .order("rotulo"),
    marcaDaSaida(null),
  ]);
  const nome = (cliente as { nome?: string } | null)?.nome;
  if (!nome) return fail("not_found", "Cliente não encontrado.", 404, { requestId });

  const linhas = (itens ?? []) as Array<{ id: string; rotulo: string; login: string | null; extra: string | null; senha_ct: unknown; senha_iv: unknown; senha_tag: unknown }>;
  const pdf = await renderRelatorioDeAcessos({
    cliente: nome,
    agencia: marca.nome,
    geradoEm: formatarDataHora(new Date().toISOString(), { comAno: true }),
    acessos: linhas.map((l) => ({ rotulo: l.rotulo, login: l.login, extra: l.extra, senha: decifrarSenha(l) })),
  });
  for (const l of linhas) await registrarVisualizacao({ itemId: l.id, clienteId, userId: ctx.user.id, motivo: "relatorio" });
  void audit({
    action: "agencia.cofre_relatorio_gerado",
    actorUserId: ctx.user.id,
    organizationId: null,
    resourceType: "agencia_cliente",
    resourceId: clienteId,
    metadata: { acessos: linhas.length },
    requestId,
  });
  const arquivo = `acessos-${nome.normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "cliente"}.pdf`;
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${arquivo}"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  });
}
