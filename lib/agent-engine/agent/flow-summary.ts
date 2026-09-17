/**
 * Síntese do fluxo de atendimento (Fase 3 do fluxo robusto) — o "passa-bastão"
 * que a continuação da venda lê para não reperguntar.
 *
 * Ao concluir (ou esgotar) um fluxo, `lib/followup/atendimento.ts` grava uma
 * síntese DETERMINÍSTICA em `followup_enrollments.completion_note` e enfileira
 * este job. Aqui a mesma síntese é REESCRITA em texto natural por UMA chamada de
 * modelo pelo seam único (`runModelCall`, purpose `flow_summary`). Se o modelo
 * falhar, a nota determinística permanece — o job só sobrescreve em caso de
 * sucesso. O motor garante; o modelo só redige.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import type { ProviderRegistry } from '../edge/llm/providers';
import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { JobRow } from '../queue/queue';
import { flowGraphSchema } from '@/lib/followup/graph-schema';
import { mapearChecklist, type PassoDeAtendimento } from '@/lib/followup/atendimento';

const RESUMO_INSTRUCAO =
  'Você escreve a SÍNTESE de um atendimento para o próximo passo da venda. ' +
  'Responda SOMENTE com um parágrafo curto (2 a 4 frases), em português do Brasil. ' +
  'NÃO responda ao cliente, NÃO faça perguntas, NÃO use marcadores nem título. ' +
  'Use apenas o que está abaixo; NÃO invente dados que não aparecem.';

export interface CampoDoResumo {
  label: string;
  key: string;
  valor: string | null;
}

export interface EventoDoResumo {
  kind: string;
  field_key: string | null;
}

export interface FluxoParaResumir {
  nomeDoFluxo: string;
  campos: CampoDoResumo[];
  eventos: EventoDoResumo[];
}

/** Monta a mensagem do modelo. Puro — coberto por teste. */
export function montarMensagemDoResumo(dados: FluxoParaResumir): string {
  const linhas = dados.campos.map(
    (c) => `- ${c.label}: ${c.valor === null || c.valor === '' ? '(não respondido)' : c.valor}`,
  );
  const esgotadas = dados.eventos.filter((e) => e.kind === 'esgotado').length;
  const desvios = dados.eventos.filter((e) => e.kind === 'fora_do_fluxo').length;
  return [
    RESUMO_INSTRUCAO,
    '',
    '## Fluxo',
    dados.nomeDoFluxo,
    '',
    '## Perguntas e respostas (na ordem)',
    linhas.length > 0 ? linhas.join('\n') : '- (nenhuma pergunta registrada)',
    '',
    '## Sinais do atendimento',
    `- desvios do roteiro (cliente falou de outro assunto): ${desvios}`,
    `- perguntas esgotadas sem resposta: ${esgotadas}`,
  ].join('\n');
}

/**
 * Normaliza a saída do modelo: tira cercas de código, colapsa espaço e corta no
 * teto da coluna. Vazio depois disso = `null` (o chamador re-tenta pela fila).
 */
export function limparResumo(texto: string): string | null {
  const limpo = texto
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (limpo.length === 0) return null;
  return limpo.slice(0, 2000);
}

export interface FlowSummaryDeps {
  llmCfg: LlmEdgeConfig;
  log: Logger;
  registry?: ProviderRegistry;
}

/** Escreve a síntese natural do fluxo. Lança quando o modelo devolve vazio. */
export async function sintetizarFluxoDeAtendimento(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId: string; jobId: string },
  dados: FluxoParaResumir,
  deps: { registry?: ProviderRegistry; log: Logger },
): Promise<string> {
  const call = await runModelCall(
    db,
    cfg,
    {
      tenantId: ids.tenantId,
      leadId: ids.leadId,
      jobId: ids.jobId,
      purpose: 'flow_summary',
      messages: [{ role: 'user', content: montarMensagemDoResumo(dados) }],
    },
    { registry: deps.registry, log: deps.log },
  );
  const resumo = limparResumo(call.result.text);
  if (resumo === null) {
    throw new Error('síntese do fluxo: modelo devolveu texto vazio — job re-tentado pela fila');
  }
  return resumo;
}

/** Os passos `collect` do grafo, na ordem — de onde saem os rótulos. */
function passosCollectDoGrafo(graph: unknown): Extract<PassoDeAtendimento, { kind: 'collect' }>[] {
  const parsed = flowGraphSchema.safeParse(graph);
  if (!parsed.success) return [];
  const checklist = mapearChecklist(parsed.data);
  if (!checklist.ok) return [];
  return checklist.checklist.passos.filter(
    (p): p is Extract<PassoDeAtendimento, { kind: 'collect' }> => p.kind === 'collect',
  );
}

/**
 * Handler do job `flow_summary`. Recalcula a síntese natural e a grava em
 * `completion_note` — SÓ quando o enrollment está concluído e o modelo devolve
 * texto. A nota determinística gravada na conclusão fica como fallback.
 */
export function createFlowSummaryHandler(deps: FlowSummaryDeps) {
  return async (job: JobRow, pool: pg.Pool): Promise<void> => {
    const tenantId = job.organization_id;
    const leadId = job.contact_id;
    if (leadId === null) {
      throw new Error('job flow_summary sem contact_id — o CHECK da fila deveria impedir');
    }
    const payload = (job.payload ?? {}) as { enrollment_id?: unknown };
    const enrollmentId = typeof payload.enrollment_id === 'string' ? payload.enrollment_id : '';
    if (enrollmentId === '') {
      throw new Error('job flow_summary sem enrollment_id no payload');
    }

    const alvo = await pool.query<{
      pointer_id: string;
      status: string;
      nome: string;
      graph: unknown;
    }>(
      `select e.pointer_id, e.status, p.name as nome, v.graph
         from followup_enrollments e
         join followup_flow_pointers p on p.id = e.pointer_id
         join followup_flow_versions v on v.id = e.version_id
        where e.organization_id = $1 and e.id = $2 and e.contact_id = $3`,
      [tenantId, enrollmentId, leadId],
    );
    const row = alvo.rows[0];
    if (!row) return;
    // Só resume o que concluiu: um job re-tentado depois de a execução reabrir
    // não deve reescrever uma nota de fluxo vivo.
    if (row.status !== 'completed') return;

    const valores = await pool.query<{ field_key: string; value: string | null }>(
      `select field_key, value from contact_flow_data
        where organization_id = $1 and contact_id = $2 and flow_pointer_id = $3`,
      [tenantId, leadId, row.pointer_id],
    );
    const porChave = new Map(valores.rows.map((v) => [v.field_key, v.value]));
    const passos = passosCollectDoGrafo(row.graph);
    const campos: CampoDoResumo[] = passos.map((p) => ({
      label: p.node.config.label,
      key: p.node.config.key,
      valor: porChave.get(p.node.config.key) ?? null,
    }));
    // Valores fora do checklist (campo removido do grafo depois de coletado)
    // entram no fim, para não sumirem da síntese.
    for (const v of valores.rows) {
      if (!campos.some((c) => c.key === v.field_key)) {
        campos.push({ label: v.field_key, key: v.field_key, valor: v.value });
      }
    }

    const eventos = await pool.query<{ kind: string; field_key: string | null }>(
      `select kind, field_key from contact_flow_events
        where organization_id = $1 and enrollment_id = $2
        order by created_at asc
        limit 200`,
      [tenantId, enrollmentId],
    );

    const resumo = await sintetizarFluxoDeAtendimento(
      pool,
      deps.llmCfg,
      { tenantId, leadId, jobId: job.id },
      {
        nomeDoFluxo: row.nome,
        campos,
        eventos: eventos.rows.map((e) => ({ kind: e.kind, field_key: e.field_key })),
      },
      { registry: deps.registry, log: deps.log },
    );

    await pool.query(
      `update followup_enrollments set completion_note = $3, updated_at = now()
        where organization_id = $1 and id = $2 and status = 'completed'`,
      [tenantId, enrollmentId, resumo],
    );
  };
}
