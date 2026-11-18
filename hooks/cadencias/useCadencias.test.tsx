import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configuracaoPadrao } from "@/lib/cadencias/exemplos";
import { useCadencia, useCadencias } from "./useCadencias";
const t = (s: string) => s;
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => t }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const row = { id: "cad-1", name: "Confirmado", status: "ativa", configuracao: configuracaoPadrao(), passos: [], versao: 1, created_at: "2026-10-26T00:00:00Z", updated_at: "2026-10-26T00:00:00Z" };
const resposta = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const http = vi.fn<typeof fetch>();
beforeEach(() => { http.mockReset(); vi.stubGlobal("fetch", http); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("ações de cadências preservam estado confirmado", () => {
  it("editar nome ativo não bloqueia a pausa e a resposta confirma o estado", async () => {
    http.mockResolvedValueOnce(resposta(row)).mockResolvedValueOnce(resposta({ ...row, status: "pausada", name: "Nome do servidor" }));
    const h = renderHook(() => useCadencia(row.id));
    await waitFor(() => expect(h.result.current.cadencia).not.toBeNull());
    await act(async () => { expect(await h.result.current.salvar({ ...h.result.current.cadencia!, nome: "Inválido enquanto ativa" })).toBe(false); });
    await act(async () => { expect(await h.result.current.salvar({ ...h.result.current.cadencia!, status: "pausada" })).toBe(true); });
    expect(http).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(http.mock.calls[1]![1]!.body))).toEqual({ status: "pausada" });
    expect(h.result.current.cadencia).toMatchObject({ nome: "Nome do servidor", status: "pausada" });
  });
  it("bloqueia conteúdo e dupla transição enquanto a pausa aguarda a rede", async () => {
    let responder!: (r: Response) => void;
    http.mockResolvedValueOnce(resposta(row)).mockImplementationOnce(() => new Promise((resolve) => { responder = resolve; }));
    const h = renderHook(() => useCadencia(row.id));
    await waitFor(() => expect(h.result.current.carregando).toBe(false));
    let pausa!: Promise<boolean>;
    act(() => { pausa = h.result.current.salvar({ ...h.result.current.cadencia!, status: "pausada" }); });
    await waitFor(() => expect(h.result.current.mudandoStatus).toBe(true));
    await act(async () => { expect(await h.result.current.salvar({ ...h.result.current.cadencia!, nome: "Tardio" })).toBe(false); });
    await act(async () => { expect(await h.result.current.salvar({ ...h.result.current.cadencia!, status: "pausada" })).toBe(false); });
    await act(async () => { responder(resposta({ ...row, status: "pausada" })); expect(await pausa).toBe(true); });
    expect(http).toHaveBeenCalledTimes(2); expect(h.result.current.mudandoStatus).toBe(false);
  });
  it("ativar espera o último conteúdo confirmado e preserva a resposta real", async () => {
    let responder!: (r: Response) => void;
    http.mockResolvedValueOnce(resposta({ ...row, status: "rascunho" }))
      .mockImplementationOnce(() => new Promise((resolve) => { responder = resolve; }))
      .mockResolvedValueOnce(resposta({ ...row, status: "ativa", name: "Editado" }));
    const h = renderHook(() => useCadencia(row.id));
    await waitFor(() => expect(h.result.current.carregando).toBe(false));
    await act(async () => { await h.result.current.salvar({ ...h.result.current.cadencia!, nome: "Editado" }); });
    let ativacao!: Promise<boolean>;
    act(() => { ativacao = h.result.current.salvar({ ...h.result.current.cadencia!, status: "ativa" }); });
    await waitFor(() => expect(http).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(http.mock.calls[1]![1]!.body))).toEqual({ name: "Editado" });
    await act(async () => { responder(resposta({ ...row, status: "rascunho", name: "Editado" })); expect(await ativacao).toBe(true); });
    expect(JSON.parse(String(http.mock.calls[2]![1]!.body))).toEqual({ status: "ativa" });
    expect(h.result.current.cadencia?.nome).toBe("Editado");
  });
});
it("lista consome cursor, mantém páginas anteriores no erro e permite nova tentativa", async () => {
  http.mockResolvedValueOnce(new Response(JSON.stringify({ data: [row], meta: { cursor: "pagina-2" } })))
    .mockResolvedValueOnce(new Response("falhou", { status: 500 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ ...row, id: "cad-2" }], meta: { cursor: null } })));
  const h = renderHook(useCadencias);
  await waitFor(() => expect(h.result.current.temMais).toBe(true));
  await act(async () => { await h.result.current.carregarMais(); });
  expect(h.result.current.lista.map((c) => c.id)).toEqual(["cad-1"]);
  expect(h.result.current.erroMais).toBe(true); expect(h.result.current.temMais).toBe(true);
  await act(async () => { await h.result.current.carregarMais(); });
  expect(http.mock.calls[2]![0]).toContain("cursor=pagina-2");
  expect(h.result.current.lista.map((c) => c.id)).toEqual(["cad-1", "cad-2"]);
  expect(h.result.current.temMais).toBe(false); expect(h.result.current.erroMais).toBe(false);
});
