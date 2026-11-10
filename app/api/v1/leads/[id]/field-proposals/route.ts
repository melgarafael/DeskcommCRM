/**
 * GET /api/v1/leads/[id]/field-proposals — a FILA de revisão do card (issue #3316).
 *
 * É a tela de "valor atual × valor proposto × de onde veio", campo a campo: a
 * IA leu um documento (voucher, bilhete, apólice) e propôs valores SÓ para os
 * campos do funil; aqui a pessoa vê o que foi encontrado, com o trecho de
 * origem e o documento anexado ao negócio, e decide um a um em
 * `POST .../field-proposals/[pid]`.
 *
 * Nada é gravado por esta rota — ela só LÊ a fila. Quem grava em
 * `crm_leads.custom_fields` é a confirmação, pela porta de edição que já existe
 * (`updateLeadHandler`), com a mesma régua de tipo/lista/`padrao` (#2730).
 *
 * Tenancy: client de sessão (RLS), nunca admin — a fila é o que ESTE usuário
 * pode ver, amarrado à visibilidade do negócio pai.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { camposDoFunil, camposPorEscopo } from "@/lib/leads/campos-do-funil";
import { settingsDoFunil } from "@/lib/leads/campos-exigidos";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/** Uma proposta pendente, já com o que a REVISÃO precisa para decidir. */
export interface PropostaDeCampoDoNegocio {
  id: string;
  campo: string;
  /** O rótulo que o dono deu no funil; sem leitura, a própria chave. */
  rotulo: string;
  /** O tipo do campo — a tela monta o input certo com ele. */
  tipo: string | undefined;
  /** As opções de uma lista, quando o campo tem. */
  opcoes?: { value: string; label: string }[];
  /** O que está no card AGORA (`crm_leads.custom_fields[chave]`). */
  valor_atual: unknown;
  /** O que a IA leu no documento. */
  valor_proposto: unknown;
  /** O trecho do documento de onde veio o valor — a coluna que permite conferir. */
  trecho: string | null;
  /** O documento anexado ao negócio, quando a proposta aponta para um. */
  documento: { id: string; nome: string; url: string } | null;
  proposed_at: string;
  expires_at: string;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  // Leitura `viewer`: ver o que a IA leu no documento é a MESMA informação que o
  // card já mostra a quem enxerga o negócio (valor atual, trecho, anexo), e a
  // fila só aparece dentro do dossiê. Quem DECIDE continua sendo `agent`
  // (`requireRole` do POST) — ler não é confirmar. Fechar a leitura em `agent`
  // faria o observador ver um erro de carregamento no lugar da fila.
  const guard = await requireRole("viewer", { requestId, resource: "crm_leads" });
  if (!guard.ok) return guard.response;
  const t = (texto: string) => traduzir(texto, guard.user.idioma);
  const orgId = guard.org.orgId;

  const supabase = await createClient();
  // O relógio do SERVIDOR, uma vez: leitura e decisão têm de ser comparadas com
  // o mesmo instante dentro do handler.
  const agora = new Date();

  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, pipeline_id, custom_fields")
    .eq("organization_id", orgId)
    .eq("id", leadId)
    .maybeSingle();

  if (leadErr) return fail("internal_error", leadErr.message, 500, { requestId });
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  const settings = await settingsDoFunil(supabase, (lead as { pipeline_id?: string | null }).pipeline_id);
  // Os campos do NEGÓCIO (#2791): o do contato mora em `contacts.custom_fields`
  // e não é do card — a mesma régua do nascimento da proposta.
  const defs = camposPorEscopo(
    camposDoFunil(
      settings && typeof settings === "object" && !Array.isArray(settings)
        ? (settings as Record<string, unknown>)
        : null,
    ),
    "negocio",
  );
  const porChave = new Map(defs.map((d) => [d.key, d]));

  const { data: linhas, error } = await supabase
    .from("lead_field_proposals")
    .select(
      "id, campo, valor_proposto, valor_anterior, trecho, attachment_id, proposed_at, expires_at, " +
        "crm_lead_attachments(id, file_name)",
    )
    .eq("organization_id", orgId)
    .eq("lead_id", leadId)
    .eq("status", "pending")
    // ⏳ `expires_at` VALE NA LEITURA (defeito medido no #3415: a coluna existia
    // e nada a cobrava, então proposta vencida continuava elegível na tela).
    // O filtro é do BANCO, e não da tela: uma proposta vencida que ainda não
    // passou pela varredura não chega a ser renderizada, e o `>` aqui é o mesmo
    // sinal de `propostaVencida` (vencida = `expires_at <= agora`).
    .gt("expires_at", agora.toISOString())
    .order("proposed_at", { ascending: true });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  const gravados = ((lead as { custom_fields?: unknown }).custom_fields ??
    {}) as Record<string, unknown>;

  const propostas: PropostaDeCampoDoNegocio[] = (linhas ?? []).map((l) => {
    const linha = l as unknown as {
      id: string;
      campo: string;
      valor_proposto: unknown;
      trecho: string | null;
      attachment_id: string | null;
      proposed_at: string;
      expires_at: string;
      crm_lead_attachments: { id: string; file_name: string } | null;
    };
    const def = porChave.get(linha.campo);
    const anexo = linha.crm_lead_attachments;
    return {
      id: linha.id,
      campo: linha.campo,
      rotulo: def?.label ?? linha.campo,
      tipo: def?.type,
      ...(def?.options ? { opcoes: def.options } : {}),
      valor_atual: gravados[linha.campo] ?? null,
      valor_proposto: linha.valor_proposto,
      trecho: linha.trecho,
      documento: anexo
        ? {
            id: anexo.id,
            nome: anexo.file_name,
            url: `/api/v1/leads/${leadId}/attachments/${anexo.id}/media`,
          }
        : null,
      proposed_at: linha.proposed_at,
      expires_at: linha.expires_at,
    };
  });

  return ok({ propostas }, { requestId });
}
