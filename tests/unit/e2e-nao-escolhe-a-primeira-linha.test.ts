/**
 * NENHUMA SPEC DE E2E RESOLVE UM ALVO SEM DIZER QUEM ELE É.
 *
 * ═══ O defeito que esta varredura fecha, e por que ele não era visível ═══
 *
 * `tests/e2e/vps-fresh-onboarding.spec.ts` resolvia a organização assim:
 *
 *     .from("organizations").select("...").limit(1).single()
 *
 * Sem `where`. Em seguida o `beforeAll` zerava o `onboarded_at` dela, apagava
 * os `ai_agents` e apagava as `channel_sessions`. Num banco recém-semeado isso
 * funciona por acidente — a única organização existente é a do teste. Num banco
 * com uso, a primeira é outra, e o teste apaga dados de quem não pediu nada.
 * Levantado e medido por @Elevstudio-Dev numa instalação de trabalho (PR #559),
 * onde a organização real perdeu o onboarding.
 *
 * ═══ Por que ninguém consertou antes: a frase errada no comentário ═══
 *
 * `.github/workflows/e2e.yml` dizia que, com duas organizações, "o `.single()`
 * falha" — isto é, que o modo de falha era barulho, não dano. **Não é.** Medido
 * em 2026-09-04 contra PostgREST v14.10 (a mesma versão do Supabase local do
 * projeto), com três linhas em `organizations`:
 *
 *     .select(...).limit(1).single()   →  error: null, e a PRIMEIRA linha
 *     .select(...).single()            →  PGRST116 (aí sim falha)
 *
 * O `.limit(1)` recorta o resultado ANTES da checagem de singularidade do
 * PostgREST. Quem lesse o comentário concluía que a pior consequência era um
 * teste vermelho — e essa é a razão de a classe ter sobrevivido em quatro
 * lugares. O comentário está corrigido no mesmo commit desta varredura.
 *
 * ═══ A regra, estreita de propósito ═══
 *
 * Toda cadeia `.from("<tabela tenant-aware>")` em `tests/e2e/` que **não seja
 * um insert** precisa de PELO MENOS UM filtro (`.eq`, `.in`, `.match`, `.or`,
 * `.filter`, `.is`, comparadores). Não é sobre `.limit(1)`: a instância de
 * `ai_agents` no mesmo arquivo não tinha `.limit(1)` nenhum — era um `select`
 * cru cujo `expect(length).toBe(1)` media o banco inteiro. O que define a classe
 * é a ausência de QUEM, não a forma de recortar.
 *
 * "Tenant-aware" não é lista escrita à mão: sai de `lib/database.types.ts`,
 * pelas tabelas cuja `Row` tem `organization_id`. Tabela nova entra na régua no
 * dia em que é gerada — e catálogo global (`ai_models`, `platform_branding`)
 * fica de fora sozinho, sem ninguém precisar lembrar.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = path.resolve(__dirname, "../..");
const DIR_E2E = path.join(RAIZ, "tests/e2e");

/**
 * Dívida CONGELADA, não perdão em branco.
 *
 * Cada linha é `arquivo:tabela` com o motivo escrito. A lista só encolhe: o
 * caso final deste arquivo reprova quem a aumentar. Hoje ela está vazia — a
 * classe foi fechada nas quatro instâncias antes de a varredura entrar, porque
 * gate que nasce vermelho ensina a gente a ignorar gate.
 */
const DIVIDA_CONGELADA: ReadonlyArray<string> = [];

/**
 * A RAIZ do tenant, que a regra derivada não alcança sozinha.
 *
 * `organizations` não tem coluna `organization_id` — ela É a organização, e a
 * chave de tenant ali é o `id`. Derivar a lista só pela coluna deixava de fora
 * justamente a tabela das duas piores instâncias, e os dois primeiros casos
 * deste arquivo nasceram vermelhos por isto (medido: a varredura devolvia
 * `[ai_agents]` onde deveria devolver `[organizations, ai_agents]`, e o caso da
 * varredura ficava VERDE por cegueira). A exceção é escrita à mão e anda numa
 * direção só: mais cobertura, nunca menos.
 */
const RAIZ_DO_TENANT = "organizations";

/** Tabelas com `organization_id` — a fonte é o tipo gerado, não a memória. */
function tabelasTenantAware(): Set<string> {
  const src = fs.readFileSync(path.join(RAIZ, "lib/database.types.ts"), "utf8");
  const achadas = new Set<string>([RAIZ_DO_TENANT]);
  // `      <tabela>: {\n        Row: {\n ... }` — a indentação do arquivo gerado
  // é estável, e o `Row` é sempre o primeiro bloco da tabela.
  for (const m of src.matchAll(/^ {6}(\w+): \{\n {8}Row: \{\n([\s\S]*?)\n {8}\}/gm)) {
    if (/^ {10}organization_id[?]?:/m.test(m[2]!)) achadas.add(m[1]!);
  }
  return achadas;
}

function arquivosDeE2E(): string[] {
  const saida: string[] = [];
  const andar = (dir: string): void => {
    for (const nome of fs.readdirSync(dir)) {
      const p = path.join(dir, nome);
      if (fs.statSync(p).isDirectory()) andar(p);
      else if (p.endsWith(".ts")) saida.push(p);
    }
  };
  andar(DIR_E2E);
  return saida.sort();
}

// `[^;]` JÁ casa `\n` — a alternância `(?:[^;]|\n)` que estava aqui dava DOIS
// caminhos para o mesmo caractere, e o backtracking do quantificador preguiçoso
// virava exponencial (CodeQL js/redos, alerta #17): com `.from("a")` seguido de N
// quebras de linha, N=28 levava 1,9s e N=30 levava 26,5s. Sem a alternância a
// linguagem casada é a MESMA — conferido match a match (índice + texto) nos 83
// arquivos de tests/e2e, 75 matches idênticos — e N=200000 passa a levar 1ms.
const RE_CADEIA = /\.from\(\s*"([a-z_]+)"\s*\)([^;]*?);/g;
const RE_FILTRO = /\.(eq|in|match|or|filter|neq|gt|gte|lt|lte|like|ilike|contains|is)\(/;

interface Achado {
  arquivo: string;
  linha: number;
  tabela: string;
  acao: string;
}

function cadeiasSemQuem(tenantAware: Set<string>): Achado[] {
  const achados: Achado[] = [];
  for (const arquivo of arquivosDeE2E()) {
    const src = fs.readFileSync(arquivo, "utf8");
    for (const m of src.matchAll(RE_CADEIA)) {
      const tabela = m[1]!;
      const corpo = m[2]!;
      if (!tenantAware.has(tabela)) continue;
      // Insert/upsert declaram o dono no PRÓPRIO corpo — não há alvo a resolver.
      if (corpo.includes(".insert(") || corpo.includes(".upsert(")) continue;
      if (RE_FILTRO.test(corpo)) continue;
      achados.push({
        arquivo: path.relative(RAIZ, arquivo),
        linha: src.slice(0, m.index).split("\n").length,
        acao: corpo.includes(".delete(")
          ? "DELETE"
          : corpo.includes(".update(")
            ? "UPDATE"
            : "SELECT",
        tabela,
      });
    }
  }
  return achados;
}

describe("a suíte de e2e não escolhe 'a primeira'", () => {
  it("o INSTRUMENTO enxerga: `organizations` é tenant-aware e `ai_models` não é", () => {
    // Sem este controle, um regex que deixasse de casar devolveria conjunto
    // vazio — e conjunto vazio lê exatamente como "nenhuma tabela violou".
    const t = tabelasTenantAware();
    expect(t.size, "nenhuma tabela tenant-aware encontrada: o parser quebrou").toBeGreaterThan(30);
    expect(t.has("organizations")).toBe(true);
    expect(t.has("ai_agents")).toBe(true);
    expect(t.has("contacts")).toBe(true);
    expect(t.has("ai_models"), "catálogo global não pode entrar na régua").toBe(false);
  });

  it("o INSTRUMENTO enxerga a cadeia: uma spec sem filtro seria acusada", () => {
    // Controle positivo em memória, com a forma EXATA das duas instâncias reais
    // — a que usava `.limit(1).single()` e a que não usava recorte nenhum.
    const falsa = `
      const a = await svc.from("organizations").select("id").limit(1).single();
      const b = await svc.from("ai_agents").select("id, name");
      const c = await svc.from("contacts").select("id").eq("organization_id", org);
      const d = await svc.from("contacts").insert({ organization_id: org });
    `;
    const tenant = tabelasTenantAware();
    const pegos: string[] = [];
    for (const m of falsa.matchAll(RE_CADEIA)) {
      const [tabela, corpo] = [m[1]!, m[2]!];
      if (!tenant.has(tabela)) continue;
      if (corpo.includes(".insert(") || corpo.includes(".upsert(")) continue;
      if (RE_FILTRO.test(corpo)) continue;
      pegos.push(tabela);
    }
    expect(pegos).toEqual(["organizations", "ai_agents"]);
  });

  it("nenhuma cadeia de e2e toca tabela tenant-aware sem dizer QUEM", () => {
    const achados = cadeiasSemQuem(tabelasTenantAware());
    const vivos = achados.filter((a) => !DIVIDA_CONGELADA.includes(`${a.arquivo}:${a.tabela}`));
    const relato = vivos.map((a) => `  ${a.acao} ${a.arquivo}:${a.linha} → ${a.tabela}`).join("\n");
    expect(
      vivos,
      "cadeia que resolve alvo tenant-aware sem filtro. `.limit(1).single()` NÃO falha " +
        "com duas linhas (medido: PostgREST v14.10 devolve error:null e a primeira) — " +
        "então o efeito é ler ou APAGAR a linha de outra organização em silêncio.\n" +
        relato,
    ).toHaveLength(0);
  });

  it("a dívida congelada só encolhe", () => {
    // Sem este caso, a saída fácil de um vermelho é acrescentar uma linha na
    // allowlist — que é exatamente como uma classe fechada volta a abrir.
    expect(DIVIDA_CONGELADA.length).toBeLessThanOrEqual(0);
  });
});
