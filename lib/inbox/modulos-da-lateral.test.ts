/**
 * A LATERAL DO INBOX DE CADA PESSOA (#3008) — a régua pura.
 *
 * Este arquivo mede o que a feature promete sem passar por tela nem por banco:
 *
 *   1. o PADRÃO é a lista e a ordem de hoje — quem nunca abriu o diálogo não
 *      pode ver a lateral mudar por causa desta issue (o controle que a issue
 *      chama de "organização original");
 *   2. a ordem gravada é respeitada, e reordenar NÃO perde módulo nem duplica;
 *   3. valor torto no metadata degrada para o padrão em vez de esconder seções
 *      em silêncio — o metadata é dado alheio, e é dele que sai o que a pessoa
 *      vê da conversa.
 *
 * O diálogo e a lateral são medidos em `CRMSidePanel.modulos.test.tsx`; a
 * gravação por pessoa, em `app/actions/inbox/modulosDaLateral.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";
import {
  CHAVE_DOS_MODULOS,
  MODULOS_DA_LATERAL,
  ROTULO_DO_MODULO,
  lerModulosDaLateral,
  modulosPadrao,
  moverModulo,
  normalizarModulos,
  type ModuloDaLateral,
} from "./modulos-da-lateral";

/**
 * A LATERAL DE HOJE, escrita À MÃO de propósito.
 *
 * Se este array mudar, a tela de quem nunca configurou nada muda — e é
 * exatamente isso que o teste existe para impedir que aconteça por acidente.
 * Comparar com `MODULOS_DA_LATERAL` (a própria fonte) provaria só que a
 * constante é igual a si mesma.
 */
const LATERAL_DE_HOJE = [
  "contato",
  "tags-do-contato",
  "carteira",
  "anuncio",
  "perfil-enriquecido",
  "tags-da-conversa",
  "demandas",
  "tarefas",
  "followup",
  "memoria",
  "roteiros",
  "leads",
  "compras",
  "pedidos",
  "atividade",
  "acervo",
];

const ids = (modulos: readonly ModuloDaLateral[]) => modulos.map((m) => m.id);

describe("#3008 — o padrão é a lateral de hoje", () => {
  it("o catálogo está na ordem em que a lateral desenha, e todos nascem visíveis", () => {
    const padrao = modulosPadrao();

    expect(ids(padrao)).toEqual(LATERAL_DE_HOJE);
    expect(padrao.every((m) => m.visivel)).toBe(true);
  });

  it("quem nunca gravou (metadata ausente) vê exatamente a lateral de hoje", () => {
    expect(ids(lerModulosDaLateral(undefined))).toEqual(LATERAL_DE_HOJE);
    expect(ids(lerModulosDaLateral({}))).toEqual(LATERAL_DE_HOJE);
    // O caso REAL: a pessoa tem metadata (nome, idioma) e nenhuma escolha disto.
    expect(ids(lerModulosDaLateral({ full_name: "Maria", locale: "es" }))).toEqual(LATERAL_DE_HOJE);
  });

  it("`modulosPadrao` devolve cópias: mexer numa lista não muda o padrão do próximo", () => {
    const primeira = modulosPadrao();
    primeira[0]!.visivel = false;
    primeira.reverse();

    expect(ids(modulosPadrao())).toEqual(LATERAL_DE_HOJE);
    expect(modulosPadrao().every((m) => m.visivel)).toBe(true);
  });

  it("cobre os módulos que a issue nomeia", () => {
    // A lista da issue, traduzida para os ids do catálogo. Um bloco novo que
    // não caiba aqui é escolha de produto; um bloco da issue que falte é
    // entrega incompleta.
    const daIssue = [
      "contato",
      "tags-do-contato",
      "tags-da-conversa",
      "demandas",
      "tarefas",
      "memoria",
      "leads",
      "pedidos",
      "atividade",
      "acervo",
    ];
    expect(daIssue.every((id) => (MODULOS_DA_LATERAL as readonly string[]).includes(id))).toBe(true);
  });
});

describe("#3008 — a ordem gravada manda, sem perder e sem duplicar", () => {
  it("respeita a ordem escolhida e o que ficou desligado", () => {
    const gravado = {
      [CHAVE_DOS_MODULOS]: [
        { id: "acervo", visivel: true },
        { id: "atividade", visivel: false },
        { id: "contato", visivel: true },
      ],
    };

    const lido = lerModulosDaLateral(gravado);

    expect(lido.slice(0, 3)).toEqual([
      { id: "acervo", visivel: true },
      { id: "atividade", visivel: false },
      { id: "contato", visivel: true },
    ]);
  });

  it("id repetido não duplica: a PRIMEIRA ocorrência manda", () => {
    const lido = normalizarModulos([
      { id: "atividade", visivel: false },
      { id: "atividade", visivel: true },
      { id: "contato", visivel: true },
    ]);

    expect(lido.filter((m) => m.id === "atividade")).toEqual([{ id: "atividade", visivel: false }]);
    expect(new Set(ids(lido)).size).toBe(lido.length);
    expect(lido).toHaveLength(MODULOS_DA_LATERAL.length);
  });

  it("módulo do catálogo que NÃO veio no metadata entra no fim e VISÍVEL", () => {
    // O caso do módulo novo: quem já tinha preferência não pode receber o bloco
    // recém-criado escondido — ele nasce aparecendo para todo mundo.
    const lido = normalizarModulos([{ id: "acervo", visivel: false }]);

    expect(lido[0]).toEqual({ id: "acervo", visivel: false });
    expect(new Set(ids(lido))).toEqual(new Set(MODULOS_DA_LATERAL));
    // Nada foi perdido: os quinze ausentes entraram, todos visíveis.
    expect(lido.slice(1).every((m) => m.visivel)).toBe(true);
    expect(lido).toHaveLength(MODULOS_DA_LATERAL.length);
  });

  it("id que não existe mais no catálogo é descartado, sem levar o resto junto", () => {
    const lido = normalizarModulos([
      { id: "modulo-aposentado", visivel: true },
      { id: "contato", visivel: false },
    ]);

    expect(ids(lido)).not.toContain("modulo-aposentado");
    expect(lido[0]).toEqual({ id: "contato", visivel: false });
  });
});

describe("#3008 — valor torto não esconde módulo", () => {
  it.each([
    ["texto no lugar da lista", "contato,acervo"],
    ["objeto no lugar da lista", { contato: false }],
    ["lista vazia", []],
    ["lista só de lixo", [{ id: 42 }, null, "acervo"]],
    ["lista de chips sem id", [{ visivel: false }]],
  ])("%s → o padrão inteiro", (_caso, entrada) => {
    expect(ids(normalizarModulos(entrada))).toEqual(LATERAL_DE_HOJE);
    expect(normalizarModulos(entrada).every((m) => m.visivel)).toBe(true);
  });

  it("só `false` esconde: qualquer outra coisa deixa o módulo visível", () => {
    const lido = normalizarModulos([
      { id: "contato", visivel: "false" },
      { id: "acervo", visivel: 0 },
      { id: "memoria", visivel: null },
      { id: "leads" },
      { id: "atividade", visivel: false },
    ]);
    const porId = new Map(lido.map((m) => [m.id, m.visivel]));

    expect(porId.get("contato")).toBe(true);
    expect(porId.get("acervo")).toBe(true);
    expect(porId.get("memoria")).toBe(true);
    expect(porId.get("leads")).toBe(true);
    expect(porId.get("atividade")).toBe(false);
  });
});

describe("#3008 — mover módulo é conta de índice, e ela não pode errar", () => {
  const base = modulosPadrao();

  it("desce e sobe sem perder nem duplicar ninguém", () => {
    const desceu = moverModulo(base, 0, 3);
    const subiu = moverModulo(desceu, 3, 0);

    expect(ids(desceu).slice(0, 4)).toEqual(["tags-do-contato", "carteira", "anuncio", "contato"]);
    expect(new Set(ids(desceu)).size).toBe(base.length);
    expect(ids(subiu)).toEqual(ids(base));
  });

  it("mover para a própria posição, ou fora da faixa, não redesenha a lista", () => {
    // A MESMA referência: `onDragEnd` que não muda nada não deve re-renderizar
    // a lateral inteira por um índice que não existe.
    expect(moverModulo(base, 2, 2)).toBe(base);
    expect(moverModulo(base, -1, 3)).toBe(base);
    expect(moverModulo(base, 0, base.length)).toBe(base);
    expect(moverModulo(base, base.length, 0)).toBe(base);
  });

  it("a lista devolvida é nova: quem move não muta a preferência gravada", () => {
    const movida = moverModulo(base, 0, 1);
    expect(movida).not.toBe(base);
    expect(ids(base)).toEqual(LATERAL_DE_HOJE);
  });
});

describe("#3008 — cada módulo tem nome traduzível", () => {
  it("todo rótulo do catálogo tem espanhol no dicionário", () => {
    // O guardião de i18n não resolve `t(ROTULO_DO_MODULO[m.id])` (o índice é
    // variável de runtime), então esta é a rede que pega o módulo novo sem
    // tradução — a mesma régua do resto da tela.
    const semEspanhol = MODULOS_DA_LATERAL.filter((id) => !DICIONARIO[ROTULO_DO_MODULO[id]]?.es);
    expect(semEspanhol).toEqual([]);
  });

  it("o rótulo é o título que o bloco desenha — a escolha tem o nome da tela", () => {
    expect(ROTULO_DO_MODULO.acervo).toBe("Acervo");
    expect(ROTULO_DO_MODULO.demandas).toBe("Demandas abertas");
    expect(ROTULO_DO_MODULO["tags-da-conversa"]).toBe("Tags da conversa");
  });
});
