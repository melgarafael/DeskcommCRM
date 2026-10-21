/**
 * A TELA CONTINUA A AGENDA DE ONDE PAROU (#2736, ponto 2 do CR do #2776).
 *
 * O mantenedor mediu uma agenda dublê de 1.500 salvos: quatro cliques
 * importavam 500, 500, 0 e 0, todos com `truncado: true`, e os 500 depois do
 * milésimo nunca entravam. A causa era a tela (e o serviço) recomeçarem do
 * offset zero a cada clique.
 *
 * Aqui roda o componente de VERDADE, sobre o hook de verdade, com o `fetch`
 * devolvendo o corpo EXATO da rota: o que este arquivo prende é o fio que
 * faltava — o `proximo_offset` do resumo vira o `offset` do corpo do clique
 * seguinte. Dublar o hook provaria só que a tela sabe chamar uma função; o
 * defeito morava justamente no que atravessa a rede.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResumoDaAgenda } from "@/hooks/contacts/useSyncPhoneContacts";
import { SyncPhoneContactsDialog } from "./SyncPhoneContactsDialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
// O seletor de número é dublado (a lista de canais tem testes próprios); o
// `channelLabel` vem do mesmo módulo, então o dublê precisa dos dois.
vi.mock("@/hooks/channels/useChannelSessions", async () => {
  // O provider padrão é o canal que TEM agenda do aparelho (capability
  // `phonebook`); o diálogo filtra por capability, e a fixture não nomeia o
  // provider (cerca `lint-channels`).
  const { DEFAULT_CHANNEL_PROVIDER } = await vi.importActual<
    typeof import("@/lib/channels/capabilities")
  >("@/lib/channels/capabilities");
  return {
    useChannelSessions: () => ({
      data: [
        {
          id: "canal-1",
          provider: DEFAULT_CHANNEL_PROVIDER,
          status: "WORKING",
          display_name: "Comercial",
          phone_number: "+5511900000000",
        },
      ],
      isLoading: false,
      isError: false,
    }),
    channelLabel: (c: { display_name: string | null }) => c.display_name ?? "",
  };
});

/** Corpo que a rota devolve — o MESMO contrato de `ResumoDaAgenda`. */
function resumo(parcial: Partial<ResumoDaAgenda>): ResumoDaAgenda {
  return {
    lidos: 0,
    importados: 0,
    ja_existentes: 0,
    ignorados: 0,
    erros: 0,
    truncado: false,
    proximo_offset: null,
    ...parcial,
  };
}

const fetchMock = vi.fn();

function respostaDaRota(data: ResumoDaAgenda) {
  return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
}

/** O corpo que a tela mandou em cada clique. */
function corposEnviados(): Array<{ channel_session_id: string; offset: number }> {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

function montar() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SyncPhoneContactsDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SyncPhoneContactsDialog — retomada", () => {
  it("o clique seguinte manda o `proximo_offset` que o resumo devolveu", async () => {
    const usuario = userEvent.setup();
    fetchMock
      // 1º clique: bateu no teto de importação e disse de onde continuar.
      .mockReturnValueOnce(
        respostaDaRota(
          resumo({ lidos: 1000, importados: 500, ja_existentes: 500, truncado: true, proximo_offset: 500 }),
        ),
      )
      // 2º clique: a agenda acabou.
      .mockReturnValueOnce(respostaDaRota(resumo({ lidos: 500, importados: 500 })));

    montar();
    await usuario.click(await screen.findByRole("button", { name: "Sincronizar" }));

    // A tela mostra o resumo da passada e oferece CONTINUAR (não recomeçar).
    expect(await screen.findByText("1000 lido(s) no aparelho")).toBeInTheDocument();
    expect(screen.getByText("500 importado(s)")).toBeInTheDocument();
    const continuar = await screen.findByRole("button", { name: "Continuar de onde parou" });
    // Enquanto há cursor, "Sincronizar de novo" (que volta ao zero) não aparece.
    expect(screen.queryByRole("button", { name: "Sincronizar de novo" })).toBeNull();

    await usuario.click(continuar);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // O QUE IMPORTA: os dois cliques, no fio. O primeiro começa do zero; o
    // segundo começa na linha 500 — o cursor devolvido, não o zero de novo.
    expect(corposEnviados()).toEqual([
      { channel_session_id: "canal-1", offset: 0 },
      { channel_session_id: "canal-1", offset: 500 },
    ]);

    // A agenda acabou: some o aviso de teto e volta o "Sincronizar de novo".
    expect(await screen.findByRole("button", { name: "Sincronizar de novo" })).toBeInTheDocument();
    expect(screen.queryByText(/bateu no teto/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Continuar de onde parou" })).toBeNull();
  });

  it("agenda que cabe numa passada resolve no primeiro clique, sem cursor pendente", async () => {
    const usuario = userEvent.setup();
    fetchMock.mockReturnValueOnce(respostaDaRota(resumo({ lidos: 12, importados: 12 })));

    montar();
    await usuario.click(await screen.findByRole("button", { name: "Sincronizar" }));

    expect(await screen.findByText("12 importado(s)")).toBeInTheDocument();
    expect(screen.queryByText(/bateu no teto/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Continuar de onde parou" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sincronizar de novo" })).toBeInTheDocument();
    expect(corposEnviados()).toEqual([{ channel_session_id: "canal-1", offset: 0 }]);
  });
});
