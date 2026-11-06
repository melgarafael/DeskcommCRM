import { beforeEach, describe, expect, it, vi } from "vitest";
import { perfilDoPais } from "@/lib/legal/perfil-do-pais";
import type { MarcaDeSaida } from "@/lib/branding/saida";

const enviados = vi.hoisted(() => [] as Array<{ html: string; text: string }>);
vi.mock("@/lib/email/roteador", () => ({
  sendEmail: async (mensagem: { html: string; text: string }) => {
    enviados.push(mensagem);
    return { ok: true, id: "email-sintetico" };
  },
}));
import { sendExportEmail } from "@/lib/lgpd/email-delivery";

beforeEach(() => {
  enviados.length = 0;
});
const marca: MarcaDeSaida = {
  nome: "Marca sintética",
  logoUrl: null,
  accent: "#2f6f4e",
  accentFg: "#ffffff",
  origens: { nome: "banco", cor: "banco" },
};

describe("links dos relatórios conservam URL e idioma sem introduzir HTML", () => {
  it.each(["BR", "PT"])("país %s", async (pais) => {
    const signedUrl =
      'https://storage.example.test/relatorio?token=a&x="><img src=x onerror=alert(1)>';
    const signedUrlDados = signedUrl.replace("relatorio", "dados");
    await sendExportEmail({
      to: "titular@example.test",
      requestId: "pedido-sintetico",
      signedUrl,
      signedUrlDados,
      expiresAt: new Date("2026-11-01T12:00:00Z"),
      marca,
      perfil: perfilDoPais(pais),
      fuso: "Europe/Lisbon",
    });
    const mensagem = enviados[0]!;
    const doc = new DOMParser().parseFromString(mensagem.html, "text/html");
    expect(doc.documentElement.lang).toBe(pais === "BR" ? "pt-BR" : "pt-PT");
    const links = doc.querySelectorAll("a");
    expect(links[0]?.getAttribute("href")).toBe(signedUrl);
    expect(links[1]?.getAttribute("href")).toBe(signedUrlDados);
    expect(links[1]?.textContent).toBe(signedUrlDados);
    expect(doc.querySelector("img[onerror]")).toBeNull();
    expect(mensagem.text).toContain(signedUrl);
    expect(mensagem.text).toContain(signedUrlDados);
  });
});
