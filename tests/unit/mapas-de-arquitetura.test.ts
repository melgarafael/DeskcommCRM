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
    for (const peca of ["jev", "jevCartao", "jevRota", "jevConfig", "jevChave", "jevLlmCalls", "jevMetadata", "jevExecucoes"]) {
      expect(grau(peca), `${peca} com menos de 2 arestas — é ilha pelo invariante 1`).toBeGreaterThanOrEqual(2);
    }
    const liga = (de: string, para: string) => arestas.some((e) => e.from === de && e.to === para);
    expect(liga("jevMetadata", "jevRota"), "a concordância não chega à rota do cartão").toBe(true);
    expect(liga("jevRota", "jevCartao"), "a rota do cartão não devolve nada à tela").toBe(true);
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
