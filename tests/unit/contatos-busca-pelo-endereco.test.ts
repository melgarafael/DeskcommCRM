/**
 * O ENDEREÇO DO CONTATO ENTRA NA BUSCA (#3494).
 *
 * ─── O defeito, e o que mudou ────────────────────────────────────────────────
 * A 9041 levou as sete colunas de endereço para `contacts` e o cadastro passou a
 * preenchê-las pelo CEP — mas o `?search=` da tela de Contatos montava o `.or()`
 * com nome, e-mail, telefone e CPF e nada mais. Quem recebia o cliente pelo
 * endereço ("o da Rua XV, 120") não achava o cadastro: o dado estava gravado e
 * invisível para a única porta que a tela usa para procurar.
 *
 * ─── O que este arquivo mede, e o que ele NÃO mede ───────────────────────────
 * Não há banco em `tests/unit`: o que se mede é o FILTRO que sai do handler —
 * quais colunas entram no `.or()`, com que padrão, e que o escopo por
 * organização continua na consulta. Que a coluna gerada CASA no Postgres (com
 * `unaccent` e trigrama de verdade) é
 * `tests/invariants/contato-endereco-busca-e-exportacao.test.ts` (`test:db`).
 *
 * A coluna do endereço é GERADA e sem acento (`endereco_sem_acento`, migration
 * 9403), pela MESMA régua da `busca_sem_acento` do nome: `ilike` na `street`
 * crua repetiria o defeito da #3924 — "sao paulo" não acharia "São Paulo".
 */
import { describe, expect, it } from "vitest";

import { listContactsHandler } from "@/app/api/v1/contacts/_handler";
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

const ORG = "22222222-2222-4222-8222-222222222222";

/**
 * Cliente mínimo que registra o `.or()` montado e as igualdades (o escopo por
 * organização e a lápide de fusão). O `then` é o `await` — momento em que o
 * supabase-js faria o fetch.
 */
function supabaseEspiao() {
  const estado = {
    filtros: [] as string[],
    igualdades: [] as Array<[string, unknown]>,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    eq: (coluna: string, valor: unknown) => {
      estado.igualdades.push([coluna, valor]);
      return chain;
    },
    is: () => chain,
    order: () => chain,
    limit: () => chain,
    contains: () => chain,
    in: () => chain,
    or: (expr: string) => {
      estado.filtros.push(expr);
      return chain;
    },
    then: (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(res),
  };
  return { client: { from: () => chain } as never, estado };
}

async function busca(termo: string) {
  const { client, estado } = supabaseEspiao();
  await listContactsHandler(
    client,
    { organization_id: ORG, actor: { type: "user", id: "u-1" }, requestId: "req" },
    { search: termo, limit: 20 },
  );
  // O último `.or()` é o da listagem: termo com cara de telefone abre uma
  // consulta antes (telefones extras), e é a condição final que interessa.
  return {
    filtro: estado.filtros[estado.filtros.length - 1] ?? "",
    igualdades: estado.igualdades,
  };
}

describe("busca de contatos pelo endereço (#3494)", () => {
  it("o filtro leva a coluna gerada do endereço, com o termo sem acento", async () => {
    const { filtro } = await busca("São Paulo");

    expect(filtro).toContain(`endereco_sem_acento.like.*${termoSemAcento("sao*paulo")}*`);
    // A coluna crua NÃO entra: ali o acento separa "São" de "sao".
    expect(filtro).not.toContain("street.ilike");
    expect(filtro).not.toContain("city.ilike");
  });

  it("rua e bairro entram pelo mesmo campo gerado — não há coluna por coluna", async () => {
    const { filtro } = await busca("XV de Novembro");

    expect(filtro).toContain("endereco_sem_acento.like.*xv*de*novembro*");
    // Nome, e-mail e telefone continuam na mesma consulta: a busca do endereço
    // SOMA às portas que já existiam, não troca nenhuma.
    expect(filtro).toContain("busca_sem_acento.like.*");
    expect(filtro).toContain("email.ilike.*");
    expect(filtro).toContain("phone_number.ilike.*");
  });

  it("CEP digitado sem máscara casa também com o gravado com máscara", async () => {
    const { filtro } = await busca("80000000");

    expect(filtro).toContain("zip_code.ilike.*80000000*");
    // `zip_code` é texto livre: o CEP que sai da consulta vem `80000-000`, e o
    // que sai do teclado numérico vem `80000000`. Uma variante só acharia
    // metade da base.
    expect(filtro).toContain("zip_code.ilike.*80000-000*");
  });

  it("CEP com máscara é reduzido aos dígitos e casa com as duas grafias", async () => {
    const { filtro } = await busca("80000-000");

    expect(filtro).toContain("zip_code.ilike.*80000000*");
    expect(filtro).toContain("zip_code.ilike.*80000-000*");
  });

  it("o escopo por organização continua na consulta — o endereço não abre porta", async () => {
    const { igualdades } = await busca("Rua XV de Novembro");

    expect(igualdades).toContainEqual(["organization_id", ORG]);
    expect(igualdades).toContainEqual(["kind", "person"]);
  });
});
