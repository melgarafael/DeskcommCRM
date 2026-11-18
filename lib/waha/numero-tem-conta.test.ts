import { describe, expect, it, vi } from "vitest";

import { numeroTemContaNoWhatsapp } from "./resolve-contact-whatsapp-id";
import type { WahaClient } from "./client";

/**
 * `numeroTemContaNoWhatsapp` — a pergunta "este número tem WhatsApp?" que a
 * prospecção faz antes de abordar (`lib/prospecting/whatsapp.ts`, pelo
 * `numeroTemConta` do adapter). A terceira resposta é a que importa: falha
 * de transporte é `null`, NUNCA `false` — senão o servidor piscando descartaria
 * empresas que têm WhatsApp.
 */
const cliente = (impl: (s: string, p: string) => Promise<{ numberExists: boolean }>) =>
  ({ checkContactExists: vi.fn(impl) }) as unknown as WahaClient & {
    checkContactExists: ReturnType<typeof vi.fn>;
  };

describe("numeroTemContaNoWhatsapp", () => {
  it("existe em alguma grafia → true, e pergunta pela sessão dada", async () => {
    const c = cliente(async () => ({ numberExists: true }));
    expect(await numeroTemContaNoWhatsapp(c, "sessao", "+5511900000001")).toBe(true);
    expect(c.checkContactExists).toHaveBeenCalledWith("sessao", "5511900000001");
  });

  it("todas as grafias respondidas e nenhuma existe → false", async () => {
    const c = cliente(async () => ({ numberExists: false }));
    expect(await numeroTemContaNoWhatsapp(c, "s", "+5511999990000")).toBe(false);
    // O celular brasileiro tem duas grafias (com e sem o nono dígito): as duas foram perguntadas.
    expect(c.checkContactExists.mock.calls.length).toBeGreaterThan(1);
  });

  it("no Brasil basta UMA das grafias do nono dígito existir", async () => {
    const c = cliente(async (_s, p) => ({ numberExists: p === "551199990000" }));
    expect(await numeroTemContaNoWhatsapp(c, "s", "+5511999990000")).toBe(true);
  });

  it("transporte falhou e nenhuma grafia existiu → null ('não deu para saber'), não false", async () => {
    const c = cliente(async () => {
      throw new Error("waha_502");
    });
    expect(await numeroTemContaNoWhatsapp(c, "s", "+5511900000001")).toBeNull();
  });
});
