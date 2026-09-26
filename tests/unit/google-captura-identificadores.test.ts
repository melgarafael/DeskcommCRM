import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/v1/anuncios/google/[org]/route";
import {
  lerIdentificadoresGoogle,
  identificadorParaUpload,
} from "@/lib/plataformas-de-anuncio/google/identificadores";
import { montarEvento } from "@/lib/plataformas-de-anuncio/google/data-manager";
import type { ConversaoOffline, CredencialDeConversao } from "@/lib/plataformas-de-anuncio/types";

const mock = vi.hoisted(() => ({ criar: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/plataformas-de-anuncio/google/captura-de-clique", () => ({
  criarClickRef: mock.criar,
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mock.rate }));
vi.mock("@/lib/plataformas-de-anuncio/landing-config", () => ({
  lerConfigDaLanding: async () => ({
    whatsappE164: "+5511999999999",
    messageTemplate: "Olá [ref:{token}]",
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: { id: "org" }, error: null }),
      };
      return q;
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mock.criar.mockResolvedValue({ token: "2ABCDE" });
  mock.rate.mockResolvedValue({ allowed: true });
});
const abrir = (query: string) =>
  GET(new NextRequest(`https://example.test/api/v1/anuncios/google/loja?${query}`), {
    params: Promise.resolve({ org: "loja" }),
  });

describe("captura de identificadores Google", () => {
  it.each(["gclid", "gbraid", "wbraid"])(
    "leva %s do clique à captura sem renomear",
    async (tipo) => {
      const response = await abrir(`${tipo}=click-1&utm_campaign=teste&email=nao-persistir`);
      expect(response.status).toBe(302);
      expect(mock.criar).toHaveBeenCalledWith(
        expect.anything(),
        "org",
        { [tipo]: "click-1" },
        { utm_campaign: "teste" },
      );
      expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain("[ref:2ABCDE]");
    },
  );
  it.each(["", "gclid=%7Bgclid%7D", "wbraid=%3Cscript%3E", `gclid=${"a".repeat(513)}`])(
    "preserva o acesso ao WhatsApp sem fabricar origem inválida (%s)",
    async (query) => {
      const response = await abrir(query);
      expect(response.status).toBe(302);
      const body = decodeURIComponent(response.headers.get("location") ?? "");
      expect(body).toContain("wa.me");
      expect(body).not.toContain("2ABCDE");
      expect(mock.criar).not.toHaveBeenCalled();
    },
  );
  it("rejeita objeto sem identidade e escolhe identificador legado com precedência explícita", () => {
    expect(lerIdentificadoresGoogle({ token: "nao-e-clique" })).toBeNull();
    expect(identificadorParaUpload({ gclid: "g", gbraid: "b" })).toEqual({ gclid: "g" });
    expect(identificadorParaUpload({ wbraid: "w" })).toEqual({ wbraid: "w" });
  });
  it("Data Manager preserva wbraid e omite valor em qualificação", () => {
    const credencial = {
      google: { customerId: "1234567890", conversionActionId: "42" },
    } as CredencialDeConversao;
    const conversao = {
      eventoId: "lead:QualifiedLead",
      ocorridoEm: new Date("2026-09-24T01:00:00Z"),
      cliqueDeOrigem: "w",
      identificadoresGoogle: { wbraid: "w" },
      valorCentavos: null,
      moeda: "BRL",
    } as ConversaoOffline;
    const event = montarEvento(credencial, conversao).events[0];
    expect(event?.adIdentifiers).toEqual({ wbraid: "w" });
    expect(event).not.toHaveProperty("conversionValue");
    expect(event).not.toHaveProperty("currency");
  });
});
