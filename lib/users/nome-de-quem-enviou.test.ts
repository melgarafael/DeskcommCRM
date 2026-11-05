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
import type { SentVia } from "@/lib/types/messaging";

vi.mock("./nome-do-atendente", () => ({ nomesDosAtendentes: vi.fn() }));

const nomeados = vi.mocked(nomesDosAtendentes);

function linha(over: {
  id: string;
  sent_via: SentVia;
  sent_by_user_id: string | null;
  direction?: "inbound" | "outbound";
}) {
  return { direction: "outbound" as const, ...over };
}

beforeEach(() => {
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
    ]);

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
    ]);

    expect(nomeados).toHaveBeenCalledOnce();
    expect(nomeados.mock.calls[0]![0]).toEqual([
      "u-andreia",
      "u-andreia",
      "u-thamyres",
      "u-andreia",
    ]);
    // A deduplicação é responsabilidade declarada de `nomesDosAtendentes`
    // (medida: uma requisição HTTP por id ÚNICO) — aqui se prova que ele recebe
    // os ids de TODAS as linhas de pessoa numa chamada só.
    expect(new Set(nomeados.mock.calls[0]![0]).size).toBe(2);
  });

  it("IA, automação, sistema e celular não pagam lookup e saem com null", async () => {
    const pagina = await comNomeDeQuemEnviou([
      linha({ id: "ia", sent_via: "ai", sent_by_user_id: null }),
      linha({ id: "auto", sent_via: "automation", sent_by_user_id: null }),
      linha({ id: "sis", sent_via: "system", sent_by_user_id: null }),
      linha({ id: "cel", sent_via: "external_device", sent_by_user_id: null }),
    ]);

    expect(nomeados).not.toHaveBeenCalled();
    expect(pagina.every((m) => m.sent_by_user_name === null)).toBe(true);
  });

  it("mensagem RECEBIDA do cliente não vira nome de atendente", async () => {
    const pagina = await comNomeDeQuemEnviou([
      linha({ id: "in", sent_via: "user", sent_by_user_id: "u-andreia", direction: "inbound" }),
    ]);

    expect(nomeados).not.toHaveBeenCalled();
    expect(pagina[0]!.sent_by_user_name).toBeNull();
  });

  it("página sem nenhuma mensagem de pessoa não faz leitura nenhuma", async () => {
    expect(await comNomeDeQuemEnviou([])).toEqual([]);
    expect(nomeados).not.toHaveBeenCalled();
  });

  it("nome que o lookup não resolve sai null, sem derrubar a página", async () => {
    nomeados.mockResolvedValue(new Map());
    const pagina = await comNomeDeQuemEnviou([
      linha({ id: "m1", sent_via: "user", sent_by_user_id: "u-removido" }),
    ]);
    expect(pagina[0]!.sent_by_user_name).toBeNull();
  });

  it("não muta o array do handler (o mesmo objeto alimenta MCP e invariantes)", async () => {
    const original = linha({ id: "m1", sent_via: "user", sent_by_user_id: "u-andreia" });
    const pagina = await comNomeDeQuemEnviou([original]);
    expect(original).not.toHaveProperty("sent_by_user_name");
    expect(pagina[0]).not.toBe(original);
  });
});
