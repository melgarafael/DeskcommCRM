/**
 * #1982 — "Exportar conversa": a PORTA da rota que já existia.
 *
 * ─── O que se mede aqui, e por que cada caso existe ─────────────────────────
 *
 * A rota (`app/api/v1/conversations/[id]/export/route.ts`) e o PDF
 * (`lib/conversas/exporta-pdf.ts`) estavam prontos; o que faltava era o botão —
 * e um botão só vale pelo que ele PEDE. Os três casos cobrem as três perguntas
 * que a issue faz:
 *
 *   1. pede `?formato=pdf` (sem isso a rota devolve 422, e o "exportar" vira
 *      erro em toda conversa);
 *   2. mostra "Gerando PDF…" enquanto o arquivo não chega (a renderização é
 *      cara — 1,9s medidos para 500 mensagens — e um clique sem retorno faz a
 *      pessoa clicar três vezes e bater no teto por minuto);
 *   3. o 403 vira a frase do GESTO, não a do recurso ("conversations"): quem
 *      chegou ali por um link não tem como saber que o problema é o papel dele.
 *
 * O quarto caso é o do `viewer`: o botão existe DESABILITADO — esconder faria a
 * pessoa achar que o recurso não existe, e habilitar prometeria um 403.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  auth: {
    user: { id: "u1", support: null } as Record<string, unknown>,
    activeOrg: { role: "agent", orgId: "org-1" } as Record<string, unknown> | null,
  },
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => estado.auth,
}));

import {
  ExportarConversa,
  podeExportarConversa,
  rotaDaExportacao,
} from "@/components/inbox/ExportarConversa";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  estado.auth.activeOrg = { role: "agent", orgId: "org-1" };
  estado.auth.user = { id: "u1", support: null };
  // jsdom não implementa `createObjectURL`; o download de verdade não é o que
  // este arquivo mede (é o `fetch`), mas o caminho de sucesso passa por ele.
  Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:conversa"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function respostaPdf(): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (nome: string) =>
        nome === "Content-Disposition" ? 'attachment; filename="conversa-2026-11-07.pdf"' : null,
    },
    blob: async () => new Blob(["%PDF-1.4"], { type: "application/pdf" }),
  } as unknown as Response;
}

describe("#1982 — pede o PDF da conversa", () => {
  it("chama a rota de export com formato=pdf e o cookie da sessão", async () => {
    fetchMock.mockResolvedValue(respostaPdf());
    render(<ExportarConversa conversationId="conversa-1" />);

    fireEvent.click(screen.getByTestId("acao-exportar-conversa"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/conversations/conversa-1/export?formato=pdf", {
      credentials: "same-origin",
    });
    expect(rotaDaExportacao("conversa-1")).toBe(
      "/api/v1/conversations/conversa-1/export?formato=pdf",
    );
  });

  it("mostra o estado de geração enquanto o arquivo não chega", async () => {
    // Promessa que nunca resolve: é o "renderizando" da rota, e é o único jeito
    // de ver o estado intermediário sem depender de tempo.
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ExportarConversa conversationId="conversa-1" />);

    fireEvent.click(screen.getByTestId("acao-exportar-conversa"));

    expect(await screen.findByText("Gerando PDF…")).toBeTruthy();
    expect(screen.getByTestId("acao-exportar-conversa").hasAttribute("disabled")).toBe(true);
  });

  it("traduz o 403 na frase do gesto (o papel não baixa o histórico)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: "forbidden", message: "insufficient_role" } }),
    } as unknown as Response);

    render(<ExportarConversa conversationId="conversa-1" />);
    fireEvent.click(screen.getByTestId("acao-exportar-conversa"));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("Seu perfil não permite exportar o histórico desta conversa.");
    // A mensagem crua da rota NÃO vaza para a tela.
    expect(alerta.textContent).not.toContain("insufficient_role");
  });
});

describe("#1982 — o botão segue o papel da rota (`requireRole(\"agent\")`)", () => {
  it("agent e manager podem; viewer não", () => {
    expect(podeExportarConversa("agent")).toBe(true);
    expect(podeExportarConversa("manager")).toBe(true);
    expect(podeExportarConversa("admin")).toBe(true);
    expect(podeExportarConversa("viewer")).toBe(false);
    expect(podeExportarConversa(undefined)).toBe(false);
    expect(podeExportarConversa("viewer", true)).toBe(true);
  });

  it("viewer vê o botão DESABILITADO, com a guia dizendo o porquê", () => {
    estado.auth.activeOrg = { role: "viewer", orgId: "org-1" };
    render(<ExportarConversa conversationId="conversa-1" />);

    const botao = screen.getByTestId("acao-exportar-conversa");
    expect(botao.hasAttribute("disabled")).toBe(true);
    expect(botao.getAttribute("title")).toBe(
      "Seu perfil não permite exportar o histórico desta conversa.",
    );

    fireEvent.click(botao);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
