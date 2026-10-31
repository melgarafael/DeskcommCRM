import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sincronizar: vi.fn(), aplicarRegua: vi.fn() }));
vi.mock("./sincronizar", () => ({ sincronizar: h.sincronizar, aplicarRegua: h.aplicarRegua }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { rodadaDaCobranca } from "./rodada";

type Linha = { organization_id: string; relida_em: string | null; precisa_reler: boolean };
const nunca: Linha = { organization_id: "nunca-lida", relida_em: null, precisa_reler: true };
const recente = (i: number): Linha => ({
  organization_id: `recente-${i}`, relida_em: "2026-10-28T10:00:00Z", precisa_reler: false,
});

/** Cliente real; só o transporte é local. O servidor corta DEPOIS dos filtros e da ordem. */
async function rodar(linhas: Linha[], maxRows = 1000) {
  let devolvidas = 0;
  const admin = createClient("https://cobranca.example", "chave-sintetica", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input) => {
      const url = new URL(String(input));
      let data: Linha[] = [];
      if (url.pathname.endsWith("/rpc/fn_cobranca_reconciliaveis")) {
        data = [...linhas];
        if (url.searchParams.get("precisa_reler") === "eq.true") data = data.filter((l) => l.precisa_reler);
        if (url.searchParams.get("order") === "relida_em.asc.nullsfirst") {
          data.sort((a, b) => (a.relida_em === null ? -Infinity : Date.parse(a.relida_em)) -
            (b.relida_em === null ? -Infinity : Date.parse(b.relida_em)));
        }
        data = data.slice(0, Math.min(maxRows, Number(url.searchParams.get("limit") ?? maxRows)));
        devolvidas = data.length;
      } else if (!url.pathname.endsWith("/cobranca_assinaturas") && !url.pathname.endsWith("/cobranca_planos")) {
        throw new Error(`Consulta inesperada: ${url.pathname}`);
      }
      return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    } },
  });
  const resumo = await rodadaDaCobranca(admin);
  return { resumo, devolvidas, sincronizadas: h.sincronizar.mock.calls.map((c) => c[1]) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sincronizar.mockResolvedValue({ tipo: "aplicada", acao: "nada" });
  h.aplicarRegua.mockResolvedValue("nada");
});

describe("reconciliação antes do teto do PostgREST", () => {
  it("1.000 leituras recentes não escondem a única assinatura nunca lida", async () => {
    const r = await rodar([...Array.from({ length: 1000 }, (_, i) => recente(i)), nunca]);
    expect(r.sincronizadas).toEqual(["nunca-lida"]);
    expect(r.resumo.relidas).toBe(1);
  });

  it("a nunca lida e as mais antigas têm prioridade mesmo além da primeira página", async () => {
    const antigas = Array.from({ length: 1000 }, (_, i) => ({
      organization_id: `antiga-${i}`, precisa_reler: true,
      relida_em: new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString(),
    }));
    const r = await rodar([...antigas, nunca]);
    expect(r.sincronizadas).toEqual(["nunca-lida", ...antigas.slice(-49).reverse().map((l) => l.organization_id)]);
    expect(r.resumo.relidas).toBe(50);
  });

  it("o teto de 50 também limita a resposta, antes de trazer o conjunto para a aplicação", async () => {
    const r = await rodar(Array.from({ length: 100 }, (_, i) => ({ ...nunca, organization_id: `nunca-${i}` })));
    expect(r.sincronizadas).toHaveLength(50);
    expect(r.devolvidas).toBe(50);
  });

  it("controle: conjunto abaixo do teto continua ignorando a leitura recente", async () => {
    const r = await rodar([recente(1), nunca]);
    expect(r.sincronizadas).toEqual(["nunca-lida"]);
  });
});
