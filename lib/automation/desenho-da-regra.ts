/**
 * O DESENHO de uma automação: a mesma regra de sempre, vista como caixas ligadas.
 *
 * É a peça pura do designer de automações (`app/app/webhooks/automacoes/[id]`).
 * O canvas é só OUTRA FORMA de montar o corpo que o editor em gaveta
 * (`app/app/webhooks/_components/RuleEditor.tsx`) já manda para
 * `/api/v1/automation-rules` — gatilho, condições e a lista de ações em ordem.
 * Nada do desenho vai para o banco: a posição das caixas não é gravada, e as
 * ligações viram a ORDEM da lista `actions`. Ao abrir, o designer reorganiza.
 *
 * Por isso há duas direções que precisam fechar, e o teste ao lado prova a
 * volta completa: `desenhoDaRegra` (regra gravada → caixas) e
 * `corpoDoDesenho` (caixas → corpo da API). A validação não tem régua própria:
 * `validarDesenho` passa o corpo pelo MESMO `createAutomationRuleSchema` que a
 * rota usa e só traduz o caminho de cada recusa para a caixa que o causou.
 *
 * O formato tem uma forma só — uma fila: gatilho → (condições) → ações. Cada
 * caixa tem uma entrada e uma saída. O passo `ai_decide` (que hoje só nasce
 * pela API) entra aqui como uma ação opaca: o desenho o mostra, mantém a
 * posição dele na fila e o devolve byte a byte, sem editar.
 */
import { configAoSalvarDaTela } from "@/lib/automation/config-ao-salvar";
import {
  GATILHO_DE_DATA_DO_FUNIL,
  configDoGatilhoDeData,
} from "@/lib/automation/gatilho-de-data-do-funil";
import {
  GATILHO_ETAPA_PARADA,
  GATILHO_SILENCIO,
  configDaEtapaParada,
  configDoSilencio,
  type DirecaoDoSilencio,
} from "@/lib/automation/gatilhos-de-tempo";
import {
  MENSAGEM_DO_LACO_DE_LEAD,
  MENSAGEM_DO_RODIZIO_FORA_DO_LUGAR,
  acoesQueFechamLaco,
  createAutomationRuleSchema,
  type CreateAutomationRuleInput,
} from "@/lib/schemas/webhooks";
import {
  contarCondicoes,
  ehCondicaoDeCampo,
  MAXIMO_DE_CONDICOES,
  OPERADORES_SEM_VALOR,
  type Conditions,
  type ConditionNode,
  type ConditionOp,
} from "@/lib/automation/conditions";

/**
 * O vocabulário de operadores é o MESMO do avaliador e da porta da API
 * (`ConditionOp`, #2727). Antes do arremate o desenho mantinha uma cópia
 * paralela (`"eq" | "neq" | "contains"`) que, com os operadores novos do #2727,
 * divergiria em silêncio do que o schema aceita — e é o schema que valida o
 * corpo salvo (`validarDesenho`).
 */
export type OperadorDaCondicao = ConditionOp;

/**
 * Uma linha do SE. `avancado` é só da tela (mostrar o caminho digitado em vez
 * da lista): ausente, a tela decide como o editor de hoje decide.
 */
export type LinhaDeCondicao = {
  field: string;
  op: OperadorDaCondicao;
  value: string;
  avancado?: boolean;
};

/**
 * As condições no formato que o DESENHO entende: uma fila de linhas. O motor
 * guarda `Conditions` (#2727) — a lista antiga (≡ `all`) ou um grupo `{all|any}`
 * do topo —, mas o designer desenha UMA caixa de condições, e ela só sabe editar
 * a LISTA (que combina por E). Para a lista é a identidade; para um GRUPO, estas
 * linhas são só o que a caixa MOSTRA — o grupo viaja preservado em
 * `grupoPreservado` e é ele que volta ao salvar (ver `corpoDoDesenho`).
 */
export function linhasDeCondicoes(conditions: Conditions): LinhaDeCondicao[] {
  const achata = (nos: readonly ConditionNode[]): LinhaDeCondicao[] =>
    nos.flatMap((no) =>
      ehCondicaoDeCampo(no)
        ? [{ field: no.field, op: no.op, value: no.value }]
        : achata(no.all ?? no.any ?? []),
    );
  return achata(Array.isArray(conditions) ? conditions : (conditions.all ?? conditions.any ?? []));
}

/**
 * O desenho sabe editar as condições desta regra?
 *
 * A caixa de condições é uma fila combinada por E — a lista antiga. Um GRUPO do
 * topo (`{all}` ou `{any}`) muda o combinador, e a caixa não o representa:
 * achatá-lo perderia o "qualquer uma" e uma regra que dispara para alguns
 * passaria a disparar para todos. Quando isto é `false`, o desenho NÃO edita as
 * condições: mostra o grupo, manda para o formulário e grava o grupo como está.
 */
export function oDesenhoEditaAsCondicoes(conditions: Conditions): boolean {
  return Array.isArray(conditions) && conditions.every(ehCondicaoDeCampo);
}

/**
 * O que a tela do gatilho edita além do evento. São três grupos porque o editor
 * de hoje guarda três estados separados (fonte, data do funil, tempo), e só o do
 * evento escolhido vai para o `trigger_config` ao salvar.
 */
export type TelaDoGatilho = {
  /** `null` = qualquer fonte de formulário. */
  fonte: string | null;
  /**
   * "No máximo uma vez por contato" (#2974), do gatilho de contato novo.
   *
   * Booleano — e a tela GRAVA os dois valores, não só o ligado: se ela omitisse
   * o `false`, um `true` gravado antes sobreviveria ao `configAoSalvarDaTela`
   * (que faz merge com a configuração guardada) e o operador não conseguiria
   * DESLIGAR a opção.
   */
  umaVezPorContato: boolean;
  data: { pipeline_id: string; campo: string; dias: string };
  tempo: { dias: string; direcao: DirecaoDoSilencio; proteger_pela_agenda: boolean };
};

export type AcaoDaRegra = { type: string; config: Record<string, unknown> };

/** Os problemas que o último "salvar" achou nesta caixa — a tela os mostra nela. */
type ComProblemas = { problemas?: ProblemaDoDesenho[] };
export type DadosDoGatilho = { kind: "gatilho"; evento: string; tela: TelaDoGatilho } & ComProblemas;
export type DadosDasCondicoes = {
  kind: "condicoes";
  linhas: LinhaDeCondicao[];
  /**
   * O grupo do topo que o desenho NÃO sabe editar, guardado verbatim (#2727).
   * Presente quando a regra gravada traz `{all}`/`{any}`: as `linhas` são só o
   * que a caixa mostra, e é ISTO que o `corpoDoDesenho` devolve. Sem este campo,
   * o salvar do desenho achataria o grupo — `{any:[…]}` virava "todas" e a regra
   * passava a disparar para todo mundo (defeito medido no CR do #2727).
   */
  grupoPreservado?: Conditions;
} & ComProblemas;
export type DadosDaAcao = { kind: "acao"; acao: AcaoDaRegra } & ComProblemas;
export type DadosDaCaixa = DadosDoGatilho | DadosDasCondicoes | DadosDaAcao;
export type TipoDeCaixa = DadosDaCaixa["kind"];

/** Mesma forma de um nó do React Flow, para o canvas não precisar de tradutor. */
export type CaixaDoDesenho = {
  id: string;
  type: TipoDeCaixa;
  position: { x: number; y: number };
  data: DadosDaCaixa;
};
export type LigacaoDoDesenho = { id: string; source: string; target: string };
export type Desenho = { caixas: CaixaDoDesenho[]; ligacoes: LigacaoDoDesenho[] };

/** O que a API devolve de uma regra gravada — só os campos que o desenho lê. */
export type RegraGravada = {
  trigger_event: string;
  trigger_config: Record<string, unknown> | null;
  conditions: Conditions;
  actions: AcaoDaRegra[];
};

export type CorpoDaRegra = {
  name: string;
  trigger_event: string;
  /** A lista de linhas ou o grupo do topo preservado — o que a API recebe. */
  conditions: Conditions;
  actions: AcaoDaRegra[];
  trigger_config: Record<string, unknown>;
};

/** Um problema que impede salvar. `caixa: null` é da automação inteira (o nome). */
export type ProblemaDoDesenho = { caixa: string | null; mensagem: string };

export const ID_DO_GATILHO = "gatilho";
export const ID_DAS_CONDICOES = "condicoes";
export const MAXIMO_DE_ACOES = 10;
/** O teto mora em `conditions.ts`, ao lado do schema que o aplica. */
export { MAXIMO_DE_CONDICOES };
const DIAS_PADRAO = "7";

/**
 * As frases do desenho. Ficam numa tabela para a tela traduzi-las pela mesma
 * chave (`t(PROBLEMAS.x)`), e para o teste conferir a frase sem copiá-la.
 */
export const PROBLEMAS = {
  semNome: "Dê um nome à automação.",
  semGatilho: "A automação precisa de um gatilho.",
  semEvento: "Escolha o que dispara a automação.",
  duasEntradas:
    "Esta caixa recebe duas ligações. Numa automação cada caixa vem de um lugar só: as ações formam uma fila.",
  condicoesForaDoLugar:
    "As condições são conferidas antes de qualquer ação. Ligue esta caixa logo depois do gatilho.",
  circulo: "Esta ligação fecha um círculo: as ações rodam uma vez, em ordem.",
  foraDaAutomacao:
    "Esta caixa não está ligada à automação. Ligue-a ou exclua-a: do jeito que está, ela não seria gravada.",
  semAcao: "Ligue pelo menos uma ação depois do gatilho.",
  acoesDemais: "Uma automação tem no máximo 10 ações.",
  condicoesDemais: "No máximo 10 condições.",
  condicaoGrandeDemais: "Revise as condições: um campo ou um valor passou do tamanho permitido.",
  gatilhoInvalido: "Revise a configuração do gatilho.",
  acaoDesconhecida: "Esta ação não existe nesta instalação. Exclua a caixa ou escolha outra ação.",
  campoGrandeDemais: "Um campo desta ação passou do tamanho permitido.",
  acaoIncompleta: "Revise os campos desta ação.",
  passoDaIaInvalido: "Este passo “a IA decide” está incompleto. Hoje ele só se corrige pela API.",
} as const;

/** A frase por campo da ação recusado pelo schema — o que a pessoa precisa fazer. */
export const PROBLEMA_DO_CAMPO: Record<string, string> = {
  pipeline_id: "Escolha o funil.",
  stage_id: "Escolha a etapa.",
  channel_session_id: "Escolha o número de WhatsApp.",
  template: "Escreva a mensagem.",
  agent_id: "Escolha o agente que escreve.",
  instruction: "Diga o que a IA deve fazer com os dados.",
  tags: "Escreva de 1 a 10 tags, cada uma com até 60 caracteres.",
  user_id: "Escolha o atendente.",
  fila: "Monte a fila do rodízio com pelo menos uma pessoa, sem repetir ninguém.",
  modo: MENSAGEM_DO_RODIZIO_FORA_DO_LUGAR,
  url: "Informe um endereço válido, começando com https://.",
  flow_pointer_id: "Escolha o fluxo de follow-up.",
  titulo: "Dê um título à tarefa.",
  vence_em_dias: "O prazo vai de 0 a 365 dias.",
  atribuir_a: "Escolha quem recebe a tarefa.",
  prioridade: "Escolha a prioridade.",
  plano_id: "Escolha o plano de tarefas.",
};

/* ───────────────────────── gatilho ───────────────────────── */

/**
 * O estado da tela do gatilho a partir do que está gravado — pelos MESMOS
 * leitores que a varredura usa (como o editor de hoje faz ao abrir): se eles não
 * reconhecem o que está guardado, a tela não inventa nada e a pessoa reescolhe.
 */
export function telaDoGatilho(config: unknown): TelaDoGatilho {
  const data = configDoGatilhoDeData(config);
  const silencio = configDoSilencio(config);
  const tempo = silencio ?? configDaEtapaParada(config);
  const fonte =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>).webhook_source_id
      : undefined;
  const limite =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>).uma_vez_por_contato
      : undefined;
  return {
    fonte: typeof fonte === "string" ? fonte : null,
    umaVezPorContato: limite === true,
    data: data
      ? { pipeline_id: data.pipeline_id, campo: data.campo, dias: String(data.dias) }
      : { pipeline_id: "", campo: "", dias: DIAS_PADRAO },
    tempo: {
      dias: tempo ? String(tempo.dias) : DIAS_PADRAO,
      direcao: silencio ? silencio.direcao : "da_equipe",
      proteger_pela_agenda: tempo ? tempo.proteger_pela_agenda : false,
    },
  };
}

/**
 * O `trigger_config` que vai para a API — a mesma montagem do `onSubmit` do
 * editor de hoje, inclusive `configAoSalvarDaTela`: o que só a API grava (o
 * `pipeline_id`/`stage_id` de um gatilho de tempo, issue #2483) sobrevive ao
 * salvar. Campo de dias vazio vira `NaN`, que o schema recusa com a mensagem
 * certa em vez de gravar um zero silencioso.
 */
export function triggerConfigDaTela(
  evento: string,
  tela: TelaDoGatilho,
  regraGravada: Pick<RegraGravada, "trigger_event" | "trigger_config"> | null,
): Record<string, unknown> {
  const base = {
    gatilhoDaRegra: regraGravada?.trigger_event,
    configDaRegra: regraGravada?.trigger_config,
    gatilhoDaTela: evento,
  };
  const dias = (texto: string) => (texto.trim() === "" ? Number.NaN : Number(texto));
  if (evento === GATILHO_DE_DATA_DO_FUNIL) {
    return configAoSalvarDaTela({
      ...base,
      configDaTela: { pipeline_id: tela.data.pipeline_id, campo: tela.data.campo, dias: dias(tela.data.dias) },
    });
  }
  if (evento === GATILHO_SILENCIO || evento === GATILHO_ETAPA_PARADA) {
    return configAoSalvarDaTela({
      ...base,
      configDaTela: {
        dias: dias(tela.tempo.dias),
        ...(evento === GATILHO_SILENCIO ? { direcao: tela.tempo.direcao } : {}),
        proteger_pela_agenda: tela.tempo.proteger_pela_agenda,
      },
    });
  }
  if (evento === "lead.created") {
    return configAoSalvarDaTela({
      ...base,
      configDaTela: {
        webhook_source_id: tela.fonte,
        // Sempre gravado, ligado OU desligado (#2974): ver o comentário de
        // `TelaDoGatilho.umaVezPorContato` — omitir o `false` impediria
        // desligar a opção, porque `configAoSalvarDaTela` faz merge com o que
        // está guardado.
        uma_vez_por_contato: tela.umaVezPorContato,
      },
    });
  }
  // Gatilho sem configuração própria: nada é inventado aqui, mas o que a tela
  // NÃO desenha não pode sumir no salvar — `configAoSalvarDaTela` com
  // `configDaTela` vazio devolve a configuração guardada quando o gatilho é o
  // mesmo (é assim que um "uma vez por contato" ligado pela API sobrevive) e
  // `{}` quando o gatilho mudou, que é o comportamento de sempre.
  return configAoSalvarDaTela({ ...base, configDaTela: {} });
}

/* ───────────────────────── regra → desenho ───────────────────────── */

/** As caixas de uma regra gravada, ligadas em fila. `null` = automação nova. */
export function desenhoDaRegra(regra: RegraGravada | null): Desenho {
  const caixas: CaixaDoDesenho[] = [
    {
      id: ID_DO_GATILHO,
      type: "gatilho",
      position: { x: 0, y: 0 },
      data: { kind: "gatilho", evento: regra?.trigger_event ?? "", tela: telaDoGatilho(regra?.trigger_config ?? null) },
    },
  ];
  const ligacoes: LigacaoDoDesenho[] = [];
  let anterior = ID_DO_GATILHO;
  const ligar = (destino: string) => {
    ligacoes.push({ id: `ligacao-${ligacoes.length + 1}`, source: anterior, target: destino });
    anterior = destino;
  };
  if (regra) {
    const editavel = oDesenhoEditaAsCondicoes(regra.conditions);
    // A caixa existe se há condição para mostrar. Um grupo que o desenho não
    // edita entra MESMO vazio (`{any:[]}` é sempre falso): sem a caixa, o salvar
    // mandaria `[]`, que vale "todas" — o oposto do que a regra faz.
    if (!editavel || contarCondicoes(regra.conditions) > 0) {
      caixas.push({
        id: ID_DAS_CONDICOES,
        type: "condicoes",
        position: { x: 0, y: 0 },
        data: {
          kind: "condicoes",
          linhas: linhasDeCondicoes(regra.conditions),
          ...(editavel ? {} : { grupoPreservado: regra.conditions }),
        },
      });
      ligar(ID_DAS_CONDICOES);
    }
  }
  (regra?.actions ?? []).forEach((acao, i) => {
    const id = `acao-${i + 1}`;
    caixas.push({ id, type: "acao", position: { x: 0, y: 0 }, data: { kind: "acao", acao } });
    ligar(id);
  });
  return { caixas, ligacoes };
}

/* ───────────────────────── a volta da tela ───────────────────────── */

/**
 * O que a tela pendura nos dados de cada caixa só para desenhá-la. Não é regra:
 * `desenhoDaTela` tira antes de percorrer, validar ou comparar.
 *
 * `eventoDaRegra` NÃO pode se chamar `evento`: a caixa de gatilho já tem um
 * `evento`, e ele É a regra. Com o mesmo nome, tirar o campo de exibição
 * apagava o gatilho — a caixa dizia "escolha o que dispara", a paleta não
 * travava as ações que fecham laço e a gravação saía sem `trigger_event`.
 */
export type ExtrasDaTela = { etapa?: string; eventoDaRegra?: string };
export type CaixaNaTela = {
  id: string;
  type?: TipoDeCaixa;
  position: { x: number; y: number };
  data: DadosDaCaixa & ExtrasDaTela;
};

/** Os nós do canvas de volta ao desenho: só a regra — sem o que é de tela nem os problemas da última gravação. */
export function desenhoDaTela(
  nos: readonly CaixaNaTela[],
  ligacoes: readonly LigacaoDoDesenho[],
): Desenho {
  return {
    caixas: nos.map((n) => {
      const { etapa: _etapa, eventoDaRegra: _eventoDaRegra, problemas: _problemas, ...data } = n.data;
      return { id: n.id, type: n.type ?? n.data.kind, position: n.position, data: data as DadosDaCaixa };
    }),
    ligacoes: ligacoes.map((l) => ({ id: l.id, source: l.source, target: l.target })),
  };
}

/* ───────────────────────── o percurso da fila ───────────────────────── */

export type Percurso = {
  gatilho: CaixaDoDesenho | null;
  condicoes: CaixaDoDesenho | null;
  /** As ações na ordem em que rodam. */
  acoes: CaixaDoDesenho[];
  /** Tudo que está na fila, na ordem (inclui condições fora do lugar). */
  fila: CaixaDoDesenho[];
  /** Problemas de FORMA — os de conteúdo vêm do schema, em `validarDesenho`. */
  problemas: ProblemaDoDesenho[];
};

const saidaDe = (d: Desenho, id: string) => d.ligacoes.find((l) => l.source === id);
const caixaDe = (d: Desenho, id: string) => d.caixas.find((c) => c.id === id);

/** Anda pela fila a partir do gatilho e diz o que está fora do formato. */
export function percorrer(desenho: Desenho): Percurso {
  const problemas: ProblemaDoDesenho[] = [];
  const gatilho = desenho.caixas.find((c) => c.data.kind === "gatilho") ?? null;
  if (!gatilho) {
    return { gatilho: null, condicoes: null, acoes: [], fila: [], problemas: [{ caixa: null, mensagem: PROBLEMAS.semGatilho }] };
  }
  for (const c of desenho.caixas) {
    if (desenho.ligacoes.filter((l) => l.target === c.id).length > 1) {
      problemas.push({ caixa: c.id, mensagem: PROBLEMAS.duasEntradas });
    }
  }
  const vistas = new Set([gatilho.id]);
  const fila: CaixaDoDesenho[] = [gatilho];
  const acoes: CaixaDoDesenho[] = [];
  let condicoes: CaixaDoDesenho | null = null;
  let ligacao = saidaDe(desenho, gatilho.id);
  let proxima = ligacao ? caixaDe(desenho, ligacao.target) : undefined;
  if (proxima?.data.kind === "condicoes") {
    condicoes = proxima;
    vistas.add(proxima.id);
    fila.push(proxima);
    ligacao = saidaDe(desenho, proxima.id);
    proxima = ligacao ? caixaDe(desenho, ligacao.target) : undefined;
  }
  while (proxima) {
    if (vistas.has(proxima.id)) {
      problemas.push({ caixa: proxima.id, mensagem: PROBLEMAS.circulo });
      break;
    }
    vistas.add(proxima.id);
    fila.push(proxima);
    if (proxima.data.kind === "condicoes") problemas.push({ caixa: proxima.id, mensagem: PROBLEMAS.condicoesForaDoLugar });
    else if (proxima.data.kind === "acao") acoes.push(proxima);
    else break;
    ligacao = saidaDe(desenho, proxima.id);
    proxima = ligacao ? caixaDe(desenho, ligacao.target) : undefined;
  }
  for (const c of desenho.caixas) {
    if (!vistas.has(c.id)) problemas.push({ caixa: c.id, mensagem: PROBLEMAS.foraDaAutomacao });
  }
  if (acoes.length === 0) problemas.push({ caixa: (condicoes ?? gatilho).id, mensagem: PROBLEMAS.semAcao });
  if (acoes.length > MAXIMO_DE_ACOES) problemas.push({ caixa: acoes[MAXIMO_DE_ACOES]!.id, mensagem: PROBLEMAS.acoesDemais });
  return { gatilho, condicoes, acoes, fila, problemas };
}

/* ───────────────────────── desenho → corpo da API ───────────────────────── */

/**
 * O corpo que o designer manda — o MESMO do editor de hoje: condições
 * incompletas (sem campo, ou sem valor QUANDO o operador pede valor) são
 * descartadas, as ações vão como estão, na ordem da fila.
 *
 * ─── O que NÃO pode acontecer (#2727) ──────────────────────────────────────
 *
 *  1. `is_empty`/`is_not_empty` NÃO pedem valor: o filtro do `value.trim()`
 *     descartava a linha e a regra "está vazio" era salva sem condição nenhuma
 *     — passava a disparar para todo mundo. É `OPERADORES_SEM_VALOR`.
 *  2. Um grupo do TOPO (`{any:[…]}`) não é desenhável na caixa de linhas. Ele
 *     chega em `grupoPreservado` e é ELE que sai, verbatim: achatá-lo trocaria
 *     "qualquer uma" por "todas". Sem esta saída, abrir e salvar uma regra
 *     "qualquer uma" no desenho a destruía.
 */
export function corpoDoDesenho(
  entrada: { nome: string; desenho: Desenho; regraGravada: RegraGravada | null },
  percurso: Percurso = percorrer(entrada.desenho),
): CorpoDaRegra {
  const gatilho = percurso.gatilho?.data.kind === "gatilho" ? percurso.gatilho.data : null;
  const evento = gatilho?.evento ?? "";
  const dados = percurso.condicoes?.data.kind === "condicoes" ? percurso.condicoes.data : null;
  const conditions: Conditions =
    dados?.grupoPreservado ??
    (dados?.linhas ?? [])
      .filter((c) => c.field.trim() && (OPERADORES_SEM_VALOR.has(c.op) || c.value.trim()))
      .map((c) => ({
        field: c.field.trim(),
        op: c.op,
        value: OPERADORES_SEM_VALOR.has(c.op) ? "" : c.value.trim(),
      }));
  return {
    name: entrada.nome,
    trigger_event: evento,
    conditions,
    actions: percurso.acoes.map((c) => (c.data as DadosDaAcao).acao),
    trigger_config: gatilho ? triggerConfigDaTela(evento, gatilho.tela, entrada.regraGravada) : {},
  };
}

type Recusa = { path: ReadonlyArray<PropertyKey>; code: string; message: string };

function problemaDaRecusa(recusa: Recusa, percurso: Percurso): ProblemaDoDesenho | null {
  const [raiz, indice, ...resto] = recusa.path;
  const gatilho = percurso.gatilho?.id ?? null;
  if (raiz === "name") return { caixa: null, mensagem: PROBLEMAS.semNome };
  if (raiz === "trigger_event") return { caixa: gatilho, mensagem: PROBLEMAS.semEvento };
  if (raiz === "trigger_config") {
    // As recusas do gatilho são `custom`, escritas em português no schema.
    return { caixa: gatilho, mensagem: recusa.code === "custom" ? recusa.message : PROBLEMAS.gatilhoInvalido };
  }
  if (raiz === "conditions") {
    // A condição do contato (#3814) tem recusa `custom` escrita em português
    // pelo próprio schema ("Escolha “sim” ou “não” nesta condição.") — é a
    // frase que a pessoa precisa ler, e ela aponta o conserto. As demais são
    // as de tamanho, que já têm frase própria.
    if (recusa.code === "custom") {
      return { caixa: percurso.condicoes?.id ?? gatilho, mensagem: recusa.message };
    }
    return {
      caixa: percurso.condicoes?.id ?? gatilho,
      mensagem: indice === undefined ? PROBLEMAS.condicoesDemais : PROBLEMAS.condicaoGrandeDemais,
    };
  }
  if (raiz === "actions") {
    // Quantidade e laço já saíram do percurso, com a caixa certa marcada.
    if (typeof indice !== "number") return null;
    const caixa = percurso.acoes[indice];
    if (!caixa) return null;
    const acao = (caixa.data as DadosDaAcao).acao;
    if (acao.type === "ai_decide") {
      // O rodízio escondido numa opção da IA tem frase própria (#2041); o resto
      // do passo da IA só se corrige pela API.
      const doRodizio = recusa.message === MENSAGEM_DO_RODIZIO_FORA_DO_LUGAR;
      return { caixa: caixa.id, mensagem: doRodizio ? MENSAGEM_DO_RODIZIO_FORA_DO_LUGAR : PROBLEMAS.passoDaIaInvalido };
    }
    const campo = resto.find((p): p is string => typeof p === "string" && p !== "config");
    if (campo === undefined || campo === "type") return { caixa: caixa.id, mensagem: PROBLEMAS.acaoDesconhecida };
    if (recusa.code === "too_big" && campo !== "tags" && campo !== "vence_em_dias") {
      return { caixa: caixa.id, mensagem: PROBLEMAS.campoGrandeDemais };
    }
    return { caixa: caixa.id, mensagem: PROBLEMA_DO_CAMPO[campo] ?? PROBLEMAS.acaoIncompleta };
  }
  return null;
}

/**
 * Tudo que impede salvar, cada problema na caixa que o causou — e, quando não
 * há nenhum, o corpo já passado pelo schema (é ele que a rota recebe).
 */
export function validarDesenho(entrada: {
  nome: string;
  desenho: Desenho;
  regraGravada: RegraGravada | null;
}):
  | { ok: true; corpo: CreateAutomationRuleInput; problemas: [] }
  | { ok: false; corpo: CorpoDaRegra; problemas: ProblemaDoDesenho[] } {
  const percurso = percorrer(entrada.desenho);
  const corpo = corpoDoDesenho(entrada, percurso);
  const problemas = [...percurso.problemas];
  const evento = corpo.trigger_event;
  const laco = new Set(acoesQueFechamLaco(evento, corpo.actions));
  if (laco.size > 0) {
    for (const caixa of percurso.acoes) {
      if (acoesQueFechamLaco(evento, [(caixa.data as DadosDaAcao).acao]).length > 0) {
        problemas.push({ caixa: caixa.id, mensagem: MENSAGEM_DO_LACO_DE_LEAD });
      }
    }
  }
  const resultado = createAutomationRuleSchema.safeParse(corpo);
  if (!resultado.success) {
    for (const recusa of resultado.error.issues) {
      const problema = problemaDaRecusa(recusa, percurso);
      if (problema) problemas.push(problema);
    }
  }
  const unicos = problemas.filter(
    (p, i) => problemas.findIndex((q) => q.caixa === p.caixa && q.mensagem === p.mensagem) === i,
  );
  if (unicos.length === 0 && resultado.success) return { ok: true, corpo: resultado.data, problemas: [] };
  // O schema pode recusar algo que nenhuma regra acima traduziu: nunca dizer
  // "salvo" sem o schema ter dito sim.
  if (unicos.length === 0) unicos.push({ caixa: null, mensagem: PROBLEMAS.acaoIncompleta });
  return { ok: false, corpo, problemas: unicos };
}

/* ───────────────────────── edição da fila ───────────────────────── */

/** O próximo id livre com o prefixo (`acao-7`), mesma ideia do canvas de follow-up. */
export function proximoId(ids: string[], prefixo: string): string {
  const maior = ids.reduce((m, id) => {
    const n = new RegExp(`^${prefixo}-(\\d+)$`).exec(id)?.[1];
    return n ? Math.max(m, Number(n)) : m;
  }, 0);
  return `${prefixo}-${maior + 1}`;
}

/**
 * Põe a caixa nova na fila logo depois da âncora, já ligada — o gesto do
 * clique na paleta. Sem âncora válida, entra no fim da fila. Condições entram
 * sempre logo depois do gatilho, e uma ação nunca entra entre o gatilho e as
 * condições (elas deixariam de vir antes de qualquer ação).
 */
export function inserirDepois(desenho: Desenho, ancoraId: string | null, nova: CaixaDoDesenho): Desenho {
  const percurso = percorrer(desenho);
  let ancora: CaixaDoDesenho | null;
  if (nova.data.kind === "condicoes") ancora = percurso.gatilho;
  else {
    const escolhida = ancoraId ? percurso.fila.find((c) => c.id === ancoraId) ?? null : null;
    ancora = escolhida ?? percurso.acoes[percurso.acoes.length - 1] ?? percurso.condicoes ?? percurso.gatilho;
    if (ancora && ancora.data.kind === "gatilho" && percurso.condicoes) ancora = percurso.condicoes;
  }
  const caixas = [...desenho.caixas, nova];
  if (!ancora) return { caixas, ligacoes: desenho.ligacoes };
  const antiga = saidaDe(desenho, ancora.id);
  const ids = desenho.ligacoes.map((l) => l.id);
  const primeira = proximoId(ids, "ligacao");
  const ligacoes = desenho.ligacoes.filter((l) => l !== antiga);
  ligacoes.push({ id: primeira, source: ancora.id, target: nova.id });
  if (antiga) ligacoes.push({ id: proximoId([...ids, primeira], "ligacao"), source: nova.id, target: antiga.target });
  return { caixas, ligacoes };
}

/**
 * Tira a caixa e fecha a fila — como remover um item da lista no editor de
 * hoje: o que vinha antes passa a ligar no que vinha depois. O gatilho não sai.
 */
export function excluirCaixa(desenho: Desenho, id: string): Desenho {
  const caixa = caixaDe(desenho, id);
  if (!caixa || caixa.data.kind === "gatilho") return desenho;
  const entrada = desenho.ligacoes.find((l) => l.target === id);
  const saida = saidaDe(desenho, id);
  const ligacoes = desenho.ligacoes.filter((l) => l.source !== id && l.target !== id);
  if (entrada && saida && entrada.source !== saida.target) {
    ligacoes.push({ id: proximoId(desenho.ligacoes.map((l) => l.id), "ligacao"), source: entrada.source, target: saida.target });
  }
  return { caixas: desenho.caixas.filter((c) => c.id !== id), ligacoes };
}

/** Tira uma ligação. A caixa que ficou solta é apontada na hora de salvar. */
export function excluirLigacao(desenho: Desenho, id: string): Desenho {
  return { caixas: desenho.caixas, ligacoes: desenho.ligacoes.filter((l) => l.id !== id) };
}

export const RECUSAS_DE_LIGACAO = {
  noGatilho: "O gatilho não recebe ligações: ele é o começo da automação.",
  condicoesDepoisDoGatilho: "As condições vêm logo depois do gatilho: elas são conferidas antes de qualquer ação.",
  circulo: "Essa ligação fecharia um círculo: as ações rodam uma vez, em ordem.",
} as const;
export const AVISO_LIGACAO_TROCADA =
  "Cada caixa vem de um lugar só: a ligação anterior desta caixa foi trocada pela nova.";

function alcanca(desenho: Desenho, de: string, ate: string): boolean {
  const vistas = new Set<string>();
  const fila = [de];
  while (fila.length) {
    const atual = fila.shift()!;
    if (atual === ate) return true;
    if (vistas.has(atual)) continue;
    vistas.add(atual);
    for (const l of desenho.ligacoes) if (l.source === atual) fila.push(l.target);
  }
  return false;
}

/**
 * Liga a saída de uma caixa à entrada de outra, mantendo a fila uma fila: cada
 * caixa tem UMA saída e UMA entrada, então ligar troca a anterior — e avisa
 * quando a troca foi da entrada, que a pessoa não estava olhando.
 */
export function ligar(
  desenho: Desenho,
  origem: string,
  destino: string,
): { ok: true; desenho: Desenho; aviso: string | null } | { ok: false; recusa: string | null } {
  if (origem === destino) return { ok: false, recusa: null };
  const de = caixaDe(desenho, origem);
  const para = caixaDe(desenho, destino);
  if (!de || !para) return { ok: false, recusa: null };
  if (para.data.kind === "gatilho") return { ok: false, recusa: RECUSAS_DE_LIGACAO.noGatilho };
  if (para.data.kind === "condicoes" && de.data.kind !== "gatilho") {
    return { ok: false, recusa: RECUSAS_DE_LIGACAO.condicoesDepoisDoGatilho };
  }
  if (alcanca(desenho, destino, origem)) return { ok: false, recusa: RECUSAS_DE_LIGACAO.circulo };
  const trocouEntrada = desenho.ligacoes.some((l) => l.target === destino && l.source !== origem);
  const ligacoes = desenho.ligacoes.filter((l) => l.source !== origem && l.target !== destino);
  ligacoes.push({ id: proximoId(desenho.ligacoes.map((l) => l.id), "ligacao"), source: origem, target: destino });
  return { ok: true, desenho: { caixas: desenho.caixas, ligacoes }, aviso: trocouEntrada ? AVISO_LIGACAO_TROCADA : null };
}

/* ───────────────────────── organizar ───────────────────────── */

export const LARGURA_DA_CAIXA = 224;
const ALTURA_ESTIMADA = 88;
const ESPACO_VERTICAL = 56;
const COLUNA_SOLTA = -(LARGURA_DA_CAIXA + 120);

/**
 * Uma coluna: a fila de cima para baixo, na ordem em que roda. O que está fora
 * da fila vai para uma coluna à esquerda, para ninguém confundir com a ordem.
 * `alturas` vem do DOM quando o canvas já mediu; sem ela, uma estimativa.
 */
export function organizar(desenho: Desenho, alturas?: ReadonlyMap<string, number>): Desenho {
  const percurso = percorrer(desenho);
  const altura = (id: string) => alturas?.get(id) ?? ALTURA_ESTIMADA;
  const posicoes = new Map<string, { x: number; y: number }>();
  let y = 0;
  for (const c of percurso.fila) {
    posicoes.set(c.id, { x: 0, y });
    y += altura(c.id) + ESPACO_VERTICAL;
  }
  let ySolta = 0;
  for (const c of desenho.caixas) {
    if (posicoes.has(c.id)) continue;
    posicoes.set(c.id, { x: COLUNA_SOLTA, y: ySolta });
    ySolta += altura(c.id) + ESPACO_VERTICAL;
  }
  return {
    caixas: desenho.caixas.map((c) => ({ ...c, position: posicoes.get(c.id) ?? c.position })),
    ligacoes: desenho.ligacoes,
  };
}
