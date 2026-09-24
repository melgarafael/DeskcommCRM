/**
 * GET   /api/v1/campaigns/:id — a campanha, com os números do snapshot.
 * PATCH /api/v1/campaigns/:id — edita o RASCUNHO.
 *
 * Só rascunho aceita edição: depois da preparação, cada destinatário carrega o
 * texto congelado com que foi preparado, e mudar a campanha ali faria a tela
 * mostrar um texto e a fila enviar outro. Para editar, volta-se ao rascunho
 * (o que invalida a lista) — e isso só vale enquanto nada saiu.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { carregarCampanha } from "@/lib/campanhas/acoes";
import { ehEditavel, ehTerminal } from "@/lib/campanhas/maquina-de-estados";
import { gravarPool, lerPoolExtra } from "@/lib/campanhas/pool-de-numeros";
import { editarCampanhaSchema } from "@/lib/campanhas/schemas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, name, description, status, channel_session_id, message_body, base_legal, lia_ref, " +
  "audience_filter, audience_version, content_version, snapshot_total, snapshot_eligible, " +
  "snapshot_excluded, scheduled_at, prepared_at, started_at, paused_at, completed_at, " +
  "cancelled_at, failure_code, intervalo_segundos, janela_inicio_hora, janela_fim_hora, " +
  "teto_diario, teto_horario, pipeline_id, stage_id, agent_id, created_at, created_by";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const supabase = await createClient();
  const { data } = await supabase
    .from("campaigns")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!data) return fail("campanha_nao_encontrada", t("Campanha não encontrada."), 404, { requestId });

  // O pool vem junto: a tela precisa dele para mostrar por quantos números a
  // campanha fala, e uma segunda chamada para isso seria round-trip à toa.
  const extras = await lerPoolExtra(createAdminClient(), authz.org.orgId, id);
  return ok({ ...(data as object), channel_session_ids: extras }, { requestId });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const parsed = editarCampanhaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const entrada = parsed.data;

  // Client ADMIN na escrita (ver o comentário em `campaigns/route.ts`): o papel
  // `authenticated` só tem SELECT. O GET acima segue na sessão de propósito —
  // ali a RLS é a segunda tranca, de graça.
  const supabase = createAdminClient();
  const carregada = await carregarCampanha(supabase, authz.org.orgId, id);
  if (!carregada.ok) {
    return fail(carregada.codigo, t(carregada.mensagem), carregada.status, { requestId });
  }
  const campanha = carregada.campanha;

  // ═══ Duas classes de campo, duas permissões ═══
  //
  // CONTEÚDO e PÚBLICO só mudam em rascunho: depois da preparação cada
  // destinatário carrega o texto congelado, e editar ali faria a tela mostrar um
  // texto e a fila enviar outro.
  //
  // RITMO muda em qualquer estado vivo, e isso é deliberado: quem vê a campanha
  // andando rápido demais precisa poder desacelerá-la AGORA. Obrigar a duplicar
  // a campanha para trocar um intervalo é obrigar a recomeçar o envio — ou, pior,
  // a deixar correndo do jeito errado porque recomeçar custa caro.
  const CAMPOS_DE_RITMO = [
    "channel_session_ids",
    "intervalo_segundos",
    "janela_inicio_hora",
    "janela_fim_hora",
    "teto_diario",
    "teto_horario",
  ] as const;
  const mexeEmConteudo = Object.entries(entrada).some(
    ([campo, valor]) =>
      valor !== undefined && !(CAMPOS_DE_RITMO as readonly string[]).includes(campo),
  );

  if (ehTerminal(campanha.status)) {
    return fail(
      "campanha_nao_editavel",
      t("Campanha concluída ou cancelada não muda mais. Duplique para mandar de novo."),
      409,
      { requestId },
    );
  }
  if (mexeEmConteudo && !ehEditavel(campanha.status)) {
    return fail(
      "campanha_nao_editavel",
      t("Só um rascunho aceita mudar o texto e o público. O ritmo você pode ajustar a qualquer momento."),
      409,
      { requestId },
    );
  }

  const baseLegal = entrada.base_legal ?? campanha.base_legal;
  const liaRef = entrada.lia_ref === undefined ? campanha.lia_ref : entrada.lia_ref;
  if (baseLegal === "legitimate_interest" && (liaRef ?? "").trim() === "") {
    return fail(
      "campanha_base_legal_invalida",
      t("Interesse legítimo exige a referência da avaliação (LIA)."),
      422,
      { requestId },
    );
  }

  const mudanca: Record<string, unknown> = { updated_by: authz.user.id };
  for (const campo of [
    "name",
    "description",
    "message_body",
    "audience_filter",
    "intervalo_segundos",
    "janela_inicio_hora",
    "janela_fim_hora",
    "teto_diario",
    "teto_horario",
    "channel_session_id",
    "pipeline_id",
    "stage_id",
    "agent_id",
  ] as const) {
    if (entrada[campo] !== undefined) mudanca[campo] = entrada[campo];
  }
  if (entrada.base_legal !== undefined) mudanca.base_legal = entrada.base_legal;
  if (entrada.lia_ref !== undefined) mudanca.lia_ref = entrada.lia_ref;
  // Mexer no TEXTO sobe a versão do conteúdo: é ela que o destinatário carrega,
  // e é por ela que se sabe se a mensagem preparada é a mensagem de hoje.
  if (entrada.message_body !== undefined && entrada.message_body !== campanha.message_body) {
    mudanca.content_version = campanha.content_version + 1;
  }

  if (entrada.channel_session_id !== undefined) {
    const { data: canal } = await supabase
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .eq("id", entrada.channel_session_id)
      .maybeSingle();
    if (!canal) {
      return fail(
        "campanha_canal_indisponivel",
        t("Escolha uma conexão de WhatsApp desta organização."),
        409,
        { requestId },
      );
    }
  }

  // O compare-and-set prende o estado que foi CONFERIDO acima — não o literal
  // `draft`: ajuste de ritmo numa campanha `running` tem de passar, e continua
  // recusando se o estado mudou entre a conferência e a escrita.
  const { data, error } = await supabase
    .from("campaigns")
    .update(mudanca)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .eq("status", campanha.status)
    .select(COLUNAS)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) {
    return fail(
      "campanha_nao_editavel",
      t("O estado da campanha mudou enquanto esta edição era salva. Recarregue a tela."),
      409,
      { requestId },
    );
  }

  if (entrada.channel_session_ids !== undefined) {
    const r = await gravarPool(supabase, {
      organizationId: authz.org.orgId,
      campanhaId: id,
      principal: (data as unknown as { channel_session_id: string }).channel_session_id,
      extras: entrada.channel_session_ids,
    });
    if (!r.ok) {
      return fail(
        "campanha_canal_indisponivel",
        t("Um dos números escolhidos não é uma conexão desta organização."),
        409,
        { requestId },
      );
    }
  }

  // Editar rascunho NÃO audita: nada saiu dele, e auditar cada tecla encheria o
  // log com o que não tem consequência. Quem audita são as mudanças de estado.
  return ok({ ...(data as object), channel_session_ids: await lerPoolExtra(supabase, authz.org.orgId, id) }, { requestId });
}
