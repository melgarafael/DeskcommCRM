/**
 * O LEAD NÃO FICA NO VÁCUO QUANDO O ORÇAMENTO ACABA.
 *
 * ## O defeito que este arquivo fecha
 *
 * `aplicarOrcamento` recusa a chamada de LLM antes de sair byte para o provedor.
 * Até esta onda a exceção subia de `runAgentTurn` direto para o `catch` do
 * worker, e ali ia para `failJob`. Os dois efeitos, medidos no código:
 *
 *   1. do lado do CLIENTE, no WhatsApp, uma pessoa que perguntou alguma coisa e
 *      não recebeu resposta nenhuma — nem da IA, nem de gente. É o invariante 4
 *      da doutrina do Sistema Vivo quebrado pela própria proteção de custo;
 *   2. do lado de QUEM OPERA, `failJob` reagenda até `max_attempts` (5) e então
 *      insere um `job_dead` **crítico por job, sem dedup**: N conversas × 5
 *      tentativas viravam N alertas críticos "Uma tarefa do assistente falhou",
 *      afogando o único `budget_exceeded` — que é o alerta que EXPLICA.
 *
 * ## O que se prova aqui, e como
 *
 * A escolta (`comHandoffSeOrcamentoAcabar`) é exercitada de verdade, com um pool
 * falso: ela é função de módulo justamente para isso — o caminho de erro de um
 * turno de agente é caro demais para se provar só de ponta a ponta, e o que
 * precisa ser provado é pequeno e exato.
 *
 * O CALL SITE não é alcançável por unidade (`runAgentTurn` precisa do turno
 * inteiro, e `workers/agent-worker/main.ts` chama `main()` no topo do módulo, o
 * que impede importá-lo). Para esses dois, a propriedade é medida ONDE ELA MORA
 * — no texto — com controle negativo obrigatório: sem ele, um detector quebrado
 * deixaria o arquivo verde por não medir nada.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

import { describe, expect, it, vi } from "vitest";
import ts from "typescript";

import {
  comHandoffSeOrcamentoAcabar,
  HANDOFF_REASON_ORCAMENTO,
  RESUMO_DO_HANDOFF_POR_ORCAMENTO,
  TITULO_DO_HANDOFF_POR_ORCAMENTO,
} from "@/lib/agent-engine/agent/inbound-turn";
import type { DesfechoDoAviso } from "@/lib/agent-engine/agent/aviso-de-escalacao";
import { corpoDoBloqueio } from "@/lib/agent-engine/edge/llm/orcamento";
import { LlmBudgetExceededError } from "@/lib/agent-engine/edge/llm/run-model-call";

const RAIZ = process.cwd();
const INBOUND = join(RAIZ, "lib/agent-engine/agent/inbound-turn.ts");
const WORKER = join(RAIZ, "workers/agent-worker/main.ts");
const CABECALHO = join(RAIZ, "components/inbox/ConversationHeader.tsx");

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const RESUMO_DO_CHECKPOINT = "Compromissos: enviar orçamento. Próxima ação: ligar amanhã.";

function poolFalso(opts: { falhaEm?: string } = {}) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (opts.falhaEm !== undefined && sql.includes(opts.falhaEm)) {
      throw new Error("banco fora");
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as never, chamadas, query };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

/**
 * O AVISO AO LEAD entra como FUNÇÃO, pelo mesmo motivo do resumo: só é
 * resolvido no caminho de erro — o caminho feliz não paga por ele.
 *
 * `avisoEspiao()` devolve o dublê para quem quiser medir SE e QUANDO ele foi
 * chamado. O TEXTO do aviso não se mede aqui: tem arquivo próprio
 * (`tests/unit/aviso-ao-lead.test.ts`), e misturá-los faria este reprovar por
 * mudança de redação.
 */
function avisoEspiao() {
  return vi.fn(async (): Promise<DesfechoDoAviso> => ({ avisado: true }));
}

function contexto(pool: unknown, log: unknown, avisarLead = avisoEspiao()) {
  return {
    pool: pool as never,
    tenantId: ORG,
    leadId: LEAD,
    conversationId: CONVERSA,
    // FUNÇÃO, não valor: a escolta envolve o turno inteiro e abre antes de o
    // checkpoint ter sido lido. Resolver o resumo no caminho feliz seria uma
    // query a mais por turno para um texto que quase nunca é usado.
    resumoDoCheckpoint: async () => RESUMO_DO_CHECKPOINT,
    avisarLead,
    log: log as never,
  };
}

/** Só as escritas do handoff — as leituras auxiliares da timeline não contam. */
function sqlsDoHandoff(chamadas: Array<{ sql: string }>): string[] {
  return chamadas.map((c) => c.sql.replace(/\s+/gu, " ").trim());
}

describe("a escolta do orçamento", () => {
  it("caminho feliz: devolve o valor e não escreve nada no banco", async () => {
    const { pool, chamadas } = poolFalso();
    const log = logFalso();

    const devolvido = await comHandoffSeOrcamentoAcabar(contexto(pool, log), async () => "turno ok");

    expect(devolvido).toBe("turno ok");
    expect(chamadas, "handoff disparado num turno que deu certo").toEqual([]);
  });

  it("erro que NÃO é de orçamento passa direto — sem handoff, sem engolir", async () => {
    const { pool, chamadas } = poolFalso();
    const outro = new Error("provedor fora do ar");

    await expect(
      comHandoffSeOrcamentoAcabar(contexto(pool, logFalso()), async () => {
        throw outro;
      }),
    ).rejects.toBe(outro);

    expect(
      chamadas,
      "um 500 do provedor não pode empurrar a conversa para a fila humana: ele volta sozinho",
    ).toEqual([]);
  });

  it("orçamento esgotado: o lead ganha um humano, com as três chaves da ROW do job", async () => {
    const { pool, chamadas } = poolFalso();
    const erro = new LlmBudgetExceededError();

    await expect(
      comHandoffSeOrcamentoAcabar(contexto(pool, logFalso()), async () => {
        throw erro;
      }),
    ).rejects.toBe(erro);

    const sqls = sqlsDoHandoff(chamadas);

    // (a) fonte da verdade: o contato trava no humano
    const forceHuman = chamadas.find((c) => c.sql.includes("set force_human = true"));
    expect(forceHuman, `nenhum update de force_human. SQLs: ${sqls.join(" | ")}`).toBeDefined();
    expect(forceHuman?.params).toEqual([ORG, LEAD]);

    // (b) a conversa volta para a fila humana (e só de 'ai_handling')
    const conversa = chamadas.find((c) => c.sql.includes("update conversations"));
    expect(conversa).toBeDefined();
    expect(conversa?.sql).toContain("'ai_handling' then 'pending'");
    expect(conversa?.params?.[0]).toBe(ORG);
    expect(conversa?.params?.[1]).toBe(CONVERSA);
    expect(conversa?.params).toContain(HANDOFF_REASON_ORCAMENTO);

    // (c) follow-ups agendados do lead não disparam depois da passagem
    const crons = chamadas.find((c) => c.sql.includes("update cron_jobs"));
    expect(crons?.params).toEqual([ORG, LEAD]);

    // (d) a Central recebe o item de escalação, com o título desta causa
    const inbox = chamadas.find((c) => c.sql.includes("insert into agent_inbox_items"));
    expect(inbox, "handoff sem item na Central é passagem que ninguém vê").toBeDefined();
    expect(inbox?.params).toContain(TITULO_DO_HANDOFF_POR_ORCAMENTO);
  });

  it("o resumo do handoff é texto fixo + checkpoint — nunca um resumo gerado", async () => {
    const { pool, chamadas } = poolFalso();
    const chamada = vi.fn(async () => {
      throw new LlmBudgetExceededError();
    });

    await expect(comHandoffSeOrcamentoAcabar(contexto(pool, logFalso()), chamada)).rejects.toThrow();

    // A callback é a ÚNICA porta para o modelo nesta função, e ela rodou uma vez
    // (a que falhou). Gerar o resumo por LLM seria gastar exatamente o que acabou
    // de ser recusado.
    expect(chamada).toHaveBeenCalledTimes(1);

    const inbox = chamadas.find((c) => c.sql.includes("insert into agent_inbox_items"));
    const corpo = String(inbox?.params?.[2] ?? "");
    expect(corpo).toContain(RESUMO_DO_HANDOFF_POR_ORCAMENTO);
    expect(corpo, "o humano assume sem o contexto acumulado da conversa").toContain(
      RESUMO_DO_CHECKPOINT,
    );
    expect(
      RESUMO_DO_HANDOFF_POR_ORCAMENTO,
      "o resumo precisa dizer que o lead NÃO pediu humano — senão quem assume responde a um pedido que não houve",
    ).toMatch(/não pediu atendimento humano/iu);
  });

  it("o lead é AVISADO, e antes de a trava ser armada", async () => {
    // O defeito que este caso fecha: a escolta devolvia a conversa à fila humana
    // e silenciava a IA sem dizer nada a quem estava do outro lado. Do lado de
    // fora, no WhatsApp, é a mesma coisa que não ter escolta nenhuma.
    //
    // A ORDEM é o que se mede, não só a chamada. `performHumanHandoff` grava
    // `force_human = true`, e o gate 1 da cadeia de envio lê essa flag DIRETO da
    // fonte a cada tentativa: avisar depois é avisar ninguém. Um conserto que
    // invertesse a ordem ficaria verde num teste que só contasse a chamada.
    const { pool, chamadas } = poolFalso();
    const avisar = avisoEspiao();
    let avisadoNaChamada = -1;
    avisar.mockImplementation(async () => {
      avisadoNaChamada = chamadas.length;
      return { avisado: true };
    });

    await expect(
      comHandoffSeOrcamentoAcabar(contexto(pool, logFalso(), avisar), async () => {
        throw new LlmBudgetExceededError();
      }),
    ).rejects.toThrow();

    expect(avisar, "escolta que silencia sem avisar é o defeito original").toHaveBeenCalledTimes(1);

    const iForceHuman = chamadas.findIndex((c) => c.sql.includes("set force_human = true"));
    expect(iForceHuman, "sem force_human não há passagem para medir a ordem contra").toBeGreaterThanOrEqual(0);
    expect(
      avisadoNaChamada,
      "o aviso saiu DEPOIS de force_human — a trava que ele acabou de armar veta o envio",
    ).toBeLessThanOrEqual(iForceHuman);
  });

  it("aviso que não chegou vira LINHA no item da Central", async () => {
    // Falhar fechado na AÇÃO, aberto na INFORMAÇÃO: a passagem acontece de todo
    // jeito, mas quem for assumir precisa saber que o cliente está esperando sem
    // ter sido avisado — é o que muda a primeira frase que o atendente digita.
    const { pool, chamadas } = poolFalso();
    const avisar = vi.fn(async (): Promise<DesfechoDoAviso> => ({ avisado: false, porque: "outside_window" }));

    await expect(
      comHandoffSeOrcamentoAcabar(contexto(pool, logFalso(), avisar), async () => {
        throw new LlmBudgetExceededError();
      }),
    ).rejects.toThrow();

    const inbox = chamadas.find((c) => c.sql.includes("insert into agent_inbox_items"));
    const corpo = String(inbox?.params?.[2] ?? "");
    expect(corpo).toMatch(/NÃO foi avisado/u);
    expect(corpo).toContain("outside_window");
  });

  it("aviso que falha NÃO impede a passagem", async () => {
    // A ordem certa não pode virar dependência: se o canal cair, o cliente perde
    // o aviso — mas não pode perder também o atendente.
    const { pool, chamadas } = poolFalso();
    const avisar = vi.fn(async () => {
      throw new Error("canal fora");
    });

    await expect(
      comHandoffSeOrcamentoAcabar(contexto(pool, logFalso(), avisar as never), async () => {
        throw new LlmBudgetExceededError();
      }),
    ).rejects.toThrow();

    expect(
      chamadas.some((c) => c.sql.includes("set force_human = true")),
      "o aviso derrubou a passagem que ele deveria só anteceder",
    ).toBe(true);
  });

  it("handoff que falha deixa SUBIR o erro dele, não o de orçamento", async () => {
    // O erro do handoff não é terminal: o job re-tenta e o handoff volta a ser
    // tentado. Preservar o de orçamento aqui faria a fila cancelar o job com o
    // lead ainda no vácuo — o defeito que esta escolta existe para fechar.
    const { pool } = poolFalso({ falhaEm: "set force_human = true" });

    await expect(
      comHandoffSeOrcamentoAcabar(contexto(pool, logFalso()), async () => {
        throw new LlmBudgetExceededError();
      }),
    ).rejects.toThrow("banco fora");
  });
});

/**
 * ⚠️ A VERSÃO ANTERIOR DESTA SUÍTE TINHA PONTO CEGO, e o ponto cego era o
 * defeito. Ela contava `runModelCall(` no TEXTO de `inbound-turn.ts` e exigia
 * que as duas ocorrências estivessem dentro da escolta. Mas o turno faz pelo
 * menos SEIS chamadas de modelo, e quatro entram por auxiliares
 * (`classifyStage`, `maybeCompact`/flush, `classifyJailbreak`,
 * `classifyPromise`) — nenhuma delas aparece como `runModelCall(` neste arquivo.
 * O detector media o que sabia medir, o controle negativo provava que ele
 * enxergava a própria régua, e a PROPRIEDADE que o nome do caso prometia era
 * falsa com a suíte verde.
 *
 * A régua nova não tem esse eixo cego porque não conta chamadas de modelo: ela
 * afirma que o TURNO INTEIRO roda dentro da escolta. `runAgentTurn` delega a
 * `executarTurnoDoAgente`, que não é exportada — então não existe caminho para
 * o corpo do turno rodar desescoltado, e nenhum auxiliar futuro precisa ser
 * lembrado numa lista.
 */
/** Distinguishes the authorized in-memory preview from every operational entrance. */
function chamadasDoNucleo(texto: string) {
  const ast = ts.createSourceFile("inbound.ts", texto, ts.ScriptTarget.Latest, true);
  const chamadas: Array<{ tipo: "operacional" | "preview" | "sem_escolta"; texto: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "executarTurnoDoAgente") {
      const ancestors: ts.Node[] = [];
      for (let p = node.parent; p; p = p.parent) ancestors.push(p);
      const owner = ancestors.find(ts.isFunctionDeclaration)?.name?.text;
      const escoltado = ancestors.some(p => ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "comHandoffSeOrcamentoAcabar");
      const preview = owner === "runAgentPreview" && node.arguments.length === 6 &&
        node.arguments[1]?.kind === ts.SyntaxKind.NullKeyword && node.arguments[5]?.getText(ast) === "preview";
      chamadas.push({ tipo: owner === "runAgentTurn" && escoltado ? "operacional" : preview ? "preview" : "sem_escolta", texto: node.getText(ast) });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return chamadas;
}

describe("o call site — AST separa prévia sem job do turno operacional escoltado", () => {
  const fonteInbound = readFileSync(INBOUND, "utf8");
  const ESCOLTADO = "() => executarTurnoDoAgente(deps, job, pool, ctx, input),";

  it("há uma única entrada operacional escoltada e uma prévia explicitamente sem job", () => {
    const calls = chamadasDoNucleo(fonteInbound);
    expect(calls.map(c => c.tipo).sort()).toEqual(["operacional", "preview"]);
    const ast = ts.createSourceFile("inbound.ts", fonteInbound, ts.ScriptTarget.Latest, true);
    const declarations = ast.statements.filter(ts.isFunctionDeclaration).filter(n => n.name?.text === "executarTurnoDoAgente");
    expect(declarations).toHaveLength(1);
    expect(declarations[0]!.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false).toBe(false);
  });

  function auxiliaresForaDoNucleo(texto: string) {
    const ast = ts.createSourceFile("inbound.ts", texto, ts.ScriptTarget.Latest, true);
    const encontrados: Array<{ nome: string; owner: string | undefined }> = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["classifyStage", "maybeCompact"].includes(node.expression.text)) {
        let parent: ts.Node | undefined = node.parent;
        while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
        encontrados.push({ nome: node.expression.text, owner: parent && ts.isFunctionDeclaration(parent) ? parent.name?.text : undefined });
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    return encontrados;
  }
  it("todos os auxiliares de classificação e compaction ficam dentro do núcleo", () => {
    const calls = auxiliaresForaDoNucleo(fonteInbound);
    expect(new Set(calls.map(c => c.nome))).toEqual(new Set(["classifyStage", "maybeCompact"]));
    expect(calls.filter(c => c.owner !== "executarTurnoDoAgente")).toEqual([]);
  });

  it("controle negativo: retirar a escolta é acusado mesmo mantendo o número de chamadas", () => {
    const sabotado = fonteInbound.replace(ESCOLTADO, "() => Promise.resolve(),\n  );\n  await executarTurnoDoAgente(deps, job, pool, ctx, input);\n  void (");
    expect(sabotado).not.toBe(fonteInbound);
    expect(chamadasDoNucleo(sabotado)).toHaveLength(2);
    expect(chamadasDoNucleo(sabotado).filter(c => c.tipo === "sem_escolta")).toHaveLength(1);
  });
  it("controle negativo: um novo atalho é acusado sem remover a escolta legítima", () => {
    const sabotado = `${fonteInbound}\nasync function atalho() { await executarTurnoDoAgente(a, b, c, d, e); }`;
    expect(chamadasDoNucleo(sabotado).map(c => c.tipo).sort()).toEqual(["operacional", "preview", "sem_escolta"]);
  });
  it("controle negativo: prévia não pode transportar um job operacional", () => {
    const sabotado = fonteInbound.replace(/(await executarTurnoDoAgente\(\s*deps,\s*)null,/, "$1job,");
    expect(sabotado).not.toBe(fonteInbound);
    expect(chamadasDoNucleo(sabotado).filter(c => c.tipo === "sem_escolta")).toHaveLength(1);
  });
  it("controle negativo: um auxiliar fora do núcleo é acusado", () => {
    const sabotado = `${fonteInbound}\nasync function atalho() { await classifyStage(x); }`;
    expect(auxiliaresForaDoNucleo(sabotado).filter(c => c.owner !== "executarTurnoDoAgente")).toEqual([{ nome: "classifyStage", owner: "atalho" }]);
  });

  it("o erro de orçamento se declara terminal — é o que a fila lê", () => {
    const erro = new LlmBudgetExceededError() as unknown as { terminal?: unknown };
    expect(
      erro.terminal,
      "sem esta propriedade o worker manda o bloqueio para failJob e a Central afoga em job_dead",
    ).toBe(true);
  });
});

describe("a fila trata veto de negócio como veto, não como incidente", () => {
  const fonteWorker = readFileSync(WORKER, "utf8").replace(/\s+/gu, " ");
  const ROTEAMENTO =
    "if (terminal) { await cancelJob(pool, job.id, workerId, errMsg(err), claimOfJob(job)?.acquired_at); } " +
    "else { await failJob(pool, job.id, workerId, err, claimOfJob(job)?.acquired_at); }";

  it("erro terminal vai para cancelJob; o resto continua em failJob", () => {
    expect(fonteWorker.length, "guarda de vacuidade: arquivo do worker vazio").toBeGreaterThan(1000);
    expect(
      fonteWorker,
      "bloqueio por orçamento em failJob = 5 tentativas por conversa + 1 job_dead crítico sem dedup por job",
    ).toContain(ROTEAMENTO);
    expect(fonteWorker).toContain("ehVetoPermanenteDeNegocio(err)");
  });

  it("controle negativo: o detector acusa a volta do failJob", () => {
    const sabotado = fonteWorker.replace(
      "await cancelJob(pool, job.id, workerId, errMsg(err), claimOfJob(job)?.acquired_at);",
      "await failJob(pool, job.id, workerId, err, claimOfJob(job)?.acquired_at);",
    );
    expect(sabotado).not.toBe(fonteWorker);
    expect(sabotado).not.toContain(ROTEAMENTO);
  });
});

describe("o código morto de orçamento não volta", () => {
  const APAGADOS = [
    "workers/ai-budget-checker.cron.ts",
    "workers/ai-budget-reset.cron.ts",
    "lib/ai/dispatcher/budget.ts",
  ];
  const SIMBOLOS = ["runBudgetChecker", "runBudgetReset", "checkTenantBudget"];
  const RAIZES = ["app", "components", "hooks", "lib", "workers"] as const;

  function arquivos(dir: string): string[] {
    const alvos: string[] = [];
    for (const entrada of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      const rel = posix.join(dir, entrada.name);
      if (entrada.isDirectory()) alvos.push(...arquivos(rel));
      else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) alvos.push(rel);
    }
    return alvos;
  }

  /** Linhas de código, sem comentário — o que sobrou é referência VIVA. */
  function semComentarios(fonte: string): string {
    return fonte
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
  }

  const alvos = RAIZES.flatMap((r) => arquivos(r));

  it("os três arquivos não existem", () => {
    // Deixá-los vivos mantém armada a mina que esta feature desarma: um PR futuro
    // que só acrescentasse o agendamento ligaria negação de serviço à distância —
    // e `runBudgetReset` zera o contador INCONDICIONALMENTE, o que numa primeira
    // execução no meio do mês descartaria o gasto corrente.
    expect(APAGADOS.filter((f) => existsSync(join(RAIZ, f)))).toEqual([]);
  });

  it("ninguém referencia os símbolos apagados", () => {
    expect(alvos.length, "guarda de vacuidade: a varredura não achou arquivo").toBeGreaterThan(500);
    const vivos = alvos.filter((f) => {
      const fonte = semComentarios(readFileSync(join(RAIZ, f), "utf8"));
      return SIMBOLOS.some((s) => fonte.includes(s));
    });
    expect(vivos, "referência a código apagado — o `verify` quebra no próximo build").toEqual([]);
  });

  it("as flags mortas não têm mais leitor de decisão", () => {
    // `is_throttled`/`is_disabled` perderam o escritor. Um leitor sobrevivente é
    // pior que inútil: é uma trava que ninguém mais consegue destravar pela tela.
    // `lib/database.types.ts` é gerado do banco (as colunas continuam lá) e fica
    // de fora — o que se mede é CÓDIGO que decide.
    const leitores = alvos.filter((f) => {
      if (f === "lib/database.types.ts") return false;
      const fonte = semComentarios(readFileSync(join(RAIZ, f), "utf8"));
      return fonte.includes("is_throttled") || fonte.includes("is_disabled");
    });
    expect(leitores).toEqual([]);
  });

  it("controle negativo: a varredura enxerga um leitor quando ele existe", () => {
    const comLeitor = semComentarios('const x = row.is_throttled;\n// is_disabled num comentário\n');
    expect(comLeitor.includes("is_throttled")).toBe(true);
    expect(comLeitor.includes("is_disabled")).toBe(false);
  });
});

/**
 * O BOTÃO QUE O TEXTO MANDA PROCURAR TEM DE EXISTIR COM ESSE NOME.
 *
 * Achado desta revisão, e da pior classe possível: os dois textos que a pessoa lê
 * quando a IA para — o corpo do item `budget_exceeded` na Central e o resumo que
 * vai ao humano que assume — mandavam usar um botão chamado
 * "Retomar atendimento automático". Esse botão não existe. O rótulo que
 * `components/inbox/ConversationHeader.tsx` renderiza é **"Devolver ao automático"**.
 *
 * É exatamente o defeito que esta entrega existe para matar, uma camada acima: um
 * texto afirmando uma coisa sobre o produto, e o produto fazendo outra. Quem
 * seguisse a instrução procuraria na tela um botão que não está lá, com a IA
 * parada e o cliente esperando.
 *
 * A guarda lê o rótulo DO COMPONENTE — nunca uma cópia transcrita aqui. Transcrever
 * mediria a minha cópia, e ela continuaria "certa" com o botão renomeado.
 */
describe("os textos do orçamento nomeiam botões que existem", () => {
  const fonteCabecalho = readFileSync(CABECALHO, "utf8");

  /**
   * O rótulo do botão de volta, extraído do próprio componente.
   *
   * Lê o ÚLTIMO `t("...")` antes de `</Button>`, não o primeiro depois do
   * `data-testid`: o `title` do botão (tooltip com o alcance da ação, i18n
   * também) ganhou suas próprias chamadas `t(...)` antes do texto visível, e
   * pegar a primeira ocorrência passou a capturar o tooltip em vez do rótulo.
   */
  function rotuloDoBotaoDeVolta(): string {
    const bloco = fonteCabecalho.slice(fonteCabecalho.indexOf('data-testid="devolver-ao-automatico"'));
    const fechamento = bloco.indexOf("</Button>");
    const corpoDoBotao = fechamento === -1 ? bloco : bloco.slice(0, fechamento);
    const ocorrencias = [...corpoDoBotao.matchAll(/t\("([^"]+)"\)/g)];
    const ultima = ocorrencias[ocorrencias.length - 1];
    if (ultima === undefined) {
      throw new Error(
        "não achei o rótulo do botão de volta em ConversationHeader.tsx — o extrator perdeu o alvo. " +
          "Perder o alvo NÃO é aprovação: conserte o extrator, nunca apague o caso.",
      );
    }
    return ultima[1]!;
  }

  it("o botão de volta existe e tem um rótulo legível (guarda de vacuidade)", () => {
    expect(fonteCabecalho).toContain('data-testid="devolver-ao-automatico"');
    expect(rotuloDoBotaoDeVolta().length).toBeGreaterThan(3);
  });

  it("o corpo do item da Central manda o cliente ao botão que existe", () => {
    expect(
      corpoDoBloqueio(15_000, 10_000),
      "a IA parou e o texto manda procurar um botão que não está na tela",
    ).toContain(rotuloDoBotaoDeVolta());
  });

  it("o resumo entregue ao humano que assume também", () => {
    expect(RESUMO_DO_HANDOFF_POR_ORCAMENTO).toContain(rotuloDoBotaoDeVolta());
  });

  it("controle negativo: o detector acusa o rótulo renomeado", () => {
    // Sabota o COMPONENTE, não o texto: é a direção real do apodrecimento (o
    // botão é renomeado por outra frente, e os textos ficam para trás).
    const renomeado = fonteCabecalho.replace(
      `t("${rotuloDoBotaoDeVolta()}")`,
      't("Voltar para a IA")',
    );
    expect(renomeado).not.toBe(fonteCabecalho);
    const blocoRenomeado = renomeado.slice(renomeado.indexOf('data-testid="devolver-ao-automatico"'));
    const fechamentoRenomeado = blocoRenomeado.indexOf("</Button>");
    const corpoRenomeado =
      fechamentoRenomeado === -1 ? blocoRenomeado : blocoRenomeado.slice(0, fechamentoRenomeado);
    const ocorrenciasRenomeadas = [...corpoRenomeado.matchAll(/t\("([^"]+)"\)/g)];
    const novo = ocorrenciasRenomeadas[ocorrenciasRenomeadas.length - 1]?.[1];
    expect(novo).toBe("Voltar para a IA");
    expect(corpoDoBloqueio(15_000, 10_000)).not.toContain(novo as string);
  });
});
