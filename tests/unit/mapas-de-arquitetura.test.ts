import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Os mapas de `docs/architecture/` são FONTE, e ninguém os verificava.
 *
 * O item 13 do Definition of Done pede que "o mapa vivo reflita a peça nova com
 * ≥2 arestas". Até aqui isso era honra: os JSON não passavam por gate nenhum, e
 * os modos de falha são todos silenciosos —
 *
 *   - aresta apontando para um `id` que não existe (renomeou o node, esqueceu a
 *     aresta) → o render some com a ligação e o mapa passa a mentir por omissão,
 *     que é o jeito mais difícil de perceber;
 *   - node em `lane` inexistente → cai fora do desenho;
 *   - node ÓRFÃO, sem nenhuma aresta → é o oposto do que o DoD pede: a peça está
 *     no mapa e continua sendo ilha;
 *   - `mainPath` citando id morto → o fio condutor quebra.
 *
 * O gate é estrutural de propósito. Ele NÃO julga se o mapa descreve a realidade
 * do código — isso nenhum teste faz, e fingir que faz seria pior que não ter.
 * Ele garante que o mapa é internamente coerente, que é a parte verificável.
 */

const DIR = path.join(process.cwd(), "docs", "architecture");

interface Mapa {
  schema_version?: number;
  lanes?: Array<{ id: string; label: string }>;
  mainPath?: string[];
  nodes?: Array<{ id: string; lane: string; label: string }>;
  edges?: Array<{ id: string; from: string; to: string; label?: string }>;
}

const arquivos = fs
  .readdirSync(DIR)
  // TODO *.json, não só `.architecture.json`. O filtro estreito deixava de fora
  // exatamente `agent-turn.workflow.json` — o mapa mais importante do produto e o
  // único que o archify renderiza. Foi por essa fresta que ele passou a afirmar
  // "cadeia de 7 gates" (eram 10) e "1 chamada de modelo" (eram 2) sem nada
  // reprovar: prosa não tem catraca, e o gate estrutural nem olhava o arquivo.
  .filter((f) => f.endsWith(".json"))
  .sort();

/**
 * Mapas que descrevem desenho CONTRATADO e ainda não construído podem ter peças
 * sem aresta — `docs/architecture/README.md` diz isso de `crm-vivo` com todas as
 * letras ("é PLANTA, não fotografia"). A allowlist é de ÓRFÃOS apenas: os demais
 * casos valem para todos os arquivos, sem exceção.
 */
const PLANTA_COM_ORFAOS = new Set(["crm-vivo.architecture.json"]);

describe("mapas de arquitetura — coerência interna", () => {
  it("existe mapa para verificar (guarda de vacuidade)", () => {
    // Sem isto, apagar a pasta faria todos os casos abaixo passarem por não
    // haver o que verificar.
    expect(arquivos.length).toBeGreaterThan(0);
  });

  it.each(arquivos)("%s é JSON válido com nodes e edges", (nome) => {
    const bruto = fs.readFileSync(path.join(DIR, nome), "utf8");
    const m = JSON.parse(bruto) as Mapa;
    expect(Array.isArray(m.nodes), `${nome} sem nodes`).toBe(true);
    expect(Array.isArray(m.edges), `${nome} sem edges`).toBe(true);
    expect(m.nodes!.length, `${nome} sem nenhuma peça`).toBeGreaterThan(0);
  });

  it.each(arquivos)("%s: toda aresta liga ids que existem", (nome) => {
    const m = JSON.parse(fs.readFileSync(path.join(DIR, nome), "utf8")) as Mapa;
    const ids = new Set(m.nodes!.map((n) => n.id));
    const quebradas = (m.edges ?? [])
      .flatMap((e) => [
        ids.has(e.from) ? null : `${e.id}: from="${e.from}"`,
        ids.has(e.to) ? null : `${e.id}: to="${e.to}"`,
      ])
      .filter((x): x is string => x !== null);
    expect(quebradas, `${nome} tem aresta para id inexistente`).toEqual([]);
  });

  it.each(arquivos)("%s: todo node está numa lane declarada", (nome) => {
    const m = JSON.parse(fs.readFileSync(path.join(DIR, nome), "utf8")) as Mapa;
    const lanes = new Set((m.lanes ?? []).map((l) => l.id));
    const fora = m.nodes!.filter((n) => !lanes.has(n.lane)).map((n) => `${n.id}→${n.lane}`);
    expect(fora, `${nome} tem node em lane inexistente`).toEqual([]);
  });

  it.each(arquivos)("%s: mainPath só cita ids que existem", (nome) => {
    const m = JSON.parse(fs.readFileSync(path.join(DIR, nome), "utf8")) as Mapa;
    const ids = new Set(m.nodes!.map((n) => n.id));
    const mortos = (m.mainPath ?? []).filter((id) => !ids.has(id));
    expect(mortos, `${nome} tem mainPath citando id morto`).toEqual([]);
  });

  it.each(arquivos)("%s: nenhuma peça é ilha — o DoD 13 pede ≥1 aresta", (nome) => {
    const m = JSON.parse(fs.readFileSync(path.join(DIR, nome), "utf8")) as Mapa;
    const ligados = new Set((m.edges ?? []).flatMap((e) => [e.from, e.to]));
    const orfaos = m.nodes!.filter((n) => !ligados.has(n.id)).map((n) => n.id);
    if (PLANTA_COM_ORFAOS.has(nome)) {
      // Dívida CONGELADA: o mapa é planta e o README declara isso. Só não pode
      // piorar — se alguém acrescentar peça solta, este número sobe e reprova.
      expect(orfaos.length, `${nome}: órfãos aumentaram além do congelado`).toBeLessThanOrEqual(4);
      return;
    }
    expect(orfaos, `${nome} tem peça sem nenhuma ligação`).toEqual([]);
  });

  it("a marca própria está no mapa, e nenhuma peça dela é ilha", () => {
    // O caso concreto do DoD 13 para o épico de marca própria. O caso genérico
    // acima cobra ≥1 aresta; o invariante 1 do Sistema Vivo cobra ≥2 (uma de
    // entrada e uma de saída), e essa parte nenhum gate cobrava. Sem nomear as
    // peças, "algum mapa existe" continuaria verde com a marca inteira ausente.
    const m = JSON.parse(
      fs.readFileSync(path.join(DIR, "marca-propria.architecture.json"), "utf8"),
    ) as Mapa;
    const grau = (id: string) =>
      (m.edges ?? []).filter((e) => e.from === id || e.to === id).length;
    for (const peca of [
      "platformbranding",
      "orgbranding",
      "resolver",
      "saida",
      "layout",
      "iconroute",
      "marcaemails",
      "pdf",
    ]) {
      expect(
        grau(peca),
        `${peca} com menos de 2 arestas — é ilha pelo invariante 1`,
      ).toBeGreaterThanOrEqual(2);
    }
    // `pdf` está na lista de propósito: ele é a peça DESLIGADA da marca, e a
    // tentação de "desilhá-la" ligando-a a `saida` é exatamente a decisão que o
    // épico recusou. As duas arestas que ele tem são para o CONTROLADOR e para o
    // titular — nenhuma delas vem do resolvedor de marca.
    const doPdf = (m.edges ?? []).filter((e) => e.from === "pdf" || e.to === "pdf");
    expect(
      doPdf.filter((e) => e.from === "saida" || e.to === "saida"),
      "alguém ligou o PDF de LGPD ao resolvedor de marca. Isso nomearia o revendedor " +
        "(que é OPERADOR) como controlador num documento que responde a direito legal do " +
        "titular. A não-ligação é a decisão — está no card vermelho do próprio mapa.\n",
    ).toEqual([]);
  });

  it("clientes pela agenda está no mapa, e nenhuma peça dela é ilha", () => {
    // O caso concreto do DoD 13 para a migration 0262. A regra genérica acima
    // cobra ≥1 aresta, e foi por essa fresta que o nó `auditoria` entrou com UMA
    // só — a de entrada —, sem nenhuma saída: o invariante 1 do Sistema Vivo
    // pede entrada E saída, e a saída é justamente o laço de retorno (quem lê a
    // auditoria é quem desliga a regra). As listas de ≥2 deste arquivo eram
    // fixas em `marca-propria` e no índice de atrito; `crm-vivo` não entrava em
    // nenhuma, então nada media isto.
    const m = JSON.parse(
      fs.readFileSync(path.join(DIR, "crm-vivo.architecture.json"), "utf8"),
    ) as Mapa;
    const grau = (id: string) =>
      (m.edges ?? []).filter((e) => e.from === id || e.to === id).length;
    for (const peca of ["interruptorcliente", "promocaocliente", "auditoria", "telaauditoria"]) {
      expect(grau(peca), `${peca} com menos de 2 arestas — é ilha pelo invariante 1`).toBeGreaterThanOrEqual(2);
    }
    // E a saída existe de fato: `auditoria` PARTE de alguma aresta. Só contar o
    // grau aceitaria duas arestas de entrada, que é o mesmo defeito com outro
    // número.
    expect(
      (m.edges ?? []).filter((e) => e.from === "auditoria").map((e) => e.to),
      "api_audit_log sem nenhuma aresta de SAÍDA: a feature registra e ninguém lê",
    ).toContain("telaauditoria");
  });

  it("o índice de atrito está no mapa, e com mais de duas arestas", () => {
    // O caso concreto do DoD 13 para o trabalho desta branch. Genérico demais
    // não guardaria nada: "algum mapa existe" é verdade desde sempre.
    const m = JSON.parse(
      fs.readFileSync(path.join(DIR, "indice-de-atrito.architecture.json"), "utf8"),
    ) as Mapa;
    const grau = (id: string) =>
      (m.edges ?? []).filter((e) => e.from === id || e.to === id).length;
    for (const peca of ["demandas", "fnatrito", "libradar", "toolradar", "inbox", "rotalead", "crmleads"]) {
      expect(grau(peca), `${peca} com menos de 2 arestas — é ilha pelo invariante 1`).toBeGreaterThanOrEqual(2);
    }
  });

  it("a cobrança do revendedor está no mapa: nenhuma peça é ilha e todo espelho existe", () => {
    // Spec §13: o mapa espelha recursos-opcionais, teto-de-orcamento,
    // organizacoes-e-acesso e central-avisos, e traz o event_log, que não tem
    // mapa próprio. "Espelha" só é verificável se o nó disser QUAL peça do
    // outro mapa ele é: renomear a peça lá reprova aqui.
    type NoComEspelho = { id: string; lane: string; label: string; espelho?: string };
    const ler = (nome: string) =>
      JSON.parse(fs.readFileSync(path.join(DIR, nome), "utf8")) as {
        nodes: NoComEspelho[];
        edges: NonNullable<Mapa["edges"]>;
      };
    const m = ler("cobranca-do-revendedor.architecture.json");
    const grau = (id: string) => m.edges.filter((e) => e.from === id || e.to === id).length;
    for (const n of m.nodes) {
      expect(grau(n.id), `${n.id} com menos de 2 arestas — é ilha pelo invariante 1`).toBeGreaterThanOrEqual(2);
    }
    const espelhos = m.nodes.filter((n) => n.espelho !== undefined).map((n) => ({ id: n.id, alvo: n.espelho ?? "" }));
    for (const { id, alvo } of espelhos) {
      const [arquivo = "", alvoId = ""] = alvo.split("#");
      const outro = ler(arquivo);
      expect(outro.nodes.some((n) => n.id === alvoId), `${id} espelha ${alvo}, que não existe mais`).toBe(true);
    }
    for (const mapa of ["recursos-opcionais", "teto-de-orcamento", "organizacoes-e-acesso", "central-avisos"]) {
      expect(
        espelhos.some((e) => e.alvo.startsWith(`${mapa}.architecture.json#`)),
        `nenhuma peça espelha ${mapa}`,
      ).toBe(true);
    }
    expect(m.nodes.some((n) => n.id === "eventLog"), "o event_log não tem mapa próprio: ele mora aqui").toBe(true);
    const liga = (de: string, para: string) => m.edges.some((e) => e.from === de && e.to === para);
    expect(liga("acaoModulo", "fnLiberar"), "desligar a chave não libera quem foi suspenso por cobrança").toBe(true);
    expect(liga("fnLimite", "tetoPlano"), "o teto de IA do plano não sai da régua única de limites").toBe(true);
    expect(liga("trgCanais", "rotasCanais"), "o limite de números não volta como mensagem para a tela").toBe(true);
  });

  it("a suspensão que suspende está no mapa, e nenhuma peça dela é ilha", () => {
    // O caso concreto do DoD 13 para a PR 1 da cobrança do revendedor. O laço
    // de retorno é `fnReativar → itemCentral → central → fila`: é por ele que
    // uma pessoa revisa o que chegou enquanto a IA estava calada.
    const m = JSON.parse(
      fs.readFileSync(path.join(DIR, "suspensao-de-organizacao.architecture.json"), "utf8"),
    ) as Mapa;
    const grau = (id: string) => (m.edges ?? []).filter((e) => e.from === id || e.to === id).length;
    for (const n of m.nodes!) {
      expect(grau(n.id), `${n.id} com menos de 2 arestas — é ilha pelo invariante 1`).toBeGreaterThanOrEqual(2);
    }
    const liga = (de: string, para: string) => (m.edges ?? []).some((e) => e.from === de && e.to === para);
    expect(liga("fnReativar", "itemCentral"), "a reativação não deixa rastro para uma pessoa revisar").toBe(true);
    expect(liga("central", "fila"), "o aviso de reativação não leva à Fila").toBe(true);
    expect(liga("operante", "motor"), "a régua única não chega ao motor da IA").toBe(true);
  });

  it("o Jev está no mapa da escalação, com o laço de retorno", () => {
    // O caso concreto do DoD 13 para o Jev. O genérico cobra ≥1 aresta; o
    // invariante 7 pede o laço de retorno, e é ele que se nomeia aqui: a
    // concordância medida em observação volta ao cartão onde o admin decide
    // deixar o Jev decidir. Sem essa aresta, o modo observação mediria para
    // ninguém ler.
    const m = JSON.parse(
      fs.readFileSync(path.join(DIR, "escalacao-ciclo-humano.architecture.json"), "utf8"),
    ) as Mapa;
    const arestas = m.edges ?? [];
    const grau = (id: string) => arestas.filter((e) => e.from === id || e.to === id).length;
    for (const peca of [
      "jev",
      "jevCartao",
      "jevRota",
      "jevConfig",
      "jevChave",
      "jevLlmCalls",
      "jevMetadata",
      "jevExecucoes",
      "jevManipulacao",
      "jevObservacoes",
      "jevPedidos",
      "jevFollowup",
    ]) {
      expect(grau(peca), `${peca} com menos de 2 arestas — é ilha pelo invariante 1`).toBeGreaterThanOrEqual(2);
    }
    const liga = (de: string, para: string) => arestas.some((e) => e.from === de && e.to === para);
    expect(liga("jevMetadata", "jevRota"), "a concordância não chega à rota do cartão").toBe(true);
    expect(liga("jevRota", "jevCartao"), "a rota do cartão não devolve nada à tela").toBe(true);
    // O laço da manipulação (onda 2): a observação gravada no turno volta ao cartão.
    expect(liga("jevObservacoes", "jevRota"), "a concordância da manipulação não chega à rota do cartão").toBe(true);
    // O laço das tarefas em cascata (onda 3): os pedidos que o Jev percebe no
    // worker de clima são gravados em jev_observacoes, que volta ao cartão.
    expect(liga("jevPedidos", "jevObservacoes"), "os pedidos percebidos não chegam a jev_observacoes").toBe(true);
    // O laço da resposta ao follow-up (onda 4): o estado da tarefa entra no
    // turno do follow-up, e a observação dele vai a jev_observacoes, que volta ao cartão.
    expect(liga("jevConfig", "jevFollowup"), "o estado da tarefa do follow-up não chega ao turno").toBe(true);
    expect(liga("jevFollowup", "jevObservacoes"), "a resposta ao follow-up não chega a jev_observacoes").toBe(true);
  });

  it("o Jev está no mapa do turno, ao lado do roteador, com o laço de retorno", () => {
    // O roteador mora no mapa do turno (lane `router`), e é lá que o Jev dele
    // entra (onda 2, bloco 2.2): as intenções entram nele, a escolha dele sai
    // para o turno, e a observação volta ao cartão onde se decide deixá-lo decidir.
    const m = JSON.parse(fs.readFileSync(path.join(DIR, "agent-turn.workflow.json"), "utf8")) as Mapa;
    const arestas = m.edges ?? [];
    const grau = (id: string) => arestas.filter((e) => e.from === id || e.to === id).length;
    for (const peca of ["jevRoteador", "jevObservacoesRoteador", "jevCartaoRoteador"]) {
      expect(grau(peca), `${peca} com menos de 2 arestas — é ilha pelo invariante 1`).toBeGreaterThanOrEqual(2);
    }
    const liga = (de: string, para: string) => arestas.some((e) => e.from === de && e.to === para);
    expect(liga("routerconfig", "jevRoteador"), "as intenções do roteador não chegam ao Jev").toBe(true);
    expect(liga("jevObservacoesRoteador", "jevCartaoRoteador"), "a concordância do roteador não volta ao cartão").toBe(true);
    expect(liga("jevCartaoRoteador", "jevRoteador"), "o cartão não muda o estado da tarefa").toBe(true);
  });
});

/**
 * TODO KIND DE TURNO TEM PEÇA NO MAPA DO TURNO.
 *
 * É o gate que impede o mapa de envelhecer de novo — e ele existe porque a
 * alternativa não funciona: as duas frases erradas que este épico consertou
 * ("cadeia de 7 gates" com 10 na cadeia, "1 chamada de modelo" com 2) moravam em
 * `sublabel`, e prosa não tem catraca. Guardar a string seria guardar TEXTO.
 *
 * O que se guarda é ESTRUTURAL: um kind de turno novo — algo que o worker registra
 * como handler e a fila obriga a ter contato — é uma peça nova do runtime da IA, e
 * peça nova entra no mapa com pelo menos duas arestas, por doutrina. Foi
 * exatamente isso que não aconteceu quando `operator_turn` nasceu: o épico dos três
 * papéis criou um segundo turno de modelo e o mapa seguiu descrevendo um.
 *
 * A allowlist existe para o kind que legitimamente não é peça do mapa do turno, e
 * exige razão escrita.
 */
describe("o mapa do turno conhece todos os turnos", () => {
  /** Kinds da fila que NÃO são turno de agente, com o motivo. */
  const NAO_SAO_TURNO: Record<string, string> = {
    watchdog: "vigia sessões e não roda modelo — não é turno de agente",
    flywheel: "ciclo de auto-aprimoramento, tem mapa próprio (flywheel)",
  };

  it("cada kind de turno aparece como peça ou tag do mapa do turno", () => {
    const fila = fs.readFileSync(
      path.join(process.cwd(), "lib/agent-engine/queue/queue.ts"),
      "utf8",
    );
    const m = /export type JobKind =([^;]+);/.exec(fila);
    // Controle positivo: sem o union, a varredura compararia com lista vazia.
    expect(m, "não achei o union JobKind — ENSINE ESTE TESTE").toBeTruthy();
    const kinds = [...(m?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
    expect(kinds.length).toBeGreaterThan(3);

    // Olha os NÓS, não o arquivo inteiro. A primeira versão deste caso fazia
    // `include` no texto do JSON e passava com o nó do Operador APAGADO — porque o
    // nome do kind também aparece na prosa de um card. Um gate que aceita menção em
    // vez de peça mede o proxy: descoberto por sabotagem, com a contagem prevista
    // que não veio.
    const mapa = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "docs/architecture/agent-turn.workflow.json"),
        "utf8",
      ),
    ) as { nodes: Array<{ id: string; tag?: string; sublabel?: string; label?: string }> };

    const nosComoTexto = mapa.nodes
      .map((n) => `${n.id} ${n.tag ?? ""} ${n.label ?? ""} ${n.sublabel ?? ""}`)
      .join(" | ");

    const ausentes = kinds
      .filter((k) => NAO_SAO_TURNO[k] === undefined)
      .filter((k) => !nosComoTexto.includes(k));

    expect(
      ausentes,
      "kind de turno que o mapa do turno não conhece. Peça nova do runtime entra no " +
        "mapa com pelo menos duas arestas (doutrina do sistema vivo) — ou entra em " +
        "NAO_SAO_TURNO com o motivo escrito.\n",
    ).toEqual([]);
  });

  it("toda exceção da allowlist diz por quê", () => {
    for (const [kind, porque] of Object.entries(NAO_SAO_TURNO)) {
      expect(porque.length, `${kind} sem motivo escrito`).toBeGreaterThan(25);
    }
  });
});

/**
 * TODO CHAMADOR DO GATE DE ORÇAMENTO É PEÇA DO MAPA DO TETO.
 *
 * `aplicarOrcamento` deixou de ser privado do seam para que o worker de mídia
 * recusasse com a MESMA régua — e o mapa seguiu mostrando só o turno chegando
 * nele. Quem mede o raio de uma mudança no gate pelo mapa não enxergava a visão
 * de imagem. Mesma lógica do caso dos kinds acima: o que se guarda é estrutural
 * (cada arquivo que chama o gate tem nó com aresta até ele), nunca o texto.
 */
describe("o mapa do teto conhece todos os chamadores do gate", () => {
  const RAIZES = ["lib", "workers", "app"];
  const DEFINICAO = path.join("lib", "agent-engine", "edge", "llm", "run-model-call.ts");

  const varrer = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : varrer(p);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });

  it("cada arquivo que chama aplicarOrcamento tem nó ligado ao gate", () => {
    const chamadores = RAIZES.flatMap((r) => varrer(path.join(process.cwd(), r)))
      .map((p) => path.relative(process.cwd(), p))
      .filter((p) => p !== DEFINICAO)
      .filter((p) => /\baplicarOrcamento\(/.test(fs.readFileSync(p, "utf8")));
    // Controle positivo: sem o worker de mídia, a varredura compararia com lista vazia.
    expect(chamadores, "não achei chamador nenhum — ENSINE ESTE TESTE").toContain(
      path.join("workers", "media-derive-worker.ts"),
    );

    const mapa = JSON.parse(
      fs.readFileSync(path.join(DIR, "teto-de-orcamento.architecture.json"), "utf8"),
    ) as { nodes: Array<{ id: string; label?: string }>; edges: Array<{ from: string; to: string }> };
    const gate = mapa.nodes.find((n) => (n.label ?? "").includes("aplicarOrcamento"));
    expect(gate, "o nó do gate sumiu do mapa do teto").toBeTruthy();

    const ausentes = chamadores.filter((arquivo) => {
      const nome = path.basename(arquivo).replace(/\.tsx?$/, "");
      const nos = mapa.nodes.filter((n) => (n.label ?? "").includes(nome)).map((n) => n.id);
      return !mapa.edges.some((e) => nos.includes(e.from) && e.to === gate!.id);
    });
    expect(
      ausentes,
      "arquivo que chama aplicarOrcamento sem nó (com o nome do arquivo no label) " +
        "e aresta até o gate no mapa do teto.\n",
    ).toEqual([]);
  });
});
