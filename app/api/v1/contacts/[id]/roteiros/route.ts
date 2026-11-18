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

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import type { CandidatoAoNegocio } from "@/lib/followup/negocio-do-roteiro";
import { montarRoteirosDoContato, type LinhaDoRoteiro } from "@/lib/followup/roteiros-do-contato";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";

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

/**
 * Ramo do TOKEN, sem embed: o embed `!inner` da sessão filtra o atendimento ANTES
 * do limite de 20 execuções. Aqui a mesma ordem vira leituras próprias, todas
 * por organização: os ponteiros de atendimento, as execuções desses ponteiros
 * (com o limite), e as versões dos grafos dessas execuções.
 */
async function lerRoteirosPorConsultas(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<{ data: LinhaDoBanco[]; error: { message: string } | null }> {
  const { data: ponteiros, error: erroPonteiros } = await supabase
    .from("followup_flow_pointers")
    .select("id, name")
    .eq("organization_id", organizationId)
    .eq("surface", "atendimento");
  if (erroPonteiros) return { data: [], error: erroPonteiros };
  const nomes = new Map(
    ((ponteiros ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name] as const),
  );
  if (nomes.size === 0) return { data: [], error: null };

  const { data: execucoes, error: erroExecucoes } = await supabase
    .from("followup_enrollments")
    .select("id, status, started_at, completed_at, pointer_id, version_id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("pointer_id", [...nomes.keys()])
    .order("started_at", { ascending: false })
    .limit(20);
  if (erroExecucoes) return { data: [], error: erroExecucoes };
  const linhasDeExecucao = (execucoes ?? []) as Array<{
    id: string;
    status: string;
    started_at: string;
    completed_at: string | null;
    pointer_id: string;
    version_id: string;
  }>;

  const versoes = [...new Set(linhasDeExecucao.map((e) => e.version_id))];
  const grafos = new Map<string, unknown>();
  if (versoes.length > 0) {
    const { data: versoesLidas, error: erroVersoes } = await supabase
      .from("followup_flow_versions")
      .select("id, graph")
      .in("id", versoes)
      .eq("organization_id", organizationId);
    if (erroVersoes) return { data: [], error: erroVersoes };
    for (const v of (versoesLidas ?? []) as Array<{ id: string; graph: unknown }>) {
      grafos.set(v.id, v.graph);
    }
  }

  return {
    data: linhasDeExecucao.map((e) => ({
      id: e.id,
      status: e.status,
      started_at: e.started_at,
      completed_at: e.completed_at,
      followup_flow_pointers: { name: nomes.get(e.pointer_id) ?? "", surface: "atendimento" },
      followup_flow_versions: grafos.has(e.version_id) ? { graph: grafos.get(e.version_id) } : null,
    })),
    error: null,
  };
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  // Sessão OU token de integração (Spec 33, R2): `mcp:read` e papel `viewer`.
  // A organização sai da sessão ou da LINHA DO TOKEN.
  const authz = await resolveAuthDual(_req, {
    requestId,
    resource: "contacts",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "contacts", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  if (!(await moduloLigado(createAdminClient(), "fluxos_atendimento"))) {
    return fail("not_found", t("Recurso não encontrado."), 404, { requestId });
  }

  const supabase = authz.supabase;
  const { data: contato, error: contatoErr } = await supabase
    .from("contacts")
    .select("id, custom_fields, is_anonymized")
    .eq("organization_id", authz.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (contatoErr) return fail("internal_error", contatoErr.message, 500, { requestId });
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });
  // Anonimizado: as respostas foram apagadas e o que sobra (nome do roteiro,
  // datas) é histórico de uma pessoa que pediu para sair. Nenhuma tela mostra —
  // a ficha e o painel da conversa passam os dois por aqui.
  if (contato.is_anonymized) return ok([], { requestId });

  let leitura: { data: LinhaDoBanco[]; error: { message: string } | null };
  if (authz.via === "token") {
    leitura = await lerRoteirosPorConsultas(supabase, authz.organizationId, id);
  } else {
    const { data, error } = await supabase
      .from("followup_enrollments")
      .select(
        "id, status, started_at, completed_at, followup_flow_pointers!inner(name, surface), followup_flow_versions(graph)",
      )
      .eq("organization_id", authz.organizationId)
      .eq("contact_id", id)
      .eq("followup_flow_pointers.surface", "atendimento")
      .order("started_at", { ascending: false })
      .limit(20);
    leitura = { data: (data ?? []) as unknown as LinhaDoBanco[], error };
  }
  if (leitura.error) return fail("internal_error", leitura.error.message, 500, { requestId });

  const linhas: LinhaDoRoteiro[] = leitura.data.flatMap((r) => {
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

  // ─── o NEGÓCIO de cada execução (#3363) ────────────────────────────────────
  //
  // Duas leituras e só: o VÍNCULO já fixado de cada roteiro (a mesma trilha que
  // guarda o passo a passo) e os cards ABERTOS do contato. Quem monta decide se
  // o grafo pergunta ao card — roteiro que só grava no contato não ganha o
  // bloco, e a tela de quem não usa o recurso fica exatamente como era.
  //
  // O vínculo é lido por `enrollment_id` (nunca pelo contato): cada execução tem
  // o seu, e uma não herda o card da outra.
  const ids = linhas.map((l) => l.id);
  const vinculos = new Map<string, string>();
  let cartoes: CandidatoAoNegocio[] = [];
  let camposPorLead = new Map<string, unknown>();
  if (ids.length > 0) {
    const { data: eventos } = await supabase
      .from("followup_enrollment_events")
      .select("enrollment_id, payload")
      .eq("organization_id", authz.organizationId)
      .eq("event_type", "roteiro_negocio")
      .in("enrollment_id", ids)
      .order("created_at", { ascending: true });
    for (const ev of (eventos ?? []) as Array<{ enrollment_id: string; payload: { lead_id?: string } }>) {
      // O PRIMEIRO vínculo é o que vale — e o índice único garante que só existe
      // um por execução; a ordem é só a rede de segurança da leitura.
      if (!vinculos.has(ev.enrollment_id) && typeof ev.payload?.lead_id === "string") {
        vinculos.set(ev.enrollment_id, ev.payload.lead_id);
      }
    }

    const { data: leads } = await supabase
      .from("crm_leads")
      .select("id, title, custom_fields")
      .eq("organization_id", authz.organizationId)
      .eq("contact_id", id)
      .eq("status", "open")
      .order("created_at", { ascending: true });
    const linhasDeLead = (leads ?? []) as Array<{
      id: string;
      title: string | null;
      custom_fields: unknown;
    }>;
    cartoes = linhasDeLead.map((l) => ({ id: l.id, titulo: l.title ?? null }));
    camposPorLead = new Map(linhasDeLead.map((l) => [l.id, l.custom_fields ?? {}]));
  }

  const comNegocio: LinhaDoRoteiro[] = linhas.map((l) => {
    const vinculoId = vinculos.get(l.id) ?? null;
    return {
      ...l,
      // A ESCOLHA só é pedida em execução VIVA: roteiro concluído não escolhe
      // nada — uma execução nova resolve de novo.
      ...(l.status === "coletando" ? { negocio: { vinculoId, candidatos: cartoes } } : {}),
      ...(vinculoId !== null ? { camposDoNegocio: camposPorLead.get(vinculoId) ?? {} } : {}),
    };
  });
  return ok(montarRoteirosDoContato(comNegocio, contato.custom_fields), { requestId });
}
