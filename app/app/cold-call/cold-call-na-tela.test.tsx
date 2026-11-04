/**
 * Três defeitos da prova pela tela do #3933 (head a46150bf1), cada um com o seu caso:
 *
 * 1. Importar a planilha NA TELA do Cold Call deixava a fila em "(0)" até recarregar: o
 *    QueryClient não refaz consulta no foco e o staleTime é de 30 s, e o ImportarLeads não
 *    avisava ninguém. Agora ele chama `onImportado`, e a tela invalida ["cold-call"].
 * 2. A lixeira "Tirar da fila" media 25×25 px no celular. Alvo de 44 px abaixo de `lg`.
 * 3. No lead que não recebe ligação, o seletor "Resultado Cold Call" seguia ativo, e o Salvar
 *    levava um 403 do servidor. Agora ele fica desabilitado e diz por quê.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";

import { ColdCall, SeletorDoResultado } from "./_client";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-1", name: "Clínica", role: "admin" }),
  useUser: () => ({ id: "u", email: "u@x.com" }),
}));
vi.mock("@/hooks/team/useTeamMembers", () => ({ useTeamMembers: () => ({ data: { data: [] } }) }));
vi.mock("./_guia", () => ({ GuiaDoColdCall: () => null, guiaJaVisto: () => true }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
// O ImportarLeads de verdade sobe arquivo; aqui ele é só o botão que avisa "importei".
vi.mock("@/app/app/kanban/_components/ImportarLeads", () => ({
  ImportarLeads: ({ onImportado }: { onImportado?: () => void }) => (
    <button type="button" onClick={() => onImportado?.()}>
      importar-falso
    </button>
  ),
}));

const FUNIL = { id: "funil", name: "Cold Call", slug: "cold-call", description: null, position: 1, is_default: false };

function lead(i: number) {
  return {
    id: `lead-${i}`,
    titulo: `Lead ${i}`,
    descricao: null,
    tags: [],
    contato_id: `contato-${i}`,
    tem_foto: false,
    nao_ligar: null,
    contato_nome: `Pessoa ${i}`,
    telefone: `+5511900000${i}`,
    email: null,
    endereco: null,
    conversa_id: null,
    responsavel_id: null,
    etapa: "na-fila",
    etapa_nome: "Na fila",
    tentativas: 0,
    ultima_tentativa_em: null,
    ultimo_resultado: null,
    historico: [],
    criado_em: "2026-11-01T00:00:00Z",
  };
}

function comQuery(ui: ReactNode) {
  // A régua de produção que esconde o defeito: sem refetch no foco e staleTime de 30 s.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("importar na tela do Cold Call atualiza a fila", () => {
  it("depois de importar, a fila é lida de novo e mostra quem entrou", async () => {
    vi.mocked(apiClient.get)
      .mockResolvedValueOnce({ data: { funil: FUNIL, roteiro: "", leads: [] } })
      .mockResolvedValue({ data: { funil: FUNIL, roteiro: "", leads: [lead(1)] } });
    render(comQuery(<ColdCall />));
    await screen.findByText("importar-falso");
    expect(screen.queryByText("Lead 1")).toBeNull();

    fireEvent.click(screen.getByText("importar-falso"));

    expect(await screen.findByText("Lead 1")).toBeTruthy();
    expect(vi.mocked(apiClient.get).mock.calls.filter(([p]) => p === "/api/v1/cold-call")).toHaveLength(2);
  });
});

describe("a lixeira de cada linha tem alvo de 44 px no celular", () => {
  it("size-11 abaixo de lg, compacta só a partir de lg", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { funil: FUNIL, roteiro: "", leads: [lead(1)] } });
    render(comQuery(<ColdCall />));
    const lixeira = await screen.findByRole("button", { name: "Tirar da fila: Lead 1" });
    const classes = lixeira.className.split(/\s+/);
    expect(classes).toContain("size-11");
    expect(classes).toContain("lg:size-8");
    // Nada que encolha o alvo no celular por cima do size-11.
    expect(classes.filter((c) => /^(p-1|size-[0-9]|h-[0-9]|w-[0-9])$/.test(c) && c !== "size-11")).toEqual([]);
  });
});

describe("o resultado de quem não recebe ligação", () => {
  for (const motivo of ["bloqueado", "pessoal", "anonimizado"] as const) {
    it(`${motivo}: o seletor fica desabilitado, com o motivo escrito`, () => {
      const aoMudar = vi.fn();
      render(<SeletorDoResultado valor={null} aoMudar={aoMudar} naoLigar={motivo} />);
      const seletor = screen.getByTestId("resultado-cold-call") as HTMLSelectElement;
      expect(seletor.disabled).toBe(true);
      expect(screen.getByTestId("motivo-sem-resultado").textContent).toContain("Não ligar");
      expect(seletor.getAttribute("aria-describedby")).toBe("resultado-cold-call-motivo");
    });
  }

  it("controle: contato comum escolhe o resultado normalmente", () => {
    const aoMudar = vi.fn();
    render(<SeletorDoResultado valor={null} aoMudar={aoMudar} naoLigar={null} />);
    const seletor = screen.getByTestId("resultado-cold-call") as HTMLSelectElement;
    expect(seletor.disabled).toBe(false);
    expect(screen.queryByTestId("motivo-sem-resultado")).toBeNull();
    fireEvent.change(seletor, { target: { value: "nao_atendeu" } });
    expect(aoMudar).toHaveBeenCalledWith("nao_atendeu");
  });
});
