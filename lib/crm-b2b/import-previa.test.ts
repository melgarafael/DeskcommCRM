/**
 * A prévia da importação (A23, #4888): a REGRA de "já existe", repetida e conflito.
 *
 * `classificarLinhas` é pura — o que já existe entra como mapas —, então a régua
 * se prova sem banco. O que NÃO se prova aqui é a leitura da base
 * (`carregarExistentes`), que é coberta pelo teste da rota.
 */
import { describe, expect, it } from "vitest";

import {
  classificarLinhas,
  emailQueIdentifica,
  totaisDaPrevia,
  type ExistentesNaBase,
  type LinhaParaClassificar,
} from "@/lib/crm-b2b/import-previa";
import type { MappingField } from "@/lib/crm-b2b/spreadsheet";

const VAZIA: Record<MappingField, string> = {
  company_name: "",
  legal_name: "",
  trade_name: "",
  cnpj: "",
  person_name: "",
  job_title: "",
  phone: "",
  email: "",
};

function linha(rowNumber: number, campos: Partial<Record<MappingField, string>>): LinhaParaClassificar {
  return { rowNumber, mapped: { ...VAZIA, ...campos } };
}

function base(parcial: Partial<ExistentesNaBase> = {}): ExistentesNaBase {
  return {
    contatosPorCelular: new Map(),
    contatosPorEmail: new Map(),
    empresasPorCnpj: new Map(),
    ...parcial,
  };
}

const CONTATO_DA_ANA = { tipo: "contato" as const, id: "c1", nome: "Ana", donoId: "u-dono" };
// 11 98888-7777 na forma canônica de `canonicalPhoneBR` (+55 e o nono dígito).
const CEL = "+5511988887777";

function statusDe(linhas: LinhaParaClassificar[], existentes = base()): string[] {
  return classificarLinhas(linhas, existentes).map((l) => l.status);
}

describe("emailQueIdentifica", () => {
  it("minúsculo, com @, e fora das caixas compartilhadas", () => {
    expect(emailQueIdentifica("  Ana@Empresa.com ")).toBe("ana@empresa.com");
    for (const generico of ["contato", "vendas", "comercial", "financeiro", "atendimento", "sac", "suporte", "info", "adm", "nfe", "recepcao"]) {
      expect(emailQueIdentifica(`${generico}@empresa.com`), generico).toBeNull();
    }
    expect(emailQueIdentifica("sem-arroba")).toBeNull();
    expect(emailQueIdentifica("")).toBeNull();
  });
});

describe("linhas que nem chegam à comparação", () => {
  it("sem telefone não entra; telefone inválido e linha vazia são inválidas", () => {
    expect(
      statusDe([
        linha(2, { person_name: "Sem fone", email: "a@b.com" }),
        linha(3, { person_name: "Fone ruim", phone: "123" }),
        linha(4, {}),
        linha(5, { cnpj: "123", phone: CEL }),
      ]),
    ).toEqual(["sem_telefone", "invalida", "invalida", "invalida"]);
  });
});

describe("contra a base", () => {
  it("celular que já existe: já existe, e diz de quem é", () => {
    const [r] = classificarLinhas(
      [linha(2, { person_name: "Ana Souza", phone: "(11) 98888-7777" })],
      base({ contatosPorCelular: new Map([[CEL, CONTATO_DA_ANA]]) }),
    );
    expect(r?.status).toBe("ja_existe");
    expect(r?.existente).toEqual(CONTATO_DA_ANA);
  });

  it("o NOME não entra: mesmo nome, celular diferente é linha nova", () => {
    expect(
      statusDe([linha(2, { person_name: "Ana", phone: "11 97777-6666" })], base({ contatosPorCelular: new Map([[CEL, CONTATO_DA_ANA]]) })),
    ).toEqual(["nova"]);
  });

  it("e-mail pessoal que já existe: já existe; e-mail genérico NÃO conta", () => {
    const existentes = base({
      contatosPorEmail: new Map([
        ["ana@empresa.com", CONTATO_DA_ANA],
        ["contato@empresa.com", CONTATO_DA_ANA], // nem entra na prática; o teste prova que a consulta ignora
      ]),
    });
    expect(
      statusDe(
        [
          linha(2, { phone: "11 91111-2222", email: "Ana@Empresa.com" }),
          linha(3, { phone: "11 93333-4444", email: "contato@empresa.com" }),
        ],
        existentes,
      ),
    ).toEqual(["ja_existe", "nova"]);
  });

  it("empresa com CNPJ que já existe e linha COM telefone: é anexada (a empresa é reaproveitada, a pessoa é nova)", () => {
    const empresa = { tipo: "empresa" as const, id: "e1", nome: "Acme", donoId: "u-dono" };
    const [r] = classificarLinhas(
      [linha(2, { cnpj: "11.222.333/0001-81", phone: CEL })],
      base({ empresasPorCnpj: new Map([["11222333000181", empresa]]) }),
    );
    expect(r?.status).toBe("anexada");
    expect(r?.motivo).toMatch(/empresa já cadastrada/i);
    expect(r?.existente?.nome).toBe("Acme");
  });

  it("linha SÓ de empresa, sem telefone, entra (nova); repetida e CNPJ já na base são avisadas", () => {
    const empresa = { tipo: "empresa" as const, id: "e1", nome: "Acme", donoId: null };
    const r = classificarLinhas(
      [
        linha(2, { company_name: "Beta Ltda", cnpj: "45.723.174/0001-10" }),
        linha(3, { company_name: "Beta Ltda", cnpj: "45.723.174/0001-10" }),
        linha(4, { cnpj: "11.222.333/0001-81" }),
        linha(5, { company_name: "Gama" }),
      ],
      base({ empresasPorCnpj: new Map([["11222333000181", empresa]]) }),
    );
    expect(r.map((x) => x.status)).toEqual(["nova", "repetida", "ja_existe", "nova"]);
    expect(r[2]?.existente).toEqual(empresa);
  });

  it("linha com pessoa e sem telefone não entra, nem com empresa; e-mail ou cargo soltos também não", () => {
    expect(
      statusDe([
        linha(2, { company_name: "Beta", person_name: "Ana" }),
        linha(3, { email: "x@y.com" }),
        linha(4, { job_title: "Diretor" }),
      ]),
    ).toEqual(["sem_telefone", "sem_telefone", "sem_telefone"]);
  });

  it("a regra do telefone vale mais que a do CNPJ para a PESSOA: sem telefone não entra, mesmo com a empresa na base", () => {
    const empresa = { tipo: "empresa" as const, id: "e1", nome: "Acme", donoId: "u-dono" };
    const [r] = classificarLinhas(
      [linha(2, { cnpj: "11.222.333/0001-81", person_name: "Ana" })],
      base({ empresasPorCnpj: new Map([["11222333000181", empresa]]) }),
    );
    expect(r?.status).toBe("sem_telefone");
  });

  it("celular que já é de um contato continua sendo 'já existe', mesmo com o CNPJ da empresa na base", () => {
    const empresa = { tipo: "empresa" as const, id: "e1", nome: "Acme", donoId: null };
    const contato = { tipo: "contato" as const, id: "c1", nome: "Ana", donoId: "u-dono" };
    const [r] = classificarLinhas(
      [linha(2, { cnpj: "11.222.333/0001-81", phone: CEL })],
      base({
        empresasPorCnpj: new Map([["11222333000181", empresa]]),
        contatosPorCelular: new Map([[CEL, contato]]),
      }),
    );
    expect(r?.status).toBe("ja_existe");
  });

  it("duas linhas anexadas ao mesmo celular: a segunda é repetida ou conflito, como qualquer linha", () => {
    const empresa = { tipo: "empresa" as const, id: "e1", nome: "Acme", donoId: null };
    const r = classificarLinhas(
      [
        linha(2, { cnpj: "11.222.333/0001-81", phone: CEL }),
        linha(3, { cnpj: "11.222.333/0001-81", phone: CEL }),
      ],
      base({ empresasPorCnpj: new Map([["11222333000181", empresa]]) }),
    );
    expect(r.map((x) => x.status)).toEqual(["anexada", "repetida"]);
  });

  it("os totais contam as anexadas à parte", () => {
    const t = totaisDaPrevia([
      { rowNumber: 2, status: "nova", motivo: null },
      { rowNumber: 3, status: "anexada", motivo: "x" },
      { rowNumber: 4, status: "anexada", motivo: "x" },
    ]);
    expect(t).toMatchObject({ total: 3, novas: 1, anexadas: 2 });
  });
});

describe("dentro da planilha", () => {
  it("linha idêntica é descartada como repetida, e a primeira entra", () => {
    const l = { person_name: "Ana", phone: CEL, email: "ana@x.com" };
    const r = classificarLinhas([linha(2, l), linha(3, { ...l, person_name: " ANA " })], base());
    expect(r.map((x) => x.status)).toEqual(["nova", "repetida"]);
    expect(r[1]?.motivo).toMatch(/linha 2/);
  });

  it("mesmo celular com dados diferentes: conflito", () => {
    expect(
      statusDe([
        linha(2, { person_name: "Ana", phone: CEL }),
        linha(3, { person_name: "Beatriz", phone: "(11) 98888-7777" }),
      ]),
    ).toEqual(["nova", "conflito"]);
  });

  it("o celular de um registro e o e-mail de OUTRO: conflito", () => {
    const r = classificarLinhas(
      [
        linha(2, { person_name: "Ana", phone: CEL }),
        linha(3, { person_name: "Beatriz", phone: "11 97777-6666", email: "bia@x.com" }),
        linha(4, { person_name: "Misto", phone: CEL, email: "bia@x.com" }),
      ],
      base(),
    );
    expect(r.map((x) => x.status)).toEqual(["nova", "nova", "conflito"]);
    expect(r[2]?.motivo).toMatch(/linha 2.*linha 3/);
  });

  it("e-mail genérico repetido na planilha NÃO vira conflito: vale só o celular", () => {
    expect(
      statusDe([
        linha(2, { person_name: "Ana", phone: "11 91111-2222", email: "contato@x.com" }),
        linha(3, { person_name: "Beatriz", phone: "11 93333-4444", email: "contato@x.com" }),
      ]),
    ).toEqual(["nova", "nova"]);
  });

  it("uma linha que sobra não segura a chave: só a PRIMEIRA a detém", () => {
    expect(
      statusDe([
        linha(2, { person_name: "Ana", phone: CEL }),
        linha(3, { person_name: "Outra", phone: CEL }),
        linha(4, { person_name: "Outra", phone: CEL }),
      ]),
    ).toEqual(["nova", "conflito", "conflito"]);
  });
});

describe("totaisDaPrevia", () => {
  it("conta cada veredito uma vez", () => {
    const l = { person_name: "Ana", phone: CEL };
    const r = classificarLinhas(
      [linha(2, l), linha(3, l), linha(4, { person_name: "Sem" }), linha(5, { phone: "1" })],
      base(),
    );
    expect(totaisDaPrevia(r)).toEqual({
      total: 4,
      novas: 1,
      anexadas: 0,
      ja_existem: 0,
      conflitos: 0,
      repetidas: 1,
      sem_telefone: 1,
      invalidas: 1,
    });
  });
});
