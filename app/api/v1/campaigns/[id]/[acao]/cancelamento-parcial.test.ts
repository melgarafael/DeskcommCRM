/**
 * Cancelar quando o fechamento da fila falha (#4498).
 *
 * A campanha é gravada `cancelled` antes da fila. Se a gravação dos
 * destinatários falha, a resposta tem de dizer o erro (não «0 cancelados»), e
 * repetir o cancelamento tem de terminar de fechar a fila — sem isso, a
 * campanha terminal recusava a repetição com 409 e os pendentes ficavam para
 * sempre. Atravessa a rota e as ações reais, com o client Supabase real sobre
 * um PostgREST de mentira (a bancada é a da reprodução da issue).
 */
import { createClient as criarSupabase } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

import { POST } from "./route";

vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const CAMPANHA = "33333333-3333-4333-8333-333333333333";
const CANCELADA_EM = "2026-11-01T10:00:00.000Z";
type Linha = Record<string, unknown>;

function bancada(opcoes: {
  statusDaCampanha?: string;
  destinatarios?: string[];
  /** Quantas gravações em `campaign_recipients` falham, a partir da primeira. */
  falhas?: number;
}) {
  let falhas = opcoes.falhas ?? 0;
  const campanha: Linha = {
    id: CAMPANHA,
    organization_id: ORG,
    status: opcoes.statusDaCampanha ?? "ready",
    cancelled_at: opcoes.statusDaCampanha === "cancelled" ? CANCELADA_EM : null,
    provider_broadcast_id: null,
  };
  const destinatarios: Linha[] = (opcoes.destinatarios ?? ["pending"]).map((status, i) => ({
    id: `r-${i + 1}`,
    campaign_id: CAMPANHA,
    status,
  }));
  const transporte: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const tabela = url.pathname.split("/").at(-1);
    expect(["campaigns", "campaign_recipients"]).toContain(tabela);
    if (init?.method === "PATCH" && tabela === "campaign_recipients" && falhas > 0) {
      falhas -= 1;
      return Response.json({ code: "57014", message: "canceling statement due to statement timeout" }, { status: 500 });
    }
    const linhas = tabela === "campaigns" ? [campanha] : destinatarios;
    const atendem = linhas.filter((linha) =>
      [...url.searchParams].every(([coluna, filtro]) => {
        if (filtro.startsWith("eq.")) return String(linha[coluna]) === filtro.slice(3);
        if (filtro.startsWith("in.(")) return filtro.slice(4, -1).split(",").includes(String(linha[coluna]));
        return true;
      }),
    );
    if (init?.method === "PATCH") for (const l of atendem) Object.assign(l, JSON.parse(String(init.body)));
    return Response.json(atendem.map((l) => ({ ...l })));
  };
  const client = criarSupabase("http://postgrest.invalid", "chave-sintetica", {
    global: { fetch: transporte },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return { campanha, destinatarios };
}

async function cancelar() {
  return POST(new NextRequest(`http://localhost/api/v1/campaigns/${CAMPANHA}/cancelar`, { method: "POST" }), {
    params: Promise.resolve({ id: CAMPANHA, acao: "cancelar" }),
  });
}

describe("cancelar com falha ao fechar a fila (#4498)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" },
      org: { orgId: ORG, name: "Org", role: "manager" },
    } as never);
  });

  it("a falha na fila responde erro, não «0 cancelados», e a auditoria diz que a fila ficou aberta", async () => {
    const { campanha, destinatarios } = bancada({ falhas: 1 });
    const resposta = await cancelar();
    expect(resposta.status).toBe(500);
    const corpo = await resposta.json();
    expect(corpo.data).toBeUndefined();
    expect(JSON.stringify(corpo)).toContain("Cancele de novo para concluir");
    expect(campanha.status).toBe("cancelled");
    expect(destinatarios[0]!.status).toBe("pending");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "campaign.cancelled", metadata: { cancelados: 0, fila_fechada: false } }),
    );
  });

  it("repetir depois que o banco volta fecha a fila e preserva a data do cancelamento", async () => {
    const { campanha, destinatarios } = bancada({ falhas: 1, destinatarios: ["pending", "queued", "sent"] });
    expect((await cancelar()).status).toBe(500);
    const cancelouEm = campanha.cancelled_at;
    vi.mocked(audit).mockClear();

    const tentativa = await cancelar();
    expect(tentativa.status).toBe(200);
    expect(await tentativa.json()).toMatchObject({ data: { cancelados: 2, reconciliado: true } });
    expect(destinatarios.map((d) => d.status)).toEqual(["cancelled", "cancelled", "sent"]);
    expect(campanha.status).toBe("cancelled");
    expect(campanha.cancelled_at).toBe(cancelouEm);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "campaign.cancelled", metadata: { cancelados: 2, reconciliado: true } }),
    );
  });

  it("repetir com o banco ainda fora responde erro de novo, sem auditar nada", async () => {
    const { destinatarios } = bancada({ statusDaCampanha: "cancelled", falhas: 1 });
    const tentativa = await cancelar();
    expect(tentativa.status).toBe(500);
    expect(destinatarios[0]!.status).toBe("pending");
    expect(audit).not.toHaveBeenCalled();
  });

  it("cancelada sem ninguém na fila continua 409, e quem está `sending` não é tocado", async () => {
    const { destinatarios } = bancada({ statusDaCampanha: "cancelled", destinatarios: ["sending", "cancelled"] });
    const tentativa = await cancelar();
    expect(tentativa.status).toBe(409);
    expect(destinatarios.map((d) => d.status)).toEqual(["sending", "cancelled"]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("controle: sem erro, cancela campanha e fila de uma vez, sem marca de reconciliação", async () => {
    const { campanha, destinatarios } = bancada({ destinatarios: ["pending", "queued", "sending"] });
    const resposta = await cancelar();
    expect(resposta.status).toBe(200);
    const corpo = await resposta.json();
    expect(corpo.data).toEqual({ cancelados: 2 });
    expect(campanha.status).toBe("cancelled");
    expect(destinatarios.map((d) => d.status)).toEqual(["cancelled", "cancelled", "sending"]);
  });
});
