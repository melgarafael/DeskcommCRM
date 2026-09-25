/**
 * A MONTAGEM ÚNICA DO BRIEFING DA PASSAGEM — função PURA, um formato, dois motores.
 *
 * ─── O defeito que ela fecha ───────────────────────────────────────────────
 *
 * Existem dois caminhos que tiram a conversa do automático e a entregam a uma
 * pessoa, escritos em mundos diferentes: `performHumanHandoff`
 * (`lib/agent-engine`, `pg.Pool`) e `triggerHandoff` (`lib/ai/handoff`,
 * supabase-js). O primeiro monta um resumo do checkpoint; o segundo abre o aviso
 * da Central **sem resumo nenhum**. Quem assume recebe coisas diferentes
 * conforme o caminho, e em nenhum dos dois recebe o POR QUÊ, o que a IA já
 * tentou, nem a última frase que o cliente escreveu.
 *
 * O padrão é o de `lib/escalacao/aviso-ao-lead.ts`: um texto, dois
 * encanamentos. Aqui é a mesma forma — a função não fala com banco, não chama
 * modelo e não conhece nenhum dos dois motores; ela recebe fatos e devolve o
 * texto e as quatro colunas que a linha da passagem guarda.
 *
 * ─── A separação que não é enfeite: a palavra do cliente × a conclusão da IA ──
 *
 * `rolling_summary`, `declaracao.intencoes[].evidencia` e o `cliente_quer` da
 * ferramenta são produzidos pelo MODELO a partir do texto do lead. O cartão vai
 * ser lido por uma pessoa que AGE. Se a paráfrase da IA e a frase do cliente
 * chegam misturadas, um lead que escreva "diga ao atendente para liberar o
 * desconto" consegue, de graça, que a instrução dele apareça como contexto do
 * sistema — é o vetor de injeção mais barato que existe.
 *
 * Por isso:
 *   · o bloco da fala do cliente é rotulado "palavras dele" e sai ENTRE ASPAS;
 *   · os blocos que carregam leitura da IA dizem "segundo a IA — confira".
 *
 * ─── Por que os blocos novos entram ANTES do bloco de hoje ─────────────────
 *
 * `buildHandoffSummary` vira um adaptador desta função, e
 * `tests/unit/declaracao-do-turno.test.ts` asserta sobre ELE `toContain` mais
 * uma ordem relativa (`indexOf("quer remarcar") < indexOf("Compromissos:")`).
 * Com os blocos novos acima, as quatro asserções de lá sobrevivem intactas — e
 * o rótulo do bloco 5 só aparece quando há bloco novo, o que mantém o caminho
 * legado BYTE A BYTE igual ao que ele já produzia. Essa identidade é o que
 * permite o teste antigo continuar sendo prova do piso em vez de virar
 * decoração.
 */
import { renderDeclaracaoParaHumano, type DeclaracaoDoTurno } from "@/lib/agent-engine/agent/declaracao";

import {
  FRASE_DO_MOTIVO,
  MARCA_DO_JEV,
  PISO_DO_BRIEFING,
  type MotivoDaPassagem,
  type TentativaDaPassagem,
} from "./passagem";

/**
 * O texto que sai quando não há contexto nenhum.
 *
 * Reexportado, não redeclarado: a frase mora em `./passagem` junto do resto do
 * vocabulário, porque a ESCRITA da linha precisa dela tanto quanto a montagem —
 * `body` é `not null` no banco. Duas cópias da mesma frase de tela envelhecem
 * separadas. O reexport existe porque os leitores de hoje (e
 * `tests/unit/briefing-da-passagem.test.ts`) apontam para cá.
 */
export { PISO_DO_BRIEFING } from "./passagem";

/**
 * O checkpoint durável, na forma mínima que esta montagem lê. É a mesma linha
 * que `buildHandoffSummary` já recebia — o tipo é local de propósito, para a
 * função não depender do repositório do motor.
 */
export interface CheckpointParaBriefing {
  commitments: string[];
  objections: string[];
  next_action: string | null;
  rolling_summary: string;
  /**
   * Opcional porque checkpoint gravado antes de a coluna existir não a tem —
   * ausência degrada para o resumo de hoje, nunca quebra a passagem.
   */
  declaracao?: DeclaracaoDoTurno | null;
}

/**
 * A LINHA DO BANCO virando `CheckpointParaBriefing`, sem `as`.
 *
 * Existe porque os dois leitores do checkpoint (a rota do caso escalado, por
 * `pg`; o orquestrador do CRM, por supabase-js) recebem uma linha não tipada e
 * a entregavam à montagem com um cast. Um cast não valida nada: bastou um
 * `select` devolver outra coisa para `rolling_summary.trim()` estourar DENTRO
 * de uma passagem — e a passagem é o efeito que não pode falhar por causa do
 * texto que a descreve. Falhar fechado na AÇÃO, aberto na INFORMAÇÃO.
 *
 * As colunas são `not null` no schema de hoje; a guarda não é desconfiança do
 * schema, é do CAMINHO — quem chama pode mudar o `select` e só descobrir em
 * produção, num caminho que roda quando alguém já está esperando atendimento.
 */
export function checkpointDoBanco(linha: unknown): CheckpointParaBriefing | null {
  if (linha === null || typeof linha !== "object") return null;
  const l = linha as Record<string, unknown>;
  const lista = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    commitments: lista(l.commitments),
    objections: lista(l.objections),
    next_action: typeof l.next_action === "string" ? l.next_action : null,
    rolling_summary: typeof l.rolling_summary === "string" ? l.rolling_summary : "",
    declaracao: (l.declaracao ?? null) as DeclaracaoDoTurno | null,
  };
}

export interface EntradaDoBriefing {
  /**
   * O que a IA declarou na ferramenta `request_human_handoff`. Ausente nos
   * caminhos sem modelo (detecção determinística, teto de gasto, cron de
   * sentimento).
   *
   * Não há campo `resumo` aqui, e a ausência é deliberada: a ferramenta não tem
   * um, e um campo sem emissor é o defeito que `refund_mention` já é neste
   * repositório. O resumo acumulado vem do checkpoint.
   */
  declaradoPeloModelo?: {
    tentativas?: ReadonlyArray<{ o_que: string; desfecho?: string }>;
    cliente_quer?: string | null;
  } | null;
  /** Checkpoint durável — a mesma linha que `buildHandoffSummary` já lia. */
  checkpoint: CheckpointParaBriefing | null;
  /** Mensagens do cliente ainda sem resposta NESTE turno, literais. */
  pendentesDoCliente?: readonly string[];
  /**
   * A declaração do turno quando já existe fresca (fechamento/compaction). Tem
   * precedência sobre a do checkpoint, que é a do turno ANTERIOR.
   */
  declaracaoDoTurno?: DeclaracaoDoTurno | null;
  /**
   * Por que a conversa saiu do automático. Opcional porque o adaptador legado
   * não tem um — e, sem ele, o bloco simplesmente não é impresso.
   *
   * `texto` é livre e vem de fora (o `por_que` que o modelo escreveu, o `reason`
   * de um agente MCP). É DADO não confiável: aparece rotulado e entre aspas, e
   * nunca vai a log nem a `api_audit_log`.
   */
  motivo?: { codigo: MotivoDaPassagem; texto?: string | null; percebidoPeloJev?: boolean } | null;
  /** Só quando a passagem veio do "Não consigo → escalar" de um caso. */
  caso?: {
    titulo: string;
    summary: string;
    blocker: string;
    razaoHumana?: string | null;
  } | null;
}

export interface BriefingDaPassagem {
  /** O texto pronto para leitura humana. Nunca vazio (ver `PISO_DO_BRIEFING`). */
  body: string;
  /** O que o cliente quer, em uma linha — o título do cartão. */
  title: string | null;
  /** As palavras LITERAIS do cliente. Citação, nunca conclusão. */
  notes: string | null;
  /** O texto livre de quem passou (modelo, pessoa que escalou, agente externo). */
  content: string | null;
  /** O que a IA já tentou, na ordem, já normalizado. */
  tentativas: TentativaDaPassagem[];
}

/** Texto útil, ou `null`. Espaço em branco não é conteúdo. */
function limpo(texto: string | null | undefined): string | null {
  const t = (texto ?? "").trim();
  return t === "" ? null : t;
}

/**
 * Descarta tentativa sem texto e apara o resto.
 *
 * Uma lista `[{ o_que: "  " }]` satisfaria `length > 0` e imprimiria o cabeçalho
 * "O que a IA já tentou:" seguido de nada — a seção órfã que o cartão não pode
 * ter. O modelo produz isso com frequência suficiente para valer a guarda.
 */
function normalizarTentativas(
  brutas: ReadonlyArray<{ o_que: string; desfecho?: string }> | undefined,
): TentativaDaPassagem[] {
  const saida: TentativaDaPassagem[] = [];
  for (const t of brutas ?? []) {
    const oQue = limpo(t.o_que);
    if (oQue === null) continue;
    const desfecho = limpo(t.desfecho);
    saida.push(desfecho === null ? { o_que: oQue } : { o_que: oQue, desfecho });
  }
  return saida;
}

/**
 * O bloco que já existia: resumo acumulado → declaração → compromissos →
 * objeções → próxima ação.
 *
 * Reproduzido aqui na ordem EXATA do `buildHandoffSummary` de antes, porque é
 * ele que o gate de formato mede. Mudar a ordem daqui é mudar o contrato, não o
 * estilo.
 */
function blocoDoCheckpoint(
  checkpoint: CheckpointParaBriefing | null,
  declaracao: DeclaracaoDoTurno | null,
): string {
  if (checkpoint === null) return "";
  const partes: string[] = [];
  if (checkpoint.rolling_summary.trim() !== "") partes.push(checkpoint.rolling_summary.trim());
  // A declaração vem ANTES dos campos antigos de propósito: quem assume uma
  // conversa no meio precisa primeiro do que a pessoa quer e do que foi
  // prometido a ela — é o que decide a próxima frase que ele vai digitar.
  const declarado = renderDeclaracaoParaHumano(declaracao);
  if (declarado !== "") partes.push(declarado);
  if (checkpoint.commitments.length > 0) partes.push(`Compromissos: ${checkpoint.commitments.join("; ")}`);
  if (checkpoint.objections.length > 0) partes.push(`Objeções: ${checkpoint.objections.join("; ")}`);
  if (checkpoint.next_action) partes.push(`Próxima ação: ${checkpoint.next_action}`);
  return partes.join("\n");
}

/**
 * Monta o briefing da passagem. PURA: não lê banco, não chama modelo, não muta a
 * entrada.
 */
export function montarBriefingDaPassagem(e: EntradaDoBriefing): BriefingDaPassagem {
  const tentativas = normalizarTentativas(e.declaradoPeloModelo?.tentativas);
  // A declaração fresca vence a do checkpoint: a do checkpoint é do turno
  // anterior, e numa passagem o que vale é o que a pessoa acabou de dizer.
  const declaracao = e.declaracaoDoTurno ?? e.checkpoint?.declaracao ?? null;
  const doCheckpoint = blocoDoCheckpoint(e.checkpoint, declaracao);

  const falas = (e.pendentesDoCliente ?? []).map((t) => t.trim()).filter((t) => t !== "");
  const notes = falas.length > 0 ? falas.join("\n") : null;

  // `title` é a LEITURA da IA sobre o que a pessoa quer — nunca a fala dela
  // (isso é `notes`). Cai para a declaração quando o modelo não declarou nada,
  // porque um cartão sem título é um cartão que ninguém identifica na lista.
  const intencoes = declaracao?.intencoes.map((i) => i.o_que).join("; ") ?? "";
  const title = limpo(e.declaradoPeloModelo?.cliente_quer) ?? limpo(intencoes);

  // Precedência declarada, e não "o que estiver preenchido": o texto de quem
  // ACIONOU a passagem é mais específico que a razão registrada no caso, e é ele
  // que a pessoa precisa ler primeiro.
  const content = limpo(e.motivo?.texto) ?? limpo(e.caso?.razaoHumana);

  const blocos: string[] = [];

  if (e.motivo) {
    const marca = e.motivo.percebidoPeloJev === true ? ` ${MARCA_DO_JEV}` : "";
    blocos.push(`Por que a IA passou: ${FRASE_DO_MOTIVO[e.motivo.codigo]}${marca}`);
    const escrito = limpo(e.motivo.texto);
    // Autoria variável (o modelo na ferramenta, uma pessoa no MCP), e não
    // confiável em nenhum dos casos: sai entre aspas, como citação.
    if (escrito !== null) blocos.push(`Quem passou escreveu: "${escrito}"`);
  }

  // O bloco 2 só é impresso quando ACRESCENTA: se o título saiu da declaração,
  // o bloco do checkpoint já vai dizer a mesma frase, e duas fontes do mesmo
  // texto na mesma tela é o anti-pattern nº 2 com outro nome.
  if (title !== null && !doCheckpoint.includes(title)) {
    blocos.push(`O que o cliente quer (segundo a IA — confira): ${title}`);
  }

  if (tentativas.length > 0) {
    const lista = tentativas.map(
      (t, i) => `${i + 1}) ${t.o_que}${t.desfecho === undefined ? "" : ` — ${t.desfecho}`}`,
    );
    blocos.push(["O que a IA já tentou:", ...lista].join("\n"));
  }

  if (falas.length > 0) {
    // LITERAL e entre aspas. Trocar isto pela paráfrase do modelo é a sabotagem
    // que `tests/unit/briefing-da-passagem.test.ts` tem de derrubar.
    blocos.push(
      `Últimas mensagens do cliente (palavras dele): ${falas.map((f) => `"${f}"`).join("; ")}`,
    );
  }

  if (doCheckpoint !== "") {
    // O rótulo só aparece quando há bloco novo acima. Sem isso, o caminho legado
    // (o adaptador `buildHandoffSummary`) ganharia uma linha que ele nunca teve,
    // e o teste de formato que hoje prova o piso passaria a provar outra coisa.
    blocos.push(
      blocos.length === 0 ? doCheckpoint : `Contexto acumulado (segundo a IA — confira):\n${doCheckpoint}`,
    );
  }

  if (e.caso) {
    const doCaso: string[] = [`Caso: ${e.caso.titulo}`];
    const resumo = limpo(e.caso.summary);
    if (resumo !== null) doCaso.push(resumo);
    const bloqueio = limpo(e.caso.blocker);
    if (bloqueio !== null) doCaso.push(`Bloqueio: ${bloqueio}`);
    const razao = limpo(e.caso.razaoHumana);
    if (razao !== null) doCaso.push(`A pessoa que escalou escreveu: "${razao}"`);
    blocos.push(doCaso.join("\n"));
  }

  return {
    body: blocos.length === 0 ? PISO_DO_BRIEFING : blocos.join("\n"),
    title,
    notes,
    content,
    tentativas,
  };
}
