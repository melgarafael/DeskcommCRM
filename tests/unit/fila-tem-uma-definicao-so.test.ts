/**
 * "ESTÁ NA FILA" É UMA DECISÃO DE PRODUTO E TEM UM LUGAR SÓ.
 *
 * ## O que este teste existe para impedir
 *
 * A definição estava copiada em SEIS sítios e eles não concordavam entre si:
 *
 *   supabase/baseline.sql (trg_conversation_routing_requested)   open+pending
 *   lib/routing/queue.ts  getQueuePosition  (o nº que o CLIENTE ouve)  open+pending
 *   lib/routing/queue.ts  getQueuePositions (o nº que a TELA mostra)   open
 *   lib/routing/queue.ts  getQueueStatus    (o painel do gerente)      open
 *   app/api/v1/conversations/counts         (o badge da aba)           open
 *   components/inbox/InboxLayout            (a aba Fila)               open
 *
 * Duas consequências de produto, não de estilo: a conversa que o automático
 * ESCALOU (`pending`) sumia da aba, do badge e do painel — a que mais precisa de
 * uma pessoa era a única invisível; e duas funções VIZINHAS no mesmo arquivo
 * davam números diferentes, então o "você é o 5º da fila" que o cliente recebe
 * pelo WhatsApp não batia com o "3º" que o atendente lia na tela.
 *
 * O gate é textual porque o defeito é textual: um literal `"open"` sozinho num
 * predicado de fila é exatamente como os seis divergiram. Varre o FONTE e cobra a
 * constante — o sétimo sítio nasce ligado ou nasce vermelho.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CONVERSATION_QUEUE_STATUSES } from "@/lib/schemas";

const RAIZ = join(__dirname, "..", "..");

function fonte(caminho: string): string {
  return readFileSync(join(RAIZ, caminho), "utf8");
}

/** Todo sítio que decide, no código de produção, quem está na fila. */
const SITIOS_DA_FILA = [
  "lib/routing/queue.ts",
  "app/api/v1/conversations/counts/route.ts",
  "components/inbox/InboxLayout.tsx",
  "lib/mcp/tools/conversations.ts",
] as const;

describe("a fila tem uma definição só", () => {
  it("a constante é o vocabulário de espera — nem terminal, nem com dono", () => {
    expect([...CONVERSATION_QUEUE_STATUSES]).toEqual(["open", "pending"]);
    // `claimed` tem dono e `ai_handling` é o automático cuidando: nenhum dos dois
    // é alguém esperando uma pessoa.
    for (const fora of ["claimed", "ai_handling", "closed", "archived", "resolved"]) {
      expect(CONVERSATION_QUEUE_STATUSES as readonly string[]).not.toContain(fora);
    }
  });

  it.each(SITIOS_DA_FILA)("%s consome comandosDaFila", (caminho) => {
    // A RÉGUA MUDOU DE PERGUNTA, e a cerca mudou junto.
    //
    // `CONVERSATION_QUEUE_STATUSES` respondia "quem está esperando?" por STATUS,
    // e o status não sabe quem manda: medido na VPS em 2026-08-30, esse predicado
    // punha na fila 47 conversas que o robô estava atendendo. Quem responde agora
    // é `comandosDaFila`, e é ELE que não pode ter uma segunda cópia.
    expect(fonte(caminho)).toContain("comandosDaFila");
  });

  it.each(SITIOS_DA_FILA)("%s não decide a fila por literal solto", (caminho) => {
    const src = fonte(caminho);
    // O padrão exato que produziu a divergência: um predicado de status com
    // `"open"` literal, sem `pending` ao lado. Comentários não contam — é o
    // código que decide.
    const semComentarios = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const suspeitos = [
      /\.eq\(\s*["']status["']\s*,\s*["']open["']\s*\)/,
      /status\s*===\s*["']open["']/,
      /\.in\(\s*["']status["']\s*,\s*\[\s*["']open["']\s*,\s*["']pending["']\s*\]/,
    ];
    for (const re of suspeitos) {
      expect(semComentarios, `${caminho}: predicado de fila fora da constante`).not.toMatch(re);
    }
  });

  it("o trigger de RODÍZIO concorda com a constante — outra pergunta, declarada", () => {
    // ATENÇÃO: a constante deixou de ser a régua da FILA e passou a ser a régua do
    // RODÍZIO, que é outra pergunta. "Entra na distribuição automática?" continua
    // sendo respondida por status; "está esperando uma pessoa?" passou a ser
    // respondida por `comandosDaFila`.
    //
    // A diferença é REAL e fica declarada aqui em vez de herdada: a tela passa a
    // mostrar ~36 e o rodízio segue distribuindo ~83. Mudar o trigger é decisão de
    // produto que ninguém tomou — e o dia em que for tomada, este teste é onde a
    // decisão vai estar escrita.
    const baseline = fonte("supabase/baseline.sql");
    // Ancorado na DEFINIÇÃO (`create trigger ...`), não no nome solto, e na ÚLTIMA
    // delas — CLAUDE.md, item 10. O nome sozinho aparece três vezes no arquivo: no
    // `drop trigger`, no `create trigger` e dentro de um comentário no apêndice; um
    // `lastIndexOf` no nome cru cairia no COMENTÁRIO e mediria o texto errado. Com a
    // âncora na definição, o `lastIndexOf` cai na definição viva.
    const ancora = baseline.lastIndexOf("create trigger trg_conversation_routing_requested");
    expect(ancora, "trg_conversation_routing_requested não tem `create trigger` no baseline").toBeGreaterThan(-1);
    const gatilho = baseline.slice(ancora);
    const when = gatilho.slice(0, gatilho.indexOf("execute function"));

    // EQUIVALÊNCIA, não inclusão. Iterar a constante e pedir `toContain` teria um
    // ponto cego que este arquivo existe para não ter: encolher a constante de
    // volta para `["open"]` satisfaria o teste (o trigger contém 'open'), e a
    // catraca ficaria verde pelo motivo errado — exatamente a divergência que ela
    // vigia. Extrair o conjunto DO TRIGGER e comparar os dois lados reprova nas
    // duas direções.
    const doTrigger = [...when.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(doTrigger).toEqual([...CONVERSATION_QUEUE_STATUSES].sort());
  });
});

describe("quem manda não se decide por `ai_handling`", () => {
  /**
   * `conversations.status = 'ai_handling'` é escrito por UM caminho só em
   * produção — a volta pelo botão "Devolver ao automático" — e por isso NUNCA
   * descreveu quem está no comando: a aba que o filtrava mostrava 2 conversas
   * enquanto o robô atendia 47.
   *
   * Ele continua sendo um status de ciclo de vida legítimo, e ESCREVÊ-LO segue
   * permitido. O que esta cerca proíbe é **decidir** por ele.
   *
   * A allowlist nasce VAZIA, e isso é medido, não esperado: depois da conversão
   * nenhum arquivo de produção casa com os padrões abaixo. Uma allowlist que
   * nasce vazia só encolhe — não há dívida para carimbar.
   */
  const ALLOWLIST: readonly string[] = [];

  const PADROES: Array<[nome: string, re: RegExp]> = [
    ["comparação direta", /status\s*===\s*["']ai_handling["']/],
    ["filtro no banco", /\.eq\(\s*["']status["']\s*,\s*["']ai_handling["']/],
    ["filtro em objeto", /status:\s*["']ai_handling["']/],
  ];

  function arquivosDeProducao(): string[] {
    const out: string[] = [];
    const anda = (dir: string) => {
      for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name !== "node_modules") anda(rel);
        } else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) {
          out.push(rel);
        }
      }
    };
    for (const raiz of ["app", "components", "lib", "hooks", "workers"]) anda(raiz);
    return out;
  }

  it("nenhum arquivo de produção decide o comando por `ai_handling`", () => {
    const culpados: string[] = [];
    for (const caminho of arquivosDeProducao()) {
      if (ALLOWLIST.includes(caminho)) continue;
      // Comentários fora: eles EXPLICAM o defeito, e uma cerca que os lê acusa
      // justamente o texto que documenta o conserto.
      const src = fonte(caminho)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const [nome, re] of PADROES) {
        if (re.test(src)) culpados.push(`${caminho} (${nome})`);
      }
    }
    expect(culpados, "quem manda voltou a ser decidido por status").toEqual([]);
  });

  it("o controle: a cerca ENXERGA o padrão que ela proíbe", () => {
    // Uma varredura que nasce com zero achados pode estar certa ou pode estar
    // cega, e as duas se leem igual. Este caso prova que ela morde.
    const falso = `const x = { status: "ai_handling" };`;
    expect(PADROES.some(([, re]) => re.test(falso))).toBe(true);
    expect(PADROES.some(([, re]) => re.test(`if (c.status === "ai_handling") {}`))).toBe(true);
    expect(arquivosDeProducao().length).toBeGreaterThan(200);
  });
});
