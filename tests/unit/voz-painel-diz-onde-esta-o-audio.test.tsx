/**
 * O PAINEL DIZ ONDE ESTÁ O ÁUDIO, E O QUE FAZER.
 *
 * O aviso "Sem áudio: o canal de voz não abriu" foi o único fio que o dono
 * tinha em 2026-09-15 — e ele apontava para rede, quando o áudio estava noutra
 * aba, e depois continuou na tela quando a conexão só tinha caído no fim. Cada
 * estado agora tem a própria frase e a própria ação.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessao = vi.hoisted(() => ({ valor: {} as Record<string, unknown> }));
vi.mock("@/components/voice/VoiceCallContext", () => ({ useVoiceCall: () => sessao.valor }));
vi.mock("@/hooks/contacts/useContact", () => ({ useContact: () => ({ data: undefined }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import { ActiveCallPanel } from "@/components/voice/ActiveCallPanel";

function emLigacao(over: Record<string, unknown> = {}) {
  sessao.valor = {
    call: {
      id: "c1",
      contact_id: null,
      direction: "outbound",
      peer_phone: "553198966398",
      status: "connected",
      answered_at: new Date().toISOString(),
    },
    muted: false,
    connectingMedia: false,
    estadoDaMidia: "aberta",
    midiaEmOutraAba: false,
    encerrando: false,
    toggleMute: vi.fn(),
    hangUp: vi.fn(),
    ouvirAqui: vi.fn(),
    ...over,
  };
  render(<ActiveCallPanel />);
}

beforeEach(() => vi.clearAllMocks());

describe("o aviso de mídia do painel", () => {
  it("áudio noutra aba: diz isso e oferece trazer para cá", () => {
    emLigacao({ midiaEmOutraAba: true, estadoDaMidia: "ociosa" });
    expect(screen.getByText("O áudio desta ligação está em outra aba")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ouvir aqui" }));
    expect(sessao.valor.ouvirAqui).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Sem áudio: o canal de voz não abriu")).toBeNull();
  });

  it("canal que abriu e caiu diz 'caiu', não 'não abriu'", () => {
    emLigacao({ estadoDaMidia: "caiu" });
    expect(screen.getByText("O áudio caiu")).toBeVisible();
    expect(screen.queryByText("Sem áudio: o canal de voz não abriu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reconectar o áudio" }));
    expect(sessao.valor.ouvirAqui).toHaveBeenCalledTimes(1);
  });

  it("canal que nunca abriu mantém o aviso grave e oferece tentar de novo", () => {
    emLigacao({ estadoDaMidia: "sem_rota" });
    expect(screen.getByText("Sem áudio: o canal de voz não abriu")).toBeVisible();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeEnabled();
  });

  it("abertura que falhou avisa já com o telefone tocando, e oferece tentar de novo", () => {
    emLigacao({
      estadoDaMidia: "falhou",
      call: { id: "c1", contact_id: null, direction: "outbound", peer_phone: "553198966398", status: "ringing", answered_at: null },
    });
    expect(screen.getByText("Não consegui abrir o áudio. Confira o microfone.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(sessao.valor.ouvirAqui).toHaveBeenCalledTimes(1);
  });

  it("com áudio, nenhum aviso", () => {
    emLigacao({ estadoDaMidia: "com_audio" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("encerrando: o botão fica desabilitado — o segundo clique não sai", () => {
    emLigacao({ encerrando: true });
    const botao = screen.getByRole("button", { name: "Encerrar chamada" });
    expect(botao).toBeDisabled();
    fireEvent.click(botao);
    expect(sessao.valor.hangUp).not.toHaveBeenCalled();
  });
});
