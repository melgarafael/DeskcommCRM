// @vitest-environment jsdom
/**
 * CAMPO PERSONALIZADO DO TIPO ARQUIVO NO CARD DO NEGÓCIO (#2829, fatia 1).
 *
 * ─── O defeito, medido na `main` antes do conserto ──────────────────────────
 *
 * O tipo `file` já é ACEITO e SALVO (`lib/schemas/settings.ts`), o uploader já
 * existe (`components/kanban/FileUploadCustomField.tsx`) e o dossiê já o
 * desenha (`CustomFieldsEditor`, caso `file`). O que faltava era o CARD: o
 * `KanbanCard` desenha título, valor, a faixa do agente, conversa, contato,
 * dono e tempo — nenhum campo do funil, e portanto nenhum `file`. O operador
 * criava o campo, subia o documento no dossiê e o quadro continuava sem dizer
 * que aquele negócio tem documento — a única tela onde ele olha o funil
 * inteiro.
 *
 * ─── O que estes casos provam ──────────────────────────────────────────────
 *
 * 1. dois PDFs sobem e o card mostra os DOIS, com a contagem, cada um clicável
 *    pelo MESMO caminho de mídia que a listagem serve hoje;
 * 2. campo declarado e VAZIO aparece como tal (não some, não quebra o card);
 * 3. CONTROLE — funil sem campo `file`: o negócio passa intacto, sem bloco e
 *    sem consulta extra;
 * 4. removido um dos dois, o outro continua lá (é o estado que o DELETE deixa);
 * 5. CONTROLE — a rota de listagem continua respondendo pela mesma porta de
 *    mídia (`/attachments/{id}/media`).
 *
 * A leitura do anexo é feita UMA vez por quadro (rota do board), como os
 * marcadores, as tarefas e a conversa — o card não pode custar uma consulta
 * por negócio.
 *
 * Sabotagem prevista ANTES de reverter (ver `previsao-sabotagem-2829.md`):
 * removida a linha `<ArquivosNoCard lead={lead} />` do `KanbanCard`, caem
 * exatamente 2 dos 17 casos — o que monta o card de verdade e a cerca da
 * fiação —, e os outros 15 seguem verdes.
 */
import { createElement as h } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
// O card é um `Draggable`: o dnd entra como casca oca (mesma técnica de
// `funil-deep-link-abre-o-negocio`), e o menu de ações — que abre diálogos e lê
// permissões — sai de cena: o que este arquivo mede é o CONTEÚDO do card.
vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ children }: { children: unknown }) => h("div", null, children as never),
  Droppable: ({ children }: { children: (p: unknown, s: unknown) => unknown }) =>
    children({ innerRef: () => {}, droppableProps: {}, placeholder: null }, {}) as never,
  Draggable: ({ children }: { children: (p: unknown, s: unknown) => unknown }) =>
    children(
      { innerRef: () => {}, draggableProps: {}, dragHandleProps: {} },
      { isDragging: false },
    ) as never,
}));
vi.mock("@/components/kanban/KanbanCardActions", () => ({ KanbanCardActions: () => null }));

import {
  MAX_ARQUIVOS_NO_CARD,
  anexarAnexosAosNegocios,
  caminhoDaMidiaDoAnexo,
  type AnexosDoCampoNoCard,
  type LinhaDoAnexoNoQuadro,
} from "@/lib/kanban/anexos-no-card";
import { camposDeArquivoDoNegocio } from "@/lib/leads/campos-do-funil";
import { ArquivosNoCard } from "@/components/kanban/ArquivosNoCard";
import { KanbanCard } from "@/components/kanban/KanbanCard";
import type { CardInput } from "@/lib/kanban/card-state";
import type { Lead } from "@/lib/types/leads";

const RAIZ = process.cwd();
const fonte = (arquivo: string) => readFileSync(join(RAIZ, arquivo), "utf8");

/** `noUncheckedIndexedAccess` está ligado: o primeiro item existe, e o teste diz isso. */
function primeiro<T>(lista: readonly T[]): T {
  const item = lista[0];
  if (item === undefined) throw new Error("esperava ao menos um item na lista");
  return item;
}

afterEach(cleanup);

const NEGOCIO = "aaaaaaaa-1111-4111-8111-111111111111";
const VIZINHO = "bbbbbbbb-2222-4222-8222-222222222222";
const ANEXO_1 = "cccccccc-3333-4333-8333-333333333333";
const ANEXO_2 = "dddddddd-4444-4444-8444-444444444444";

/** A definição do campo como o editor do funil a grava (`customFieldSchema`). */
const CAMPO_DOCUMENTO = { key: "documentos", label: "Documentos", type: "file" as const };

function negocios(...ids: string[]): Lead[] {
  return ids.map(
    (id) =>
      ({
        id,
        title: `Negócio ${id.slice(0, 4)}`,
        custom_fields: {},
        tags: [],
      }) as unknown as Lead,
  );
}

function anexo(over: Partial<LinhaDoAnexoNoQuadro> = {}): LinhaDoAnexoNoQuadro {
  return {
    lead_id: NEGOCIO,
    field_key: "documentos",
    id: ANEXO_1,
    file_name: "contrato.pdf",
    mime_type: "application/pdf",
    file_size: 1234,
    created_at: "2026-10-22T10:00:00Z",
    ...over,
  };
}

/** O bloco do campo `documentos` — o caminho que todos os casos percorrem. */
function blocoDe(lead: Lead): AnexosDoCampoNoCard {
  return primeiro(lead.anexos ?? []);
}

describe("camposDeArquivoDoNegocio", () => {
  it("isola o tipo `file` do escopo do NEGÓCIO — arquivo de contato e texto ficam de fora", () => {
    const campos = camposDeArquivoDoNegocio({
      fields: [
        CAMPO_DOCUMENTO,
        { key: "doc_do_contato", label: "RG", type: "file", escopo: "contato" },
        { key: "observacao", label: "Observação", type: "text" },
      ],
    });

    expect(campos.map((c) => c.key)).toEqual(["documentos"]);
  });

  it("funil sem campo de arquivo devolve lista vazia", () => {
    expect(
      camposDeArquivoDoNegocio({ fields: [{ key: "obs", label: "Obs", type: "text" }] }),
    ).toEqual([]);
    expect(camposDeArquivoDoNegocio(null)).toEqual([]);
  });
});

describe("anexarAnexosAosNegocios", () => {
  it("⭐ dois PDFs no mesmo campo viram UM bloco com total 2 e os dois caminhos de mídia", () => {
    const lead = primeiro(
      anexarAnexosAosNegocios(
        negocios(NEGOCIO),
        [
          anexo(),
          anexo({ id: ANEXO_2, file_name: "voucher.pdf", created_at: "2026-10-22T11:00:00Z" }),
        ],
        [CAMPO_DOCUMENTO],
      ),
    );

    expect(lead.anexos).toHaveLength(1);
    const bloco = blocoDe(lead);
    expect(bloco.campo).toBe("documentos");
    expect(bloco.rotulo).toBe("Documentos");
    expect(bloco.total).toBe(2);
    expect(bloco.arquivos.map((a) => a.nome)).toEqual(["contrato.pdf", "voucher.pdf"]);
    expect(bloco.arquivos.map((a) => a.href)).toEqual([
      caminhoDaMidiaDoAnexo(NEGOCIO, ANEXO_1),
      caminhoDaMidiaDoAnexo(NEGOCIO, ANEXO_2),
    ]);
    expect(primeiro(bloco.arquivos).href).toBe(
      `/api/v1/leads/${NEGOCIO}/attachments/${ANEXO_1}/media`,
    );
  });

  it("⭐ campo declarado e VAZIO aparece como tal: total 0 e nenhum arquivo", () => {
    const lead = primeiro(anexarAnexosAosNegocios(negocios(NEGOCIO), [], [CAMPO_DOCUMENTO]));

    expect(lead.anexos).toEqual([
      { campo: "documentos", rotulo: "Documentos", total: 0, arquivos: [] },
    ]);
  });

  it("CONTROLE — funil sem campo `file`: o negócio passa INTACTO (mesmo objeto, sem bloco)", () => {
    const original = primeiro(negocios(NEGOCIO));

    const lead = primeiro(
      anexarAnexosAosNegocios(
        [original],
        [anexo()],
        [{ key: "observacao", label: "Observação", type: "text" as const }],
      ),
    );

    expect(lead).toBe(original);
    expect(lead.anexos).toBeUndefined();
  });

  it("anexo de campo que o funil NÃO declara não vira bloco — o card não inventa campo", () => {
    const lead = primeiro(
      anexarAnexosAosNegocios(
        negocios(NEGOCIO),
        [anexo({ field_key: "campo_que_sumiu_do_funil" })],
        [CAMPO_DOCUMENTO],
      ),
    );

    expect(lead.anexos).toEqual([
      { campo: "documentos", rotulo: "Documentos", total: 0, arquivos: [] },
    ]);
  });

  it("anexo de OUTRO negócio não contamina o bloco deste", () => {
    const leads = anexarAnexosAosNegocios(
      negocios(NEGOCIO, VIZINHO),
      [anexo(), anexo({ lead_id: VIZINHO, id: ANEXO_2, file_name: "do-vizinho.pdf" })],
      [CAMPO_DOCUMENTO],
    );

    expect(blocoDe(primeiro(leads)).arquivos.map((a) => a.nome)).toEqual(["contrato.pdf"]);
    expect(blocoDe(leads[1] ?? primeiro(negocios(VIZINHO))).arquivos.map((a) => a.nome)).toEqual([
      "do-vizinho.pdf",
    ]);
  });

  it("acima do teto o card mostra os primeiros e o TOTAL real (nada é escondido na contagem)", () => {
    const linhas = Array.from({ length: MAX_ARQUIVOS_NO_CARD + 2 }, (_, i) =>
      anexo({
        id: `eeeeeeee-5555-4555-8555-55555555555${i}`,
        file_name: `doc-${i}.pdf`,
        created_at: `2026-10-22T1${i}:00:00Z`,
      }),
    );

    const bloco = blocoDe(primeiro(anexarAnexosAosNegocios(negocios(NEGOCIO), linhas, [CAMPO_DOCUMENTO])));

    expect(bloco.total).toBe(MAX_ARQUIVOS_NO_CARD + 2);
    expect(bloco.arquivos).toHaveLength(MAX_ARQUIVOS_NO_CARD);
    expect(primeiro(bloco.arquivos).nome).toBe("doc-0.pdf");
  });
});

describe("ArquivosNoCard", () => {
  it("⭐ mostra os dois PDFs com a contagem, e clicar num deles abre o ARQUIVO (não o dossiê)", () => {
    const abrirDossie = vi.fn();
    const lead = primeiro(
      anexarAnexosAosNegocios(
        negocios(NEGOCIO),
        [anexo(), anexo({ id: ANEXO_2, file_name: "voucher.pdf" })],
        [CAMPO_DOCUMENTO],
      ),
    );

    render(h("div", { onClick: abrirDossie }, h(ArquivosNoCard, { lead })));

    expect(screen.getByTestId("arquivos-no-card")).toHaveTextContent("Documentos");
    expect(screen.getByTestId("arquivos-do-campo-documentos")).toHaveTextContent("2");

    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      caminhoDaMidiaDoAnexo(NEGOCIO, ANEXO_1),
      caminhoDaMidiaDoAnexo(NEGOCIO, ANEXO_2),
    ]);
    const primeiroLink = primeiro(links);
    expect(primeiroLink).toHaveAttribute("target", "_blank");
    expect(primeiroLink).toHaveAttribute("rel", expect.stringContaining("noopener"));

    fireEvent.click(links[1] ?? primeiroLink);
    expect(abrirDossie).not.toHaveBeenCalled();
  });

  it("⭐ campo vazio aparece como tal, com o rótulo do funil, e não quebra o card", () => {
    const lead = primeiro(anexarAnexosAosNegocios(negocios(NEGOCIO), [], [CAMPO_DOCUMENTO]));

    render(h(ArquivosNoCard, { lead }));

    expect(screen.getByTestId("arquivos-do-campo-documentos")).toHaveTextContent("0");
    expect(screen.getByText("Nenhum arquivo anexado")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("CONTROLE — lead sem campo de arquivo declarado não desenha bloco nenhum", () => {
    const { container } = render(h(ArquivosNoCard, { lead: primeiro(negocios(NEGOCIO)) }));

    expect(container).toBeEmptyDOMElement();
  });

  it("removido um dos dois, o outro continua clicável e a contagem cai", () => {
    // O estado que o DELETE da rota de anexos deixa: a linha que ficou.
    const lead = primeiro(
      anexarAnexosAosNegocios(
        negocios(NEGOCIO),
        [anexo({ id: ANEXO_2, file_name: "voucher.pdf" })],
        [CAMPO_DOCUMENTO],
      ),
    );

    render(h(ArquivosNoCard, { lead }));

    expect(screen.getByTestId("arquivos-do-campo-documentos")).toHaveTextContent("1");
    expect(screen.queryByText("contrato.pdf")).toBeNull();
    expect(screen.getByRole("link", { name: "Abrir arquivo: voucher.pdf" })).toHaveAttribute(
      "href",
      caminhoDaMidiaDoAnexo(NEGOCIO, ANEXO_2),
    );
  });
});

/** O mínimo que o card precisa para desenhar: valor nenhum, dono nenhum. */
function cardDoQuadro(id: string): CardInput {
  return {
    id,
    title: "Negócio do documento",
    valueCents: null,
    currency: null,
    owner: { kind: null, name: null, agentVersion: null },
    stageName: "Negociação",
    hoursInStage: null,
    isCooling: false,
    tags: [],
  };
}

describe("KanbanCard — o card do quadro inteiro", () => {
  it("⭐ o card desenha o bloco de arquivos do FUNIL do lead, com os dois PDFs", () => {
    const lead = primeiro(
      anexarAnexosAosNegocios(
        negocios(NEGOCIO),
        [anexo(), anexo({ id: ANEXO_2, file_name: "voucher.pdf" })],
        [CAMPO_DOCUMENTO],
      ),
    );

    render(h(KanbanCard, { card: cardDoQuadro(NEGOCIO), lead, index: 0, pipelineId: "p-1" }));

    expect(screen.getByTestId("arquivos-do-campo-documentos")).toHaveTextContent("2");
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toContain(
      caminhoDaMidiaDoAnexo(NEGOCIO, ANEXO_2),
    );
  });

  it("CONTROLE — card de negócio cujo funil não declara campo `file` fica sem o bloco", () => {
    render(
      h(KanbanCard, {
        card: cardDoQuadro(NEGOCIO),
        lead: primeiro(negocios(NEGOCIO)),
        index: 0,
        pipelineId: "p-1",
      }),
    );

    expect(screen.queryByTestId("arquivos-no-card")).toBeNull();
  });
});

describe("fiação — o card do quadro lê o anexo que a rota anexou", () => {
  it("o KanbanCard desenha o ArquivosNoCard com o lead do quadro", () => {
    const card = fonte("components/kanban/KanbanCard.tsx");

    expect(card, "o card não importa o bloco de arquivos").toMatch(
      /import\s*\{\s*ArquivosNoCard\s*\}\s*from\s*"\.\/ArquivosNoCard"/,
    );
    expect(card, "o card não renderiza o bloco de arquivos").toMatch(
      /<ArquivosNoCard\s+lead=\{lead\}/,
    );
  });

  it("a rota do quadro anexa os anexos numa etapa própria, uma leitura só", () => {
    const rota = fonte("app/api/v1/pipelines/[id]/board/route.ts");

    expect(rota, "a rota não importa a regra do card").toMatch(
      /from\s*"@\/lib\/kanban\/anexos-no-card"/,
    );
    expect(rota, "a rota não chama withAnexos").toMatch(/leadsComAnexos\s*=\s*await withAnexos\(/);
    expect(rota, "o resultado de withAnexos não chega à resposta").toMatch(
      /withConversas\(\s*supabase,\s*\(pipeline as Pipeline\)\.organization_id,\s*leadsComAnexos\.leads,?\s*\)/,
    );
    expect(rota, "a leitura não é em lotes").toMatch(/crm_lead_attachments/);
    expect(rota, "a leitura não filtra pela organização da sessão").toMatch(
      /\.eq\("organization_id", organizationId\)/,
    );
  });

  it("CONTROLE — a listagem de anexos continua servindo a mídia pela MESMA porta", () => {
    const rota = fonte("app/api/v1/leads/[id]/attachments/route.ts");

    expect(rota, "a listagem deixou de apontar para a rota de mídia").toMatch(
      /url:\s*`\/api\/v1\/leads\/\$\{leadId\}\/attachments\/\$\{row\.id\}\/media`/,
    );
    // O caminho que o card monta é o MESMO — se um mudar sozinho, o link do card
    // passa a abrir 404 e este caso reprova antes de chegar na tela.
    expect(caminhoDaMidiaDoAnexo("lead-1", "anexo-1")).toBe(
      "/api/v1/leads/lead-1/attachments/anexo-1/media",
    );
  });
});
