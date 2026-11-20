/**
 * AS ABAS DE CADA PESSOA (#3313, item 2) — as regras puras da faixa.
 *
 * O que este arquivo trava:
 *
 *   - a lista de ids daqui é a MESMA de `INBOX_TABS`, na mesma ordem (lida da
 *     fonte, como faz `inbox-ordem-das-abas-2498.test.tsx`): uma aba nova que só
 *     entrasse lá não poderia ser gravada;
 *   - a leitura tolerante do metadata (lixo, id velho, repetido, ausente);
 *   - a faixa nunca fica vazia;
 *   - preferência não é permissão: aba que o papel tirou não volta.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ABAS_DA_INBOX,
  CHAVE_DAS_ABAS,
  abasDaInboxSchema,
  abasPadrao,
  faixaDaPessoa,
  juntarComAsForaDoPapel,
  lerAbasDaInbox,
  moverAba,
  normalizarAbas,
  type AbaDaPessoa,
} from "./abas-da-inbox";

const TODAS = [...ABAS_DA_INBOX];
const ids = (abas: readonly AbaDaPessoa[]) => abas.map((a) => a.id);

describe("a lista de ids é a da faixa", () => {
  it("os mesmos ids de INBOX_TABS, na mesma ordem", () => {
    const fonte = readFileSync("components/inbox/InboxFilters.tsx", "utf8");
    const daFaixa = [...fonte.matchAll(/\{\s*value:\s*"(\w+)",\s*label:\s*"[^"]+"\s*\}/g)].map(
      ([, value]) => value,
    );
    expect(daFaixa.length).toBeGreaterThan(0);
    expect([...ABAS_DA_INBOX]).toEqual(daFaixa);
  });
});

describe("o padrão é a faixa de hoje", () => {
  it("todas visíveis, na ordem de ABAS_DA_INBOX", () => {
    expect(abasPadrao()).toEqual(TODAS.map((id) => ({ id, visivel: true })));
  });

  it("devolve cópias: mexer numa não muda o padrão", () => {
    const a = abasPadrao();
    a[0]!.visivel = false;
    expect(abasPadrao()[0]!.visivel).toBe(true);
  });
});

describe("normalizarAbas — o metadata é dado alheio", () => {
  it.each([
    ["não é lista", "Fila primeiro"],
    ["nulo", null],
    ["lista vazia", []],
    ["só lixo", [1, "ai", null, { visivel: false }]],
  ])("%s → o padrão", (_caso, entrada) => {
    expect(normalizarAbas(entrada)).toEqual(abasPadrao());
  });

  it("id que não existe mais é descartado", () => {
    const r = normalizarAbas([{ id: "aba-velha", visivel: false }, { id: "mine", visivel: true }]);
    expect(ids(r)).not.toContain("aba-velha");
    expect(r[0]).toEqual({ id: "mine", visivel: true });
  });

  it("id repetido: a primeira ocorrência manda", () => {
    const r = normalizarAbas([
      { id: "closed", visivel: false },
      { id: "closed", visivel: true },
    ]);
    expect(r.filter((a) => a.id === "closed")).toEqual([{ id: "closed", visivel: false }]);
  });

  it("as que não vieram entram no fim, visíveis, na ordem padrão", () => {
    const r = normalizarAbas([{ id: "mine", visivel: true }, { id: "ai", visivel: false }]);
    expect(ids(r)).toEqual(["mine", "ai", "unassigned", "all", "closed", "archived", "pessoal"]);
    expect(r.slice(2).every((a) => a.visivel)).toBe(true);
  });

  it.each([["false" as unknown], [0 as unknown], [null as unknown], [undefined as unknown]])(
    "só `false` oculta (%s deixa visível)",
    (valor) => {
      expect(normalizarAbas([{ id: "closed", visivel: valor }])[0]).toEqual({ id: "closed", visivel: true });
    },
  );

  it("nenhuma visível → todas voltam à faixa, na ordem escolhida", () => {
    const escolhida = [...TODAS].reverse().map((id) => ({ id, visivel: false }));
    const r = normalizarAbas(escolhida);
    expect(ids(r)).toEqual([...TODAS].reverse());
    expect(r.every((a) => a.visivel)).toBe(true);
  });
});

describe("lerAbasDaInbox", () => {
  it("lê a chave do metadata", () => {
    const r = lerAbasDaInbox({ [CHAVE_DAS_ABAS]: [{ id: "archived", visivel: false }], locale: "es" });
    expect(r[0]).toEqual({ id: "archived", visivel: false });
    expect(r).toHaveLength(TODAS.length);
  });

  it.each([[undefined], [null], ["texto"], [{}]])("metadata %s → o padrão", (metadata) => {
    expect(lerAbasDaInbox(metadata)).toEqual(abasPadrao());
  });
});

describe("faixaDaPessoa — o que a barra desenha", () => {
  it("sem preferência: a faixa é a das permitidas, sem menu de ocultas", () => {
    expect(faixaDaPessoa(TODAS, abasPadrao())).toEqual({ faixa: TODAS, ocultas: [] });
  });

  it("a ordem é a da pessoa, e as ocultas vão para o menu na mesma ordem", () => {
    const pref = normalizarAbas([
      { id: "unassigned", visivel: true },
      { id: "mine", visivel: true },
      { id: "ai", visivel: true },
      { id: "archived", visivel: false },
      { id: "all", visivel: false },
    ]);
    expect(faixaDaPessoa(TODAS, pref)).toEqual({
      faixa: ["unassigned", "mine", "ai", "closed", "pessoal"],
      ocultas: ["archived", "all"],
    });
  });

  it("preferência não é permissão: aba que o papel tirou não aparece em lugar nenhum", () => {
    const semTodasNemPessoal = TODAS.filter((id) => id !== "all" && id !== "pessoal");
    const pref = normalizarAbas([
      { id: "all", visivel: true },
      { id: "pessoal", visivel: false },
    ]);
    const r = faixaDaPessoa(semTodasNemPessoal, pref);
    expect(r.faixa).not.toContain("all");
    expect(r.ocultas).not.toContain("pessoal");
    expect([...r.faixa, ...r.ocultas].sort()).toEqual([...semTodasNemPessoal].sort());
  });

  it("se só sobrou visível uma aba que o papel não alcança, a faixa volta inteira", () => {
    // Era gerente, deixou só "Todas" à vista, e virou atendente sem "Todas".
    const pref = TODAS.map((id) => ({ id, visivel: id === "all" }));
    const semTodas = TODAS.filter((id) => id !== "all");
    expect(faixaDaPessoa(semTodas, pref)).toEqual({ faixa: semTodas, ocultas: [] });
  });
});

describe("juntarComAsForaDoPapel — gravar o diálogo não apaga o que o papel esconde", () => {
  it("as abas fora do papel voltam no fim, com a visibilidade de antes", () => {
    const gravadas = normalizarAbas([{ id: "all", visivel: false }]);
    const editadas: AbaDaPessoa[] = [
      { id: "mine", visivel: true },
      { id: "unassigned", visivel: true },
      { id: "ai", visivel: false },
      { id: "closed", visivel: true },
      { id: "archived", visivel: true },
    ];
    const r = juntarComAsForaDoPapel(editadas, gravadas);
    expect(ids(r)).toEqual(["mine", "unassigned", "ai", "closed", "archived", "all", "pessoal"]);
    expect(r.find((a) => a.id === "all")).toEqual({ id: "all", visivel: false });
  });
});

describe("moverAba", () => {
  it("move sem perder nem duplicar", () => {
    const r = moverAba(abasPadrao(), 2, 0);
    expect(ids(r)).toEqual(["mine", "ai", "unassigned", "all", "closed", "archived", "pessoal"]);
  });

  it.each([
    [0, 0],
    [-1, 0],
    [0, 99],
  ])("de %i para %i devolve a MESMA lista", (de, para) => {
    const lista = abasPadrao();
    expect(moverAba(lista, de, para)).toBe(lista);
  });
});

describe("abasDaInboxSchema — o que a action aceita", () => {
  it("aceita a lista padrão", () => {
    expect(abasDaInboxSchema.safeParse(abasPadrao()).success).toBe(true);
  });

  it.each([
    ["vazia", []],
    ["id desconhecido", [{ id: "inventada", visivel: true }]],
    ["sem visibilidade", [{ id: "ai" }]],
    ["grande demais", Array.from({ length: TODAS.length * 2 + 1 }, () => ({ id: "ai", visivel: true }))],
  ])("recusa lista %s", (_caso, entrada) => {
    expect(abasDaInboxSchema.safeParse(entrada).success).toBe(false);
  });
});
