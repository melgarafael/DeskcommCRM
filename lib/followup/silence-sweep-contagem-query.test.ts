import { describe, expect, it } from "vitest";

import { createSupabaseSilenceSweepDb } from "./silence-sweep";

/**
 * `loadContagemDeInscricoes` — a query de produção do teto de repetições.
 *
 * O PostgREST devolve no máximo 1000 linhas por resposta, SEM erro. O fake
 * imita isso: aplica o `.range()` pedido e corta em 1000. Sem paginar, um lote
 * de contatos com mais de 1000 inscrições somadas era contado pela metade — e o
 * teto falhava aberto justo para quem está em laço há meses.
 */
const MAX_ROWS = 1000;

function fakeAdmin(linhas: Array<{ contact_id: string }>) {
  let consultas = 0;
  const from = () => {
    consultas += 1;
    let fatia: [number, number] | null = null;
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            const [de, ate] = fatia ?? [0, linhas.length - 1];
            const data = linhas.slice(de, ate + 1).slice(0, MAX_ROWS);
            return (resolve: (value: unknown) => unknown) => resolve({ data, error: null });
          }
          return (...args: unknown[]) => {
            if (prop === "range") fatia = [args[0] as number, args[1] as number];
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return { admin: { from } as never, consultas: () => consultas };
}

describe("createSupabaseSilenceSweepDb().loadContagemDeInscricoes — paginada", () => {
  it("conta além das 1000 linhas que o PostgREST devolve por resposta", async () => {
    const linhas = [
      ...Array.from({ length: 1500 }, () => ({ contact_id: "c-1" })),
      ...Array.from({ length: 3 }, () => ({ contact_id: "c-2" })),
    ];
    const { admin, consultas } = fakeAdmin(linhas);

    const contagem = await createSupabaseSilenceSweepDb(admin).loadContagemDeInscricoes!("org-1", "ptr-1", ["c-1", "c-2"]);

    expect(contagem.get("c-1")).toBe(1500);
    expect(contagem.get("c-2")).toBe(3);
    expect(consultas()).toBe(2);
  });

  it("página incompleta encerra sem consulta extra", async () => {
    const { admin, consultas } = fakeAdmin([{ contact_id: "c-1" }]);
    const contagem = await createSupabaseSilenceSweepDb(admin).loadContagemDeInscricoes!("org-1", "ptr-1", ["c-1"]);
    expect(contagem.get("c-1")).toBe(1);
    expect(consultas()).toBe(1);
  });
});
