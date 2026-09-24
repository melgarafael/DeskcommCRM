/**
 * VALIDADOR DA RESPOSTA DO FLUXO — um agente dedicado, chamado SÓ quando o
 * fluxo de atendimento está esperando resposta ou o cliente pode estar
 * corrigindo um dado.
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 *
 * O modelo principal do turno é ótimo para conversar e ruim para uma tarefa
 * estreita: no teste ao vivo de 2026-09-18 ele gravou "ok" em `troca_estado`,
 * `2019` em `troca_documentacao` e a frase de abertura em `troca_ano`. Cada
 * gravação errada é dado errado no cadastro do cliente.
 *
 * A captura determinística (regex por tipo) resolve o caso inequívoco, mas não
 * texto livre nem correção. Aqui entra a peça que faltava: uma chamada de modelo
 * BARATA e com UMA tarefa — "o cliente respondeu a quais perguntas? e qual o dado
 * exato?" — decide o que vai para o banco. O modelo principal continua cuidando
 * da conversa; a ESCRITA do fluxo passa a ter um especialista.
 *
 * ─── MÚLTIPLOS CAMPOS e ORDEM LIVRE ─────────────────────────────────────────
 *
 * O cliente costuma responder a VÁRIAS perguntas de uma vez e fora de ordem
 * ("é uma CG 125 2015, 120 mil km, tá boa e a doc em dia"). O validador recebe
 * TODAS as pendentes e devolve TODAS as que a mensagem responde — assim nada é
 * reperguntado. Antes ele devolvia um campo só, e o resto era perdido.
 *
 * ─── Correção ───────────────────────────────────────────────────────────────
 *
 * O validador também recebe os campos JÁ PREENCHIDOS que permitem correção. Se
 * a mensagem corrige um deles ("na verdade o ano é 2020"), ele devolve esse campo
 * — e o motor sobrescreve.
 *
 * ─── Segurança ──────────────────────────────────────────────────────────────
 *
 * Saída é JSON com `respostas: [{ campo, valor }]`. Cada `valor` só é aceito
 * quando passa na validação de tipo (`valorBateComTipo`); cada `campo` só é
 * aceito se for uma pendente ou um corrigível. Falha de modelo NÃO derruba o
 * turno: devolve `indefinido`.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import type { ProviderRegistry } from '../edge/llm/providers';
import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import { valorBateComTipo } from '@/lib/followup/captura-do-fluxo';
import type { AuxModelArgs } from './aux-model-args';

/** O que o validador enxerga de uma pergunta do fluxo. */
export interface PerguntaDoFluxo {
  key: string;
  label: string;
  question?: string | undefined;
  type: 'text' | 'number' | 'date' | 'boolean' | 'select';
  options?: string[] | undefined;
}

/** Uma linha da conversa que vai no prompt (poucas, recentes). */
export interface MensagemDoContexto {
  de: 'cliente' | 'loja';
  texto: string;
}

/** Uma resposta do cliente a um campo (pendente ou corrigido). */
export interface RespostaDoFluxo {
  campo: string;
  valor: string;
}

export type LeituraDaResposta =
  | { resultado: 'respondeu'; respostas: RespostaDoFluxo[] }
  | { resultado: 'nao_respondeu' }
  /** O validador não pôde ser usado (modelo/chave ausente, saída ilegível). */
  | { resultado: 'indefinido' };

const INSTRUCAO =
  'Você é um validador auxiliar de um sistema de vendas (NÃO fala com o cliente). ' +
  'Recebe as PERGUNTAS pendentes (pode haver várias), os DADOS já preenchidos (que podem ser ' +
  'corrigidos) e as ÚLTIMAS mensagens da conversa. Sua tarefa: decidir QUAIS perguntas pendentes a ' +
  'mensagem mais recente do CLIENTE responde E/OU quais dados já preenchidos ela corrige. ' +
  'IMPORTANTE: o cliente pode responder a MAIS DE UMA pergunta na MESMA mensagem, e em QUALQUER ' +
  'ordem — devolva TODAS as que ele respondeu, cada uma com sua chave. ' +
  'Responda SOMENTE com JSON: {"respostas":[{"campo":"<chave>","valor":"<dado>"}]}. ' +
  'Se não respondeu a nenhuma e não corrigiu nenhuma, devolva {"respostas":[]}. ' +
  'Use a CHAVE do campo em `campo`. ' +
  'Regras do `valor`: sim/não → "true"/"false"; número → só os dígitos (sem "km", "ano", "R$"); ' +
  'data → "AAAA-MM-DD"; escolha → exatamente uma das opções; texto livre → o trecho sucinto. ' +
  'NÃO trate INTENÇÃO genérica como resposta: se a mensagem só diz que quer dar/ver/trocar algo ' +
  '("quero dar uma moto na troca", "quero trocar de moto", "tenho interesse") SEM dizer QUAL, o ' +
  'campo que espera um dado específico (um modelo, um ano, um valor) NÃO foi respondido — ' +
  'devolva {"respostas":[]}. Só responda se a mensagem trouxer o DADO específico. ' +
  'NÃO invente, NÃO complete e NÃO responda por conta própria.';

/** Monta a mensagem do modelo. Puro — coberto por teste. */
export function montarMensagemDoValidador(
  perguntas: readonly PerguntaDoFluxo[],
  preenchidos: readonly { key: string; label: string; valor: string }[],
  mensagens: readonly MensagemDoContexto[],
): string {
  const campos = (p: PerguntaDoFluxo): string => {
    const opcoes =
      p.type === 'select' && (p.options?.length ?? 0) > 0 ? ` (uma de: ${p.options!.join(', ')})` : '';
    return `${p.question?.trim() || p.label} (chave: ${p.key}, tipo: ${p.type}${opcoes})`;
  };
  const conversa = mensagens
    .slice(-6)
    .map((m) => `- ${m.de === 'cliente' ? 'CLIENTE' : 'LOJA'}: ${m.texto}`)
    .join('\n');
  return [
    INSTRUCAO,
    '',
    '## Perguntas pendentes (as que ainda não foram respondidas)',
    perguntas.length === 0 ? '(nenhuma)' : perguntas.map((p) => `- ${campos(p)}`).join('\n'),
    '',
    '## Dados já preenchidos (corrigíveis)',
    preenchidos.length === 0
      ? '(nenhum)'
      : preenchidos.map((p) => `- ${p.label} (chave: ${p.key}): ${p.valor}`).join('\n'),
    '',
    '## Últimas mensagens (a mais recente é a que importa)',
    conversa,
  ].join('\n');
}

/** Extrai o JSON do modelo (tolerante a prosa/cerca em volta). */
export function parseLeituraDoValidador(texto: string): { respostas: RespostaDoFluxo[] } | null {
  const m = /\{[\s\S]*\}/.exec(texto);
  if (m === null) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Formato novo: { respostas: [{campo, valor}] }.
  if (Array.isArray(obj.respostas)) {
    const respostas = obj.respostas
      .map((r) => {
        const item = (r ?? {}) as Record<string, unknown>;
        const campo = typeof item.campo === 'string' ? item.campo.trim() : '';
        const valor = typeof item.valor === 'string' ? item.valor.trim() : '';
        return { campo, valor };
      })
      .filter((r) => r.campo !== '');
    return { respostas };
  }
  // Compatibilidade: formato antigo { campo, respondeu, valor }.
  if (typeof obj.respondeu === 'boolean') {
    const campo = typeof obj.campo === 'string' ? obj.campo.trim() : '';
    const valor = typeof obj.valor === 'string' ? obj.valor.trim() : '';
    return { respostas: obj.respondeu && campo !== '' ? [{ campo, valor }] : [] };
  }
  return null;
}

/**
 * Valida as respostas contra as perguntas pendentes e os campos corrigíveis.
 * Chama o modelo (ponto `flow_validate`); falha de qualquer natureza devolve
 * `indefinido` — quem chama decide o fallback.
 */
export async function validarRespostaDoFluxo(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId: string; jobId: string },
  args: {
    perguntas: readonly PerguntaDoFluxo[];
    /** Campos já preenchidos que ACEITAM correção (o cliente pode mudar). */
    preenchidos: readonly { key: string; label: string; valor: string }[];
    mensagens: readonly MensagemDoContexto[];
  },
  deps: {
    registry?: ProviderRegistry;
    log: Logger;
    /**
     * Modelo e credencial das chamadas auxiliares do turno (`auxModelArgs`).
     * Sem isto, a instalação configurada só pela tela (sem `default_model` na
     * organização) nunca teria validador: a chamada falharia por "modelo não
     * definido" e todo turno cairia em `indefinido` — calado.
     */
    aux?: AuxModelArgs;
  },
): Promise<LeituraDaResposta> {
  // Sem pergunta pendente e sem corrigível, não há o que validar.
  if (args.perguntas.length === 0 && args.preenchidos.length === 0) {
    return { resultado: 'nao_respondeu' };
  }
  let texto: string;
  try {
    const call = await runModelCall(
      db,
      cfg,
      {
        tenantId: ids.tenantId,
        leadId: ids.leadId,
        jobId: ids.jobId,
        purpose: 'flow_validate',
        ...(deps.aux ?? {}),
        messages: [
          {
            role: 'user',
            content: montarMensagemDoValidador(args.perguntas, args.preenchidos, args.mensagens),
          },
        ],
      },
      { registry: deps.registry, log: deps.log },
    );
    texto = call.result.text;
  } catch {
    return { resultado: 'indefinido' };
  }

  const leitura = parseLeituraDoValidador(texto);
  if (leitura === null) return { resultado: 'indefinido' };

  const validas: RespostaDoFluxo[] = [];
  const vistas = new Set<string>();
  for (const r of leitura.respostas) {
    // O `campo` só é aceito se for uma pendente OU um corrigível declarado.
    const pendente = args.perguntas.find((p) => p.key === r.campo);
    const preenchido = args.preenchidos.find((p) => p.key === r.campo);
    const alvo = pendente ?? preenchido;
    if (alvo === undefined) continue;
    if (vistas.has(r.campo)) continue; // um campo, uma resposta
    // O valor passa pela MESMA régua de tipo da captura determinística. Um campo
    // já preenchido (correção) não carrega o tipo aqui — vale como texto livre.
    const campoParaValidar = {
      key: alvo.key,
      label: alvo.label,
      type: 'type' in alvo ? alvo.type : ('text' as const),
      ...('options' in alvo && alvo.options !== undefined ? { options: alvo.options } : {}),
    };
    if (!valorBateComTipo(campoParaValidar, r.valor)) continue;
    vistas.add(r.campo);
    validas.push({ campo: r.campo, valor: r.valor });
  }

  if (validas.length === 0) return { resultado: 'nao_respondeu' };
  return { resultado: 'respondeu', respostas: validas };
}
