/**
 * Camada SEMÂNTICA de promessa em texto livre (F4-02; blueprint 6.5) — classificador
 * binário BARATO que roda DEPOIS da camada determinística (F4-01) no gate before_send.
 * A regex+schema da F4-01 só pega valor ESTRUTURADO (R$/%/parcelas); promessa em texto
 * livre ("faço de graça", "te dou uma cortesia", "garanto entrega amanhã") escapa dela —
 * esta camada fecha o buraco.
 *
 * O classificador passa pela camada de modelo agnóstica (F2-23 — modelo auxiliar pequeno,
 * budget da org checado ANTES da chamada dentro de runModelCall; NÃO é roteamento do modelo
 * do agente). Binário: a mensagem candidata contém uma promessa/compromisso livre? Devolve
 * {isPromise, suspectPhrase}. suspectPhrase é o trecho da PRÓPRIA candidata (mensagem que o
 * agente quer enviar) — volta ao modelo no veto (erro de ensino), mas NUNCA vai a log.
 *
 * Como Gate.evaluate é SÍNCRONO (before-send.ts), a chamada async roda na FASE DE CARGA do
 * GateContext (sob o advisory lock, junto de loadPromiseTable); o resultado entra no ctx e o
 * `semanticPromiseGate` (sync) lê e veta. Este módulo não persiste nada.
 *
 * organization_id/contact_id vêm da ROW do job (closure do run), nunca do payload (regra dura 1).
 */
import type pg from 'pg';

import type { Logger } from '../../obs/logger';
import type { ProviderRegistry } from '../../edge/llm/providers';
import { runModelCall, type LlmEdgeConfig } from '../../edge/llm/run-model-call';
import type { LlmResolveOverride } from '../../edge/llm/credentials';
import { detectHumanPromise } from '../human-promise';

/** Veredito binário do classificador. suspectPhrase = null quando isPromise = false. */
export interface PromiseClassification {
  isPromise: boolean;
  /** trecho literal da candidata que caracteriza a promessa (só quando isPromise=true). */
  suspectPhrase: string | null;
  /**
   * A mensagem promete que ALGUÉM DA EMPRESA volta a falar com o cliente?
   *
   * PERGUNTA DIFERENTE de `isPromise`. `isPromise` é sobre promessa COMERCIAL —
   * preço, desconto, prazo de entrega, cortesia. Este campo é sobre o COMPROMISSO
   * DE RETORNAR: "te retorno", "te dou um retorno", "vou encaminhar para análise",
   * "vou levar para avaliação interna", "vou passar para o setor X" — COM OU SEM
   * nomear a pessoa ou o setor. O que importa é o COMPROMISSO DE VOLTAR, não a
   * palavra usada.
   *
   * Existe porque o detector léxico (`detectHumanPromise`) exige palavra de alvo
   * humano colada ao verbo, e um objeto no meio ("as informações") quebra o padrão:
   * 5 das 7 frases medidas em 2026-09-16 vazaram por ali, inclusive uma que escreve
   * literalmente "equipe". O `casePromiseGate` lê os dois sinais em OU — o léxico é
   * o filtro barato que roda sem chamada de modelo; este campo é o que pega o resto.
   */
  prometeuRetornoHumano: boolean;
}

/**
 * Instrução FIXA do classificador — marcador estável (como STAGE_CLASSIFIER_INSTRUCTION)
 * para os testes reconhecerem a chamada do auxiliar. Descreve a tarefa binária, dá exemplos
 * de promessa vs. inocente (incl. as armadilhas de slogan) e força saída JSON.
 */
export const PROMISE_SEMANTIC_INSTRUCTION =
  'Você é um classificador auxiliar de compliance de vendas (NÃO responde ao lead). ' +
  'Analise a MENSAGEM que o vendedor quer enviar e responda a DUAS perguntas INDEPENDENTES.\n' +
  '\n' +
  '## Pergunta 1 — isPromise (promessa COMERCIAL concreta)\n' +
  'Decida se a mensagem contém uma PROMESSA ou ' +
  'COMPROMISSO concreto em texto livre — algo que obriga a empresa a algo específico e que ' +
  'um validador de valores estruturados (preço/desconto/parcelas em número) NÃO pegaria.\n' +
  'É PROMESSA (isPromise=true): oferecer algo de graça/cortesia/por conta da casa, isentar ' +
  'taxa, dar brinde, garantir devolução de dinheiro, garantir um prazo de entrega concreto ' +
  '("entrego amanhã", "fica pronto até sexta") ou assumir que resolve pessoalmente até um prazo.\n' +
  'NÃO é promessa (isPromise=false): perguntas, saudações, agradecimentos, descrições de ' +
  'horário/empresa, próximos passos vagos SEM compromisso concreto e slogans genéricos de ' +
  'marketing ("garantimos qualidade", "nossa entrega é rápida", "10x mais rápido que a concorrência").\n' +
  '\n' +
  '## Pergunta 2 — prometeuRetornoHumano (promessa de retorno humano)\n' +
  'Decida se a mensagem promete que ALGUÉM DA EMPRESA volta a falar com o cliente, ou que ' +
  'algo será feito internamente e devolvido a ele.\n' +
  'É promessa de retorno (prometeuRetornoHumano=true): "te retorno", "te dou um retorno", ' +
  '"vou encaminhar para análise", "vou levar para avaliação interna", "vou passar para o ' +
  'setor X", "te mando a proposta" — COM OU SEM nomear a pessoa ou o setor. O que importa ' +
  'é o COMPROMISSO DE VOLTAR, não a palavra usada.\n' +
  'NÃO é promessa de retorno (prometeuRetornoHumano=false): perguntas, saudações, horário ' +
  'de funcionamento, oferta de horários já disponíveis, e qualquer coisa que o próprio ' +
  'assistente resolve AGORA na própria conversa.\n' +
  '⚠️ A ressalva da pergunta 1 — "próximos passos vagos SEM compromisso concreto NÃO é ' +
  'promessa" — NÃO vale para esta pergunta. É exatamente por essa ressalva que a frase ' +
  '"vou encaminhar para análise e te retorno com a proposta" escapou da trava: ela É um ' +
  'compromisso de retorno, ainda que vaga sobre o CONTEÚDO do que volta.\n' +
  '\n' +
  'Responda SOMENTE com JSON, sem explicação: ' +
  '{"isPromise": true|false, "suspectPhrase": "<trecho literal da promessa na mensagem>"|null, ' +
  '"prometeuRetornoHumano": true|false}. ' +
  'suspectPhrase é null quando isPromise=false.';

function buildPromiseMessage(candidate: string): string {
  return ['## Mensagem candidata (que o vendedor quer enviar ao lead)', candidate, '', PROMISE_SEMANTIC_INSTRUCTION].join(
    '\n',
  );
}

/**
 * Extrai {isPromise, suspectPhrase} do texto do modelo (tolerante a code-fence/prosa em
 * volta do JSON). Saída não-parseável → degrada para "sem promessa" (a camada determinística
 * F4-01 já rodou); a camada semântica NUNCA bloqueia envio por falha de parse do auxiliar.
 */
export function parsePromiseClassification(
  text: string,
  candidata: string,
  log?: Logger,
): PromiseClassification {
  // ⛔ DEGRADE ASSIMÉTRICO DE PROPÓSITO — e a assimetria é o ponto deste bloco.
  //
  // `isPromise` degrada para `false`: a camada determinística (F4-01) já rodou e
  // pegou o valor estruturado; fail-open ali é uma rede a menos, não uma
  // invariante ferida.
  //
  // `prometeuRetornoHumano` NÃO pode degradar para `false`. Não há camada anterior
  // equivalente para ELE: o detector léxico (`detectHumanPromise`) deixa passar 5
  // das 7 frases medidas em 2026-09-16. Degradar para `false` desarmaria a
  // invariante sagrada exatamente quando o sistema está com defeito — o pior
  // momento possível. Degrada para o veredito do LÉXICO: pior que o semântico,
  // melhor que nada.
  //
  // Por isto o parser precisa da CANDIDATA (assinatura mudou): o veredito de
  // degrade não sai do vazio, sai do detector barato que já existe.
  const fallbackLexico = detectHumanPromise(candidata);

  const match = /\{[\s\S]*\}/.exec(text);
  if (match === null) {
    // degrade OBSERVÁVEL (F4-08 ressalva 2): sem o warn, um classificador sistematicamente
    // quebrado ficaria invisível (todo envio "sem promessa"). Loga só o FATO do parse-fail —
    // nunca o texto do modelo (poderia carregar trecho da candidata, PII fora de log).
    log?.warn('classificador semântico de promessa: saída sem JSON — degrade assimétrico (isPromise=false, prometeuRetornoHumano=léxico)', {
      event: 'promise_semantic_parse_fail',
      reason: 'no_json',
    });
    return { isPromise: false, suspectPhrase: null, prometeuRetornoHumano: fallbackLexico };
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    // saída do auxiliar não é JSON válido → MESMA assimetria do ramo acima:
    // `isPromise` fail-open (a camada determinística cobriu o valor estruturado),
    // `prometeuRetornoHumano` fail-CLOSED ao léxico.
    log?.warn('classificador semântico de promessa: JSON inválido — degrade assimétrico (isPromise=false, prometeuRetornoHumano=léxico)', {
      event: 'promise_semantic_parse_fail',
      reason: 'invalid_json',
    });
    return { isPromise: false, suspectPhrase: null, prometeuRetornoHumano: fallbackLexico };
  }
  const isPromise = obj.isPromise === true || obj.isPromise === 'true';
  const rawPhrase = typeof obj.suspectPhrase === 'string' ? obj.suspectPhrase.trim() : '';
  // Campo novo ausente ou com tipo trocado cai no MESMO degrade do léxico. Um sinal
  // de segurança que sai `undefined` é pior que um que sai errado: o gate o leria
  // como ausência (compara `=== true`) e a invariante sagrada ficaria desarmada sem
  // ninguém perceber. Por isso o tipo é `boolean` obrigatório e o parser garante o valor.
  const prometeuRetornoHumano =
    typeof obj.prometeuRetornoHumano === 'boolean' ? obj.prometeuRetornoHumano : fallbackLexico;
  return {
    isPromise,
    suspectPhrase: isPromise && rawPhrase !== '' ? rawPhrase : null,
    prometeuRetornoHumano,
  };
}

/**
 * Roda o classificador semântico pelo seam agnóstico (purpose 'promise_semantic'; budget da
 * org checado ANTES da chamada dentro de runModelCall). Injetável (registry) para testes
 * determinísticos com MockLanguageModelV4. Devolve o veredito binário + a frase suspeita.
 */
export async function classifyPromise(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId?: string | null; jobId?: string },
  args: { candidate: string; model?: string; llmOverride?: LlmResolveOverride },
  deps: { registry?: ProviderRegistry; log: Logger },
): Promise<PromiseClassification> {
  const call = await runModelCall(
    db,
    cfg,
    {
      tenantId: ids.tenantId,
      ...(ids.leadId != null ? { leadId: ids.leadId } : {}),
      ...(ids.jobId !== undefined ? { jobId: ids.jobId } : {}),
      purpose: 'promise_semantic',
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.llmOverride !== undefined ? { llmOverride: args.llmOverride } : {}),
      messages: [{ role: 'user', content: buildPromiseMessage(args.candidate) }],
    },
    { registry: deps.registry, log: deps.log },
  );
  // Assinatura nova: o parser recebe a CANDIDATA para poder degradar
  // `prometeuRetornoHumano` pelo veredito do léxico. A assimetria do degrade
  // (`isPromise` → false; `prometeuRetornoHumano` → léxico) está documentada no
  // corpo do parser. Este é o único chamador no repositório (medido).
  return parsePromiseClassification(call.result.text, args.candidate, deps.log);
}

/**
 * Erro de ENSINO que volta AO MODELO no veto semântico (acceptance 3): destaca a frase
 * suspeita e orienta a reformular. É o único lugar onde a frase (trecho da própria candidata)
 * aparece — vai ao modelo, jamais a log.
 */
export function renderSemanticPromiseVeto(suspectPhrase: string | null): string {
  const highlight = suspectPhrase !== null ? `frase suspeita: "${suspectPhrase}" — ` : '';
  return (
    `${highlight}isso é uma promessa/compromisso fora do playbook que a validação de valores ` +
    'estruturados não pega; reformule sem prometer prazo, cortesia, gratuidade, brinde ou garantia ' +
    'não autorizada antes de reenviar.'
  );
}
