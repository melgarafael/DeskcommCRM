/**
 * A META POR FUNIL NO CADASTRO (#4796, a parte que o #4820 deixou aberta).
 *
 * O banco já guarda a meta do funil (`crm_metas.pipeline_id`, índice único
 * `crm_metas_uma_por_funil_periodo_idx`) e o Desempenho já a lê e desenha
 * (`/api/v1/metrics/metas` recorta por `pipeline_id`; `MetaDoMesPanel` mostra o
 * nome do funil). Faltava a porta: a action gravava `pipeline_id: null` sempre
 * e o formulário só oferecia a empresa e os vendedores.
 *
 *   1. a action grava e corrige a meta DO FUNIL (mesma chave do índice);
 *   2. funil + vendedor juntos é recusado antes do banco (a constraint
 *      `crm_metas_dono_ou_funil` recusaria depois, com erro cru);
 *   3. funil de outra empresa, inexistente ou arquivado é recusado com código
 *      próprio — a organização vem da sessão e o funil tem de ser dela;
 *   4. o formulário oferece os funis que a página entrega e manda o
 *      `pipeline_id`, sem vendedor; a meta já gravada do funil aparece.
 */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const FUNIL_ARQUIVADO = "55555555-5555-4555-8555-555555555555";
const FUNIL_DE_OUTRA = "66666666-6666-4666-8666-666666666666";

const h = vi.hoisted(() => ({
  existente: null as { id: string; alvo: number } | null,
  funis: [] as Array<{ id: string; organization_id: string; is_archived: boolean }>,
  inseridas: [] as Array<Record<string, unknown>>,
  atualizadas: [] as Array<Record<string, unknown>>,
  /** Filtros da LEITURA da meta existente (`crm_metas`), em ordem. */
  filtrosDaMeta: [] as Array<[string, string, unknown]>,
  tabelasLidas: [] as string[],
  auditadas: [] as Array<Record<string, unknown>>,
  /** A outra pessoa gravou a MESMA chave entre a leitura e o insert desta. */
  conflito: false,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    h.auditadas.push(e);
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    is_platform_admin: false,
    platform_admin_scope: null,
    support: null,
  })),
  resolveActiveOrg: vi.fn(async () => ({
    orgId: "22222222-2222-4222-8222-222222222222",
    name: "Loja",
    role: "manager",
  })),
  mfaEmDivida: vi.fn(async () => false),
}));

function cadeia(tabela: string) {
  const filtros: Array<[string, string, unknown]> = [];
  const c = {
    select: () => c,
    eq: (col: string, val: unknown) => (filtros.push(["eq", col, val]), c),
    is: (col: string, val: unknown) => (filtros.push(["is", col, val]), c),
    maybeSingle: async () => {
      h.tabelasLidas.push(tabela);
      if (tabela === "crm_pipelines") {
        const quer = (col: string) => filtros.find(([, c2]) => c2 === col)?.[2];
        const achado = h.funis.find(
          (f) =>
            f.id === quer("id") &&
            f.organization_id === quer("organization_id") &&
            (quer("is_archived") === undefined || f.is_archived === quer("is_archived")),
        );
        return { data: achado ? { id: achado.id, is_archived: achado.is_archived } : null, error: null };
      }
      if (tabela === "crm_metas") h.filtrosDaMeta.push(...filtros);
      return { data: h.existente, error: null };
    },
    insert: async (linha: Record<string, unknown>) => {
      if (h.conflito) {
        h.conflito = false;
        h.existente = { id: "meta-da-outra-pessoa", alvo: 8 };
        return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      }
      h.inseridas.push(linha);
      return { error: null };
    },
    update: (valores: Record<string, unknown>) => {
      h.atualizadas.push(valores);
      const u = { eq: () => u, then: (r: (v: { error: null }) => void) => r({ error: null }) };
      return u;
    },
  };
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (tabela: string) => cadeia(tabela) }),
}));

const form = vi.hoisted(() => ({
  definir: vi.fn(),
  resposta: { ok: true } as { ok: boolean; error?: string },
  /** O que `/api/v1/metrics/metas` devolve por mês — o banco visto pelo formulário. */
  porMes: {} as Record<string, Array<Record<string, unknown>>>,
  lidos: [] as string[],
  /** Quantas leituras ainda falham (rede caída) antes de responder. */
  falhas: 0,
  /** Segura a resposta até alguém chamar `liberar()`. */
  segurar: false,
  liberar: null as null | (() => void),
  /** Segura a resposta do SALVAR até `liberarSalvar()`. */
  segurarSalvar: false,
  liberarSalvar: null as null | (() => void),
}));
vi.mock("@/hooks/team/useTeamMembers", () => ({
  useTeamMembers: () => ({ data: { data: [] }, isLoading: false, refetch: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { definirMetaMensal } = await import("@/app/actions/settings/definirMetaMensal");

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  h.existente = null;
  h.funis = [
    { id: FUNIL, organization_id: ORG, is_archived: false },
    { id: FUNIL_ARQUIVADO, organization_id: ORG, is_archived: true },
    { id: FUNIL_DE_OUTRA, organization_id: "99999999-9999-4999-8999-999999999999", is_archived: false },
  ];
  h.inseridas.length = 0;
  h.atualizadas.length = 0;
  h.filtrosDaMeta.length = 0;
  h.tabelasLidas.length = 0;
  h.auditadas.length = 0;
  h.conflito = false;
  form.definir.mockClear();
  form.resposta = { ok: true };
  form.porMes = {};
  form.lidos = [];
  form.falhas = 0;
  form.segurar = false;
  form.liberar = null;
  form.segurarSalvar = false;
  form.liberarSalvar = null;
});

afterEach(cleanup);

describe("#4796 — a action grava a meta do funil", () => {
  it("grava a meta do funil, sem vendedor, e audita o funil", async () => {
    const r = await definirMetaMensal({ periodo: "2026-11", alvo: 12, pipeline_id: FUNIL } as never);
    expect(r).toEqual({ ok: true });
    expect(h.inseridas).toEqual([
      expect.objectContaining({ organization_id: ORG, pipeline_id: FUNIL, vendedor_id: null, alvo: 12 }),
    ]);
    // A busca da linha existente é pela chave do índice do funil.
    expect(h.filtrosDaMeta).toContainEqual(["eq", "pipeline_id", FUNIL]);
    expect(h.auditadas[0]?.metadata).toEqual(expect.objectContaining({ pipeline_id: FUNIL }));
    expect(USER).toBeTruthy();
  });

  it("gravar de novo o mesmo funil e mês corrige, não duplica", async () => {
    h.existente = { id: "meta-1", alvo: 12 };
    const r = await definirMetaMensal({ periodo: "2026-11", alvo: 20, pipeline_id: FUNIL } as never);
    expect(r).toEqual({ ok: true });
    expect(h.inseridas).toEqual([]);
    expect(h.atualizadas).toEqual([expect.objectContaining({ alvo: 20 })]);
  });

  it("a primeira meta salva ao mesmo tempo por outra pessoa vira correção, não erro", async () => {
    h.conflito = true;
    const r = await definirMetaMensal({ periodo: "2026-11", alvo: 15, pipeline_id: FUNIL } as never);
    expect(r).toEqual({ ok: true });
    expect(h.atualizadas).toEqual([expect.objectContaining({ alvo: 15 })]);
    // O audit conta a correção da linha que nasceu, com o alvo de antes.
    expect(h.auditadas[0]).toEqual(
      expect.objectContaining({ action: "crm_meta.updated", resourceId: "meta-da-outra-pessoa" }),
    );
    expect(h.auditadas[0]?.metadata).toEqual(expect.objectContaining({ alvo_anterior: 8 }));
  });

  it("funil e vendedor juntos é recusado antes do banco", async () => {
    const r = await definirMetaMensal({
      periodo: "2026-11",
      alvo: 5,
      pipeline_id: FUNIL,
      vendedor_id: USER,
    } as never);
    expect(r).toEqual(expect.objectContaining({ ok: false, error: "validation_failed" }));
    expect(h.tabelasLidas).toEqual([]);
    expect(h.inseridas).toEqual([]);
  });

  it.each([
    ["arquivado", FUNIL_ARQUIVADO],
    ["de outra empresa", FUNIL_DE_OUTRA],
    ["inexistente", "77777777-7777-4777-8777-777777777777"],
  ])("funil %s é recusado com código próprio", async (_rotulo, id) => {
    const r = await definirMetaMensal({ periodo: "2026-11", alvo: 5, pipeline_id: id } as never);
    expect(r).toEqual(expect.objectContaining({ ok: false, error: "funil_invalido" }));
    expect(h.inseridas).toEqual([]);
    expect(h.atualizadas).toEqual([]);
  });
});

describe("#4796 — o formulário oferece o funil", () => {
  async function montar(metas: Array<Record<string, unknown>> | null = []) {
    vi.doMock("@/app/actions/settings/definirMetaMensal", () => ({
      definirMetaMensal: vi.fn(async (entrada: unknown) => {
        form.definir(entrada);
        if (form.segurarSalvar) await new Promise<void>((r) => (form.liberarSalvar = r));
        return form.resposta;
      }),
    }));
    vi.doMock("@/lib/api/client", () => ({
      apiClient: {
        get: vi.fn(async (url: string) => {
          // O mês sai do TEXTO da janela, como na rota.
          const de = decodeURIComponent(new URL(url, "http://x").searchParams.get("from") ?? "");
          const periodo = de.slice(0, 7);
          form.lidos.push(periodo);
          if (form.falhas > 0) {
            form.falhas -= 1;
            throw new Error("rede fora");
          }
          if (form.segurar) await new Promise<void>((r) => (form.liberar = r));
          return { data: { metas: form.porMes[periodo] ?? [] } };
        }),
      },
    }));
    vi.resetModules();
    const { FormularioDaMeta } = await import("@/app/app/settings/metas/_form");
    const props = {
      mes: "2026-11",
      metas,
      moeda: "BRL",
      funis: [{ id: FUNIL, name: "Vendas B2B" }],
    } as never;
    return render(createElement(IdiomaProvider, { locale: "pt-BR", children: createElement(FormularioDaMeta, props) }));
  }

  async function escolher(nome: string) {
    fireEvent.click(screen.getByRole("combobox", { name: "De quem é a meta" }));
    fireEvent.click(await screen.findByRole("option", { name: nome }));
  }

  it("o funil aparece no seletor e salvar manda o pipeline_id, sem vendedor", async () => {
    await montar();
    await escolher("Funil · Vendas B2B");
    const alvo = document.getElementById("alvo") as HTMLInputElement;
    fireEvent.change(alvo, { target: { value: "8" } });
    fireEvent.submit(alvo.closest("form")!);
    await waitFor(() => expect(form.definir).toHaveBeenCalledTimes(1));
    expect(form.definir).toHaveBeenCalledWith(
      expect.objectContaining({ pipeline_id: FUNIL, vendedor_id: null, alvo: 8 }),
    );
  });

  it("trocar o mês mostra a meta DAQUELE mês (lida do banco), não a deste", async () => {
    form.porMes["2026-12"] = [
      { periodo: "2026-12", indicador: "vendas_ganhas", vendedor_id: null, pipeline_id: FUNIL, alvo: 30 },
    ];
    await montar([{ periodo: "2026-11", indicador: "vendas_ganhas", vendedor_id: null, pipeline_id: FUNIL, alvo: 9 }]);
    await escolher("Funil · Vendas B2B");
    const alvo = document.getElementById("alvo") as HTMLInputElement;
    await waitFor(() => expect(alvo.value).toBe("9"));
    fireEvent.change(document.getElementById("periodo")!, { target: { value: "2026-12" } });
    await waitFor(() => expect(alvo.value).toBe("30"));
    expect(form.lidos).toContain("2026-12");
    fireEvent.change(document.getElementById("periodo")!, { target: { value: "2027-01" } });
    await waitFor(() => expect(form.lidos).toContain("2027-01"));
    await waitFor(() => expect(alvo.value).toBe(""));
    // Salvar em janeiro grava janeiro, com o número digitado — nunca o de outro mês.
    fireEvent.change(alvo, { target: { value: "4" } });
    fireEvent.submit(alvo.closest("form")!);
    await waitFor(() => expect(form.definir).toHaveBeenCalledWith(expect.objectContaining({ periodo: "2027-01", alvo: 4 })));
  });

  it("enquanto o mês lê, o campo trava e não diz «ainda não há meta»", async () => {
    form.porMes["2026-12"] = [
      { periodo: "2026-12", indicador: "vendas_ganhas", vendedor_id: null, pipeline_id: null, alvo: 30 },
    ];
    form.segurar = true;
    await montar([]);
    const alvo = document.getElementById("alvo") as HTMLInputElement;
    fireEvent.change(document.getElementById("periodo")!, { target: { value: "2026-12" } });
    await waitFor(() => expect(form.lidos).toContain("2026-12"));
    expect(alvo).toBeDisabled();
    expect(screen.queryByText("Ainda não há meta para este mês.")).toBeNull();
    expect(screen.getByRole("button", { name: "Salvar meta" })).toBeDisabled();
    form.liberar?.();
    await waitFor(() => expect(alvo.value).toBe("30"));
    expect(alvo).toBeEnabled();
  });

  it("a leitura falhou: «Tentar de novo» lê o mesmo mês outra vez", async () => {
    form.falhas = 1;
    form.porMes["2026-12"] = [
      { periodo: "2026-12", indicador: "vendas_ganhas", vendedor_id: null, pipeline_id: null, alvo: 30 },
    ];
    await montar([]);
    fireEvent.change(document.getElementById("periodo")!, { target: { value: "2026-12" } });
    const tentar = await screen.findByRole("button", { name: "Tentar de novo" });
    expect(screen.getByRole("button", { name: "Salvar meta" })).toBeDisabled();
    fireEvent.click(tentar);
    const alvo = document.getElementById("alvo") as HTMLInputElement;
    await waitFor(() => expect(alvo.value).toBe("30"));
    expect(form.lidos.filter((m) => m === "2026-12")).toHaveLength(2);
  });

  it("voltar a um mês já lido lê de novo (outra pessoa pode ter corrigido)", async () => {
    form.porMes["2026-12"] = [
      { periodo: "2026-12", indicador: "vendas_ganhas", vendedor_id: null, pipeline_id: null, alvo: 9 },
    ];
    await montar([]);
    const alvo = document.getElementById("alvo") as HTMLInputElement;
    const mes = document.getElementById("periodo")!;
    fireEvent.change(mes, { target: { value: "2026-12" } });
    await waitFor(() => expect(alvo.value).toBe("9"));
    fireEvent.change(mes, { target: { value: "2026-11" } });
    form.porMes["2026-12"] = [
      { periodo: "2026-12", indicador: "vendas_ganhas", vendedor_id: null, pipeline_id: null, alvo: 30 },
    ];
    fireEvent.change(mes, { target: { value: "2026-12" } });
    await waitFor(() => expect(alvo.value).toBe("30"));
    expect(form.lidos.filter((m) => m === "2026-12")).toHaveLength(2);
  });

  it("voltar ao mês em que a página abriu também lê de novo", async () => {
    await montar([{ periodo: "2026-11", indicador: "vendas_ganhas", vendedor_id: null, pipeline_id: null, alvo: 9 }]);
    const alvo = document.getElementById("alvo") as HTMLInputElement;
    const mes = document.getElementById("periodo")!;
    await waitFor(() => expect(alvo.value).toBe("9"));
    fireEvent.change(mes, { target: { value: "2026-12" } });
    await waitFor(() => expect(form.lidos).toContain("2026-12"));
    // Outra pessoa corrigiu novembro enquanto esta tela olhava dezembro.
    form.porMes["2026-11"] = [
      { periodo: "2026-11", indicador: "vendas_ganhas", vendedor_id: null, pipeline_id: null, alvo: 30 },
    ];
    fireEvent.change(mes, { target: { value: "2026-11" } });
    await waitFor(() => expect(alvo.value).toBe("30"));
    expect(form.lidos).toContain("2026-11");
  });

  it("a resposta de um salvar antigo não apaga o que já se digita em outro mês", async () => {
    form.segurarSalvar = true;
    await montar([]);
    const alvo = document.getElementById("alvo") as HTMLInputElement;
    const mes = document.getElementById("periodo")!;
    fireEvent.change(alvo, { target: { value: "5" } });
    fireEvent.submit(alvo.closest("form")!);
    await waitFor(() => expect(form.definir).toHaveBeenCalledTimes(1));
    fireEvent.change(mes, { target: { value: "2027-01" } });
    await waitFor(() => expect(alvo).toBeEnabled());
    fireEvent.change(alvo, { target: { value: "18" } });
    const leiturasAntes = form.lidos.length;
    form.liberarSalvar?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(alvo.value).toBe("18");
    expect(form.lidos.length).toBe(leiturasAntes);
  });

  it("no mesmo mês, a resposta de um salvar não troca o que já se digita em outro indicador", async () => {
    form.segurarSalvar = true;
    await montar([
      { periodo: "2026-11", indicador: "valor_vendido", vendedor_id: null, pipeline_id: null, alvo: 90000 },
    ]);
    const alvo = document.getElementById("alvo") as HTMLInputElement;
    fireEvent.change(alvo, { target: { value: "5" } });
    fireEvent.submit(alvo.closest("form")!);
    await waitFor(() => expect(form.definir).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("combobox", { name: "Indicador" }));
    fireEvent.click(await screen.findByRole("option", { name: /Valor vendido/ }));
    await waitFor(() => expect(alvo.value).toBe("900.00"));
    fireEvent.change(alvo, { target: { value: "1800" } });
    form.liberarSalvar?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(alvo.value).toBe("1800");
  });

  it("a página não conseguiu ler o mês: o formulário lê sozinho, sem dizer «sem meta»", async () => {
    form.porMes["2026-11"] = [
      { periodo: "2026-11", indicador: "vendas_ganhas", vendedor_id: null, pipeline_id: null, alvo: 9 },
    ];
    await montar(null);
    const alvo = document.getElementById("alvo") as HTMLInputElement;
    await waitFor(() => expect(form.lidos).toContain("2026-11"));
    await waitFor(() => expect(alvo.value).toBe("9"));
  });

  it("a meta já gravada do funil aparece ao escolher o funil", async () => {
    await montar([
      { indicador: "vendas_ganhas", vendedor_id: null, pipeline_id: null, alvo: 40 },
      { indicador: "vendas_ganhas", vendedor_id: null, pipeline_id: FUNIL, alvo: 9 },
    ]);
    const alvo = document.getElementById("alvo") as HTMLInputElement;
    await waitFor(() => expect(alvo.value).toBe("40"));
    await escolher("Funil · Vendas B2B");
    await waitFor(() => expect(alvo.value).toBe("9"));
  });
});
