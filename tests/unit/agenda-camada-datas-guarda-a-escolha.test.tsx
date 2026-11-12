/**
 * A CAMADA "DATAS DOS NEGÓCIOS" GUARDA A ESCOLHA (#4436, item 1).
 *
 * ─── O defeito que este teste prende ──────────────────────────────────────
 *
 * A camada nasceu com a escolha só na tela (`useState(false)` /
 * `useState(null)`): quem ligava a camada, escolhia o funil e o campo de
 * embarque fechava a Agenda e voltava na visita seguinte encontrava tudo
 * desligado outra vez. Numa agência que abre a agenda dezenas de vezes por dia,
 * isso é a mesma escolha refeita dezenas de vezes — e a camada nunca chega a
 * ser usada no dia a dia.
 *
 * ─── O contrato medido aqui ────────────────────────────────────────────────
 *
 *   1. **Volta como a pessoa deixou.** Montada com a escolha gravada, a camada
 *      abre ligada, no funil e no campo daquela escolha, e já busca os itens —
 *      sem clique nenhum.
 *   2. **Cada mudança é gravada INTEIRA.** O que sai do componente é o estado
 *      completo (ligada + funil + campo + campo-fim), e não um campo solto: o
 *      gravador regrava o objeto, e um campo faltando voltaria ao padrão.
 *   3. **Montar não regrava.** Abrir a Agenda não pode reescrever por cima do
 *      que estava guardado com o valor do primeiro render — quem só olha a
 *      tela não muda a própria escolha.
 *
 * O que NÃO se prova aqui: onde a escolha é guardada (é `raw_user_meta_data`,
 * coberto em `agenda-preferencia-da-camada.test.ts` e na action), nem a
 * leitura tolerante de funil arquivado — essa é a mesma régua daquele teste.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CamadaDatasDosNegocios } from "@/app/app/agenda/_components/CamadaDatasDosNegocios";
import type { FunilComDatas } from "@/lib/agenda/datas-dos-negocios";

// Polyfills que o Radix Select exige e o jsdom não tem (mesmo padrão de
// tests/unit/agenda-camada-datas-dos-negocios.test.tsx).
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
  {
    id: "p-frota",
    nome: "Frota",
    campos: [{ key: "revisao", label: "Revisão" }],
  },
];

/** A escolha como ela sai do componente e volta do servidor. */
interface Escolha {
  ligada: boolean;
  funilId: string | null;
  campo: string | null;
  campoFim: string | null;
}

const JANELA = { de: "2026-03-09", ate: "2026-03-15" };

function respostaVazia() {
  return {
    ok: true,
    json: async () => ({ data: { itens: [], truncado: false } }),
  } as unknown as Response;
}

function montar(escolhaInicial: Escolha | undefined, aoEscolher?: (escolha: Escolha) => void) {
  return render(
    <CamadaDatasDosNegocios
      funis={FUNIS}
      janela={JANELA}
      {...(escolhaInicial ? { escolhaInicial } : {})}
      {...(aoEscolher ? { aoEscolher } : {})}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => respostaVazia()),
  );
});

describe("Camada 'Datas dos negócios' — a escolha volta na visita seguinte", () => {
  it("abre LIGADA, no funil e no campo gravados, e já busca sem clique nenhum", async () => {
    montar({
      ligada: true,
      funilId: "p-viagens",
      campo: "data_inicio",
      campoFim: "data_fim",
    });

    // O interruptor volta como a pessoa deixou.
    expect(screen.getByTestId("camada-datas-alternar").getAttribute("aria-pressed")).toBe("true");
    // O corpo da camada está aberto: sem isto, "ligada" seria só a cor do botão.
    expect(screen.getByTestId("camada-datas-itens")).toBeTruthy();
    // Os dois seletores mostram a escolha gravada, e não "Escolha o campo".
    expect(
      screen.getByRole("combobox", { name: "Campo de data do negócio" }).textContent,
    ).toContain("Embarque");
    expect(screen.getByRole("combobox", { name: "Segundo campo de data" }).textContent).toContain(
      "Retorno",
    );
    expect(screen.queryByTestId("camada-datas-aviso")).toBeNull();

    // E a busca sai sozinha, com a mesma pergunta da escolha guardada.
    const url = vi
      .mocked(fetch)
      .mock.calls.map(([alvo]) => String(alvo))
      .find((alvo) => alvo.includes("datas-dos-negocios"));
    expect(url).toContain("pipeline_id=p-viagens");
    expect(url).toContain("campo=data_inicio");
    expect(url).toContain("campo_fim=data_fim");
  });

  it("a escolha gravada DESLIGADA volta desligada — e sem busca nenhuma", () => {
    montar({ ligada: false, funilId: "p-viagens", campo: "data_inicio", campoFim: null });

    expect(screen.getByTestId("camada-datas-alternar").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("camada-datas-itens")).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("cada mudança é gravada INTEIRA — ligar, escolher o campo, escolher o segundo, trocar de funil", async () => {
    const gravadas: Escolha[] = [];
    montar(undefined, (escolha) => gravadas.push(escolha));

    await userEvent.click(screen.getByTestId("camada-datas-alternar"));
    // Ligar já grava o objeto completo: funil visível na tela e nenhum campo
    // escolhido (nada de heurística de nome).
    expect(gravadas.at(-1)).toEqual({
      ligada: true,
      funilId: "p-viagens",
      campo: null,
      campoFim: null,
    });

    await userEvent.click(screen.getByRole("combobox", { name: "Campo de data do negócio" }));
    await userEvent.click(await screen.findByRole("option", { name: "Embarque" }));
    expect(gravadas.at(-1)).toEqual({
      ligada: true,
      funilId: "p-viagens",
      campo: "data_inicio",
      campoFim: null,
    });

    await userEvent.click(screen.getByRole("combobox", { name: "Segundo campo de data" }));
    await userEvent.click(await screen.findByRole("option", { name: "Retorno" }));
    expect(gravadas.at(-1)).toEqual({
      ligada: true,
      funilId: "p-viagens",
      campo: "data_inicio",
      campoFim: "data_fim",
    });

    // Funil novo, campos novos: o campo do funil anterior NÃO pode ficar na
    // escolha gravada — no outro funil ele não existe.
    await userEvent.click(screen.getByRole("combobox", { name: "Funil das datas" }));
    await userEvent.click(await screen.findByRole("option", { name: "Frota" }));
    expect(gravadas.at(-1)).toEqual({
      ligada: true,
      funilId: "p-frota",
      campo: null,
      campoFim: null,
    });
  });

  it("abrir a Agenda NÃO regrava por cima do que estava guardado", async () => {
    const gravadas: Escolha[] = [];
    montar(
      { ligada: true, funilId: "p-viagens", campo: "data_inicio", campoFim: null },
      (escolha) => gravadas.push(escolha),
    );

    // A primeira pintura não é escolha de ninguém: gravar aqui reescreveria a
    // preferência com o valor do render.
    await screen.findByTestId("camada-datas-aviso").catch(() => undefined);
    expect(gravadas).toEqual([]);
  });

  it("desligar e ligar de novo volta ao MESMO funil e campo da pessoa", async () => {
    const gravadas: Escolha[] = [];
    montar(
      { ligada: true, funilId: "p-viagens", campo: "data_inicio", campoFim: "data_fim" },
      (escolha) => gravadas.push(escolha),
    );

    await userEvent.click(screen.getByTestId("camada-datas-alternar"));
    expect(gravadas.at(-1)).toEqual({
      ligada: false,
      funilId: "p-viagens",
      campo: "data_inicio",
      campoFim: "data_fim",
    });

    cleanup();
    // A visita seguinte ao desligar e a remontagem com o que foi gravado: é o
    // caminho real (a pessoa desliga, fecha, volta).
    montar(gravadas.at(-1)!);
    expect(screen.getByTestId("camada-datas-alternar").getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(screen.getByTestId("camada-datas-alternar"));
    expect(
      screen.getByRole("combobox", { name: "Campo de data do negócio" }).textContent,
    ).toContain("Embarque");
  });
});
