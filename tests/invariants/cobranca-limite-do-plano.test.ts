import { beforeAll, describe, expect, it } from "vitest";

import { RECURSOS_DO_PLANO } from "@/lib/cobranca/vocabulario";

import { sql } from "./gov-helpers";
import {
  assinar, chaveDeCobranca, comoAnon, comoServidor, comoUsuario, criarOrg, criarPlano, criarUsuarios, erroDe, uuid, valor, vincular,
} from "./cobranca-helpers";

/**
 * O LIMITE DO PLANO (migration 0510; spec §2.6, §5). Nulo = sem limite: chave
 * desligada, org sem assinatura (isenta) ou plano sem teto. O plano agendado não
 * vale antes da virada paga (D-3). Os recursos aceitos são RECURSOS_DO_PLANO,
 * lidos aqui do CORPO da função no catálogo.
 */

const P = "c0b00003-0000-4000-8000";
const ORG_COM_TETO = uuid(P, 1);
const ORG_SEM_TETO = uuid(P, 2);
const ORG_ISENTA = uuid(P, 3);
const ADMIN = uuid(P, 11);
const PLANO_COM_TETO = uuid(P, 101);
const PLANO_SEM_TETO = uuid(P, 102);
const PLANO_MAIOR = uuid(P, 103);

function limite(org: string, recurso: string): string {
  return valor(comoServidor(`select coalesce(public.fn_limite_do_plano('${org}', '${recurso}')::text, 'sem limite')`));
}

function ligada(): string {
  return valor(comoServidor(`select public.fn_cobranca_ligada()::text`));
}

beforeAll(() => {
  criarUsuarios([[ADMIN, "admin-limite-0510@invariant.test"]]);
  criarOrg(ORG_COM_TETO, "cob-limite-1");
  criarOrg(ORG_SEM_TETO, "cob-limite-2");
  criarOrg(ORG_ISENTA, "cob-limite-3");
  vincular(ADMIN, ORG_COM_TETO, "admin");
  criarPlano({ id: PLANO_COM_TETO, nome: "Com teto", maxAssentos: 3, maxCanais: 2, tetoIaUsdCents: 500 });
  criarPlano({ id: PLANO_SEM_TETO, nome: "Sem teto" });
  criarPlano({ id: PLANO_MAIOR, nome: "Maior", maxAssentos: 30, maxCanais: 20, tetoIaUsdCents: 50000 });
  assinar(ORG_COM_TETO, PLANO_COM_TETO);
  assinar(ORG_SEM_TETO, PLANO_SEM_TETO);
});

describe("fn_cobranca_ligada e fn_limite_do_plano", () => {
  it("fn_cobranca_ligada: só o valor `ligado` liga", () => {
    chaveDeCobranca("ausente");
    expect(ligada()).toBe("false");
    chaveDeCobranca("desligado");
    expect(ligada()).toBe("false");
    sql(`update public.platform_config set valor = 'LIGADO' where chave = 'MODULO_COBRANCA';`);
    expect(ligada()).toBe("false");
    chaveDeCobranca("ligado");
    expect(ligada()).toBe("true");
  });

  it("⭐ chave desligada ou ausente: nenhum limite, mesmo com assinatura", () => {
    for (const estado of ["ausente", "desligado"] as const) {
      chaveDeCobranca(estado);
      for (const recurso of RECURSOS_DO_PLANO) expect(limite(ORG_COM_TETO, recurso), `${estado}/${recurso}`).toBe("sem limite");
    }
  });

  it("chave ligada: o limite é o do plano da assinatura", () => {
    chaveDeCobranca("ligado");
    expect(limite(ORG_COM_TETO, "assentos")).toBe("3");
    expect(limite(ORG_COM_TETO, "canais")).toBe("2");
    expect(limite(ORG_COM_TETO, "ia_usd_cents")).toBe("500");
  });

  it("plano sem teto e org sem assinatura (isenta): sem limite", () => {
    chaveDeCobranca("ligado");
    for (const recurso of RECURSOS_DO_PLANO) {
      expect(limite(ORG_SEM_TETO, recurso), recurso).toBe("sem limite");
      expect(limite(ORG_ISENTA, recurso), recurso).toBe("sem limite");
    }
  });

  it("o plano AGENDADO não vale antes da virada paga (D-3)", () => {
    chaveDeCobranca("ligado");
    sql(`update public.cobranca_assinaturas set plano_agendado_id = '${PLANO_MAIOR}' where organization_id = '${ORG_COM_TETO}';`);
    try {
      expect(limite(ORG_COM_TETO, "assentos")).toBe("3");
    } finally {
      sql(`update public.cobranca_assinaturas set plano_agendado_id = null where organization_id = '${ORG_COM_TETO}';`);
    }
  });

  it("⭐ recurso fora do vocabulário é 22023, com a chave ligada ou ausente", () => {
    for (const estado of ["ligado", "ausente"] as const) {
      chaveDeCobranca(estado);
      for (const chamada of [`'contatos'`, `null`]) {
        const e = erroDe(comoServidor(`select public.fn_limite_do_plano('${ORG_COM_TETO}', ${chamada})`));
        expect(e, `${estado}/${chamada}`).toContain("22023");
        expect(e, `${estado}/${chamada}`).toContain("recurso_do_plano_invalido");
      }
    }
  });

  it("⭐ SQL e TypeScript aceitam os mesmos recursos (RECURSOS_DO_PLANO)", () => {
    const def = sql(`select pg_get_functiondef('public.fn_limite_do_plano(uuid, text)'::regprocedure);`);
    const m = /p_recurso not in \(([^)]*)\)/.exec(def);
    expect(m, "o corpo da função mudou de forma: ensine esta sonda").not.toBeNull();
    const doBanco = [...(m?.[1] ?? "").matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
    expect(doBanco).toEqual([...RECURSOS_DO_PLANO].sort());
    chaveDeCobranca("ligado");
    for (const recurso of RECURSOS_DO_PLANO) {
      expect(erroDe(comoServidor(`select public.fn_limite_do_plano('${ORG_COM_TETO}', '${recurso}')`)), recurso).toBe("");
    }
  });

  it("nenhuma sessão executa as duas funções; o servidor sim", () => {
    const chamadas = [`select public.fn_cobranca_ligada()`, `select public.fn_limite_do_plano('${ORG_COM_TETO}', 'assentos')`];
    for (const chamada of chamadas) {
      for (const script of [comoUsuario(ADMIN, chamada), comoAnon(chamada)]) {
        expect(erroDe(script), chamada).toContain("permission denied for function");
      }
      expect(erroDe(comoServidor(chamada)), chamada).toBe("");
    }
  });
});
