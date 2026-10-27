/**
 * A RECONSTRUÇÃO DO VÍNCULO COM O CATÁLOGO ANCORADA NA AUDITORIA (#1976).
 *
 * ## O que a 0644 não resolvia, medido
 *
 * A 0644 decide pela ORDEM das versões dentro da janela `[#1484, #1960)`. Medido
 * num Postgres com o baseline do repo (42 cópias sintéticas criadas pelo DAO
 * real, `tests/invariants/reconstrucao-do-vinculo-ancorada-na-auditoria.test.ts`):
 * ela cura a edição simples do editor (6/6), **inventa origem** em 12 cópias que
 * eram manuais (o `.zip` reimportado por cima de uma cópia do catálogo, dentro e
 * antes da janela) e **não alcança** 6 cópias editadas na janela e editadas de
 * novo depois do #1960 — a segunda edição herdou o nulo e caiu fora da janela,
 * que é o que o ponteiro da cópia lê.
 *
 * ## O que este arquivo prende
 *
 * A 0808 troca "dentro da janela" por "quem criou a versão": `api_audit_log`
 * grava, para cada versão, uma linha com `resource_type = 'skill_versions'` e
 * `resource_id` = id da versão, e o caminho que a criou é o que decide.
 *
 *   1. a migration e o apêndice do `baseline.sql` trazem o MESMO bloco, letra a
 *      letra — o self-host aplica o baseline, a cadeia aplica a migration, e um
 *      conserto feito num só dos dois ficaria meio entregue;
 *   2. a regra exercitada nos casos da issue: a edição que atravessa o #1960 é
 *      curada, o `.zip` por cima do catálogo é solto, a cópia manual fica nula,
 *      e a versão sem auditoria — a que não dá para distinguir — também fica
 *      nula. Ambíguo não vira vínculo inventado.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const MIGRATION =
  "supabase/migrations/20261027150000_0808_vinculo_com_o_catalogo_ancorado_na_auditoria.sql";

function ler(relativo: string): string {
  return readFileSync(path.join(RAIZ, relativo), "utf8");
}

/** O bloco da 0808: `do $$ … end $$;` único que desliga e religa a trava. */
function blocoDoBackfill(texto: string): { bloco: string; ocorrencias: number } {
  const ocorrencias = texto.match(/v_soltas integer/g)?.length ?? 0;
  const achou = texto.match(/do \$\$\ndeclare\n  v_soltas integer;[\s\S]*?end \$\$;/);
  return { bloco: achou?.[0] ?? "", ocorrencias };
}

describe("a 0808 nos dois caminhos de aplicação", () => {
  it("o baseline repete o bloco da migration letra a letra", () => {
    const daMigration = blocoDoBackfill(ler(MIGRATION));
    const doBaseline = blocoDoBackfill(ler("supabase/baseline.sql"));
    expect(daMigration.bloco, "migration sem o bloco de backfill").not.toBe("");
    expect(daMigration.ocorrencias).toBe(1);
    expect(doBaseline.ocorrencias, "apêndice duplicado no baseline").toBe(1);
    expect(doBaseline.bloco).toBe(daMigration.bloco);
  });

  it("traz na letra as guardas de confiança, e a trava em volta das duas passadas", () => {
    const { bloco } = blocoDoBackfill(ler(MIGRATION));
    // só cópia de organização, nunca o catálogo
    expect(bloco).toContain("copia.organization_id is not null");
    expect(bloco).toContain("v.organization_id is not null");
    // a origem tem de ser versão de plataforma
    expect(bloco).toContain("origem_plataforma.organization_id is null");
    // evidência positiva dos três gravadores, e só eles
    expect(bloco).toContain("'ai.skill_imported'");
    expect(bloco).toContain("'ai.skill_installed'");
    expect(bloco).toContain("salva.action = 'ai.skill_saved'");
    // elo sem prova bloqueia a cura
    expect(bloco).toContain("salva_elo.action = 'ai.skill_saved'");
    // solta o vínculo inventado e cura o nulo, sem tocar em conteúdo
    expect(bloco).toContain("set forked_from_version_id = null");
    expect(bloco).toContain("set forked_from_version_id = provadas.origem");
    expect(bloco).not.toMatch(/set\s+(description|body|matcher|manifest)/);
    // a trava é desligada e religada no MESMO bloco
    expect(bloco).toContain("disable trigger trg_skill_versions_immutable");
    expect(bloco).toContain("enable trigger trg_skill_versions_immutable");
    // migration não-executada não é gate: o harness só roda o baseline
    expect(ler(MIGRATION).startsWith("-- manifest: ")).toBe(true);
  });
});

/**
 * A mesma regra em TypeScript, sobre um histórico em memória — para exercitar o
 * veredito de cada caso da issue sem depender do Postgres (o invariante faz a
 * mesma coisa contra o SQL de verdade).
 */
type Criador = "install" | "import" | "saved" | null;

interface Versao {
  id: string;
  nome: string;
  criada: number;
  vinculo: string | null;
  criador: Criador;
}

/** Passada 1: solta o vínculo cujo evento de origem mais recente é um import. */
function soltar(vs: Versao[]): Versao[] {
  return vs.map((v) => {
    const linhagem = vs.filter((x) => x.nome === v.nome && x.criada <= v.criada);
    const ultimo = linhagem
      .filter((x) => x.criador === "install" || x.criador === "import")
      .sort((a, b) => b.criada - a.criada)[0];
    if (v.vinculo && ultimo?.criador === "import") return { ...v, vinculo: null };
    return v;
  });
}

/** Passada 2: herda da âncora quando toda a cadeia até ela nasceu no editor. */
function curar(vs: Versao[]): Versao[] {
  return vs.map((v) => {
    if (v.vinculo || v.criador !== "saved") return v;
    const anteriores = vs
      .filter((x) => x.nome === v.nome && x.criada < v.criada)
      .sort((a, b) => b.criada - a.criada);
    const ancora = anteriores.find((x) => x.vinculo !== null);
    if (!ancora) return v;
    const cadeia = anteriores.filter((x) => x.criada > ancora.criada);
    if (cadeia.some((x) => x.criador !== "saved")) return v; // .zip (ou ausência de prova) no meio
    return { ...v, vinculo: ancora.vinculo };
  });
}

function aplicar(vs: Versao[]): Versao[] {
  return curar(soltar(vs));
}

const CATALOGO = "plat-1";
const NOMES = { instalar: 1, janela: 2, depois: 3, zip: 4, edicao: 5 };

function historico(casos: { nome: string; versoes: Omit<Versao, "nome">[] }[]): Versao[] {
  return casos.flatMap((c) => c.versoes.map((v) => ({ ...v, nome: c.nome })));
}

const ACERVO = historico([
  {
    // controle: instalada do catálogo, nunca editada
    nome: "instalada",
    versoes: [{ id: "a", criada: NOMES.instalar, vinculo: CATALOGO, criador: "install" }],
  },
  {
    // o defeito: editada na janela do #1960 (a 0644 já curou) e editada de novo
    // depois, herdando o nulo — o ponteiro aponta para a última
    nome: "atravessa",
    versoes: [
      { id: "b1", criada: 1, vinculo: CATALOGO, criador: "install" },
      { id: "b2", criada: 2, vinculo: CATALOGO, criador: "saved" },
      { id: "b3", criada: 5, vinculo: null, criador: "saved" },
    ],
  },
  {
    // o vínculo inventado: .zip por cima da cópia do catálogo, e a 0644 pôs o vínculo
    nome: "zip-por-cima",
    versoes: [
      { id: "c1", criada: 1, vinculo: CATALOGO, criador: "install" },
      { id: "c2", criada: 2, vinculo: CATALOGO, criador: "import" },
    ],
  },
  {
    // manual de verdade: nulo, sem âncora
    nome: "manual",
    versoes: [{ id: "d1", criada: 2, vinculo: null, criador: "import" }],
  },
  {
    // sem prova de autoria: fica nula, e é reportada
    nome: "sem-prova",
    versoes: [
      { id: "e1", criada: 1, vinculo: CATALOGO, criador: "install" },
      { id: "e2", criada: 6, vinculo: null, criador: null },
    ],
  },
  {
    // cadeia com .zip no meio: a edição posterior não herda
    nome: "elo-importado",
    versoes: [
      { id: "f1", criada: 1, vinculo: CATALOGO, criador: "install" },
      { id: "f2", criada: 3, vinculo: null, criador: "import" },
      { id: "f3", criada: 7, vinculo: null, criador: "saved" },
    ],
  },
]);

const depois = aplicar(ACERVO);
const porId = new Map(depois.map((v) => [v.id, v]));

describe("a regra da 0808 sobre o acervo sintético", () => {
  it("cura a cópia editada dos dois lados do #1960", () => {
    expect(porId.get("b3")?.vinculo).toBe(CATALOGO);
    expect(porId.get("b2")?.vinculo).toBe(CATALOGO);
  });

  it("solta o vínculo de quem recebeu .zip por cima do catálogo", () => {
    expect(porId.get("c2")?.vinculo).toBeNull();
  });

  it("mantém nula a cópia manual, e a que não tem prova de autoria", () => {
    expect(porId.get("d1")?.vinculo).toBeNull();
    expect(porId.get("e2")?.vinculo).toBeNull();
  });

  it("não cura quando há um .zip no meio da cadeia", () => {
    expect(porId.get("f3")?.vinculo).toBeNull();
  });

  it("não toca no vínculo legítimo da instalação", () => {
    expect(porId.get("a")?.vinculo).toBe(CATALOGO);
    expect(porId.get("b1")?.vinculo).toBe(CATALOGO);
    expect(porId.get("c1")?.vinculo).toBe(CATALOGO);
  });

  it("é idempotente: reaplicar não muda nada", () => {
    expect(aplicar(depois).map((v) => `${v.id}:${v.vinculo ?? "-"}`)).toEqual(
      depois.map((v) => `${v.id}:${v.vinculo ?? "-"}`),
    );
  });
});
