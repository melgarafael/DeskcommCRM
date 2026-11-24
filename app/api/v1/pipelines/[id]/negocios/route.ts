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
 *   - `{ escolha: "transferir", funil_id, etapa_id? }` — leva os negócios EM
 *     ANDAMENTO (`status = 'open'`) do funil para o destino; os ganhos e perdidos
 *     ficam no funil de origem (doc de decisão 400, opção B). Sem `etapa_id`, a primeira etapa de ANDAMENTO do
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
 * ─── O QUE A ROTA FAZ EM VOLTA DA FUNÇÃO, E POR QUÊ (#4852) ────────────────
 *
 * O lote do quadro não é só o RPC: antes dele vêm as recusas de negócio e depois a
 * linha do tempo de cada card. A transferência pulava as três, e cada ausência era
 * um defeito medido:
 *
 *   1. **SÓ O NEGÓCIO EM ANDAMENTO MUDA DE FUNIL** (doc 400, opção B). Ganho e
 *      perdido ficam no funil de origem — arquivado, ele abre em modo leitura e
 *      guarda o histórico. Levá-los para uma etapa de andamento do destino
 *      poria venda fechada numa coluna aberta e contaria a venda no funil
 *      errado, e o gatilho de fechamento (P-02, sem exceção) os reabriria. Por
 *      isso a leitura do lote filtra `status = 'open'`, e a recusa de reabertura
 *      do lote do quadro não tem o que recusar aqui. Para EXCLUIR de vez um funil
 *      com encerrados, o caminho é `remover`.
 *
 *   2. (A recusa de reabertura do `novo_negocio` não se aplica: nenhum negócio
 *      encerrado entra no lote.)
 *
 *   3. **OS CAMPOS OBRIGATÓRIOS DO DESTINO VALEM.** Mesma régua do lote do quadro,
 *      pela MESMA função (`recusaDeCamposDoLote` → `validaCamposExigidos`): 422
 *      `required_fields_missing`, com `details.lead_ids` e `details.faltando` por
 *      card. O `settings` é o do funil de DESTINO — a etapa que recebe é dele, e é
 *      ele que declara `obrigatorio_em`. Sem isso, a transferência em massa seria a
 *      porta por onde um lote inteiro entra numa etapa que exige campo.
 *
 *   4. **CADA NEGÓCIO GANHA A SUA LINHA DE `stage_changed`.** N negócios movidos são
 *      N timelines — uma linha em cada uma, com a etapa de ORIGEM que a função
 *      devolve (lida dentro do `update`, sem janela para outra escrita mover o card
 *      entre a leitura e a gravação), `bulk: true` e `transferencia_de_funil: true`
 *      para quem lê distinguir a origem. Sem elas, mover um funil inteiro era o
 *      buraco por onde a timeline some.
 *
 * ⚠️ `lead.stage_changed` NÃO É EMITIDO — e é decisão, não esquecimento. Esse evento
 * alimenta o follow-up por etapa, os avisos de etapa, as conversões de anúncio e os
 * webhooks de saída: disparar um por card numa transferência em massa mandaria
 * mensagem para centenas de contatos de uma vez, por um movimento que não é avanço
 * de etapa nenhum (o negócio não andou; ele mudou de funil). O lote do quadro emite
 * porque lá cada card realmente avançou dentro do funil. O que fica registrado é o
 * que auditoria e timeline precisam: a atividade por card, o `audit` da operação e
 * o resumo com os números medidos.
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
import { emitLeadActivity, stageChangeReason } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { settingsDoFunil } from "@/lib/leads/campos-exigidos";
import { recusaDeCamposDoLote } from "@/lib/leads/campos-obrigatorios-em-lote";
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
 * O negócio como as regras desta rota o leem — as MESMAS colunas que o lote do
 * quadro carrega antes de decidir (`status` para a reabertura, `custom_fields` e
 * `won_reason` para os campos obrigatórios, `contact_id` para a linha da timeline).
 */
interface NegocioDoFunil {
  id: string;
  stage_id: string;
  pipeline_id: string;
  contact_id: string | null;
  status: string | null;
  custom_fields: Record<string, unknown> | null;
  won_reason: string | null;
}

/**
 * Todos os negócios do funil, paginados.
 *
 * ⚠️ PAGINADO, e não um `select` só: o PostgREST devolve no máximo 1000 linhas
 * (`max_rows` do `config.toml`) sem erro nenhum — um funil com 3.900 negócios
 * transferiria 1.000 e diria "pronto". O laço só termina quando uma página vem
 * incompleta.
 *
 * `order by id` é o que torna a paginação determinística: sem ordem, duas páginas
 * podem repetir ou pular linha.
 */
async function negociosDoFunil(
  supabase: Supabase,
  orgId: string,
  pipelineId: string,
  somenteAbertos: boolean,
): Promise<NegocioDoFunil[]> {
  const negocios: NegocioDoFunil[] = [];
  for (let de = 0; ; de += PAGINA) {
    let consulta = supabase
      .from("crm_leads")
      .select("id, stage_id, pipeline_id, contact_id, status, custom_fields, won_reason")
      .eq("organization_id", orgId)
      .eq("pipeline_id", pipelineId);
    // Doc 400 (B): a transferência leva só o negócio em andamento.
    if (somenteAbertos) consulta = consulta.eq("status", "open");
    const { data, error } = await consulta
      .order("id", { ascending: true })
      .range(de, de + PAGINA - 1);
    if (error) throw new Error(error.message);
    const pagina = (data ?? []) as unknown as NegocioDoFunil[];
    for (const linha of pagina) negocios.push(linha);
    if (pagina.length < PAGINA) break;
  }
  return negocios;
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
    // Doc 400 (B): só os em andamento são transferidos — a tela diz quantos são
    // e quantos (ganhos e perdidos) ficam no funil.
    const { count: abertos, error: abertosErr } = await supabase
      .from("crm_leads")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("pipeline_id", pipelineId)
      .eq("status", "open");
    if (abertosErr) throw new Error(abertosErr.message);
    // `negocios` e os dois outros vínculos vão juntos: a tela mostra a contagem e,
    // quando a rota RECUSA o arquivamento, é esta mesma leitura que explica por quê.
    return ok(
      {
        negocios: deps.negocios,
        abertos: abertos ?? 0,
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

  let negocios: NegocioDoFunil[];
  try {
    negocios = await negociosDoFunil(supabase, orgId, pipelineId, pedido.escolha === "transferir");
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }

  if (negocios.length === 0) {
    // Só encerrados no funil: nada a transferir, e eles ficam onde estão (B).
    return ok(
      {
        escolha: pedido.escolha,
        movidos: 0,
        restantes: negociosAntes,
        mensagem:
          pedido.escolha === "transferir"
            ? t("Nenhum negócio em andamento para transferir. Os ganhos e perdidos ficam neste funil.")
            : null,
        destino: null,
        encerrados_ficaram: pedido.escolha === "transferir" ? negociosAntes : 0,
      },
      { requestId },
    );
  }

  if (pedido.escolha === "transferir") {
    const settingsDoDestino = await settingsDoFunil(supabase, destinoPipelineId, orgId);

    // ── OS CAMPOS OBRIGATÓRIOS DO DESTINO ───────────────────────────────────
    // A etapa de destino é sempre de ANDAMENTO (as de fechamento são recusadas
    // acima), então não há `desfecho`: o que se cobra é a régua de `etapa`.
    const camposDoLote = await recusaDeCamposDoLote({
      supabase,
      organizationId: orgId,
      negocios,
      settingsDoFunilDe: () => settingsDoDestino,
      destino: { stageId: destinoStageId, desfecho: null },
      idioma: authz.user.idioma,
    });
    if (camposDoLote.recusa) {
      return fail(camposDoLote.recusa.codigo, camposDoLote.recusa.mensagem, 422, {
        requestId,
        details: {
          lead_ids: camposDoLote.recusa.lead_ids,
          faltando: camposDoLote.faltandoPorCard,
        },
      });
    }
  }

  const ids = negocios.map((n) => n.id);

  let movidosNoBanco: Array<{ lead_id: string; from_stage_id: string; pipeline_id: string }> = [];

  if (pedido.escolha === "transferir") {
    // UMA chamada, UMA transação: "transferir todos de uma vez" é a regra da
    // issue, e a função do banco move o lote inteiro ou nada. O `pipeline_id` vai
    // junto porque a função o tira da PRÓPRIA etapa de destino (migration 9466).
    const { data, error } = await supabase.rpc("fn_mover_leads_em_lote", {
      p_organization_id: orgId,
      p_lead_ids: ids,
      p_stage_id: destinoStageId,
      p_lost_reason: null,
    });
    if (error) return fail("internal_error", error.message, 500, { requestId });
    movidosNoBanco = (data ?? []) as typeof movidosNoBanco;
    await registraEstagioNaTimeline({
      supabase,
      orgId,
      requestId,
      actorUserId: authz.user.id,
      destinoStageId: destinoStageId as string,
      destinoPipelineId: destinoPipelineId as string,
      negocios,
      movidosNoBanco,
    });
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
      // Doc 400 (B): os ganhos e perdidos que ficaram no funil de origem — medido
      // DEPOIS, no banco. Zero no `remover` (as linhas não existem mais).
      encerrados_ficaram: pedido.escolha === "transferir" ? restantes : 0,
    },
    { requestId },
  );
}

/**
 * UMA linha de `stage_changed` por negócio — a timeline do lote, card a card.
 *
 * `source_id` é o próprio negócio (é a timeline DELE), `bulk` e
 * `transferencia_de_funil` marcam a origem para quem lê depois, e a etapa de
 * origem vem da função do banco, não do `select` de antes.
 *
 * Falha de atividade NÃO derruba a transferência (ela já aconteceu) — vira o
 * registro de falha de `registraFalhaDeAtividade`, que é o que impede o buraco
 * na timeline de ficar sem nem tamanho conhecido.
 */
async function registraEstagioNaTimeline(input: {
  supabase: Supabase;
  orgId: string;
  requestId: string;
  actorUserId: string;
  destinoStageId: string;
  destinoPipelineId: string;
  negocios: NegocioDoFunil[];
  movidosNoBanco: Array<{ lead_id: string; from_stage_id: string; pipeline_id: string }>;
}): Promise<void> {
  const { supabase, orgId, requestId, actorUserId, destinoStageId, destinoPipelineId, negocios, movidosNoBanco } =
    input;

  // Card que já estava na etapa de destino não mudou de etapa: nada a contar.
  const movidos = movidosNoBanco.filter((r) => r.from_stage_id !== destinoStageId);
  if (movidos.length === 0) return;

  const nomesEstagio = new Map<string, string>();
  const { data: stageRows } = await supabase
    .from("crm_stages")
    .select("id, name")
    .eq("organization_id", orgId)
    .in("id", [destinoStageId, ...movidos.map((r) => r.from_stage_id)]);
  for (const s of (stageRows ?? []) as Array<{ id: string; name: string }>) {
    nomesEstagio.set(s.id, s.name);
  }

  const contatoPorNegocio = new Map(negocios.map((n) => [n.id, n.contact_id]));

  await Promise.all(
    movidos.map(async (row) => {
      const r = await emitLeadActivity(supabase, {
        organizationId: orgId,
        leadId: row.lead_id,
        contactId: contatoPorNegocio.get(row.lead_id) ?? null,
        // `stage_changed` é o tipo que a taxa por etapa e a `win-rates` leem
        // (#1753): trocar por outro tipo tiraria a transferência da conta.
        type: "stage_changed",
        sourceModule: "crm",
        sourceId: row.lead_id,
        actor: { type: "user", id: actorUserId },
        reason: stageChangeReason(
          nomesEstagio.get(row.from_stage_id) ?? null,
          nomesEstagio.get(destinoStageId) ?? null,
        ),
        payload: {
          from_stage_id: row.from_stage_id,
          to_stage_id: destinoStageId,
          // `row.pipeline_id` é o funil de ORIGEM (lido antes do `update`); o
          // `pipeline_id` da linha é onde o negócio passou a morar.
          from_pipeline_id: row.pipeline_id,
          pipeline_id: destinoPipelineId,
          bulk: true,
          transferencia_de_funil: true,
        },
      });
      if (!r.ok) {
        await registraFalhaDeAtividade(supabase, {
          organizationId: orgId,
          leadId: row.lead_id,
          tipo: "stage_changed",
          origem: "pipelines/negocios",
          erro: r.error,
          requestId,
        });
      }
    }),
  );
}
