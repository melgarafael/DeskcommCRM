import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool } from "ai";

import { terminalizarApresentacaoNoTurno } from "./terminalidade-de-apresentacao";

function executar(tools: ReturnType<typeof terminalizarApresentacaoNoTurno>, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`missing_execute_${name}`);
  return execute({} as never, { toolCallId: name, messages: [], context: {} });
}

describe("terminalidade da apresentação no passo do modelo", () => {
  it("aguarda uma tool anterior, ativa a apresentação e barra envios irmãos", async () => {
    let liberar!: () => void;
    const anterior = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          liberar = () => resolve("anterior");
        }),
    );
    const apresentar = vi.fn(async () => "apresentado");
    const enviar = vi.fn(async () => "enviado");
    const ativada = vi.fn();
    const tools = terminalizarApresentacaoNoTurno(
      {
        anterior: tool({ inputSchema: z.object({}), execute: anterior }),
        present_catalog_items: tool({ inputSchema: z.object({}), execute: apresentar }),
        send_message: tool({ inputSchema: z.object({}), execute: enviar }),
      },
      "present_catalog_items",
      ativada,
    );

    const first = executar(tools, "anterior");
    const second = executar(tools, "present_catalog_items");
    const third = executar(tools, "send_message");
    await vi.waitFor(() => expect(anterior).toHaveBeenCalledOnce());
    expect(apresentar).not.toHaveBeenCalled();
    liberar();
    expect(await first).toBe("anterior");
    expect(await second).toBe("apresentado");
    expect(await third).toMatchObject({
      ok: false,
      error: { code: "catalog_presentation_terminal" },
    });
    expect(ativada).toHaveBeenCalledOnce();
    expect(enviar).not.toHaveBeenCalled();
  });

  it("barra uma segunda apresentação e envio mesmo quando a primeira falha", async () => {
    const apresentar = vi.fn(async (): Promise<string> => {
      throw new Error("falha");
    });
    const enviar = vi.fn(async () => "enviado");
    const tools = terminalizarApresentacaoNoTurno(
      {
        present_catalog_items: tool({ inputSchema: z.object({}), execute: apresentar }),
        send_message: tool({ inputSchema: z.object({}), execute: enviar }),
      },
      "present_catalog_items",
      () => undefined,
    );

    const first = executar(tools, "present_catalog_items");
    const duplicate = executar(tools, "present_catalog_items");
    const send = executar(tools, "send_message");
    await expect(first).rejects.toThrow("falha");
    expect(await duplicate).toMatchObject({
      ok: false,
      error: { code: "catalog_presentation_terminal" },
    });
    expect(await send).toMatchObject({
      ok: false,
      error: { code: "catalog_presentation_terminal" },
    });
    expect(apresentar).toHaveBeenCalledOnce();
    expect(enviar).not.toHaveBeenCalled();
  });
});
