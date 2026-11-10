import { describe, expect, it } from "vitest";

import {
  contatosDonosDosExtras,
  encontrarContatoPorTelefone,
  encontrarContatoPorTelefoneComBloqueio,
  encontrarContatoPorTelefoneComNome,
  idsDoContatoEGemeos,
} from "@/lib/channels/contato-por-telefone";

/**
 * A FICHA ACHADA PELO TELEFONE EXTRA (Spec 31, parte B1 — item 3 do PR B).
 *
 * A ficha guarda vários números: o principal (`contacts.phone_number`) e os
 * extras (`contact_phones`). Antes, a busca só olhava o principal — a mensagem
 * que chegava pelo segundo número abria uma ficha nova, a duplicata que a
 * junção de fichas acabou de desfazer.
 *
 * O que este arquivo prova, com um cliente em memória que registra cada filtro:
 *   - principal ainda ganha, e a resposta de quem NÃO tem extra não muda;
 *   - sem principal, o extra acha a ficha DONA (com a forma que o principal devolve);
 *   - extra de ficha fundida não conta;
 *   - a consulta aos extras leva `organization_id` (a outra organização não acha).
 *
 * O cliente é um fake de propósito: a regra é a ordem de busca e os filtros,
 * não o PostgREST. O banco de verdade fica com o `pnpm test:db` no CI.
 */

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "aaaaaaaa-0000-4000-8000-000000000002";

const SEM_NONO = "+553284793302";
const COM_NONO = "+5532984793302";
const NUMERO_DO_PRINCIPAL = "+5531991112222";

interface Linha {
  [coluna: string]: unknown;
}
interface Banco {
  contacts: Linha[];
  contact_phones: Linha[];
}
interface Filtro {
  tabela: string;
  op: "eq" | "in" | "is" | "not";
  coluna: string;
  valor: unknown;
}

/**
 * Cliente em memória. Aplica os filtros de verdade (eq/in/is/limit) e guarda
 * cada um em `filtros`, para o teste poder perguntar "a consulta aos extras
 * filtrou por organização?".
 */
function fakeAdmin(banco: Banco, filtros: Filtro[] = []) {
  return {
    from(tabela: string) {
      const linhas = banco[tabela as keyof Banco] ?? [];
      let resultado: Linha[] = linhas;
      let limite: number | null = null;
      // Como o PostgREST: devolve só as colunas pedidas no `select`.
      let colunasPedidas: string[] | null = null;
      const projeta = (rs: Linha[]): Linha[] =>
        colunasPedidas
          ? rs.map((r) => Object.fromEntries(colunasPedidas!.map((k) => [k, r[k]])))
          : rs;
      const b = {
        select(colunas?: string) {
          if (colunas) colunasPedidas = colunas.split(",").map((s) => s.trim());
          return b;
        },
        eq(coluna: string, valor: unknown) {
          filtros.push({ tabela, op: "eq", coluna, valor });
          resultado = resultado.filter((r) => r[coluna] === valor);
          return b;
        },
        in(coluna: string, valores: unknown[]) {
          filtros.push({ tabela, op: "in", coluna, valor: valores });
          resultado = resultado.filter((r) => valores.includes(r[coluna]));
          return b;
        },
        is(coluna: string, valor: null) {
          filtros.push({ tabela, op: "is", coluna, valor });
          resultado = resultado.filter((r) => (r[coluna] ?? null) === valor);
          return b;
        },
        limit(n: number) {
          limite = n;
          return b;
        },
        maybeSingle() {
          const primeira = projeta(limite !== null ? resultado.slice(0, limite) : resultado)[0] ?? null;
          return Promise.resolve({ data: primeira, error: null });
        },
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          const corte = projeta(limite !== null ? resultado.slice(0, limite) : resultado);
          return Promise.resolve({ data: corte, error: null }).then(onF, onR);
        },
      };
      return b;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Ficha viva com principal e, opcionalmente, um extra apontando para ela. */
function bancoComUmExtra(extra: { numero: string; org?: string; dona?: string } | null): Banco {
  const banco: Banco = {
    contacts: [
      {
        id: "dona",
        organization_id: ORG,
        phone_number: NUMERO_DO_PRINCIPAL,
        name: "Clínica Aurora",
        is_blocked: false,
        is_personal: false,
        is_merged_into: null,
      },
    ],
    contact_phones: [],
  };
  if (extra) {
    banco.contact_phones.push({
      organization_id: extra.org ?? ORG,
      contact_id: extra.dona ?? "dona",
      phone_number: extra.numero,
    });
  }
  return banco;
}

describe("sem extra: o resultado é o de hoje", () => {
  it("principal achado pela grafia sem o nono continua igual e sem a marca de extra", async () => {
    const banco = bancoComUmExtra(null);
    banco.contacts[0]!.phone_number = COM_NONO;

    const achado = await encontrarContatoPorTelefone(fakeAdmin(banco), ORG, SEM_NONO);

    expect(achado).toEqual({ id: "dona", phone_number: COM_NONO });
    expect(achado).not.toHaveProperty("achado_pelo_extra");
  });

  it("número que não existe em lugar nenhum continua null", async () => {
    const achado = await encontrarContatoPorTelefone(fakeAdmin(bancoComUmExtra(null)), ORG, "+14155550123");
    expect(achado).toBeNull();
  });
});

describe("sem principal, o extra acha a ficha DONA", () => {
  it("devolve a dona e o número que chegou, marcado como achado pelo extra", async () => {
    const banco = bancoComUmExtra({ numero: COM_NONO });

    const achado = await encontrarContatoPorTelefone(fakeAdmin(banco), ORG, SEM_NONO);

    expect(achado).toEqual({ id: "dona", phone_number: COM_NONO, achado_pelo_extra: true });
  });

  it("o principal ganha do extra: se os dois existirem, quem vale é a ficha do principal", async () => {
    // Estado que a regra "um número, uma ficha" tenta evitar. Se existir, o
    // principal é a resposta de sempre — o extra só entra quando não há principal.
    const banco: Banco = {
      contacts: [
        { id: "principal", organization_id: ORG, phone_number: COM_NONO, is_merged_into: null },
        { id: "outra", organization_id: ORG, phone_number: NUMERO_DO_PRINCIPAL, is_merged_into: null },
      ],
      contact_phones: [{ organization_id: ORG, contact_id: "outra", phone_number: COM_NONO }],
    };

    const achado = await encontrarContatoPorTelefone(fakeAdmin(banco), ORG, COM_NONO);

    expect(achado?.id).toBe("principal");
    expect(achado).not.toHaveProperty("achado_pelo_extra");
  });

  it("a versão com nome e com bloqueio também acham pela dona, com as colunas dela", async () => {
    const banco = bancoComUmExtra({ numero: COM_NONO });
    banco.contacts[0]!.is_blocked = true;

    const comNome = await encontrarContatoPorTelefoneComNome(fakeAdmin(banco), ORG, SEM_NONO);
    const comBloqueio = await encontrarContatoPorTelefoneComBloqueio(fakeAdmin(banco), ORG, SEM_NONO);

    expect(comNome).toMatchObject({ id: "dona", name: "Clínica Aurora", achado_pelo_extra: true });
    expect(comBloqueio).toMatchObject({ id: "dona", is_blocked: true, is_personal: false });
  });
});

describe("extra de ficha fundida não conta", () => {
  it("a dona está na lápide de fusão: nenhuma ficha é achada", async () => {
    const banco = bancoComUmExtra({ numero: COM_NONO });
    banco.contacts[0]!.is_merged_into = "vencedora";

    const achado = await encontrarContatoPorTelefone(fakeAdmin(banco), ORG, SEM_NONO);

    expect(achado).toBeNull();
  });
});

describe("a consulta aos extras é da organização", () => {
  it("o extra de OUTRA organização não acha a ficha, e a consulta leva organization_id", async () => {
    const banco = bancoComUmExtra({ numero: COM_NONO, org: ORG_B });
    const filtros: Filtro[] = [];

    const achado = await encontrarContatoPorTelefone(fakeAdmin(banco, filtros), ORG, SEM_NONO);

    expect(achado).toBeNull();
    const consultaAosExtras = filtros.filter((f) => f.tabela === "contact_phones");
    expect(consultaAosExtras.length).toBeGreaterThan(0);
    expect(consultaAosExtras).toContainEqual(
      expect.objectContaining({ op: "eq", coluna: "organization_id", valor: ORG }),
    );
  });

  it("a leitura da dona também filtra por organização", async () => {
    const banco = bancoComUmExtra({ numero: COM_NONO });
    const filtros: Filtro[] = [];

    await encontrarContatoPorTelefone(fakeAdmin(banco, filtros), ORG, SEM_NONO);

    const leituraDaDona = filtros.filter((f) => f.tabela === "contacts" && f.coluna === "id");
    expect(leituraDaDona.length).toBeGreaterThan(0);
    expect(filtros).toContainEqual(
      expect.objectContaining({ tabela: "contacts", op: "eq", coluna: "organization_id", valor: ORG }),
    );
  });
});

describe("gêmeos e pilhas de números", () => {
  it("idsDoContatoEGemeos inclui a ficha que tem o número como extra", async () => {
    // A mensagem vem da ficha "msg", com o número SEM o nono. A dona tem a
    // forma canônica como extra: é gêmea da mensagem e entra no conjunto.
    const banco: Banco = {
      contacts: [
        { id: "msg", organization_id: ORG, phone_number: SEM_NONO, is_merged_into: null },
        { id: "dona", organization_id: ORG, phone_number: NUMERO_DO_PRINCIPAL, is_merged_into: null },
      ],
      contact_phones: [{ organization_id: ORG, contact_id: "dona", phone_number: COM_NONO }],
    };

    const ids = await idsDoContatoEGemeos(fakeAdmin(banco), ORG, "msg");

    expect(ids).toEqual(expect.arrayContaining(["msg", "dona"]));
  });

  it("contatosDonosDosExtras devolve número canônico -> dona, e só fichas vivas", async () => {
    const banco: Banco = {
      contacts: [
        { id: "viva", organization_id: ORG, phone_number: NUMERO_DO_PRINCIPAL, is_merged_into: null },
        { id: "fundida", organization_id: ORG, phone_number: null, is_merged_into: "viva" },
      ],
      contact_phones: [
        { organization_id: ORG, contact_id: "viva", phone_number: COM_NONO },
        { organization_id: ORG, contact_id: "fundida", phone_number: "+5511988887777" },
      ],
    };

    const mapa = await contatosDonosDosExtras(fakeAdmin(banco), ORG, [SEM_NONO, "+5511988887777"]);

    expect([...mapa.entries()]).toEqual([[COM_NONO, "viva"]]);
  });

  it("contatosDonosDosExtras com lista vazia não consulta nada", async () => {
    const filtros: Filtro[] = [];
    const mapa = await contatosDonosDosExtras(fakeAdmin(bancoComUmExtra(null), filtros), ORG, []);
    expect(mapa.size).toBe(0);
    expect(filtros).toHaveLength(0);
  });
});

/*
 * Sabotagem: tirar a chamada de `buscarPeloExtra` em `buscarPorVariantes` deixa
 * o caso "sem principal, o extra acha a dona" com `null` — vermelho. Trocar o
 * filtro `organization_id` da consulta aos extras por nada deixa o caso de outra
 * organização achando a ficha — vermelho. Tirar o `is("is_merged_into", null)` da
 * dona faz o caso da lápide achar a ficha fundida — vermelho.
 */
