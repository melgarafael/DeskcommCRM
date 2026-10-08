import { beforeAll, describe, expect, it } from "vitest";

import { PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";

import { sql } from "./gov-helpers";
import {
  alguemEsperaTravaConsultiva, assinar, canaisOcupados, chaveDeCobranca, corrida, criarOrg, criarPlano, erroDe,
  insercaoDeCanal, sessao, uuid,
} from "./cobranca-helpers";

/**
 * O TETO DE NÚMEROS CONECTADOS — invariante 6 da spec (§5, §12), migration 0583.
 * Conta canal não arquivado que não seja `wacalls` (voz); desarquivar, trocar o
 * provider e trocar de org contam; regravar `archived_at = null` num canal que
 * JÁ está no ar não conta (é o que a reconexão faz); a trava consultiva é a
 * MESMA de fn_reserve_channel_connection (chave 2281), então reserva e inserção
 * direta nunca contam ao mesmo tempo.
 */

const P = "c0b00005-0000-4000-8000";
const org = (n: number) => uuid(P, n);
const canal = (n: number) => uuid(P, 100 + n);
const PLANO_1 = uuid(P, 901);
const PLANO_5 = uuid(P, 902);
const PLANO_SEM_TETO = uuid(P, 903);

beforeAll(() => {
  criarPlano({ id: PLANO_1, nome: "Um número", maxCanais: 1 });
  criarPlano({ id: PLANO_5, nome: "Cinco números", maxCanais: 5 });
  criarPlano({ id: PLANO_SEM_TETO, nome: "Sem teto" });
  for (let n = 1; n <= 10; n++) criarOrg(org(n), `cob-canais-${n}`);
  chaveDeCobranca("ligado");
});

describe("inv. 6 — canais de mensagem", () => {
  it("⭐ teto 1: o segundo número é PT402 com a mensagem que o app lê; voz (wacalls) não conta", () => {
    assinar(org(1), PLANO_1);
    sql(`${insercaoDeCanal(canal(1), org(1))};`);
    const e = erroDe(`${insercaoDeCanal(canal(2), org(1))};`);
    expect(e).toContain("PT402");
    // O contrato com lib/cobranca/limites.ts: a MENSAGEM carrega recurso e teto.
    expect(e).toContain("limite_do_plano:canais:1");
    expect(e).toContain(`"recurso": "canais"`);
    expect(e).toContain(`"limite": 1`);
    expect(erroDe(`${insercaoDeCanal(canal(3), org(1), "wacalls")};`)).toBe("");
    expect(canaisOcupados(org(1))).toBe(1);
  });

  it("arquivar libera a vaga; desarquivar acima do teto é recusado", () => {
    assinar(org(2), PLANO_1);
    sql(`${insercaoDeCanal(canal(4), org(2))};`);
    sql(`update public.channel_sessions set archived_at = now() where id = '${canal(4)}';`);
    sql(`${insercaoDeCanal(canal(5), org(2))};`);
    expect(erroDe(`update public.channel_sessions set archived_at = null where id = '${canal(4)}';`)).toContain("PT402");
    expect(canaisOcupados(org(2))).toBe(1);
  });

  it("⭐ regravar archived_at = null num canal JÁ ativo, com o plano cheio, passa (reconexão)", () => {
    // savePartnerSession e reactivateChannelSession gravam archived_at = null em
    // todo UPDATE, e o gatilho dispara em `update of archived_at`. Reconectar o
    // número que já está no ar não pode virar "Seu plano permite 1 número conectado".
    assinar(org(10), PLANO_1);
    sql(`${insercaoDeCanal(canal(21), org(10))};`);
    expect(erroDe(`update public.channel_sessions set archived_at = null, provider = 'waha' where id = '${canal(21)}';`)).toBe("");
    expect(canaisOcupados(org(10))).toBe(1);
  });

  it("trocar um canal de voz para mensagem acima do teto é recusado", () => {
    assinar(org(3), PLANO_1);
    sql(`${insercaoDeCanal(canal(6), org(3))};`);
    sql(`${insercaoDeCanal(canal(7), org(3), "wacalls")};`);
    expect(erroDe(`update public.channel_sessions set provider = 'waha', waha_session_name = 'cob-troca-${canal(7).slice(-12)}'
                    where id = '${canal(7)}';`)).toContain("PT402");
  });

  it("mudar a organização de um canal conta no destino", () => {
    assinar(org(4), PLANO_1);
    sql(`${insercaoDeCanal(canal(8), org(4))};`);
    sql(`${insercaoDeCanal(canal(9), org(5))};`);
    expect(erroDe(`update public.channel_sessions set organization_id = '${org(4)}' where id = '${canal(9)}';`)).toContain("PT402");
  });

  it("⭐ duas conexões ao mesmo tempo com uma vaga: exatamente uma passa", async () => {
    assinar(org(6), PLANO_1);
    const [primeira, segunda] = await corrida(insercaoDeCanal(canal(10), org(6)), insercaoDeCanal(canal(11), org(6)));
    expect(primeira.ok, primeira.saida).toBe(true);
    expect(segunda.ok, "a segunda entrou junto: a trava consultiva sumiu").toBe(false);
    expect(segunda.saida).toContain("PT402");
    expect(canaisOcupados(org(6))).toBe(1);
  });

  it("⭐ a trava é a MESMA de fn_reserve_channel_connection: com a reserva em curso, a inserção espera", async () => {
    assinar(org(7), PLANO_5);
    const reserva = sessao(`begin; select pg_advisory_xact_lock(hashtextextended('${org(7)}'::text, 2281)); select pg_sleep(2); commit;`);
    await new Promise((r) => setTimeout(r, 400));
    const insercao = sessao(`${insercaoDeCanal(canal(12), org(7))};`);
    expect(await alguemEsperaTravaConsultiva(), "a inserção não esperou a trava da reserva").toBe(true);
    const [r, i] = await Promise.all([reserva, insercao]);
    expect(r.ok, r.saida).toBe(true);
    expect(i.ok, i.saida).toBe(true);
    expect(canaisOcupados(org(7))).toBe(1);
    for (const fn of ["public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean)", "public.fn_trava_canais_do_plano()"]) {
      expect(sql(`select pg_get_functiondef('${fn}'::regprocedure);`), fn).toMatch(/hashtextextended\([^)]*,\s*2281\)/);
    }
  });

  it("sem limite com chave desligada/ausente, org isenta ou plano sem teto; acima do teto, só não cresce", () => {
    assinar(org(8), PLANO_1);
    sql(`${insercaoDeCanal(canal(13), org(8))};`);
    try {
      chaveDeCobranca("desligado");
      sql(`${insercaoDeCanal(canal(14), org(8))};`);
      chaveDeCobranca("ausente");
      sql(`${insercaoDeCanal(canal(15), org(8))};`);
    } finally {
      chaveDeCobranca("ligado");
    }
    expect(canaisOcupados(org(8))).toBe(3);
    // Org JÁ acima do teto (chave ligada sobre orgs existentes, ou downgrade): reconectar um
    // canal ativo não pode virar PT402. Aqui só a guarda de transição protege — `cs.id <> new.id`
    // sozinho contaria os OUTROS 2 (2 >= 1) e recusaria um número que já está no ar.
    expect(erroDe(`update public.channel_sessions set archived_at = null where id = '${canal(13)}';`)).toBe("");
    expect(erroDe(`${insercaoDeCanal(canal(16), org(8))};`)).toContain("PT402");
    sql(`${insercaoDeCanal(canal(17), org(5))}; ${insercaoDeCanal(canal(18), org(5))};`);
    assinar(org(9), PLANO_SEM_TETO);
    sql(`${insercaoDeCanal(canal(19), org(9))}; ${insercaoDeCanal(canal(20), org(9))};`);
    expect(canaisOcupados(org(9))).toBe(2);
  });

  it("a contagem é a dos canais de MENSAGEM: CHECK de provider menos wacalls = PROVIDERS_DE_MENSAGEM", () => {
    const def = sql(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'channel_sessions_provider_check';`);
    const doBanco = [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!).filter((p) => p !== "wacalls").sort();
    expect(doBanco.length).toBeGreaterThan(0);
    expect(doBanco).toEqual([...PROVIDERS_DE_MENSAGEM].sort());
  });
});
