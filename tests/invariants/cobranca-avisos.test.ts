import { beforeAll, describe, expect, it } from "vitest";

import { assinar, comoAnon, comoServidor, comoUsuario, criarOrg, criarPlano, erroDe, numero, resultado, uuid, valor } from "./cobranca-helpers";

/**
 * O AVISO DA RÉGUA E O ITEM DA CENTRAL NASCEM JUNTOS — spec da cobrança do
 * revendedor §3.2 (garantias), §7d, D-5; migration 0601, seção E.
 *
 * "Ninguém é suspenso sem aviso final gravado há 48 h JUNTO com o item na
 * Central": o `ultimo_aviso` e o item precisam da mesma transação, ou a régua
 * suspenderia por um aviso que a empresa nunca viu. E o mesmo aviso da mesma
 * dívida ganha uma vez só: cron e sinal correndo juntos não duplicam o item.
 */

const P = "c0b3a003-0000-4000-8000";
const PLANO = uuid(P, 101);
const ORG = uuid(P, 1);
const ORG_IA = uuid(P, 2);
const ISENTA = uuid(P, 3);
const DEVEDORA = uuid(P, 4);

const ontem = () => new Date(Date.now() - 86_400_000).toISOString();

function registrar(org: string, aviso: string, desde: string | null): string {
  return valor(
    comoServidor(
      `select public.fn_cobranca_registrar_aviso('${org}', '${aviso}', ${desde === null ? "null" : `'${desde}'`}, 'Título ${aviso}', 'Corpo', 'warn')::text`,
    ),
  );
}

const abertos = (org: string) =>
  numero(`select count(*) from public.agent_inbox_items where organization_id = '${org}' and kind = 'cobranca' and ref_kind is null and status = 'open';`);

beforeAll(() => {
  criarPlano({ id: PLANO, nome: "Avisos" });
  criarOrg(ORG, "cob-avisos-1");
  criarOrg(ORG_IA, "cob-avisos-2");
  criarOrg(ISENTA, "cob-avisos-3");
  criarOrg(DEVEDORA, "cob-avisos-4");
  assinar(ORG, PLANO);
  assinar(ORG_IA, PLANO);
  assinar(DEVEDORA, PLANO);
});

describe("fn_cobranca_registrar_aviso", () => {
  it("⭐ o mesmo aviso da mesma dívida ganha uma vez só, com um item só", () => {
    const desde = ontem();
    expect(registrar(ORG, "venceu", desde)).toBe("true");
    expect(registrar(ORG, "venceu", desde)).toBe("false");
    expect(abertos(ORG)).toBe(1);
    expect(valor(`select ultimo_aviso from public.cobranca_assinaturas where organization_id = '${ORG}';`)).toBe("venceu");
  });

  it("⭐ o aviso seguinte fecha o anterior na Central: a empresa vê só a situação de agora", () => {
    expect(registrar(ORG, "suspende_em_breve", ontem())).toBe("true");
    expect(abertos(ORG)).toBe(1);
    expect(
      numero(`select count(*) from public.agent_inbox_items where organization_id = '${ORG}' and kind = 'cobranca' and status = 'resolved' and resolved_at is not null;`),
    ).toBe(1);
  });

  it("dívida NOVA depois do aviso: o mesmo aviso ganha de novo", () => {
    const depoisDoAviso = new Date(Date.now() + 60_000).toISOString();
    expect(registrar(ORG, "suspende_em_breve", depoisDoAviso)).toBe("true");
  });

  it("aviso fora do vocabulário é recusado pelo CHECK, e nenhum item nasce", () => {
    const antes = abertos(ORG);
    const e = erroDe(comoServidor(`select public.fn_cobranca_registrar_aviso('${ORG}', 'forjado', null, 'x', 'y', 'warn')`));
    expect(e).toContain("23514");
    expect(abertos(ORG)).toBe(antes);
  });

  it("empresa isenta (sem assinatura): false e nenhum item", () => {
    expect(registrar(ISENTA, "venceu", ontem())).toBe("false");
    expect(abertos(ISENTA)).toBe(0);
  });
});

describe("fn_cobranca_avisar_teto_de_ia", () => {
  it("⭐ um aviso por mês, com referência ao plano", () => {
    const chamar = () =>
      valor(comoServidor(`select public.fn_cobranca_avisar_teto_de_ia('${ORG_IA}', 'IA a 80%', 'corpo')::text`));
    expect(chamar()).toBe("true");
    expect(chamar()).toBe("false");
    expect(
      valor(`select ref_kind || '|' || ref_id::text from public.agent_inbox_items where organization_id = '${ORG_IA}' and kind = 'cobranca';`),
    ).toBe(`plano|${ORG_IA}`);
  });
});

describe("fn_cobranca_suspender_se_devendo", () => {
  const estado = (e: string) => valor(`update public.cobranca_assinaturas set estado = '${e}' where organization_id = '${DEVEDORA}'; select 1;`);
  const suspender = () => resultado(`public.fn_cobranca_suspender_se_devendo('${DEVEDORA}', 'Falta de pagamento')`);

  it("⭐ quem JÁ pagou entre a decisão da régua e a suspensão não é suspenso", () => {
    estado("ativa");
    expect(suspender()).toMatchObject({ changed: false });
    expect(valor(`select status from public.organizations where id = '${DEVEDORA}';`)).toBe("active");
  });

  it("ainda em dívida: suspende por cobrança", () => {
    estado("em_atraso");
    expect(suspender()).toMatchObject({ changed: true });
    expect(valor(`select status || '|' || suspended_kind from public.organizations where id = '${DEVEDORA}';`)).toBe("suspended|cobranca");
  });
});

describe("a coluna e os grants", () => {
  it("link_de_pagamento existe e nasce nulo", () => {
    expect(valor(`select coalesce(link_de_pagamento, 'nulo') from public.cobranca_assinaturas where organization_id = '${ORG}';`)).toBe("nulo");
  });

  it("EXECUTE só do servidor nas três funções", () => {
    for (const chamada of [
      `select public.fn_cobranca_registrar_aviso('${ORG}', 'venceu', null, 'x', 'y', 'warn')`,
      `select public.fn_cobranca_avisar_teto_de_ia('${ORG}', 'x', 'y')`,
      `select public.fn_cobranca_suspender_se_devendo('${ORG}', 'x')`,
    ]) {
      expect(erroDe(comoUsuario(uuid(P, 99), chamada))).toContain("42501");
      expect(erroDe(comoAnon(chamada))).toContain("42501");
    }
  });
});
