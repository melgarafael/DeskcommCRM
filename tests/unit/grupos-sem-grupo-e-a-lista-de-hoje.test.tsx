/**
 * "SEM GRUPO É A LISTA DE HOJE" (#3245) — O CONTROLE BYTE A BYTE.
 *
 * A issue é explícita: o agrupamento é OPCIONAL, e quem nunca criar grupo tem de
 * continuar vendo a lista de sempre. "De sempre" aqui não é uma impressão: é o
 * `outerHTML` do componente que existia ANTES desta mudança, capturado em
 * `tests/fixtures/*-antes-dos-grupos.html` a partir do arquivo do `HEAD`
 * (`tests/fixtures/nota.md` conta como). O teste renderiza o componente de
 * hoje com `grupos` vazio e compara BYTE A BYTE.
 *
 * ─── A única normalização, e por que ela é honesta ─────────────────────────
 *
 * `@hello-pangea/dnd` gera contadores de contexto (`_r_0_`, `_r_n_`) a cada
 * montagem — dois renders do MESMO componente divergem neles. A comparação
 * troca esses contadores por `_r_X_` dos DOIS lados: continua comparando cada
 * atributo, cada classe e cada nó de texto, e deixa de medir o número que o
 * React sorteia.
 *
 * ─── O outro lado da régua ─────────────────────────────────────────────────
 *
 * Os casos de grupo provam que o recurso FUNCIONA quando existe: seções na
 * ordem dos grupos, "Sem grupo" no fim (só quando há resposta sem grupo), grupo
 * vazio visível (é onde a pessoa vai soltar a primeira resposta) e o arrasto
 * com uma lista por seção. Sem eles, o teste de compatibilidade passaria com um
 * componente que ignora `grupos` por completo.
 */
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ListaDeRespostas } from "@/app/app/templates/_components/ListaDeRespostas";
import { BarraDeRecursos } from "@/components/inbox/composer/BarraDeRecursos";
import type { GrupoDeRespostas, MessageTemplate } from "@/hooks/inbox/useMessageTemplates";

/** A fixture de referência, gerada do componente anterior a esta mudança. */
function referencia(arquivo: string): string {
  return normalizar(
    readFileSync(join(process.cwd(), "tests/fixtures", arquivo), "utf8"),
  );
}

/** Contadores de contexto do dnd são por render; o resto do markup não é. */
function normalizar(html: string): string {
  return html.replace(/_r_[a-z0-9]+_/g, "_r_X_").trim();
}

const TEMPLATES = [
  { id: "1", title: "Meu Pessoal", body: "Oi {{primeiro_nome}}", shortcut: "oi", owner_user_id: "u1" },
  { id: "2", title: "Política da Equipe", body: "Política de troca", shortcut: null, owner_user_id: null },
  { id: "3", title: "Pessoal do Outro", body: "Segredo do colega", shortcut: null, owner_user_id: "u2" },
  {
    id: "4",
    title: "Áudio Boas-vindas",
    body: "",
    shortcut: null,
    owner_user_id: null,
    midias: [{ storage_path: "org/templates/4/a.ogg", media_mime: "audio/ogg", media_size_bytes: 10 }],
  },
  {
    id: "5",
    title: "Tabela",
    body: "Olha a tabela",
    shortcut: null,
    owner_user_id: null,
    midias: [{ storage_path: "org/templates/5/b.png", media_mime: "image/png", media_size_bytes: 10 }],
  },
] as unknown as MessageTemplate[];

/** A mesma régua da tela: o dono do pessoal, ou manager+ no compartilhado. */
const podeMover = (template: MessageTemplate) =>
  template.owner_user_id === "u1" || template.owner_user_id === null;

function lista(grupos: GrupoDeRespostas[] | null | undefined) {
  return render(
    <ListaDeRespostas
      templates={TEMPLATES}
      grupos={grupos}
      podeMover={podeMover}
      onEditar={() => {}}
      onExcluir={() => {}}
      aoSoltar={() => {}}
    />,
  );
}

const RECURSOS = [
  { id: "1", title: "Meu Pessoal", body: "Oi", mostrar_na_barra: true },
  { id: "2", title: "Política da Equipe", body: "Política", mostrar_na_barra: true },
  { id: "3", title: "Pessoal do Outro", body: "Segredo", mostrar_na_barra: true },
];

const GRUPOS: GrupoDeRespostas[] = [
  { id: "g-fechamento", name: "Fechamento", ordem: 3000 },
  { id: "g-abordagem", name: "Abordagem", ordem: 1000 },
  { id: "g-objecao", name: "Objeção", ordem: 2000 },
];

const COM_GRUPO = TEMPLATES.map((template) => {
  if (template.id === "1") return { ...template, grupo_id: "g-fechamento" };
  if (template.id === "2") return { ...template, grupo_id: "g-abordagem" };
  if (template.id === "4") return { ...template, grupo_id: "g-objecao" };
  // 3 e 5 ficam sem grupo de propósito: são a seção "Sem grupo".
  return { ...template, grupo_id: null };
});

describe("#3245 — sem grupo, a lista é a de HOJE (byte a byte)", () => {
  it("`grupos=[]` desenha exatamente o HTML anterior à mudança", () => {
    const { container } = lista([]);
    expect(normalizar(container.querySelector("ul")!.outerHTML)).toBe(
      referencia("respostas-rapidas-lista-plana-antes-dos-grupos.html"),
    );
  });

  it("`grupos` ausente (fixture antiga, GET que não devolveu) é o MESMO HTML", () => {
    const { container } = lista(undefined);
    expect(normalizar(container.querySelector("ul")!.outerHTML)).toBe(
      referencia("respostas-rapidas-lista-plana-antes-dos-grupos.html"),
    );
  });

  it("a barra do Inbox, com `grupos=[]`, é exatamente a anterior à mudança", () => {
    const { container } = render(
      <BarraDeRecursos recursos={RECURSOS as never} grupos={[]} onEscolher={() => {}} />,
    );
    expect(normalizar(container.querySelector('[data-testid="barra-de-recursos"]')!.outerHTML)).toBe(
      referencia("respostas-rapidas-barra-plana-antes-dos-grupos.html"),
    );
  });

  it("sem grupo não há seção, cabeçalho nem botão de grupo na tela", () => {
    const { container } = lista([]);
    expect(container.querySelectorAll('[data-testid="secao-de-respostas"]')).toHaveLength(0);
    expect(container.querySelectorAll("h2")).toHaveLength(0);
    expect(screen.queryByLabelText("Renomear grupo")).not.toBeInTheDocument();
    // E a lista continua sendo UM droppable só, com o id de sempre.
    expect(container.querySelectorAll("ul")).toHaveLength(1);
    expect(container.querySelector("ul")!.getAttribute("data-rfd-droppable-id")).toBe(
      "respostas-rapidas",
    );
  });
});

describe("#3245 — com grupo, as seções", () => {
  it("as seções saem na ORDEM dos grupos, e 'Sem grupo' vem por último", () => {
    const { container } = render(
      <ListaDeRespostas
        templates={COM_GRUPO}
        grupos={GRUPOS}
        podeMover={podeMover}
        onEditar={() => {}}
        onExcluir={() => {}}
        aoSoltar={() => {}}
        podeGerirGrupos
      />,
    );
    const secoes = [...container.querySelectorAll('[data-testid="secao-de-respostas"]')];
    expect(secoes.map((secao) => secao.getAttribute("data-secao"))).toEqual([
      "grupo:g-abordagem",
      "grupo:g-objecao",
      "grupo:g-fechamento",
      "sem-grupo",
    ]);
    // A resposta sem grupo NÃO some: ela aparece na seção do fim.
    const semGrupo = secoes.at(-1)!;
    expect(semGrupo.textContent).toContain("Pessoal do Outro");
    expect(semGrupo.textContent).toContain("Tabela");
  });

  it("só há seção 'Sem grupo' quando existe resposta sem grupo", () => {
    // Todas vinculadas: o cabeçalho "Sem grupo" vazio não aparece.
    const todas = TEMPLATES.map((template) => ({ ...template, grupo_id: "g-abordagem" }));
    const { container } = render(
      <ListaDeRespostas
        templates={todas}
        grupos={GRUPOS}
        podeMover={podeMover}
        onEditar={() => {}}
        onExcluir={() => {}}
        aoSoltar={() => {}}
      />,
    );
    expect(container.querySelector('[data-secao="sem-grupo"]')).toBeNull();
    // Mas os grupos vazios continuam: é neles que a pessoa vai soltar a
    // primeira resposta.
    expect(container.querySelector('[data-secao="grupo:g-fechamento"]')).not.toBeNull();
    // Dois grupos vazios (Fechamento e Objeção) mostram a frase de vazio.
    expect(screen.getAllByText("Nenhuma resposta neste grupo.")).toHaveLength(2);
  });

  it("cada seção é um droppable próprio — o arrasto é dentro da seção", () => {
    const { container } = render(
      <ListaDeRespostas
        templates={COM_GRUPO}
        grupos={GRUPOS}
        podeMover={podeMover}
        onEditar={() => {}}
        onExcluir={() => {}}
        aoSoltar={() => {}}
      />,
    );
    const ids = [...container.querySelectorAll("ul")].map((ul) =>
      ul.getAttribute("data-rfd-droppable-id"),
    );
    expect(ids).toEqual(["grupo:g-abordagem", "grupo:g-objecao", "grupo:g-fechamento", "sem-grupo"]);
  });

  it("grupo que a lista não conhece cai em 'Sem grupo' em vez de sumir", () => {
    const orfa = [{ ...TEMPLATES[0]!, grupo_id: "g-apagado-agora-mesmo" }];
    const { container } = render(
      <ListaDeRespostas
        templates={orfa as unknown as MessageTemplate[]}
        grupos={GRUPOS}
        podeMover={() => true}
        onEditar={() => {}}
        onExcluir={() => {}}
        aoSoltar={() => {}}
      />,
    );
    expect(container.querySelector('[data-secao="sem-grupo"]')!.textContent).toContain("Meu Pessoal");
  });

  it("quem não é manager+ não vê renomear/excluir/mover grupo", () => {
    render(
      <ListaDeRespostas
        templates={COM_GRUPO}
        grupos={GRUPOS}
        podeMover={podeMover}
        onEditar={() => {}}
        onExcluir={() => {}}
        aoSoltar={() => {}}
        podeGerirGrupos={false}
      />,
    );
    expect(screen.queryByLabelText("Renomear grupo")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Excluir grupo")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Mover grupo para cima")).not.toBeInTheDocument();
  });
});
