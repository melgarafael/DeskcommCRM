import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { listContactsHandler } from "@/app/api/v1/contacts/_handler";
import type { ContactListQueryParams } from "@/lib/schemas/contacts";

type Linha = Record<string, string | boolean | null>;
const ORG = "11111111-1111-4111-8111-111111111111";
const ctx = {
  organization_id: ORG,
  actor: { type: "user" as const, id: "operador" },
  requestId: "pagina",
};

/** Vírgulas de topo separam condições. Aspas e parênteses pertencem ao valor ou grupo. */
function condicoes(texto: string): string[] {
  const partes: string[] = [];
  let inicio = 0;
  let profundidade = 0;
  let entreAspas = false;
  let escapado = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (escapado) {
      escapado = false;
      continue;
    }
    if (entreAspas && ch === "\\") {
      escapado = true;
      continue;
    }
    if (ch === '"') entreAspas = !entreAspas;
    if (entreAspas) continue;
    if (ch === "(") profundidade++;
    if (ch === ")") profundidade--;
    if (ch === "," && profundidade === 0) {
      partes.push(texto.slice(inicio, i));
      inicio = i + 1;
    }
  }
  if (entreAspas || profundidade !== 0) throw new Error("Filtro desbalanceado");
  partes.push(texto.slice(inicio));
  return partes;
}

function casa(linha: Linha, filtro: string): boolean {
  if (filtro.startsWith("and(")) {
    return condicoes(filtro.slice(4, -1)).every((parte) => casa(linha, parte));
  }
  const [coluna, op, ...resto] = filtro.split(".");
  const bruto = resto.join(".");
  const valor = bruto.startsWith('"') ? bruto.slice(1, -1).replace(/\\(.)/gs, "$1") : bruto;
  const atual = linha[coluna!];
  if (op === "is" && valor === "null") return atual === null;
  // Comparações SQL com NULL não satisfazem o WHERE.
  if (atual === null) return false;
  if (op === "eq") return atual === valor;
  if (op === "gt") return String(atual) > valor;
  if (op === "lt") return String(atual) < valor;
  throw new Error(`Operador não implementado no dublê: ${op}`);
}

function banco(linhas: Linha[]): SupabaseClient {
  return {
    from(tabela: string) {
      const filtros: Array<(linha: Linha) => boolean> = [];
      const ordens: Array<{ coluna: string; asc: boolean; nulosPrimeiro: boolean }> = [];
      let teto = Infinity;
      const consulta = {
        select: () => consulta,
        eq(coluna: string, valor: unknown) {
          filtros.push((linha) => linha[coluna] === valor);
          return consulta;
        },
        is(coluna: string, valor: unknown) {
          filtros.push((linha) => linha[coluna] === valor);
          return consulta;
        },
        in: () => consulta,
        gt(coluna: string, valor: string) {
          filtros.push((linha) => linha[coluna] !== null && String(linha[coluna]) > valor);
          return consulta;
        },
        lt(coluna: string, valor: string) {
          filtros.push((linha) => linha[coluna] !== null && String(linha[coluna]) < valor);
          return consulta;
        },
        or(expressao: string) {
          const partes = condicoes(expressao);
          filtros.push((linha) => partes.some((parte) => casa(linha, parte)));
          return consulta;
        },
        order(coluna: string, opcoes: { ascending: boolean; nullsFirst?: boolean }) {
          ordens.push({ coluna, asc: opcoes.ascending, nulosPrimeiro: opcoes.nullsFirst ?? false });
          return consulta;
        },
        limit(n: number) {
          teto = n;
          return consulta;
        },
        then(resolve: (valor: unknown) => unknown) {
          const data =
            tabela === "contacts" ? linhas.filter((linha) => filtros.every((f) => f(linha))) : [];
          data.sort((a, b) => {
            for (const ordem of ordens) {
              const av = a[ordem.coluna];
              const bv = b[ordem.coluna];
              if (av === bv) continue;
              if (av === null) return ordem.nulosPrimeiro ? -1 : 1;
              if (bv === null) return ordem.nulosPrimeiro ? 1 : -1;
              return (String(av) < String(bv) ? -1 : 1) * (ordem.asc ? 1 : -1);
            }
            return 0;
          });
          return Promise.resolve({ data: data.slice(0, teto), error: null }).then(resolve);
        },
      };
      return consulta;
    },
  } as unknown as SupabaseClient;
}

function contato(n: number, campos: Partial<Linha> = {}): Linha {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    organization_id: ORG,
    kind: "person",
    is_merged_into: null,
    is_personal: false,
    cpf_encrypted: null,
    last_activity_at: null,
    display_name: null,
    ...campos,
  };
}

async function todasAsPaginas(
  linhas: Linha[],
  parametros: ContactListQueryParams,
): Promise<string[]> {
  const cliente = banco(linhas);
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pagina = 0; pagina < 10; pagina++) {
    const r = await listContactsHandler(cliente, ctx, { ...parametros, limit: 1, cursor });
    ids.push(...r.contacts.map((c) => c.id));
    if (!r.has_more) return ids;
    cursor = r.cursor!;
  }
  throw new Error("A paginação não terminou");
}

describe("o cursor de contatos atravessa os valores preenchidos e os nulos", () => {
  it.each(["asc", "desc"] as const)(
    "inclui quem não tem atividade, em ordem %s e sem repetir IDs",
    async (direcao) => {
      const linhas = [
        contato(1, { last_activity_at: "2026-11-01T00:00:00.000Z" }),
        contato(2, { last_activity_at: "2026-11-02T00:00:00.000Z" }),
        contato(3),
        contato(4),
        contato(5, { organization_id: "outra-organizacao" }),
      ];

      const ids = await todasAsPaginas(linhas, {
        order_by: "last_activity_at",
        order_dir: direcao,
      });

      const ordem = direcao === "asc" ? [1, 2, 3, 4] : [2, 1, 4, 3];
      expect(ids).toEqual(ordem.map((n) => contato(n).id));
    },
  );

  it("nome vazio é paginado antes do nome preenchido e do NULL", async () => {
    const linhas = [
      contato(1, { display_name: "" }),
      contato(2, { display_name: "" }),
      contato(3, { display_name: "Ana" }),
      contato(4),
    ];

    expect(await todasAsPaginas(linhas, { order_by: "display_name", order_dir: "asc" })).toEqual(
      linhas.map((c) => c.id),
    );
  });

  it("nome com vírgula, parênteses, aspas e barra permanece um valor do cursor", async () => {
    const nome = 'Silva, "Maria" (Equipe \\ Sul)';
    const linhas = [
      contato(1, { display_name: nome }),
      contato(2, { display_name: nome }),
      contato(3),
    ];

    expect(await todasAsPaginas(linhas, { order_by: "display_name", order_dir: "asc" })).toEqual(
      linhas.map((c) => c.id),
    );
  });

  it.each([0, { nome: "Ana" }])(
    "recusa um valor de cursor com tipo inválido (%j)",
    async (sort) => {
      const cursor = Buffer.from(JSON.stringify({ sort, id: contato(1).id })).toString("base64url");

      await expect(listContactsHandler(banco([]), ctx, { cursor })).rejects.toMatchObject({
        status: 400,
        code: "invalid_cursor",
      });
    },
  );
});
