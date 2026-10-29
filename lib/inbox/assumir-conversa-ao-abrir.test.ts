/**
 * ASSUMIR A CONVERSA RECÉM-ABERTA — o claim que o Inbox faz, num lugar só.
 *
 * A função nasceu do #3483: o cadastro de contato e de negócio pedem o MESMO
 * claim depois de salvar, e o bloco que morava inline no painel "Iniciar
 * conversa" virou esta função. O que estes casos prendem é o contrato que os
 * DOIS consumidores herdam:
 *
 *   - o pedido é `claim` com `expected_assignee: null` — "assuma se estiver
 *     livre". Sem ele a conversa nasce SEM dono e, em `visibility_mode = 'own'`,
 *     fica invisível ao próprio atendente que a abriu (#3479);
 *   - 409 com a conversa já sendo sua não vira aviso (a conversa fechada reabre
 *     com o dono antigo, que pode ser você);
 *   - 409 com dono alheio NOMEIA quem é: não se rouba atendimento de ninguém;
 *   - outro erro: a conversa já existe, o erro aparece e a função diz `false` —
 *     quem chama decide o que fazer (o painel não manda a primeira mensagem).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

const { post, get, toast, showApiError } = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  showApiError: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    post: (...args: unknown[]) => post(...args),
    get: (...args: unknown[]) => get(...args),
  },
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({
  showApiError: (...args: unknown[]) => showApiError(...args),
}));

import { assumirConversaAoAbrir } from "./assumir-conversa-ao-abrir";

const EU = "usuario-eu";
/** O `t` do teste não traduz: as asserções leem o texto em português. */
const t = (texto: string) => texto;

function recusa(status: number) {
  return new ApiError(status, "recusa", undefined, "req-1");
}

describe("assumirConversaAoAbrir", () => {
  beforeEach(() => {
    post.mockReset();
    get.mockReset();
    toast.info.mockReset();
    showApiError.mockReset();
    post.mockResolvedValue({ data: {} });
  });

  it("⭐ pede o claim com expected_assignee nulo e devolve true", async () => {
    await expect(assumirConversaAoAbrir("conv-1", { userId: EU, t })).resolves.toBe(true);

    expect(post).toHaveBeenCalledWith("/api/v1/conversations/conv-1/claim", {
      expected_assignee: null,
    });
    // `expected_assignee: null` é "assuma se estiver livre": mandar um dono
    // esperado mudaria o significado do pedido para takeover.
    expect(get).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("409 com a conversa já sendo sua: assume em silêncio", async () => {
    post.mockRejectedValueOnce(recusa(409));
    get.mockResolvedValueOnce({ data: { assigned_to_user_id: EU, assigned_to_user_name: "Eu" } });

    await expect(assumirConversaAoAbrir("conv-1", { userId: EU, t })).resolves.toBe(true);
    expect(toast.info).not.toHaveBeenCalled();
    expect(showApiError).not.toHaveBeenCalled();
  });

  it("409 com dono alheio: não assume e diz com quem está", async () => {
    post.mockRejectedValueOnce(recusa(409));
    get.mockResolvedValueOnce({
      data: { assigned_to_user_id: "outra", assigned_to_user_name: "Ana" },
    });

    await expect(assumirConversaAoAbrir("conv-1", { userId: EU, t })).resolves.toBe(false);
    expect(toast.info).toHaveBeenCalledWith("A conversa neste número está com Ana.");
  });

  it("claim recusado por outro motivo: mostra o erro e devolve false", async () => {
    // 403 é o papel que falta — `claim` exige `agent`. A conversa continua
    // aberta e sem dono: quem chamou precisa saber disso pelo `false`.
    post.mockRejectedValueOnce(recusa(403));

    await expect(assumirConversaAoAbrir("conv-1", { userId: EU, t })).resolves.toBe(false);
    expect(showApiError).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("409 cuja releitura falha: não inventa dono, e avisa sem nome", async () => {
    post.mockRejectedValueOnce(recusa(409));
    get.mockRejectedValueOnce(recusa(500));

    await expect(assumirConversaAoAbrir("conv-1", { userId: EU, t })).resolves.toBe(false);
    expect(toast.info).toHaveBeenCalledWith("A conversa neste número está com outro atendente.");
  });
});
