import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/clone — levar o negócio para outro funil.
 * A criação, os vínculos e o fechamento da origem são uma transação.
 * A rota reutiliza uma cópia aberta do mesmo negócio que já está no destino.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { getLeadHandler } from "@/app/api/v1/leads/_handler";
import { copiarAnexosDoClone } from "@/lib/leads/anexos-do-clone";
import { criarCloneNoFunil } from "@/lib/leads/clone-com-anexos";
import { ehRecusaDaVisibilidadeDoFunil } from "@/lib/leads/recusa-da-visibilidade";
import { ocultarProvaMetaNaResposta } from "@/lib/leads/prova-meta-lead-submitted";
import { modoDeReabertura } from "@/lib/leads/reabertura";
import {
  recusaDeCamposObrigatorios,
  settingsDoFunil,
  validaCamposExigidos,
} from "@/lib/leads/campos-exigidos";
import { listPipelinesHandler } from "@/app/api/v1/pipelines/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import {
  FUNIL_DE_DESTINO_NAO_ENCONTRADO,
  escolheEtapaDeDestino,
  recusaTrocaDeFunil,
  registroDoDestino,
  type EtapaDoFunil,
  type OrigemParaClonar,
} from "@/lib/leads/clonar-para-funil";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import {
  preparaEncerramentoDemanda,
  registraEncerramentoDemanda,
  type EncerraDemandaInput,
} from "@/lib/leads/encerramento";
import {
  motivoDaPerdaDaOrigem,
  recusaDeMotivoForaDoVocabulario,
  recusaDeMotivoDaPerdaPeloBanco,
} from "@/lib/leads/motivo-da-perda";
import { cloneLeadSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * A etapa como a tela de destino precisa dela: `id`/`name` para o seletor e os
 * três campos que dizem se ela pode RECEBER o negócio. `is_archived` fica de
 * fora porque o filtro é do banco (`.eq("is_archived", false)`): etapa arquivada
 * não é escolha, nem como explicação.
 */
interface EtapaDeDestino {
  id: string;
  pipeline_id: string;
  name: string;
  /** `numeric` no Postgres chega como string pelo PostgREST. */
  position: number | string;
  is_won: boolean;
  is_lost: boolean;
}

/** O que a tela recebe: sem `pipeline_id`, que já é a chave do funil na resposta. */
type EtapaNaResposta = Omit<EtapaDeDestino, "pipeline_id">;

/**
 * GET /api/v1/leads/[id]/clone — para ONDE este negócio pode ir.
 *
 * Exceção deliberada e MÍNIMA à matriz spec 13 §4 (pipelines read = manager+,
 * `GET /api/v1/pipelines`): quem vai clicar em "Levar para outro funil" precisa
 * escolher o destino, e `pipeline.move_card` (a MESMA permissão que já autoriza
 * o POST abaixo) já é `agent`+ — negar a leitura aqui só empurraria o mesmo dado
 * por um caminho sem gate nenhum. Payload mínimo: `id` e `name`, nunca
 * `settings`/`description` (isso é configuração, fica atrás de `manager` na rota
 * de gestão). O funil ATUAL do lead sai da lista — não é destino válido de troca
 * (a mesma regra de `recusaTrocaDeFunil`, medida aqui em vez de deixar a tela
 * descobrir só ao tentar).
 *
 * ── Por que as ETAPAS vêm junto (issue #3643) ────────────────────────────────
 *
 * O diálogo passou a pedir também a etapa de entrada, e a lista dela NÃO pode
 * vir de `GET /api/v1/pipelines/:id/stages`: aquela rota é `manager`+ (é a tela
 * de configuração do funil) e quem leva o card é `agent`. Com duas fontes, o
 * vendedor veria o seletor de funil e nenhuma etapa — exatamente o operador que
 * a issue quer atender. Aqui a leitura é a mesma de `id`/`name`: o nome da
 * coluna já aparece para qualquer papel no quadro, e `position`/`is_won`/
 * `is_lost` são o que a tela precisa para oferecer só etapa ABERTA (a mesma
 * régua de `escolheEtapaDeDestino`, que continua sendo quem decide no POST).
 * Uma chamada por abertura do diálogo, não uma por funil escolhido.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_leads",
    role: "agent",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "leads_clone_view", requestId);
  if (teto) return teto;
  const { supabase, organizationId, actor, idioma } = authz;
  const t = (texto: string) => traduzir(texto, idioma ?? IDIOMA_PADRAO);

  const { data: origem, error: selErr } = await supabase
    .from("crm_leads")
    .select("id, pipeline_id")
    .eq("id", leadId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (selErr) return fail("internal_error", selErr.message, 500, { requestId });
  if (!origem) return fail("not_found", t("Lead não encontrado."), 404, { requestId });

  const { pipelines } = await listPipelinesHandler(supabase, {
    organization_id: organizationId,
    actor,
    requestId,
  });

  const idsDosDestinos = pipelines
    .filter((p) => p.id !== (origem as { pipeline_id: string }).pipeline_id)
    .map((p) => p.id);

  // Funil único (instalação nova) não é erro: a tela explica que não há destino.
  // Sem esta guarda o `.in("pipeline_id", [])` iria ao banco pedir nada.
  const { data: etapas, error: stagesErr } =
    idsDosDestinos.length === 0
      ? { data: [] as EtapaDeDestino[], error: null }
      : await supabase
          .from("crm_stages")
          .select("id, pipeline_id, name, position, is_won, is_lost")
          .eq("organization_id", organizationId)
          .in("pipeline_id", idsDosDestinos)
          .eq("is_archived", false)
          .order("position", { ascending: true });

  if (stagesErr) return fail("internal_error", stagesErr.message, 500, { requestId });

  const etapasPorFunil = new Map<string, EtapaNaResposta[]>();
  for (const etapa of (etapas ?? []) as EtapaDeDestino[]) {
    const lista = etapasPorFunil.get(etapa.pipeline_id) ?? [];
    lista.push({
      id: etapa.id,
      name: etapa.name,
      position: etapa.position,
      is_won: etapa.is_won,
      is_lost: etapa.is_lost,
    });
    etapasPorFunil.set(etapa.pipeline_id, lista);
  }

  const destinos = pipelines
    .filter((p) => p.id !== (origem as { pipeline_id: string }).pipeline_id)
    .map((p) => ({ id: p.id, name: p.name, stages: etapasPorFunil.get(p.id) ?? [] }));

  return ok({ pipelines: destinos }, { requestId });
}

type Linha = Record<string, unknown>;

interface GravacaoDoClone {
  clone: Linha;
  origem: Linha;
  criou: boolean;
  fechou: boolean;
}

// O caminho comum de criação não deve emitir evento nem auditar para quem
// apenas recebeu um card já existente da transação. Os anexos, sim, são
// completados nesse caso (ver `completaAnexos` no POST).
class CloneReutilizado extends Error {
  constructor(readonly gravacao: GravacaoDoClone) {
    super("clone_reutilizado");
  }
}

function respostaDoClone(gravacao: GravacaoDoClone, requestId: string, anexos = 0) {
  return ok(
    {
      lead: ocultarProvaMetaNaResposta(gravacao.clone),
      origem: ocultarProvaMetaNaResposta(gravacao.origem),
      anexos,
    },
    { requestId, status: gravacao.criou ? 201 : 200 },
  );
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_leads",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "leads_clone", requestId);
  if (teto) return teto;
  const supabase = authz.supabase;
  const { organizationId, actor, idioma } = authz;
  const t = (texto: string) => traduzir(texto, idioma ?? IDIOMA_PADRAO);

  const handlerCtx: HandlerCtx = {
    organization_id: organizationId,
    actor,
    requestId,
    idioma,
  };

  // A cópia reaproveitada completa os anexos que a primeira gravação não levou
  // (Storage que falhou, pedido que caiu entre a transação e a cópia). A cópia é
  // idempotente por anexo de origem, então repeti-la não duplica nada.
  const completaAnexos = async (gravacao: GravacaoDoClone) =>
    (await copiarAnexosDoClone(supabase, {
      organizationId,
      origemLeadId: leadId,
      destinoLeadId: String(gravacao.clone.id),
    })).copiados;

  try {
    const input = await validateRequest(cloneLeadSchema, req);

    const origem = await getLeadHandler(supabase, handlerCtx, leadId) as OrigemParaClonar & Linha;

    const { data: pipelineDestino, error: pipeErr } = await supabase
      .from("crm_pipelines")
      .select("id, name, is_archived")
      .eq("id", input.pipeline_id)
      .eq("organization_id", handlerCtx.organization_id)
      .maybeSingle();

    if (pipeErr) {
      return fail("internal_error", pipeErr.message, 500, { requestId });
    }
    if (!pipelineDestino || pipelineDestino.is_archived) {
      return fail("pipeline_not_found", t(FUNIL_DE_DESTINO_NAO_ENCONTRADO), 404, { requestId });
    }

    // O funil de ORIGEM responde DUAS coisas antes da primeira escrita: se um
    // encerrado pode ser clonado (issue #1538 — só num funil `novo_negocio`) e,
    // abaixo, se o `lost_reason` do chamador está no vocabulário dele.
    const { data: pipelineOrigem, error: origemPipeErr } = await supabase
      .from("crm_pipelines")
      .select("settings, name")
      .eq("id", origem.pipeline_id)
      .eq("organization_id", handlerCtx.organization_id)
      .maybeSingle();

    if (origemPipeErr) {
      return fail("internal_error", origemPipeErr.message, 500, { requestId });
    }
    const modoDaOrigem = modoDeReabertura(
      (pipelineOrigem as { settings?: unknown } | null)?.settings,
    );

    const recusa = recusaTrocaDeFunil(origem, input.pipeline_id, modoDaOrigem);
    if (recusa?.code === "pipeline_unchanged") {
      return fail(recusa.code, t(recusa.texto), recusa.status, { requestId });
    }

    const servidor = createAdminClient();
    let sessao: Linha | null = null;
    if (authz.via === "session") {
      const { data, error } = await supabase.auth.getClaims();
      if (error || !data?.claims || data.claims.sub !== actor.id) {
        return fail("unauthenticated", t("Auth required."), 401, { requestId });
      }
      const { sub, session_id, aal, role } = data.claims;
      sessao = { sub, session_id, aal, role };
    }

    async function gravar(
      linha: Linha | null,
      fechamento: Linha | null,
      atualizadaEm: unknown,
    ) {
      const { data, error } = await servidor.rpc("fn_levar_negocio_para_funil", {
        p_org: organizationId,
        p_origem: leadId,
        p_destino: input.pipeline_id,
        p_linha: linha,
        p_fechamento: fechamento,
        p_origem_atualizada_em: atualizadaEm ?? null,
        p_sessao: sessao,
      });
      if (error?.code === "PT404") {
        throw new ApiError(404, "not_found", undefined, requestId, t("Lead não encontrado."));
      }
      if (error?.code === "PT403" || ehRecusaDaVisibilidadeDoFunil(error)) {
        throw new ApiError(
          403, "forbidden", undefined, requestId,
          t("Sem permissão para salvar este negócio: pela visibilidade definida na organização, ele ficaria fora do que você pode ver."),
        );
      }
      if (error?.code === "PT409") {
        throw new ApiError(409, "state_conflict", undefined, requestId, t("O negócio mudou enquanto era encerrado."));
      }
      return { gravacao: data as GravacaoDoClone | null, error };
    }

    const consulta = await gravar(null, null, null);
    if (consulta.error) return fail("internal_error", consulta.error.message, 500, { requestId });
    const existente = consulta.gravacao;
    if (existente && existente.origem.status !== "open") {
      return respostaDoClone(existente, requestId, await completaAnexos(existente));
    }
    if (!existente && recusa) {
      return fail(recusa.code, t(recusa.texto), recusa.status, { requestId });
    }

    // O vocabulário de perda é do funil que a operação encerra.
    const motivoRecusado = recusaDeMotivoForaDoVocabulario({
      motivo: input.lost_reason,
      settingsDoFunil: (pipelineOrigem as { settings?: unknown } | null)?.settings ?? null,
      idioma,
    });
    if (motivoRecusado) {
      return fail(motivoRecusado.codigo, motivoRecusado.mensagem, 422, { requestId });
    }

    let etapaDeEntrada: EtapaDoFunil | null = null;
    if (!existente) {
      const { data: etapas, error: stagesErr } = await supabase
        .from("crm_stages")
        .select("id, pipeline_id, position, is_won, is_lost, is_archived")
        .eq("organization_id", handlerCtx.organization_id)
        .eq("pipeline_id", input.pipeline_id)
        .eq("is_archived", false)
        .order("position", { ascending: true });

      if (stagesErr) {
        return fail("internal_error", stagesErr.message, 500, { requestId });
      }

      const destino = escolheEtapaDeDestino(
        (etapas ?? []) as EtapaDoFunil[],
        input.stage_id ?? null,
      );
      if (!destino.ok) {
        return fail(destino.code, t(destino.texto), destino.status, { requestId });
      }

      // A etapa de destino valida os campos que serão herdados. Anexos só
      // existem depois da criação, como em createLeadHandler (#3433).
      const settingsDoDestino = await settingsDoFunil(supabase, destino.etapa.pipeline_id, organizationId);
      const vereditoDeCampos = validaCamposExigidos({
        lead: { custom_fields: origem.custom_fields ?? {} },
        settingsDoFunil: settingsDoDestino,
        destino: { stageId: destino.etapa.id, desfecho: null },
        motivoDeGanho: null,
        semAnexosAinda: true,
      });
      if (vereditoDeCampos.faltando.length > 0) {
        const recusaDeCampos = recusaDeCamposObrigatorios(
          vereditoDeCampos.faltando,
          idioma,
        );
        return fail(recusaDeCampos.codigo, recusaDeCampos.mensagem, 422, {
          details: { faltando: vereditoDeCampos.faltando },
          requestId,
        });
      }
      etapaDeEntrada = destino.etapa;
    }

    const nomeDoFunilDeOrigem = (pipelineOrigem as { name?: string | null } | null)?.name ?? null;
    const nomeDoFunilDeDestino = (pipelineDestino as { name?: string | null }).name ?? null;
    const origemAtual = existente?.origem ?? origem;
    const motivo = origemAtual.status === "open"
      ? motivoDaPerdaDaOrigem(input.lost_reason)
      : ((origemAtual.lost_reason as string | null) ?? null);
    const dadosDoFecho: EncerraDemandaInput = {
      leadId,
      desfecho: "lost",
      motivo,
      razaoNaTimeline: nomeDoFunilDeDestino
        ? `Levado para o funil ${nomeDoFunilDeDestino}`
        : "Levado para outro funil",
    };
    const preparo = origemAtual.status === "open"
      ? await preparaEncerramentoDemanda(supabase, handlerCtx, dadosDoFecho)
      : null;
    const fechamento = preparo && !preparo.jaEstava ? preparo : null;

    let gravacao: GravacaoDoClone;
    let anexosCopiados = 0;
    if (etapaDeEntrada) {
      const escrita: { gravacao?: GravacaoDoClone } = {};
      try {
        const { anexos } = await criarCloneNoFunil(supabase, handlerCtx, origem, etapaDeEntrada, {
          persistir: async (linha) => {
            const tentar = () => gravar(linha, fechamento?.patch ?? null, origem.updated_at);
            // A automação e o roteador de intenção gravam a cópia FORA desta
            // transação. Se um deles gravou entre a busca e o INSERT, o índice
            // único recusa com 23505 (#5281); a 2ª chamada acha essa cópia sob a
            // trava da origem e a reaproveita, como a qualquer repetição.
            let resultado = await tentar();
            if (resultado.error?.code === "23505") resultado = await tentar();
            if (resultado.gravacao && !resultado.gravacao.criou) {
              throw new CloneReutilizado(resultado.gravacao);
            }
            escrita.gravacao = resultado.gravacao ?? undefined;
            return { data: resultado.gravacao?.clone ?? null, error: resultado.error };
          },
        });
        anexosCopiados = anexos.copiados;
        if (!escrita.gravacao) {
          throw new ApiError(500, "internal_error", undefined, requestId);
        }
        gravacao = escrita.gravacao;
      } catch (erro) {
        if (!(erro instanceof CloneReutilizado)) throw erro;
        gravacao = erro.gravacao;
      }
    } else if (fechamento) {
      const resultado = await gravar(null, fechamento.patch, fechamento.lead.updated_at);
      if (resultado.error) {
        const recusaDeMotivo = recusaDeMotivoDaPerdaPeloBanco(resultado.error, idioma);
        if (recusaDeMotivo) return fail(recusaDeMotivo.codigo, recusaDeMotivo.mensagem, 422, { requestId });
      }
      if (!resultado.gravacao || resultado.error) {
        return fail("internal_error", resultado.error?.message ?? "Falha ao levar o negócio.", 500, { requestId });
      }
      gravacao = resultado.gravacao;
    } else {
      // O fecho concorrente já terminou desde a primeira leitura.
      const atual = await gravar(null, null, null);
      if (atual.error) return fail("internal_error", atual.error.message, 500, { requestId });
      if (!atual.gravacao) return fail("state_conflict", t("O negócio mudou enquanto era encerrado."), 409, { requestId });
      return respostaDoClone(atual.gravacao, requestId, await completaAnexos(atual.gravacao));
    }

    if (!gravacao.criou) anexosCopiados = await completaAnexos(gravacao);
    if (!gravacao.criou && !gravacao.fechou) return respostaDoClone(gravacao, requestId, anexosCopiados);
    const destination = registroDoDestino(gravacao.clone);

    if (gravacao.criou) {
      const atividadeDoClone = await emitLeadActivity(supabase, {
        organizationId: handlerCtx.organization_id,
        leadId: String(destination.lead_id),
        contactId: origem.contact_id ?? null,
        type: "moved_from_pipeline",
        sourceModule: "crm",
        sourceId: leadId,
        actor: handlerCtx.actor,
        reason: nomeDoFunilDeOrigem ? `Veio do funil ${nomeDoFunilDeOrigem}` : "Veio de outro funil",
        payload: {
          from_pipeline_id: origem.pipeline_id,
          from_lead_id: leadId,
        },
      });
      if (!atividadeDoClone.ok) {
        // Falha BAIXO, como em `encerraDemanda`: o clone já existe, e prender a
        // troca à timeline deixaria a operação refém do registro. Contada, nunca
        // engolida.
        await registraFalhaDeAtividade(supabase, {
          organizationId: handlerCtx.organization_id,
          leadId: String(destination.lead_id),
          tipo: "moved_from_pipeline",
          origem: "app/api/v1/leads/[id]/clone",
          erro: atividadeDoClone.error,
          requestId,
        });
      }
    }

    if (gravacao.fechou && fechamento) {
      await registraEncerramentoDemanda(supabase, handlerCtx, {
        ...dadosDoFecho,
        payloadNaTimeline: { to_pipeline_id: input.pipeline_id, to_lead_id: destination.lead_id },
      }, fechamento, gravacao.origem);
    }

    await audit({
      action: "lead.moved_to_pipeline",
      actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
      actorApiTokenId: authz.apiTokenId ?? null,
      organizationId: handlerCtx.organization_id,
      resourceType: "crm_lead",
      resourceId: leadId,
      requestId,
      metadata: {
        actor_type: "user",
        from_pipeline_id: origem.pipeline_id,
        to_pipeline_id: input.pipeline_id,
        to_stage_id: destination.stage_id,
        cloned_lead_id: destination.lead_id,
        lost_reason: motivo,
      },
    });

    return respostaDoClone(gravacao, requestId, anexosCopiados);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
