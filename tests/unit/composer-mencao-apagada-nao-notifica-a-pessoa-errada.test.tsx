import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A MENÇÃO APAGADA NÃO PODE NOTIFICAR A PESSOA ERRADA (#2463).
 *
 * ─── O defeito, na sequência exata da issue ─────────────────────────────────
 *
 * A lista de escolhas (`mencoes`) só era zerada quando a nota era salva. Quem
 * apagava uma menção do texto mantinha a escolha na lista, e o `embutirMencoes`
 * consome em ORDEM: com duas "Ana Lima" na organização, "escolher Ana
 * (pessoa 1), apagar, escolher Ana (pessoa 2)" gravava o id da pessoa 1 — a
 * notificação ia para quem não foi mencionado, e o texto das duas é idêntico,
 * então a tela não mostra diferença nenhuma.
 *
 * ⚠️ O CASO ENTRA PELO COMPOSER DE VERDADE: abre o modo nota, digita o `@`,
 * clica na lista, apaga, escolhe de novo e envia — o que se confere é o corpo
 * que sai para `useCreateNote`, que é o que o banco grava e o que o sino lê.
 *
 * Os três casos andam juntos: sem o controle (escolher a 1ª SEM apagar), uma
 * correção que sempre preferisse a última passaria; sem o caso das duas
 * ocorrências legítimas, uma poda larga demais que derrubasse as duas também
 * passaria.
 */

const { membros } = vi.hoisted(() => ({
  membros: [
    // O rótulo é o MESMO — é o que a issue mede. O que difere é o `user_id`,
    // que é o que sai no token (e para onde a notificação vai).
    { user_id: "ana-lima-0001", role: "agent", full_name: "Ana Lima" },
    { user_id: "ana-lima-0002", role: "agent", full_name: "Ana Lima" },
  ],
}));

const sendMock = vi.fn();
const createNoteMock = vi.fn();
const uploadMock = vi.fn();

vi.mock("@/hooks/inbox/useSendMessage", () => ({ useSendMessage: () => ({ mutate: sendMock, isPending: false }) }));
vi.mock("@/hooks/inbox/useCreateNote", () => ({ useCreateNote: () => ({ mutate: createNoteMock, isPending: false }) }));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: uploadMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({ useMessageTemplates: () => ({ data: [], isLoading: false }) }));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: membros, isLoading: false }),
}));

import { Composer } from "@/components/inbox/Composer";

function abrirModoNota() {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <Composer conversationId="conv-1" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));
  return screen.getByLabelText(/mensagem/i);
}

async function digitar(texto: string) {
  const campo = screen.getByLabelText(/mensagem/i);
  fireEvent.change(campo, { target: { value: texto } });
  return campo;
}

async function escolherNaLista(indice: number) {
  const lista = await screen.findByRole("listbox", { name: /atendentes para mencionar/i });
  // As duas opções têm o MESMO rótulo: quem distingue é a POSIÇÃO na lista,
  // que segue a ordem dos membros (`membros[0]` → 0001, `membros[1]` → 0002).
  fireEvent.click(within(lista).getAllByRole("option", { name: /ana lima/i })[indice]!);
  // A escolha agenda um `requestAnimationFrame` (`escolherMencao`) que devolve
  // o foco e a SELEÇÃO para a posição de inserção. No navegador, com gente
  // digitando, ele sempre roda antes do próximo evento; no teste comprimido,
  // ele pode cair DEPOIS do próximo `change` — o `onSelect` do textarea então
  // regride o `caret`, e o clique seguinte no menu vira no-op silencioso (foi
  // assim que este arquivo ficou dependente de carga). Drenar a frame aqui
  // devolve a ordem real: escolhe → frame → digita.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function enviarNota() {
  fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
  await waitFor(() => expect(createNoteMock).toHaveBeenCalled());
  return createNoteMock.mock.calls[0]![0] as { conversation_id: string; body: string };
}

describe("menção apagada não notifica a pessoa errada", () => {
  beforeEach(() => {
    sendMock.mockClear();
    createNoteMock.mockClear();
    uploadMock.mockClear();
  });

  it("⭐ escolher a 1ª Ana, apagar, escolher a 2ª: o token que sai é o da 2ª", async () => {
    abrirModoNota();
    await digitar("fala com @an");
    await escolherNaLista(0); // pessoa 1
    expect(screen.getByLabelText(/mensagem/i)).toHaveValue("fala com @Ana Lima ");

    // O gesto da issue: apaga a menção inteira do texto.
    await digitar("fala com ");
    await digitar("fala com @an");
    await escolherNaLista(1); // pessoa 2

    await digitar("fala com @Ana Lima sobre o orçamento");
    const enviado = await enviarNota();

    expect(enviado.conversation_id).toBe("conv-1");
    expect(enviado.body, "a escolha APAGADA roubou a menção: o sino chamaria a pessoa errada").toBe(
      "fala com @[Ana Lima](mencao:ana-lima-0002) sobre o orçamento",
    );
    expect(enviado.body).not.toContain("ana-lima-0001");
    expect(sendMock, "nota interna não sai para o cliente").not.toHaveBeenCalled();
  });

  it("controle: escolher a 1ª e NÃO apagar grava o id da 1ª", async () => {
    // Sem este caso, uma correção que sempre preferisse a última escolha
    // passaria no ⭐ — trocando a pessoa errada por outra.
    abrirModoNota();
    await digitar("fala com @an");
    await escolherNaLista(0);

    await digitar("fala com @Ana Lima sobre o orçamento");
    const enviado = await enviarNota();

    expect(enviado.body).toBe("fala com @[Ana Lima](mencao:ana-lima-0001) sobre o orçamento");
    expect(enviado.body).not.toContain("ana-lima-0002");
  });

  it("duas menções legítimas no texto: dois tokens, um de cada Ana (a poda não derruba escolha viva)", async () => {
    abrirModoNota();
    await digitar("fala com @an");
    await escolherNaLista(0);
    await digitar("fala com @Ana Lima e @an");
    await escolherNaLista(1);

    await digitar("fala com @Ana Lima e @Ana Lima sobre o orçamento");
    const enviado = await enviarNota();

    // O pareamento é por POSIÇÃO: a 1ª ocorrência é da pessoa 1 (escolhida
    // primeiro), a 2ª é da pessoa 2 — o mesmo contrato do caso "duas pessoas"
    // de `embutirMencoes`.
    expect(enviado.body).toBe(
      "fala com @[Ana Lima](mencao:ana-lima-0001) e @[Ana Lima](mencao:ana-lima-0002) sobre o orçamento",
    );
  });

  it("digitar DURANTE o envio e o envio falhar: o retry ainda leva o id da escolha", async () => {
    // O campo segue editável enquanto a nota é salva (`isDisabled` não inclui
    // o envio). A 1ª tecla dali poda as escolhas contra um campo que já não
    // tem `@Ana Lima` — e o `restoreOnError` devolvia o texto SEM o id: o retry
    // saía como texto puro e, com homônimos, avisava as duas Anas.
    abrirModoNota();
    await digitar("fala com @an");
    await escolherNaLista(0);
    await digitar("fala com @Ana Lima oi");
    await enviarNota();
    const [, opcoes] = createNoteMock.mock.calls[0]! as [unknown, { onError: () => void }];

    await digitar("x"); // a próxima nota começa enquanto a 1ª ainda está no ar
    act(() => opcoes.onError());
    expect(screen.getByLabelText(/mensagem/i)).toHaveValue("fala com @Ana Lima oi\nx");

    createNoteMock.mockClear();
    const retry = await enviarNota();
    expect(retry.body, "o retry perdeu a escolha: a nota sairia como texto puro").toBe(
      "fala com @[Ana Lima](mencao:ana-lima-0001) oi\nx",
    );
  });
});
