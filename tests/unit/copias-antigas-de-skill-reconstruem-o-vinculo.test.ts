/**
 * CÓPIAS DE SKILL EDITADAS ANTES DO #1960 VOLTAM A APONTAR O CATÁLOGO (#1974).
 *
 * ## O defeito, medido no código
 *
 * O fork-on-install gravou o vínculo desde o nascedouro: a coluna
 * `skill_versions.forked_from_version_id` e o `forkedFromVersionId` de
 * `installPlatformSkill` (`lib/ai/skills/install.ts`) nasceram JUNTOS na 0068
 * (2026-07-24, commit `999b952a2`). Quem quebrava era o editor: o
 * `PUT /api/v1/ai/skills/[name]`, que entrou na main com o #1484 (merge
 * `28e0baf41`, 2026-09-23T03:50:24Z), criava a versão nova sem herdar o vínculo
 * até o #1960 (commit `24b0f3c35`, merge `cd31a305c`, 2026-09-30T00:04:41Z).
 * Entre essas duas datas toda edição de cópia gravava uma versão com o vínculo nulo, o ponteiro passava a
 * apontar para ela, o GET derivava `source: "manual"` e
 * `temVersaoNovaNoCatalogo(nulo, …)` era `false` para sempre — o badge de
 * versão nova nunca acendia, e não havia backfill (medido: nenhuma migration
 * até aqui tocava a coluna).
 *
 * ## O conserto, e o que este arquivo prende
 *
 * A migration `0644` e o apêndice idêntico no `baseline.sql` reconstruem o
 * vínculo a partir do próprio histórico (append-only pela regra dura 9): para
 * cada versão de ORG nula na janela do defeito, carrega o vínculo da versão
 * ANTERIOR mais recente do mesmo (org, name) que aponte versão de plataforma.
 * É a mesma herança que o PUT faz desde o #1960, reconstruída pela ordem de
 * criação das versões.
 *
 * Duas amarras, e cada uma fecha uma porta diferente:
 *
 *   1. migration e apêndice têm de trazer o MESMO bloco, letra a letra — os
 *      dois caminhos de aplicação (cadeia e self-host) curam igual, e o teste
 *      reprova qualquer conserto feito num só;
 *   2. a regra documentada (só nulos, só linhagem com origem de plataforma, só
 *      a janela, anterior MAIS RECENTE) é exercitada nos casos da issue: a
 *      cópia editada antes do #1960 ganha o vínculo e passa a avisar; a cópia
 *      MANUAL continua sem vínculo e sem aviso. Antes do fix o arquivo de
 *      migration nem existe — o vermelho é a ausência dele.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { temVersaoNovaNoCatalogo } from "@/lib/ai/skills/versao-nova-catalogo";

const RAIZ = process.cwd();
const MIGRATION =
  "supabase/migrations/20261011210004_0644_copias_antigas_de_skill_reconstroem_o_vinculo_com_o_catalogo.sql";

/** As duas pontas da janela do defeito, com a razão de cada uma. */
const INICIO_DA_JANELA = "2026-09-23T03:50:24Z"; // merge do #1484: o editor que gravava o nulo nasce aqui
const FIM_DA_JANELA = "2026-09-30T00:04:41Z"; // merge do #1960: depois o PUT herda sozinho

function ler(relativo: string): string {
  return readFileSync(path.join(RAIZ, relativo), "utf8");
}

/** O bloco de backfill: `do $$ … end $$;` único que desliga e religa a trava. */
function blocoDoBackfill(texto: string): { bloco: string; ocorrencias: number } {
  const ocorrencias = texto.match(/v_alteradas integer/g)?.length ?? 0;
  const achou = texto.match(/do \$\$\ndeclare\n  v_alteradas integer;[\s\S]*?end \$\$;/);
  return { bloco: achou?.[0] ?? "", ocorrencias };
}

describe("a 0644 nos dois caminhos de aplicação", () => {
  it("o baseline repete o bloco da migration letra a letra", () => {
    const daMigration = blocoDoBackfill(ler(MIGRATION));
    const doBaseline = blocoDoBackfill(ler("supabase/baseline.sql"));
    expect(daMigration.bloco, "migration sem o bloco de backfill").not.toBe("");
    expect(daMigration.ocorrencias).toBe(1);
    expect(doBaseline.ocorrencias, "apêndice duplicado no baseline").toBe(1);
    expect(doBaseline.bloco).toBe(daMigration.bloco);
  });

  it("traz na letra as três guardas de confiança e a janela medida", () => {
    const { bloco } = blocoDoBackfill(ler(MIGRATION));
    // 1. só nulos: vínculo já gravado jamais é reescrito.
    expect(bloco).toContain("v.forked_from_version_id is null");
    // 2. só linhagem de cópia, e só com origem que É versão de plataforma.
    expect(bloco).toContain("v.organization_id is not null");
    expect(bloco).toContain("and origem.organization_id is null");
    // 3. só a janela medida (as duas pontas, literais).
    expect(bloco).toContain(`v.created_at >= '${INICIO_DA_JANELA}'::timestamptz`);
    expect(bloco).toContain(`v.created_at <  '${FIM_DA_JANELA}'::timestamptz`);
    // A anterior MAIS RECENTE carrega o vínculo (reinstalação muda a origem).
    expect(bloco).toContain("order by anterior.created_at desc, anterior.id desc");
    // A imutabilidade (regra dura 9) só cede dentro do próprio bloco.
    expect(bloco).toContain("disable trigger trg_skill_versions_immutable");
    expect(bloco).toContain("enable trigger trg_skill_versions_immutable");
  });
});

/** Uma linha do histórico de versões — o mesmo vocabulário do backfill. */
interface Versao {
  id: string;
  org: string | null; // null = versão de PLATAFORMA (catálogo)
  nome: string;
  criadaEm: string; // ISO em UTC de largura fixa: comparação lexicográfica = cronológica
  forked: string | null;
}

/**
 * A regra da 0644, reimplementada aqui para os fixtures da issue: uma cópia
 * nula na janela herda o vínculo da versão anterior mais recente do mesmo
 * (org, name) cujo forked aponte versão de plataforma. Devolve o `forked` de
 * cada versão DEPOIS do backfill.
 */
function reconstruir(historico: Versao[]): Map<string, string | null> {
  const plataformas = new Set(historico.filter((v) => v.org === null).map((v) => v.id));
  const depois = new Map(historico.map((v) => [v.id, v.forked]));
  for (const v of historico) {
    if (v.org === null) continue; // só cópia de organização
    if (v.forked !== null) continue; // só nulos
    if (v.criadaEm < INICIO_DA_JANELA || v.criadaEm >= FIM_DA_JANELA) continue; // só a janela
    const anterior = historico
      .filter(
        (w) =>
          w.org === v.org &&
          w.nome === v.nome &&
          w.forked !== null &&
          (w.criadaEm < v.criadaEm || (w.criadaEm === v.criadaEm && w.id < v.id)) &&
          plataformas.has(w.forked!), // a origem aponta versão de PLATAFORMA
      )
      .sort((a, b) => (a.criadaEm === b.criadaEm ? (a.id < b.id ? 1 : -1) : a.criadaEm < b.criadaEm ? 1 : -1))[0];
    if (anterior?.forked) depois.set(v.id, anterior.forked);
  }
  return depois;
}

/** O que o GET /api/v1/ai/skills deriva da versão apontada (route.ts). */
function fonte(forked: string | null | undefined): "catalog" | "manual" {
  return forked ? "catalog" : "manual";
}

// A versão atual do catálogo para o nome: o alvo do aviso.
const VERSAO_ATUAL_DO_CATALOGO = "plat-p2";

describe("cópia editada antes do #1960 — o caso da issue #1974", () => {
  // Org instalou do catálogo (v1 com vínculo, como o install SEMPRE gravou) e
  // editou antes do #1960: v2 nasceu nula e o ponteiro passou a apontar para ela.
  const copia: Versao[] = [
    { id: "v1", org: "org-aaa", nome: "playbook-x", criadaEm: "2026-08-05T10:00:00Z", forked: "plat-p1" },
    { id: "v2", org: "org-aaa", nome: "playbook-x", criadaEm: "2026-09-25T10:00:00Z", forked: null },
  ];
  const plataforma: Versao[] = [
    { id: "plat-p1", org: null, nome: "playbook-x", criadaEm: "2026-08-01T10:00:00Z", forked: null },
    { id: "plat-p2", org: null, nome: "playbook-x", criadaEm: "2026-09-20T10:00:00Z", forked: null },
  ];
  const historico = [...plataforma, ...copia];

  it("sem o backfill a cópia vira 'manual' e nunca avisa (é o defeito medido)", () => {
    const atual = copia.at(-1)!;
    expect(fonte(atual.forked)).toBe("manual");
    expect(temVersaoNovaNoCatalogo(atual.forked, VERSAO_ATUAL_DO_CATALOGO)).toBe(false);
  });

  it("com o backfill ela ganha o vínculo certo e passa a avisar versão nova", () => {
    const depois = reconstruir(historico);
    // A origem é a versão de plataforma da INSTALAÇÃO (plat-p1), não a atual.
    expect(depois.get("v2")).toBe("plat-p1");
    expect(fonte(depois.get("v2"))).toBe("catalog");
    expect(temVersaoNovaNoCatalogo(depois.get("v2"), VERSAO_ATUAL_DO_CATALOGO)).toBe(true);
    // A v1 já tinha vínculo e não é reescrita.
    expect(depois.get("v1")).toBe("plat-p1");
  });
});

describe("cópia MANUAL — nunca veio do catálogo", () => {
  const manual: Versao[] = [
    { id: "m1", org: "org-bbb", nome: "criada-no-zip", criadaEm: "2026-09-24T10:00:00Z", forked: null },
  ];

  it("continua sem vínculo e continua sem aviso", () => {
    const depois = reconstruir(manual);
    expect(depois.get("m1")).toBeNull();
    expect(fonte(depois.get("m1"))).toBe("manual");
    expect(temVersaoNovaNoCatalogo(depois.get("m1"), VERSAO_ATUAL_DO_CATALOGO)).toBe(false);
  });
});

describe("a janela é o que separa edição perdida de importação deliberada", () => {
  it(".zip reimportado ANTES do editor (#1484) fica nulo", () => {
    // Antes de 23/09 o editor não existia: versão de org com vínculo nulo só
    // podia vir do import .zip, que o produto trata como manual.
    const historico: Versao[] = [
      { id: "plat-p1", org: null, nome: "playbook-x", criadaEm: "2026-08-01T10:00:00Z", forked: null },
      { id: "z1", org: "org-eee", nome: "playbook-x", criadaEm: "2026-08-05T10:00:00Z", forked: "plat-p1" },
      { id: "z2", org: "org-eee", nome: "playbook-x", criadaEm: "2026-09-01T10:00:00Z", forked: null },
    ];
    const depois = reconstruir(historico);
    expect(depois.get("z2")).toBeNull();
    expect(fonte(depois.get("z2"))).toBe("manual");
  });

  it(".zip reimportado DEPOIS do #1960 não é ligado ao catálogo", () => {
    // A org instalou do catálogo e, depois do fix do #1960, importou um .zip
    // com o mesmo nome: o produto trata como manual, e o backfill também.
    const historico: Versao[] = [
      { id: "plat-p1", org: null, nome: "playbook-x", criadaEm: "2026-08-01T10:00:00Z", forked: null },
      { id: "x1", org: "org-ccc", nome: "playbook-x", criadaEm: "2026-08-06T10:00:00Z", forked: "plat-p1" },
      { id: "x2", org: "org-ccc", nome: "playbook-x", criadaEm: "2026-10-05T10:00:00Z", forked: null },
    ];
    const depois = reconstruir(historico);
    expect(depois.get("x2")).toBeNull();
    expect(fonte(depois.get("x2"))).toBe("manual");
  });

  it("reinstalação no catálogo muda a origem das edições que vêm depois", () => {
    // A herança carrega a anterior MAIS RECENTE: reinstalar (vínculo já
    // preenchido, plat-p2) e editar em seguida aponta a nova origem, não a
    // primeira instalação.
    const historico: Versao[] = [
      { id: "plat-p1", org: null, nome: "playbook-x", criadaEm: "2026-08-01T10:00:00Z", forked: null },
      { id: "plat-p2", org: null, nome: "playbook-x", criadaEm: "2026-09-20T10:00:00Z", forked: null },
      { id: "d1", org: "org-ddd", nome: "playbook-x", criadaEm: "2026-08-07T10:00:00Z", forked: "plat-p1" },
      { id: "d2", org: "org-ddd", nome: "playbook-x", criadaEm: "2026-09-25T10:00:00Z", forked: "plat-p2" },
      { id: "d3", org: "org-ddd", nome: "playbook-x", criadaEm: "2026-09-28T10:00:00Z", forked: null },
    ];
    const depois = reconstruir(historico);
    expect(depois.get("d2")).toBe("plat-p2");
    expect(depois.get("d3")).toBe("plat-p2");
  });
});
