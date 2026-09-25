/**
 * GET /api/v1/contacts/[id]/roteiros — o que os roteiros de atendimento
 * coletaram deste contato, para a ficha e o painel da conversa (qualquer membro).
 *
 * Módulo opcional da instalação: desligado, 404 (a porta não existe). A leitura
 * é pelo cliente de SESSÃO — a RLS decide o que o usuário enxerga; o contato e
 * os roteiros de outra empresa simplesmente não voltam.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { montarRoteirosDoContato, type LinhaDoRoteiro } from "@/lib/followup/roteiros-do-contato";
import { traduzir } from "@/lib/i18n/dicionario";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LinhaDoBanco = {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  followup_flow_pointers: { name: string; surface: string } | { name: string; surface: string }[] | null;
  followup_flow_versions: { graph: unknown } | { graph: unknown }[] | null;
};

function um<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  if (!(await moduloLigado(createAdminClient(), "fluxos_atendimento"))) {
    return fail("not_found", t("Recurso não encontrado."), 404, { requestId });
  }

  const supabase = await createClient();
  const { data: contato, error: contatoErr } = await supabase
    .from("contacts")
    .select("id, custom_fields, is_anonymized")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (contatoErr) return fail("internal_error", contatoErr.message, 500, { requestId });
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });
  // Anonimizado: as respostas foram apagadas e o que sobra (nome do roteiro,
  // datas) é histórico de uma pessoa que pediu para sair. Nenhuma tela mostra —
  // a ficha e o painel da conversa passam os dois por aqui.
  if (contato.is_anonymized) return ok([], { requestId });

  const { data, error } = await supabase
    .from("followup_enrollments")
    .select(
      "id, status, started_at, completed_at, followup_flow_pointers!inner(name, surface), followup_flow_versions(graph)",
    )
    .eq("organization_id", authz.org.orgId)
    .eq("contact_id", id)
    .eq("followup_flow_pointers.surface", "atendimento")
    .order("started_at", { ascending: false })
    .limit(20);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const linhas: LinhaDoRoteiro[] = ((data ?? []) as unknown as LinhaDoBanco[]).flatMap((r) => {
    const pointer = um(r.followup_flow_pointers);
    const versao = um(r.followup_flow_versions);
    if (!pointer || pointer.surface !== "atendimento" || !versao) return [];
    return [
      {
        id: r.id,
        status: r.status,
        started_at: r.started_at,
        completed_at: r.completed_at,
        nome: pointer.name,
        graph: versao.graph,
      },
    ];
  });
  return ok(montarRoteirosDoContato(linhas, contato.custom_fields), { requestId });
}
