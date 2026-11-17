import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET/POST /api/v1/pipelines/[id]/negocios — o que fazer com os negócios de um
 * funil que vai ser arquivado ou excluído (#4802, item 3).
 *
 * `GET` responde QUANTOS negócios estão vinculados. É a contagem da confirmação, e
 * sai da MESMA leitura que a rota `DELETE /api/v1/pipelines/[id]` usa para recusar
 * (`lerDependencias`) — duas consultas para "quantos negócios este funil tem"
 * divergiriam na primeira arquivamento de card, e o usuário decidiria sobre um
 * número que o banco não tem.
 *
 * `POST` executa a escolha:
 *   - `{ escolha: "transferir", funil_id, etapa_id? }` — leva TODOS os negócios do
 *     funil para o destino. Sem `etapa_id`, a primeira etapa de ANDAMENTO do
 *     destino os recebe; com `etapa_id`, é ELA que recebe (item b da issue).
 *   - `{ escolha: "remover" }` — apaga as linhas de `crm_leads` do funil: os
 *     negócios saem da estrutura dos funis, e contatos, conversas e histórico
 *     continuam existindo (ver o cabeçalho de
 *     `lib/pipelines/transferencia-de-negocios.ts`).
 *
 * ⚠️ A TRANSFERÊNCIA NÃO ESCREVE `stage_id` POR CONTA PRÓPRIA. Ela chama
 * `fn_mover_leads_em_lote`, a mesma função que o lote do quadro usa, que dá posição
 * distinta a cada card e move todos numa transação só. Um `update` em massa escrito
 * aqui seria o segundo caminho de movimento de negócio do produto — e os dois
 * divergiriam no primeiro ajuste de posição.
 *
 * ⚠️ ARQUIVAR SEM TRANSFERIR CONTINUA POSSÍVEL: esta rota é opcional. Quem não
 * chama nada arquiva pelo `DELETE` de sempre, e o funil leva os negócios com ele.
 * A exclusão definitiva continua exigindo `?definitivo=1` explícito, e depois desta
 * rota ela passa a funcionar para o funil que tinha negócio — porque não tem mais.
 *
 * Auth: sessão por cookie, papel manager+ (a mesma régua de arquivar). A org sai do
 * JWT — nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  resumoDaOperacao,
  validarDestinoDaTransferencia,
  type EtapaConhecida,
} from "@/lib/pipelines/transferencia-de-negocios";
import { lerDependencias, lerFunis } from "../../_funis";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/** Quantos ids cabem numa página de leitura. O PostgREST corta em 1000 por padrão. */
const PAGINA = 1000;

const bodySchema = z.discriminatedUnion("escolha", [
  z
    .object({
      escolha: z.literal("transferir"),
      funil_id: z.string().uuid(),
      /** Ausente = primeira etapa de andamento do destino (escolha "transferir para outro funil"). */
      etapa_id: z.string().uuid().nullish(),
    })
    .strict(),
  z.object({ escolha: z.literal("remover") }).strict(),
]);

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Os ids de TODOS os negócios do funil, paginados.
 *
 * ⚠️ PAGINADO, e não um `select` só: o PostgREST devolve no máximo 1000 linhas
 * (`max_rows` do `config.toml`) sem erro nenhum — um funil com 3.900 negócios
 * transferiria 1.000 e diria "pronto". O laço só termina quando uma página vem
 * incompleta.
 *
 * `order by id` é o que torna a paginação determinística: sem ordem, duas páginas
 * podem repetir ou pular linha.
 */
async function idsDosNegocios(
  supabase: Supabase,
  orgId: string,
  pipelineId: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await supabase
      .from("crm_leads")
      .select("id")
      .eq("organization_id", orgId)
      .eq("pipeline_id", pipelineId)
      .order("id", { ascending: true })
      .range(de, de + PAGINA - 1);
    if (error) throw new Error(error.message);
    const pagina = (data ?? []) as Array<{ id: string }>;
    for (const linha of pagina) ids.push(linha.id);
    if (pagina.length < PAGINA) break;
  }
  return ids;
}

/** As etapas de um funil, como a regra as quer. */
async function etapasDoFunil(
  supabase: Supabase,
  orgId: string,
  pipelineId: string,
): Promise<EtapaConhecida[]> {
  const { data, error } = await supabase
    .from("crm_stages")
    .select("id, name, pipeline_id, position, is_won, is_lost, is_archived")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .order("position", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as EtapaConhecida[];
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_pipelines" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { id: pipelineId } = await ctx.params;

  const supabase = await createClient();

  let funis;
  try {
    funis = await lerFunis(supabase, orgId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
  const alvo = funis.find((f) => f.id === pipelineId);
  if (!alvo) return fail("not_found", t("Funil não encontrado."), 404, { requestId });

  try {
    const deps = await lerDependencias(supabase, orgId, pipelineId);
    // `negocios` e os dois outros vínculos vão juntos: a tela mostra a contagem e,
    // quando a rota RECUSA o arquivamento, é esta mesma leitura que explica por quê.
    return ok(
      {
        negocios: deps.negocios,
        fontes_de_webhook: deps.fontesDeWebhook.length,
        automacoes: deps.regrasAtivas.length,
      },
      { requestId },
    );
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_pipelines" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { id: pipelineId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Não entendi o que fazer com os negócios deste funil."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const pedido = parsed.data;

  const supabase = await createClient();

  let funis;
  try {
    funis = await lerFunis(supabase, orgId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
  const origem = funis.find((f) => f.id === pipelineId);
  if (!origem) return fail("not_found", t("Funil não encontrado."), 404, { requestId });

  // A contagem de ANTES é a mesma que a tela mostrou na confirmação — e é ela que
  // entra na auditoria. Lida aqui, não recebida do cliente: número vindo de fora
  // seria o do momento em que a tela abriu.
  let negociosAntes: number;
  try {
    negociosAntes = (await lerDependencias(supabase, orgId, pipelineId)).negocios;
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }

  if (negociosAntes === 0) {
    return ok(
      {
        escolha: pedido.escolha,
        movidos: 0,
        restantes: 0,
        // Nada a fazer, e dizer isso é mais útil que um 422: a tela pediu uma
        // transferência que já está feita (ou o lote saiu por outra aba).
        mensagem: t("Este funil não tem mais negócios vinculados."),
        destino: null,
      },
      { requestId },
    );
  }

  let destinoPipelineId: string | null = null;
  let destinoStageId: string | null = null;

  if (pedido.escolha === "transferir") {
    let etapasDestino: EtapaConhecida[];
    try {
      etapasDestino = await etapasDoFunil(supabase, orgId, pedido.funil_id);
    } catch (err) {
      return fail("internal_error", (err as Error).message, 500, { requestId });
    }

    const veredito = validarDestinoDaTransferencia({
      origemId: pipelineId,
      destinoId: pedido.funil_id,
      etapaId: pedido.etapa_id ?? null,
      funis: funis.map((f) => ({ id: f.id, name: f.name, is_archived: f.is_archived })),
      etapasDoDestino: etapasDestino,
    });
    if (!veredito.ok) {
      const nomeDoDestino = funis.find((f) => f.id === pedido.funil_id)?.name ?? "";
      const nomeDaEtapa = etapasDestino.find((e) => e.id === (pedido.etapa_id ?? ""))?.name ?? "";
      // `t()` primeiro, `replace` depois: as frases de
      // `lib/pipelines/transferencia-de-negocios.ts` são CHAVE do dicionário com o
      // `{nome}`/`{etapa}` por preencher — interpolar antes da tradução deixaria a
      // frase fora do dicionário e o espanhol cairia no português.
      const mensagem = t(veredito.erro)
        .replace("{nome}", nomeDoDestino)
        .replace("{etapa}", nomeDaEtapa);
      return fail(
        veredito.codigo === "not_found" ? "not_found" : "unprocessable_entity",
        mensagem,
        veredito.codigo === "not_found" ? 404 : 422,
        { requestId },
      );
    }
    destinoPipelineId = veredito.valor.destino.id;
    destinoStageId = veredito.valor.etapa.id;
  }

  let ids: string[];
  try {
    ids = await idsDosNegocios(supabase, orgId, pipelineId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }

  if (ids.length === 0) {
    return ok(
      { escolha: pedido.escolha, movidos: 0, restantes: 0, mensagem: null, destino: null },
      { requestId },
    );
  }

  if (pedido.escolha === "transferir") {
    // UMA chamada, UMA transação: "transferir todos de uma vez" é a regra da
    // issue, e a função do banco move o lote inteiro ou nada.
    const { error } = await supabase.rpc("fn_mover_leads_em_lote", {
      p_organization_id: orgId,
      p_lead_ids: ids,
      p_stage_id: destinoStageId,
      p_lost_reason: null,
    });
    if (error) return fail("internal_error", error.message, 500, { requestId });
  } else {
    // `remover`: as LINHAS do negócio saem. O contato fica (`contact_id` é SET NULL
    // no banco) e a timeline fica (`crm_lead_activities.lead_id` é SET NULL desde a
    // migration desta fatia — era CASCADE, e apagar o negócio apagava o histórico).
    const { error } = await supabase
      .from("crm_leads")
      .delete()
      .eq("organization_id", orgId)
      .in("id", ids);
    if (error) return fail("internal_error", error.message, 500, { requestId });
  }

  // ⚠️ QUANTOS SE MOVERAM É MEDIDO NO BANCO, não deduzido do tamanho do lote. O
  // número que a rota devolve é o mesmo que qualquer consulta devolveria depois —
  // e uma escrita concorrente (outra aba arquivando card no meio) aparece aqui como
  // diferença, em vez de virar uma frase otimista.
  let restantes: number;
  try {
    restantes = (await lerDependencias(supabase, orgId, pipelineId)).negocios;
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }

  const resumo = resumoDaOperacao({
    escolha: pedido.escolha,
    origem_pipeline_id: pipelineId,
    destino_pipeline_id: destinoPipelineId,
    destino_stage_id: destinoStageId,
    negocios_antes: negociosAntes,
    movidos: negociosAntes - restantes,
    restantes,
  });

  void audit({
    action: pedido.escolha === "transferir" ? "pipeline.negocios_transferidos" : "pipeline.negocios_removidos",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "crm_pipeline",
    resourceId: pipelineId,
    requestId,
    metadata: { ...resumo, nome_do_funil: origem.name },
  });

  return ok(
    {
      escolha: pedido.escolha,
      movidos: resumo.movidos,
      restantes: resumo.restantes,
      mensagem: null,
      destino: destinoStageId
        ? { funil_id: destinoPipelineId, etapa_id: destinoStageId }
        : null,
    },
    { requestId },
  );
}
