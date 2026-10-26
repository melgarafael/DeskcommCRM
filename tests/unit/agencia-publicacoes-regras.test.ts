import { describe, expect, it } from "vitest";

import { linkDeMidiaDireto, mudouOConteudo, problemaParaAgendar, publicaSozinho, somarMeses } from "@/lib/agencia/publicacoes/regras";

const agora = new Date("2026-11-10T12:00:00Z");
const base = {
  situacao: "aprovada" as const,
  rede: "instagram" as const,
  formato: "feed" as const,
  quando: "2026-11-11T12:00:00Z",
  midiaUrl: "https://cdn.exemplo.com/post.jpg",
  autoPublicar: true,
};

describe("publicações — regras", () => {
  it("só publica sozinho Instagram feed/reels/story e Facebook feed (P7)", () => {
    expect(publicaSozinho("instagram", "reels")).toBe(true);
    expect(publicaSozinho("instagram", "carrossel")).toBe(false);
    expect(publicaSozinho("facebook", "feed")).toBe(true);
    expect(publicaSozinho("facebook", "reels")).toBe(false);
    expect(publicaSozinho("tiktok", "video")).toBe(false);
  });

  it("link de pasta do Drive não é mídia direta (P5)", () => {
    expect(linkDeMidiaDireto("https://drive.google.com/file/d/abc/view")).toBe(false);
    expect(linkDeMidiaDireto("http://cdn.exemplo.com/a.jpg")).toBe(false);
    expect(linkDeMidiaDireto("https://cdn.exemplo.com/a.jpg?v=2")).toBe(true);
    expect(linkDeMidiaDireto("https://cdn.exemplo.com/a.MP4")).toBe(true);
    expect(linkDeMidiaDireto("https://cdn.exemplo.com/pagina")).toBe(false);
  });

  it("só aprovada (ou que falhou) agenda; manual não exige mídia (P8)", () => {
    expect(problemaParaAgendar({ ...base, situacao: "rascunho" }, agora)).toMatch(/aprovada/);
    expect(problemaParaAgendar({ ...base, situacao: "em_aprovacao" }, agora)).toMatch(/aprovada/);
    expect(problemaParaAgendar({ ...base, autoPublicar: false, midiaUrl: null }, agora)).toBeNull();
    expect(problemaParaAgendar({ ...base, situacao: "falhou" }, agora)).toBeNull();
  });

  it("publicar sozinho pede formato aceito, mídia certa e 5 min de antecedência", () => {
    expect(problemaParaAgendar(base, agora)).toBeNull();
    expect(problemaParaAgendar({ ...base, rede: "tiktok", formato: "video" }, agora)).toMatch(/não publica sozinha/);
    expect(problemaParaAgendar({ ...base, midiaUrl: null }, agora)).toMatch(/Falta/);
    expect(problemaParaAgendar({ ...base, midiaUrl: "https://drive.google.com/x" }, agora)).toMatch(/Drive/);
    expect(problemaParaAgendar({ ...base, formato: "reels" }, agora)).toMatch(/Reels precisa de vídeo/);
    expect(problemaParaAgendar({ ...base, midiaUrl: "https://cdn.exemplo.com/v.mp4" }, agora)).toMatch(/Reels/);
    expect(problemaParaAgendar({ ...base, formato: "story", midiaUrl: "https://cdn.exemplo.com/v.mp4" }, agora)).toBeNull();
    expect(problemaParaAgendar({ ...base, quando: "2026-11-10T12:03:00Z" }, agora)).toMatch(/5 minutos/);
  });

  it("mudar legenda, mídia, rede ou formato pede nova aprovação", () => {
    const a = { legenda: "Oi", midiaUrl: "https://x/a.jpg", formato: "feed" as const, rede: "instagram" as const };
    expect(mudouOConteudo(a, { ...a })).toBe(false);
    expect(mudouOConteudo(a, { ...a, legenda: "Olá" })).toBe(true);
    expect(mudouOConteudo({ ...a, legenda: null }, { ...a, legenda: "" })).toBe(false);
    expect(mudouOConteudo(a, { ...a, formato: "story" })).toBe(true);
  });

  it("soma meses atravessando o ano", () => {
    expect(somarMeses("2026-12", 1)).toBe("2027-01");
    expect(somarMeses("2026-01", -1)).toBe("2025-12");
  });
});
