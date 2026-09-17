/**
 * O ASSUNTO DO CASO SAI DA ROTA E CHEGA NA TELA.
 *
 * ## O defeito que esta cerca fecha
 *
 * `agent_cases.kind` entrou na consulta (`COLUNAS_LISTA`, em
 * `lib/escalacao/chamados.ts`) e na interface do cliente — e NÃO entrou em
 * `achatarContato`, que é a projeção escrita à mão por onde todo caso passa
 * antes de virar JSON. A coluna vinha do banco e morria no `map`. Efeito: todo
 * caso da fila renderizava "Outro", para sempre.
 *
 * Nada pegou porque nada LIGAVA as duas pontas: o tipo do cliente era uma
 * segunda cópia escrita à mão, e `apiClient.get<…>()` é um cast sobre JSON, não
 * uma checagem. Verde nos gates prova que nada que o CI mede quebrou — não que
 * a funcionalidade chegou.
 *
 * ## Por que o dublê do PostgREST HONRA a lista de colunas
 *
 * Porque `COLUNAS_LISTA` é uma STRING: nenhum compilador a lê. Um dublê que
 * devolvesse a linha inteira independentemente do `select` deixaria este
 * arquivo verde no dia em que alguém tirasse `kind` da consulta — a metade do
 * defeito que o tipo não cobre. Aqui o dublê projeta como o PostgREST projeta.
 *
 * ## Onde a sonda olha
 *
 * No TEXTO DA TELA, atravessando as três camadas de verdade: a consulta, a
 * projeção da rota e o componente. O valor que o `CaseList` recebe é o que
 * `listarChamados` devolveu — não um objeto escrito pelo teste.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/caso-tem-tipo-da-rota-ate-a-tela.test.tsx
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listarChamados, type ChamadoDaLista } from "@/lib/escalacao/chamados";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/app/app/ai/cases/_components/CaseDetail", () => ({
  CaseDetail: () => null,
}));

const { CaseList } = await import("@/app/app/ai/cases/_components/CaseList");

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";

/** A linha como o banco a tem — com o assunto que a IA classificou. */
const LINHA_DO_BANCO = {
  id: "case-1",
  title: "Quer marcar para quinta",
  summary: "A cliente pediu horário",
  blocker: "Preciso confirmar a agenda",
  status: "awaiting_human",
  kind: "agendamento",
  opened_at: "2026-09-14T10:00:00.000Z",
  conversation_id: "conv-1",
  source: "agent",
  closed_at: null,
  conversations: { contacts: { name: "Joana Prado", phone_number: "+5511999998888" } },
} as const;

/**
 * Projeta a linha pela lista de colunas do `select`, como o PostgREST faz.
 * Só o nível de cima importa aqui — o embed de contato vai inteiro.
 */
function projetar(select: string, linha: Record<string, unknown>): Record<string, unknown> {
  const topo: string[] = [];
  let profundidade = 0;
  let atual = "";
  for (const c of select) {
    if (c === "(") profundidade++;
    if (c === ")") profundidade--;
    if (c === "," && profundidade === 0) {
      topo.push(atual);
      atual = "";
      continue;
    }
    atual += c;
  }
  topo.push(atual);

  const saida: Record<string, unknown> = {};
  for (const bruto of topo) {
    const nome = bruto.trim().split(":")[0]!.trim();
    if (nome in linha) saida[nome] = linha[nome];
  }
  return saida;
}

function clienteFake(): SupabaseClient {
  return {
    from: () => ({
      select: (colunas: string, opts?: { count?: string; head?: boolean }) => {
        const cadeia: Record<string, unknown> = {};
        const resposta = () =>
          opts?.head
            ? { data: null, error: null, count: 1 }
            : { data: [projetar(colunas, LINHA_DO_BANCO as never)], error: null, count: 1 };
        for (const m of ["eq", "in", "order", "limit"]) cadeia[m] = () => cadeia;
        cadeia.then = (r: (v: unknown) => unknown) => r(resposta());
        return cadeia;
      },
    }),
  } as unknown as SupabaseClient;
}

function envolver(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** O que a rota devolveria, montado pelo caminho de produção. */
async function corpoDaRota(): Promise<{ cases: ChamadoDaLista[]; open_count: number }> {
  const { chamados, abertos } = await listarChamados(clienteFake(), ORG, { estado: "abertos" });
  return { cases: chamados, open_count: abertos };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("o assunto do caso atravessa a rota inteira", () => {
  it("a projeção da rota devolve o assunto que veio do banco", async () => {
    const { cases } = await corpoDaRota();

    expect(cases).toHaveLength(1);
    expect(
      cases[0]!.kind,
      "a rota engoliu o assunto entre a consulta e o JSON: a coluna existe no banco, a tela recebe `undefined` e mostra o rótulo genérico para todo caso — sem erro em lugar nenhum",
    ).toBe("agendamento");
  });

  it("e a tela escreve o rótulo desse assunto, não o genérico", async () => {
    const corpo = await corpoDaRota();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: corpo }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    envolver(<CaseList />);

    await waitFor(() => expect(screen.getByTestId("case-item")).toBeInTheDocument());
    const linha = screen.getByTestId("case-item");
    expect(
      linha.textContent,
      "a fila mostra o rótulo genérico: quem tria não consegue separar 'quer marcar horário' de 'está reclamando' antes de abrir cada caso, que é a única coisa que esta feature serve para fazer",
    ).toContain("Horário");
    expect(linha.textContent).not.toContain("Outro");
  });

  it("assunto que este build não conhece cai no genérico em vez de quebrar a tela", async () => {
    // O par de vacuidade: prova que o texto vem do VALOR e não de um rótulo
    // fixo — e congela a decisão de vocabulário aberto (um clone com engine
    // mais novo não pode derrubar a fila).
    const corpo = await corpoDaRota();
    corpo.cases[0]!.kind = "troca-de-produto";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: corpo }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    envolver(<CaseList />);

    await waitFor(() => expect(screen.getByTestId("case-item")).toBeInTheDocument());
    expect(screen.getByTestId("case-item").textContent).toContain("Outro");
  });
});
