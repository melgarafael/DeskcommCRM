/**
 * `enviarModeloDireto` — um modelo aprovado fora de qualquer conversa.
 *
 * É a metade do caminho de modelo do `sendMessageHandler` que o aviso à equipe
 * pode usar: o pré-voo da definição (`conferirDefinicao`) e a escolha do
 * transporte. A outra metade — gravar a linha em `messages` — fica de fora de
 * propósito: o aviso não é atendimento.
 *
 * Os dois ramos do transporte são os mesmos do handler: o adapter que sabe
 * falar modelo, com o contrato conferido; ou, quando ele não sabe, o envio do
 * número oficial direto, com a credencial da sessão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const conferirDefinicao = vi.hoisted(() => vi.fn(async () => ({ name: "aviso", slots: [] })));
vi.mock("@/lib/channels/conferir-definicao", () => ({ conferirDefinicao }));
const getAdapter = vi.hoisted(() => vi.fn());
vi.mock("@/lib/channels/index", () => ({ getAdapter }));
const sendTemplateForSession = vi.hoisted(() => vi.fn(async () => "direto-1"));
vi.mock("@/lib/channels/meta/send-template-for-session", () => ({ sendTemplateForSession }));

import { enviarModeloDireto } from "@/lib/channels/modelo-direto";

const ENVIO = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  channelSessionId: "22222222-2222-4222-8222-222222222222",
  provider: "provedor-do-teste",
  sessionRef: "conta-1",
  to: "5531900000000",
  name: "aviso_da_equipe",
  language: "pt_BR",
  values: { "1": "Lead novo · Cliente: Maria" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enviarModeloDireto", () => {
  it("confere a definição DESTA conexão antes de qualquer envio", async () => {
    getAdapter.mockReturnValue({ sendTemplate: vi.fn(async () => ({ externalId: "x" })) });
    await enviarModeloDireto({} as never, ENVIO);
    expect(conferirDefinicao).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ENVIO.organizationId,
      channelSessionId: ENVIO.channelSessionId,
      name: ENVIO.name,
      language: ENVIO.language,
      values: ENVIO.values,
    });
  });

  it("o adapter que fala modelo recebe o contrato conferido", async () => {
    const sendTemplate = vi.fn(async () => ({ externalId: "parceiro-1" }));
    getAdapter.mockReturnValue({ sendTemplate });
    const r = await enviarModeloDireto({} as never, ENVIO);
    expect(r).toEqual({ externalId: "parceiro-1" });
    expect(sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ENVIO.organizationId,
        sessionRef: "conta-1",
        to: "5531900000000",
        name: "aviso_da_equipe",
        values: ENVIO.values,
        contrato: { name: "aviso", slots: [] },
      }),
    );
    expect(sendTemplateForSession).not.toHaveBeenCalled();
  });

  it("sem `sendTemplate` no adapter, sai pelo envio do número oficial direto", async () => {
    getAdapter.mockReturnValue({});
    const r = await enviarModeloDireto({} as never, ENVIO);
    expect(r).toEqual({ externalId: "direto-1" });
    expect(sendTemplateForSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channelSessionId: ENVIO.channelSessionId, sessionRef: "conta-1", to: ENVIO.to }),
    );
  });

  it("o pré-voo que lança impede o envio — a definição torta não sai", async () => {
    conferirDefinicao.mockRejectedValueOnce(new Error("template_obsoleto"));
    const sendTemplate = vi.fn();
    getAdapter.mockReturnValue({ sendTemplate });
    await expect(enviarModeloDireto({} as never, ENVIO)).rejects.toThrow("template_obsoleto");
    expect(sendTemplate).not.toHaveBeenCalled();
  });
});
