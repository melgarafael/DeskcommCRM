/**
 * O cartão é a única porta OAuth da tela: ele nunca toca
 * `ai_provider_credentials` e nunca exibe segredo — só o user_code, que por
 * desenho é mostrado ao operador.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexConnectCard } from "./CodexConnectCard";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status });
}

function montarFetch(respostas: Response[]) {
  const fila = [...respostas];
  return vi.fn(async () => {
    const proxima = fila.shift();
    if (!proxima) throw new Error("fetch além da fila programada");
    return proxima;
  });
}

function montar(canWrite = true, intervaloPollMs = 10) {
  render(<CodexConnectCard canWrite={canWrite} intervaloPollMs={intervaloPollMs} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CodexConnectCard — status", () => {
  it("ausente mostra Conectar (só para quem pode escrever)", async () => {
    vi.stubGlobal("fetch", montarFetch([json({ provider: "openai-codex", status: "ausente" })]));
    montar(true);
    expect(await screen.findByText("Nenhuma assinatura conectada.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conectar ChatGPT" })).toBeInTheDocument();
  });

  it("sem escrita não há botão, só leitura do estado", async () => {
    vi.stubGlobal("fetch", montarFetch([json({ provider: "openai-codex", status: "ausente" })]));
    montar(false);
    expect(await screen.findByText("Nenhuma assinatura conectada.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Conectar ChatGPT" })).toBeNull();
  });

  it("quarentena explica e oferece Reconectar", async () => {
    vi.stubGlobal(
      "fetch",
      montarFetch([json({ status: "quarantined", quarantined_reason: "401: invalid_grant" })]),
    );
    montar(true);
    expect(await screen.findByText(/interrompida pelo provedor/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconectar" })).toBeInTheDocument();
  });
});

describe("CodexConnectCard — fluxo de conexão", () => {
  it("Conectar → código → Já autorizei (pendente, depois conectado)", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      montarFetch([
        json({ provider: "openai-codex", status: "ausente" }), // GET inicial
        json({ user_code: "ABCD-1234", verification_uri: "https://v", device_auth_id: "d", expires_in: 600 }), // iniciar
        json({ pendente: true }), // poll 1
        json({ conectado: true }), // poll 2
        json({ provider: "openai-codex", status: "active", label: "ChatGPT" }), // recarrega
      ]),
    );
    montar(true);
    await user.click(await screen.findByRole("button", { name: "Conectar ChatGPT" }));
    expect(await screen.findByTestId("codex-user-code")).toHaveTextContent("ABCD-1234");
    expect(screen.getByRole("link", { name: "Abrir página de autorização" })).toHaveAttribute("href", "https://v");

    await user.click(screen.getByRole("button", { name: "Já autorizei" }));
    expect(await screen.findByText(/Ainda não vi a aprovação/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Já autorizei" }));
    expect(await screen.findByText(/Conectado/)).toBeInTheDocument();
    expect(screen.queryByTestId("codex-user-code")).toBeNull();
  });

  it("iniciar falhando não abre sessão fantasma", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      montarFetch([
        json({ provider: "openai-codex", status: "ausente" }),
        new Response("erro", { status: 500 }),
      ]),
    );
    montar(true);
    await user.click(await screen.findByRole("button", { name: "Conectar ChatGPT" }));
    expect(await screen.findByText(/Não consegui abrir a sessão/)).toBeInTheDocument();
    expect(screen.queryByTestId("codex-user-code")).toBeNull();
  });

  it("Desconectar volta a ausente", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      montarFetch([
        json({ provider: "openai-codex", status: "active", label: "ChatGPT" }),
        json({ ok: true }), // disconnect
        json({ provider: "openai-codex", status: "ausente" }), // recarrega
      ]),
    );
    montar(true);
    await user.click(await screen.findByRole("button", { name: "Desconectar" }));
    expect(await screen.findByText("Nenhuma assinatura conectada.")).toBeInTheDocument();
  });
});
