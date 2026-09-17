import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdvomaxLinkCard } from "./AdvomaxLinkCard";

vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => true) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => vi.clearAllMocks());

describe("AdvomaxLinkCard no contexto jurídico", () => {
  it("explica quando o contato ainda não tem Pessoa vinculada", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdvomaxLinkCard contactId="contact-1" canManage={false} />);

    expect(await screen.findByText("Este contato ainda não está vinculado a uma Pessoa do Advomax.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("carrega processo e documento no próprio contexto e permite selecionar o processo", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/advomax-link")) return Promise.resolve(new Response(JSON.stringify({ data: { id: "link-1", pessoa_codigo: 42, status: "linked", pessoa: { nome: "Ana Silva", tipoPessoa: "Física", cliente: true } } }), { status: 200 }));
      if (url.endsWith("/advomax-link/processos")) return Promise.resolve(new Response(JSON.stringify({ data: [{ codigo: 7, pasta: "Ação trabalhista", numero: "0001234", status: 1, ultimaMovimentacao: "2026-09-16", tribunal: "TRT" }] }), { status: 200 }));
      if (url.endsWith("/advomax-link/processo-links")) return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      if (url.endsWith("/advomax-link/documentos")) return Promise.resolve(new Response(JSON.stringify({ data: [{ codigo: 9, nomeArquivo: "contrato.pdf", descricao: "Contrato", data: "2026-09-16", tipo: "pdf", origem: "whatsapp", armazenadoNoDrive: true }] }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ data: null }), { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdvomaxLinkCard contactId="contact-1" canManage={false} />);

    const processo = await screen.findByRole("button", { name: /Ação trabalhista/ });
    expect(screen.getByText("Ana Silva")).toBeInTheDocument();
    expect(screen.getByText("contrato.pdf")).toBeInTheDocument();
    fireEvent.click(processo);
    expect(screen.getByTestId("advomax-processo-selecionado")).toHaveTextContent("Processo selecionado");
    expect(screen.getByTestId("advomax-processo-selecionado")).toHaveTextContent("Ação trabalhista");
  });

  it("mostra falha dos processos e oferece nova tentativa sem fingir lista vazia", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/advomax-link")) return Promise.resolve(new Response(JSON.stringify({ data: { id: "link-1", pessoa_codigo: 42, status: "linked" } }), { status: 200 }));
      if (url.endsWith("/advomax-link/processos")) return Promise.reject(new Error("bridge unavailable"));
      if (url.endsWith("/advomax-link/processo-links")) return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      if (url.endsWith("/advomax-link/documentos")) return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ data: null }), { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdvomaxLinkCard contactId="contact-1" canManage={false} />);

    await waitFor(() => expect(screen.getByText("Os processos estão temporariamente indisponíveis.")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Tentar novamente");
    expect(screen.queryByText("Nenhum processo ativo encontrado para esta Pessoa.")).not.toBeInTheDocument();
  });

  it("cria atividade no processo escolhido e mantém a mesma chave após falha de rede", async () => {
    let attempts = 0;
    const keys: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/advomax-link")) return Promise.resolve(new Response(JSON.stringify({ data: { id: "link-1", pessoa_codigo: 42, status: "linked" } }), { status: 200 }));
      if (url.endsWith("/advomax-link/processos")) return Promise.resolve(new Response(JSON.stringify({ data: [{ codigo: 7, pasta: "Ação trabalhista", numero: null, status: 1, ultimaMovimentacao: null, tribunal: null }] }), { status: 200 }));
      if (url.endsWith("/advomax-link/processo-links") || url.endsWith("/advomax-link/documentos")) return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      if (url.endsWith("/advomax-link/atividades")) {
        keys.push(JSON.parse(String(init?.body)).chave_idempotencia);
        return Promise.resolve(attempts++ === 0
          ? new Response(JSON.stringify({ error: { message: "Falha temporária" } }), { status: 502 })
          : new Response(JSON.stringify({ data: { codigo: 77 } }), { status: 201 }));
      }
      return Promise.reject(new Error("Unexpected URL"));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdvomaxLinkCard contactId="contact-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Ação trabalhista/ }));
    fireEvent.change(screen.getByPlaceholderText("Ex.: Solicitar contrato assinado"), { target: { value: "Solicitar contrato" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar atividade" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Falha temporária");
    fireEvent.click(screen.getByRole("button", { name: "Criar atividade" }));
    expect(await screen.findByRole("status")).toHaveTextContent("#77");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("abre o destino seguro do rascunho de comunicação para o processo selecionado", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/advomax-link")) return Promise.resolve(new Response(JSON.stringify({ data: { id: "link-1", pessoa_codigo: 42, status: "linked" } }), { status: 200 }));
      if (url.endsWith("/advomax-link/processos")) return Promise.resolve(new Response(JSON.stringify({ data: [{ codigo: 7, pasta: "Ação trabalhista", status: 1, ultimaMovimentacao: null, tribunal: null }] }), { status: 200 }));
      if (url.endsWith("/advomax-link/processo-links") || url.endsWith("/advomax-link/documentos")) return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      if (url.includes("/advomax-link/comunicacao-contexto")) return Promise.resolve(new Response(JSON.stringify({ data: { comunicacao: { destino: "https://advomax.example/documentos" } } }), { status: 200 }));
      return Promise.reject(new Error("Unexpected URL"));
    });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    vi.stubGlobal("fetch", fetchMock);
    render(<AdvomaxLinkCard contactId="contact-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Ação trabalhista/ }));
    fireEvent.click(screen.getByRole("button", { name: "Preparar comunicação no Max" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://advomax.example/documentos", "_blank", "noopener,noreferrer"));
  });
});
