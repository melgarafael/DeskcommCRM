/**
 * O NOME DE QUEM DA EQUIPE ENVIOU VAI NO PAYLOAD — UMA LEITURA POR PÁGINA (#4031).
 *
 * ═══ O que este arquivo prende ═══
 *
 *   1. Duas pessoas da equipe na mesma página saem com nomes DIFERENTES.
 *   2. A leitura é UMA (`nomesDosAtendentes` chamado uma vez, com ids
 *      DISTINTOS) — o critério de aceite é "nenhuma consulta por mensagem", e a
 *      pior forma de quebrá-lo é chamar o helper dentro de um `map`. O dublê
 *      conta chamadas: 4 mensagens de 2 pessoas = 1 chamada com 2 ids, nunca 4.
 *   3. O que NÃO é pessoa (IA, automação, sistema, celular) e o que é RECEBIDO
 *      do cliente não paga lookup nenhum e sai com `sent_by_user_name: null`.
 *   4. Nome ausente não derruba a página: a mensagem sai com `null` e o balão
 *      cai em "Atendente".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { nomesDosAtendentes } from "./nome-do-atendente";
import { comNomeDeQuemEnviou } from "./nome-de-quem-enviou";
import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SentVia } from "@/lib/types/messaging";

vi.mock("./nome-do-atendente", () => ({ nomesDosAtendentes: vi.fn() }));
vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const nomeados = vi.mocked(nomesDosAtendentes);

/** Membros de cada org, como `user_organizations` os guarda. */
const MEMBROS: Record<string, string[]> = { "org-1": ["u-andreia", "u-thamyres", "u-removido"] };
const filtrosDeOrg: string[] = [];

/** Dublê de `from("user_organizations").select().eq(org).in(ids)`. */
function adminFalso() {
  return {
    from: (tabela: string) => {
      expect(tabela).toBe("user_organizations");
      return {
        select: () => ({
          eq: (coluna: string, orgId: string) => {
            expect(coluna).toBe("organization_id");
            filtrosDeOrg.push(orgId);
            return {
              in: async (_c: string, ids: string[]) => ({
                data: ids
                  .filter((id) => (MEMBROS[orgId] ?? []).includes(id))
                  .map((user_id) => ({ user_id })),
                error: null,
              }),
            };
          },
        }),
      };
    },
  };
}

function linha(over: {
  id: string;
  sent_via: SentVia;
  sent_by_user_id: string | null;
  direction?: "inbound" | "outbound";
}) {
  return { direction: "outbound" as const, ...over };
}

beforeEach(() => {
  filtrosDeOrg.length = 0;
  vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
  vi.mocked(createAdminClient).mockReset().mockReturnValue(adminFalso() as never);
  nomeados.mockReset();
  nomeados.mockResolvedValue(
    new Map<string, string | null>([
      ["u-andreia", "Andreia Cristina de Souza"],
      ["u-thamyres", "Thamyres"],
    ]),
  );
});

describe("#4031 — nome de quem enviou, no payload da página", () => {
  it("duas pessoas da equipe na mesma página saem com nomes distintos", async () => {
    const pagina = await comNomeDeQuemEnviou([
      linha({ id: "m1", sent_via: "user", sent_by_user_id: "u-andreia" }),
      linha({ id: "m2", sent_via: "user", sent_by_user_id: "u-thamyres" }),
      linha({ id: "m3", sent_via: "crm", sent_by_user_id: "u-andreia" }),
    ], "org-1");

    expect(pagina.map((m) => [m.id, m.sent_by_user_name])).toEqual([
      ["m1", "Andreia Cristina de Souza"],
      ["m2", "Thamyres"],
      ["m3", "Andreia Cristina de Souza"],
    ]);
  });

  it("UMA leitura por página, com ids DISTINTOS — nunca uma por mensagem", async () => {
    await comNomeDeQuemEnviou([
      linha({ id: "m1", sent_via: "user", sent_by_user_id: "u-andreia" }),
      linha({ id: "m2", sent_via: "user", sent_by_user_id: "u-andreia" }),
      linha({ id: "m3", sent_via: "user", sent_by_user_id: "u-thamyres" }),
      linha({ id: "m4", sent_via: "crm", sent_by_user_id: "u-andreia" }),
    ], "org-1");

    expect(nomeados).toHaveBeenCalledOnce();
    // Uma chamada, com os ids DISTINTOS que passaram pela conferência de membros.
    expect(nomeados.mock.calls[0]![0]).toBe("org-1");
    expect(nomeados.mock.calls[0]![1]).toEqual(["u-andreia", "u-thamyres"]);
    expect(filtrosDeOrg).toEqual(["org-1"]);
  });

  it("IA, automação, sistema e celular não pagam lookup e saem com null", async () => {
    const pagina = await comNomeDeQuemEnviou([
      linha({ id: "ia", sent_via: "ai", sent_by_user_id: null }),
      linha({ id: "auto", sent_via: "automation", sent_by_user_id: null }),
      linha({ id: "sis", sent_via: "system", sent_by_user_id: null }),
      linha({ id: "cel", sent_via: "external_device", sent_by_user_id: null }),
    ], "org-1");

    expect(nomeados).not.toHaveBeenCalled();
    expect(pagina.every((m) => m.sent_by_user_name === null)).toBe(true);
  });

  it("mensagem RECEBIDA do cliente não vira nome de atendente", async () => {
    const pagina = await comNomeDeQuemEnviou([
      linha({ id: "in", sent_via: "user", sent_by_user_id: "u-andreia", direction: "inbound" }),
    ], "org-1");

    expect(nomeados).not.toHaveBeenCalled();
    expect(pagina[0]!.sent_by_user_name).toBeNull();
  });

  it("página sem nenhuma mensagem de pessoa não faz leitura nenhuma", async () => {
    expect(await comNomeDeQuemEnviou([], "org-1")).toEqual([]);
    expect(nomeados).not.toHaveBeenCalled();
  });

  it("nome que o lookup não resolve sai null, sem derrubar a página", async () => {
    nomeados.mockResolvedValue(new Map());
    const pagina = await comNomeDeQuemEnviou([
      linha({ id: "m1", sent_via: "user", sent_by_user_id: "u-removido" }),
    ], "org-1");
    expect(pagina[0]!.sent_by_user_name).toBeNull();
  });

  it("não muta o array do handler (o mesmo objeto alimenta MCP e invariantes)", async () => {
    const original = linha({ id: "m1", sent_via: "user", sent_by_user_id: "u-andreia" });
    const pagina = await comNomeDeQuemEnviou([original], "org-1");
    expect(original).not.toHaveProperty("sent_by_user_name");
    expect(pagina[0]).not.toBe(original);
  });

  it("id que não é membro da organização sai sem nome e nem chega ao lookup", async () => {
    const pagina = await comNomeDeQuemEnviou(
      [
        linha({ id: "m1", sent_via: "user", sent_by_user_id: "u-andreia" }),
        linha({ id: "m2", sent_via: "user", sent_by_user_id: "u-de-fora" }),
      ],
      "org-1",
    );

    expect(filtrosDeOrg).toEqual(["org-1"]);
    expect(nomeados).toHaveBeenCalledOnce();
    expect(nomeados.mock.calls[0]![1]).toEqual(["u-andreia"]);
    expect(pagina.map((m) => [m.id, m.sent_by_user_name])).toEqual([
      ["m1", "Andreia Cristina de Souza"],
      ["m2", null],
    ]);
  });

  it("a conferência usa a organização recebida: membro de outra org sai sem nome", async () => {
    const pagina = await comNomeDeQuemEnviou(
      [linha({ id: "m1", sent_via: "user", sent_by_user_id: "u-andreia" })],
      "org-2",
    );

    expect(filtrosDeOrg).toEqual(["org-2"]);
    expect(nomeados).not.toHaveBeenCalled();
    expect(pagina[0]!.sent_by_user_name).toBeNull();
  });

  it("sem service role não há leitura nenhuma e o rótulo cai em Atendente", async () => {
    vi.mocked(isServiceRoleConfigured).mockReturnValue(false);
    const pagina = await comNomeDeQuemEnviou(
      [linha({ id: "m1", sent_via: "user", sent_by_user_id: "u-andreia" })],
      "org-1",
    );

    expect(createAdminClient).not.toHaveBeenCalled();
    expect(nomeados).not.toHaveBeenCalled();
    expect(pagina[0]!.sent_by_user_name).toBeNull();
  });
});
