/**
 * "PIPELINE" E "KANBAN" NÃO VOLTAM PARA A INTERFACE.
 *
 * ═══ O QUE ISTO GUARDA ═══
 *
 * O produto tinha CINCO vocabulários para a mesma coisa, e três deles chegavam
 * ao usuário no MESMO viewport: o `<h1>` de /app/kanban dizia "Pipelines", o
 * estado vazio logo abaixo dizia "Sem pipelines configurados", e o botão abaixo
 * dele dizia "Criar meu primeiro funil". No menu, "Kanban" e "Funis" eram dois
 * itens vizinhos que listavam as MESMAS linhas de `crm_pipelines`.
 *
 * "Pipeline" é palavra de quem construiu o sistema. "Funil de vendas" é palavra
 * de quem vende — e é o público deste produto.
 *
 * ⚠️ O QUE ESTE TESTE NÃO PROÍBE: `pipeline` como identificador. A rota é
 * `/app/pipelines/[id]`, a tabela é `crm_pipelines`, o campo é `pipeline_ids` e
 * o ícone importado se chama `Kanban`. Nada disso é lido por quem usa o produto;
 * renomeá-los seria custo sem ganho, e um teste que os proibisse viraria ruído
 * que se aprende a silenciar.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NAV_DESTINATIONS } from "@/lib/navigation/registry";

/**
 * `app/design` é o catálogo interno de componentes — uma tela de quem CONSTRÓI o
 * produto, não de quem o usa. Lá "Kanban · pipeline de pedidos" é o nome correto
 * do padrão que está sendo demonstrado.
 */
const FORA = ["design"];

function telas(raiz: string): string[] {
  const saida: string[] = [];
  const andar = (dir: string) => {
    for (const nome of readdirSync(dir)) {
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) {
        if (nome === "node_modules" || nome === ".next" || FORA.includes(nome)) continue;
        andar(caminho);
      } else if (/\.tsx$/.test(nome) && !/\.test\.tsx$/.test(nome)) {
        saida.push(caminho);
      }
    }
  };
  andar(raiz);
  return saida;
}

const ARQUIVOS = [...telas("app"), ...telas("components")];

/** Palavras do sistema que não podem virar texto de tela. */
const PROIBIDAS = /\b(pipelines?|kanban)\b/i;

/**
 * Texto que o usuário LÊ, extraído sem parser: conteúdo entre `>` e `<` de JSX,
 * e valores de props que são texto por contrato.
 */
function textosVisiveis(src: string): string[] {
  const achados: string[] = [];

  // O `\n` NÃO pode estar na primeira classe. Ele estava, e o efeito medido em
  // 2026-08-22 foi cegueira total ao caso mais comum de JSX: texto na própria
  // linha, entre a tag de abertura e a de fechamento.
  //
  //     <Card className="…">
  //       Nenhum lead nesta pipeline ainda.
  //     </Card>
  //
  // Depois do `>` vem `\n`, a classe o proibia como primeiro caractere, e o
  // trecho inteiro ficava invisível. Num checkout Windows o primeiro caractere é
  // `\r` — permitido —, então o mesmo teste acusava no Linux ZERO e no Windows
  // QUATRO infrações reais. Não era o Windows exagerando: era o CI que não
  // enxergava. Com a classe aberta, os dois medem 4, que é o número certo.
  //
  // O `{`/`}` seguem fora da classe e são o que segura o falso positivo: qualquer
  // expressão JSX interrompe o casamento em vez de virar "texto de tela".
  for (const m of src.matchAll(/>([^<>{}]+)</g)) {
    const t = (m[1] ?? "").trim();
    // Comentário não é texto de tela. Sem este filtro, um `/** … do pipeline */`
    // logo depois de um `>` (de um genérico ou de um JSX acima) entra como se
    // fosse copy — e um teste que acusa o que não é defeito se aprende a ignorar.
    if (/^[/*]|\*\//.test(t)) continue;
    if (t.length > 2) achados.push(t);
  }

  const props =
    /\b(headline|subcopy|placeholder|title|label|aria-label|description|alt)\s*=\s*"([^"]+)"/g;
  for (const m of src.matchAll(props)) achados.push(m[2] ?? "");

  return achados;
}

describe("o vocabulário do funil na interface", () => {
  it("nenhuma tela mostra 'pipeline' ou 'kanban' ao usuário", () => {
    const infratores: string[] = [];
    for (const f of ARQUIVOS) {
      // Normaliza o fim de linha para que a varredura meça o MESMO em qualquer
      // checkout — foi a divergência CRLF × LF que expôs o buraco acima.
      const src = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
      for (const t of textosVisiveis(src)) {
        // Caminho sempre com `/`: a mensagem é para ser colada num editor, e no
        // Windows `join` devolve `components\kanban\…`, que nenhum grep aceita.
        if (PROIBIDAS.test(t)) infratores.push(`${f.replace(/\\/g, "/")} → ${t.slice(0, 80)}`);
      }
    }
    expect(
      infratores,
      "palavra do sistema em texto de tela — use 'funil', 'etapa' ou 'quadro'",
    ).toEqual([]);
  });

  it("nenhum item de menu se chama 'Kanban' ou 'Pipelines'", () => {
    const ruins = NAV_DESTINATIONS.filter((d) => PROIBIDAS.test(d.label));
    expect(ruins.map((d) => d.label)).toEqual([]);
  });

  it("nenhuma descrição do registro usa palavra do sistema", () => {
    // As descrições alimentam o menu, a busca ⌘K, o hub E o tour do fim do
    // onboarding — quatro superfícies de uma vez.
    const ruins = NAV_DESTINATIONS.filter((d) => PROIBIDAS.test(d.description));
    expect(ruins.map((d) => `${d.label}: ${d.description}`)).toEqual([]);
  });

  it("os dois destinos de funil têm nomes DIFERENTES", () => {
    // Eles listavam as mesmas linhas de `crm_pipelines`, lado a lado no grupo
    // CRM, e um deles se chamava "Kanban" — que não é o que a tela mostra.
    const lista = NAV_DESTINATIONS.find((d) => d.href === "/app/kanban");
    const etapas = NAV_DESTINATIONS.find((d) => d.href === "/app/settings/tenant/pipelines");
    expect(lista?.label).toBeTruthy();
    expect(etapas?.label).toBeTruthy();
    expect(lista?.label).not.toBe(etapas?.label);
  });

  it("dois itens do mesmo grupo nunca compartilham rótulo", () => {
    // A colisão que motivou a regra: com os dois chamados "Funis", o menu tinha
    // dois links indistinguíveis e `getByRole("link", { name: "Funis" })`
    // passava a falhar por AMBIGUIDADE — um modo de falha que não parece
    // vocabulário, e sim teste quebrado.
    const porGrupo = new Map<string, string[]>();
    for (const d of NAV_DESTINATIONS.filter((x) => x.sidebar)) {
      porGrupo.set(d.group, [...(porGrupo.get(d.group) ?? []), d.label]);
    }
    for (const [grupo, labels] of porGrupo) {
      const dups = labels.filter((l, i) => labels.indexOf(l) !== i);
      expect(dups, `rótulo repetido no grupo ${grupo}`).toEqual([]);
    }
  });
});
