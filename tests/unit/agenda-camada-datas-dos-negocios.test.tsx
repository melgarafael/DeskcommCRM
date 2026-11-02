/**
 * A CAMADA "DATAS DOS NEGÓCIOS" NA TELA (#3221) — desligada por padrão, só
 * leitura, e o rótulo diz de que data se trata.
 *
 * ─── O que está sendo cobrado ──────────────────────────────────────────────
 *
 * A agenda da agência de viagens é a de embarques e retornos, e essas datas
 * moram em campos do NEGÓCIO. A camada as mostra ao lado da grade, e as quatro
 * promessas da entrega aparecem aqui como casos:
 *
 *   1. **Desligada por padrão**: a tela abre sem item, sem seletor e SEM BUSCA
 *      nenhuma (`fetch` não é chamado) — quem não usa a camada não paga por ela.
 *   2. **Só leitura**: o item é um LINK para o negócio no funil; não há botão,
 *      campo ou gesto que escreva. Mudar a data é mudar o campo do negócio.
 *   3. **Rótulo próprio**: o chip diz "Embarque"/"Retorno" — o `label` do campo
 *      no funil —, nunca "data do negócio".
 *   4. **Dia certo**: o item cai no dia que o servidor devolveu, e o dia é
 *      impresso a partir das partes (`YYYY-MM-DD`), sem passar por UTC.
 *
 * A permissão NÃO se prova aqui: quem a decide é a RLS de `crm_leads` no
 * servidor, e o caso dela está na rota (`app/api/v1/agenda/datas-dos-negocios/route.test.ts`).
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CamadaDatasDosNegocios } from "@/app/app/agenda/_components/CamadaDatasDosNegocios";
import type { FunilComDatas } from "@/lib/agenda/datas-dos-negocios";

// Polyfills que o Radix Select exige e o jsdom não tem (mesmo padrão de
// tests/unit/calendario-do-funil-por-campo-de-data.test.tsx).
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const traduzir = Object.assign((texto: string) => texto, { t: (texto: string) => texto });
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => traduzir }));
vi.mock("@/hooks/i18n/useLocaleDeData", async () => ({
  useTagDeIdioma: () => "pt-BR",
  useLocaleDeData: async () => (await import("date-fns/locale")).ptBR,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FUNIS: FunilComDatas[] = [
  {
    id: "p-viagens",
    nome: "Viagens",
    campos: [
      { key: "data_inicio", label: "Embarque" },
      { key: "data_fim", label: "Retorno" },
    ],
  },
];

const JANELA = { de: "2026-03-09", ate: "2026-03-15" };

/** O corpo que a rota devolve (`ok()` embrulha em `data`). */
function respostaCom(
  itens: Array<{
    id: string;
    titulo: string;
    dia: string;
    rotulos: string[];
    funilId?: string;
    funilNome?: string;
    etapaNome?: string | null;
  }>,
  extra: Record<string, unknown> = {},
) {
  return {
    ok: true,
    json: async () => ({
      data: {
        itens: itens.map((i) => ({
          negocio: {
            id: i.id,
            titulo: i.titulo,
            funilId: i.funilId ?? "p-viagens",
            funilNome: i.funilNome ?? "Viagens",
            etapaNome: i.etapaNome ?? "Reservado",
          },
          dia: i.dia,
          rotulos: i.rotulos,
        })),
        truncado: false,
        ...extra,
      },
    }),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => respostaCom([])));
});

describe("Camada 'Datas dos negócios' na Agenda", () => {
  it("sem funil com campo de data não desenha NADA — a Agenda fica igual à de antes", () => {
    const { container } = render(<CamadaDatasDosNegocios funis={[]} janela={JANELA} />);
    expect(container.innerHTML).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("nasce DESLIGADA: interruptor apagado, nenhum item e nenhuma busca", () => {
    const { container } = render(<CamadaDatasDosNegocios funis={FUNIS} janela={JANELA} />);

    const alternar = screen.getByTestId("camada-datas-alternar");
    expect(alternar.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("camada-datas-itens")).toBeNull();
    expect(screen.queryByTestId("camada-datas-campo")).toBeNull();
    // Nada de seletor, nada de item: desligada, a camada é só o interruptor.
    expect(container.querySelectorAll('[data-testid^="camada-datas-dia-"]')).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ligada sem campo escolhido: pede a escolha em vez de adivinhar o campo", async () => {
    render(<CamadaDatasDosNegocios funis={FUNIS} janela={JANELA} />);

    await userEvent.click(screen.getByTestId("camada-datas-alternar"));

    expect(screen.getByTestId("camada-datas-alternar").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("camada-datas-aviso").textContent).toContain("Escolha o campo de data");
    // Nenhum campo escolhido por heurística de nome: sem escolha, sem busca.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("com campo escolhido: busca na janela certa e põe o negócio no dia, com o rótulo do campo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        respostaCom([
          { id: "lead-1", titulo: "Família Prado — Gramado", dia: "2026-03-10", rotulos: ["Embarque"] },
        ]),
      ),
    );

    render(<CamadaDatasDosNegocios funis={FUNIS} janela={JANELA} />);
    await userEvent.click(screen.getByTestId("camada-datas-alternar"));
    await userEvent.click(screen.getByRole("combobox", { name: "Campo de data do negócio" }));
    await userEvent.click(await screen.findByRole("option", { name: "Embarque" }));

    const dia = await screen.findByTestId("camada-datas-dia-2026-03-10");
    expect(dia.textContent).toContain("Família Prado — Gramado");
    // O rótulo é o do CAMPO ("Embarque"), nunca "data do negócio".
    expect(dia.textContent).toContain("Embarque");
    expect(dia.textContent).not.toContain("data do negócio");

    // A busca é do funil escolhido, do campo escolhido, na janela que a grade
    // desenha — e o dia pedido é o do fuso da organização, sem hora.
    const url = String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(url).toContain("pipeline_id=p-viagens");
    expect(url).toContain("campo=data_inicio");
    expect(url).toContain("de=2026-03-09");
    expect(url).toContain("ate=2026-03-15");
  });

  it("o item é SÓ LEITURA: um link para o negócio no funil, e nenhum gesto de escrita", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        respostaCom([
          { id: "lead-1", titulo: "Família Prado — Gramado", dia: "2026-03-10", rotulos: ["Embarque"] },
        ]),
      ),
    );

    render(<CamadaDatasDosNegocios funis={FUNIS} janela={JANELA} />);
    await userEvent.click(screen.getByTestId("camada-datas-alternar"));
    await userEvent.click(screen.getByRole("combobox", { name: "Campo de data do negócio" }));
    await userEvent.click(await screen.findByRole("option", { name: "Embarque" }));

    const item = await screen.findByTestId("camada-datas-item-lead-1");
    expect(item.tagName).toBe("A");
    expect(item.getAttribute("href")).toBe("/app/pipelines/p-viagens?lead=lead-1");

    // Nenhuma porta de escrita dentro da camada: nem formulário, nem botão que
    // não seja o interruptor.
    const botoes = screen
      .getByTestId("camada-datas-itens")
      .querySelectorAll("button, input, textarea, form");
    expect(botoes).toHaveLength(0);
  });

  it("campo renomeado/apagado: a escolha é esquecida e o motivo fica à vista", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: { code: "campo_nao_e_data", message: "sumiu" } }),
      }) as unknown as Response),
    );

    render(<CamadaDatasDosNegocios funis={FUNIS} janela={JANELA} />);
    await userEvent.click(screen.getByTestId("camada-datas-alternar"));
    await userEvent.click(screen.getByRole("combobox", { name: "Campo de data do negócio" }));
    await userEvent.click(await screen.findByRole("option", { name: "Embarque" }));

    // O aviso aparece e a camada volta a pedir a escolha, em vez de mostrar uma
    // grade vazia — que seria indistinguível de "ninguém embarca no período".
    expect((await screen.findByTestId("camada-datas-erro")).textContent).toContain(
      "não existe mais",
    );
    expect(screen.getByTestId("camada-datas-aviso").textContent).toContain("Escolha o campo de data");
  });

  it("lista vazia é resposta, não erro: diz que ninguém tem data no período", async () => {
    render(<CamadaDatasDosNegocios funis={FUNIS} janela={JANELA} />);
    await userEvent.click(screen.getByTestId("camada-datas-alternar"));
    await userEvent.click(screen.getByRole("combobox", { name: "Campo de data do negócio" }));
    await userEvent.click(await screen.findByRole("option", { name: "Embarque" }));

    expect((await screen.findByTestId("camada-datas-vazio")).textContent).toContain(
      "Nenhum negócio com esse campo de data neste período",
    );
  });
});
