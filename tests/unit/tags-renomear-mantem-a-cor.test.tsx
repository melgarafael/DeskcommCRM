/**
 * RENOMEAR UMA ETIQUETA COLORIDA CONTINUA PINTADA — sem F5 (issue #2771).
 *
 * ─── O que está sendo medido ────────────────────────────────────────────────
 *
 * A cor é VOCABULÁRIO: mora numa entrada por nome (`organizations.settings.tags`)
 * e o chip pergunta "de que cor é esta etiqueta" ao mapa do provider
 * (`components/tags/CoresDasEtiquetas.tsx`, `staleTime` de 5 min). Renomear muda
 * o NOME no banco — e é aí que este teste aponta: a função de banco leva o
 * verbete de cor junto (medido na 0336, `jsonb_set` mexe só em `{tag}`), mas a
 * TELA só invalidava o mapa quando a ação era `definir_cor`. Renomear, juntar e
 * excluir deixavam o mapa com a chave ANTIGA até o cache vencer: o chip da lista,
 * o funil, os filtros e os editores do Inbox perdiam a pintura no mesmo clique —
 * era este o "renomear descolora" da issue.
 *
 * ─── Por que o teste monta painel + provider + um chip FORA do painel ────────
 *
 * O chip do painel pinta pela `cor` que ele acabou de ler do servidor
 * (`linha.cor`), então ele nunca fica cinza — e passaria mesmo com o defeito.
 * Quem sente o defeito é o chip que lê o MAPA, o mesmo que a lista de conversas
 * usa: é ele que está aqui, com o nome NOVO, antes e depois do rename.
 *
 * O banco não é medido aqui (precisa de Postgres — `pnpm test:db`); o contrato
 * de texto do SQL está em `tests/unit/tags-vocabulario.test.ts`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { LinhaDeVocabulario } from "@/lib/schemas/tags";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

/** O mapa do chip é lido por `/api/v1/tags/cores` — contar as leituras é a
 * assinatura visível de "o mapa foi invalidado e buscado de novo". */
const gets = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...args: unknown[]) => gets(...args), post: vi.fn(), patch: vi.fn() },
}));

/** O provider precisa da organização ATIVA (`useAuth`), como na tela real. */
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1", role: "manager" } }),
}));

import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { ProvedorDeCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";
import { CHAVES_COM_NOME_DE_ETIQUETA, PainelDeTags } from "@/app/app/settings/tags/_painel";
import { SeletorDeCorDaEtiqueta } from "@/components/tags/SeletorDeCorDaEtiqueta";

const OBRA: LinhaDeVocabulario = {
  tag: "obra",
  uso_em_contatos: 3,
  uso_em_leads: 0,
  uso_em_conversas: 1,
  em_regras: 0,
  cor: "#0091ff",
  descricao: null,
  no_vocabulario: true,
};

/** O que o banco devolve para o mapa do chip: antes e depois do rename. */
let renomeado = false;
let invalidadas: MockInstance<QueryClient["invalidateQueries"]>;

const leiturasDeCores = () =>
  gets.mock.calls.filter(([url]) => url === "/api/v1/tags/cores").length;

const pintado = (el: HTMLElement) => (el.getAttribute("style") ?? "").replace(/\s/g, "");

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  gets.mockReset();
  renomeado = false;
  gets.mockImplementation(async (url: string) =>
    url === "/api/v1/tags/cores"
      ? { data: renomeado ? [{ tag: "obra-nova", cor: "#0091ff" }] : [{ tag: "obra", cor: "#0091ff" }] }
      : { data: [] },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { body?: string }) => {
      const corpo = JSON.parse(init?.body ?? "{}") as { acao?: string };
      // O rename já aconteceu no SERVIDOR quando a resposta sai: é o instante
      // em que o mapa precisa ser lido de novo.
      if (corpo.acao === "renomear") renomeado = true;
      return new Response(
        JSON.stringify({ data: { alterou: true, contatos: 1, leads: 0, conversas: 0, regras: 0 } }),
        { status: 200 },
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function montar(tags: LinhaDeVocabulario[] = [OBRA]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidadas = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <ProvedorDeCoresDasEtiquetas>
        {/* O chip da LISTA, com o nome que o contato vai ter depois do rename.
            Ele é quem lê o mapa — é ele que fica cinza sem a invalidação. */}
        <ChipDeEtiqueta tag="obra-nova" />
        <PainelDeTags tags={tags} idioma="pt-BR" />
      </ProvedorDeCoresDasEtiquetas>
    </QueryClientProvider>,
  );
}

function renomearPara(novoNome: string) {
  fireEvent.click(screen.getByRole("button", { name: "Renomear" }));
  fireEvent.change(screen.getByLabelText("Novo nome"), { target: { value: novoNome } });
  fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
}

describe("renomear uma etiqueta colorida (#2771)", () => {
  it("⭐ depois do rename a cor CONTINUA na etiqueta nova, sem F5", async () => {
    montar();
    // O mapa só responde depois desta leitura — sem ela, a asserção seguinte
    // passaria antes de existir mapa nenhum (verde vácuo).
    await waitFor(() => expect(leiturasDeCores()).toBe(1));

    const chip = screen.getByText("obra-nova");
    expect(pintado(chip)).not.toContain("background-color");

    renomearPara("obra-nova");
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    // O mapa é invalidado, BUSCADO DE NOVO e o chip volta a exibir o mesmo tom.
    await waitFor(() => expect(leiturasDeCores()).toBeGreaterThan(1), { timeout: 4000 });
    await waitFor(
      () => expect(pintado(screen.getByText("obra-nova"))).toMatch(/rgb\(0,\s*145,\s*255\)|#0091ff/i),
      { timeout: 4000 },
    );
  });

  it("excluir também tira o verbete do mapa — mesma invalidação", async () => {
    montar();
    await waitFor(() => expect(leiturasDeCores()).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Excluir" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    await waitFor(() => expect(leiturasDeCores()).toBeGreaterThan(1), { timeout: 4000 });
  });
});

/**
 * O NOME também mora em cache, não só a cor (prova de tela do #2784): sem estas
 * invalidações, voltar ao Inbox logo depois do rename mostrava "vip" cinza na
 * lista e no editor, e o filtro oferecia "vip" sem o nome novo.
 */
describe("renomear/juntar/excluir relê todo cache que guarda o nome da etiqueta", () => {
  const chavesInvalidadas = () =>
    invalidadas.mock.calls.map(([filtro]) => JSON.stringify(filtro?.queryKey));

  it.each(["Renomear", "Juntar", "Excluir"])("%s invalida conversas, contatos, vocabulários e funil", async (botao) => {
    // `juntar` precisa de um destino existente na lista.
    montar([OBRA, { ...OBRA, tag: "casa", cor: null }]);
    fireEvent.click(screen.getAllByRole("button", { name: botao })[0]!);
    if (botao === "Renomear") {
      fireEvent.change(screen.getByLabelText("Novo nome"), { target: { value: "obra-nova" } });
    }
    if (botao === "Juntar") {
      fireEvent.change(screen.getByLabelText("Etiqueta de destino"), { target: { value: "casa" } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    for (const chave of [
      ["conversations"],
      ["conversation"],
      ["conversation-tag-vocabulary"],
      ["contacts"],
      ["contact"],
      ["contact-tag-vocabulary"],
      ["board"],
    ]) {
      expect(chavesInvalidadas()).toContain(JSON.stringify(chave));
    }
    expect(CHAVES_COM_NOME_DE_ETIQUETA).toHaveLength(7);
  });
});

describe("gatilho da cor no editor", () => {
  it("é 28x28 no desktop (o `lg:h-8` do size=sm não sobrevive) e 44x44 abaixo de `lg`, como o toque pede", () => {
    render(<SeletorDeCorDaEtiqueta cor={null} onChange={() => {}} />);
    const classes = screen.getByRole("button", { name: "Cor da etiqueta" }).className.split(/\s+/);
    expect(classes).toContain("lg:h-7");
    expect(classes).toContain("lg:w-7");
    expect(classes).not.toContain("lg:h-8");
    expect(classes).toContain("h-11");
    expect(classes).toContain("w-11");
  });
});

describe("o aviso de junção antes do clique (#2801)", () => {
  const AVISO =
    "Este nome já existe no vocabulário — confirmar vai juntar as duas etiquetas numa só.";
  const VIP: LinhaDeVocabulario = { ...OBRA, tag: "vip", cor: null };

  it("mudar só a caixa da própria etiqueta NÃO avisa junção; o nome de OUTRA avisa", () => {
    montar([OBRA, VIP]);
    fireEvent.click(screen.getAllByRole("button", { name: "Renomear" })[0]!);
    const campo = screen.getByLabelText("Novo nome");

    // "obra" → "OBRA" é renome: a lista de comparação não inclui a própria etiqueta.
    fireEvent.change(campo, { target: { value: "OBRA" } });
    expect(screen.queryByText(AVISO)).toBeNull();

    // "obra" → "VIP" junta com a outra linha: o aviso aparece antes de confirmar.
    fireEvent.change(campo, { target: { value: "VIP" } });
    expect(screen.getByText(AVISO)).toBeTruthy();
  });
});
