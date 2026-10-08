import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import { comoUsuario, criarOrg, criarPlano, criarUsuarios, erroDe, numero, tornarPlatformAdmin, uuid, valor } from "./cobranca-helpers";

/**
 * A EMPRESA COM ASSINATURA VIVA NO PROVEDOR NÃO SAI DO BANCO — pendência do
 * recorte do #1967 (exclusão de empresa pelo admin da plataforma), migration
 * 0601, seção G.
 *
 * Apagar a organização leva `cobranca_assinaturas` em cascata, e o provedor
 * continuaria cobrando o cliente final sem ninguém do lado de cá para cancelar.
 * A trava é um gatilho na PRÓPRIA exclusão: vale para a função do painel
 * (`fn_excluir_organizacao`, quando existe), para script e para SQL à mão.
 * "Viva" é o que a última releitura gravou: mais de uma assinatura não
 * terminal, ou uma que não cancela no fim do período.
 */
const P = "c0b3a005-0000-4000-8000";
const PLANO = uuid(P, 101);
const ATOR = uuid(P, 99);
const VIVA = uuid(P, 1);
const DUAS_VIVAS = uuid(P, 2);
const CANCELA_NO_FIM = uuid(P, 3);
const SEM_PROVEDOR = uuid(P, 4);
const NADA_VIVO = uuid(P, 5);
const PELA_FUNCAO = uuid(P, 6);
const PELA_SESSAO = uuid(P, 7);

function assinatura(org: string, n: number, o: { provedor?: boolean; vivas?: number; cancelaNoFim?: boolean } = {}): void {
  const comProvedor = o.provedor ?? true;
  sql(`insert into public.cobranca_assinaturas
         (organization_id, plano_id, estado, provedor, provedor_cliente_id, modo, assinaturas_vivas, cancela_no_fim)
       values ('${org}', '${PLANO}', 'ativa', ${comProvedor ? "'stripe'" : "null"},
               ${comProvedor ? `'cus_exc_${n}'` : "null"}, ${comProvedor ? "'teste'" : "null"},
               ${o.vivas ?? 0}, ${o.cancelaNoFim ?? false});`);
}
const apagar = (org: string) => erroDe(`delete from public.organizations where id = '${org}';`);
const existe = (org: string) => numero(`select count(*) from public.organizations where id = '${org}';`);

beforeAll(() => {
  criarUsuarios([[ATOR, "ator-exc-0601@invariant.test"]]);
  tornarPlatformAdmin(ATOR, "full", ATOR);
  criarPlano({ id: PLANO, nome: "Exclusão" });
  [VIVA, DUAS_VIVAS, CANCELA_NO_FIM, SEM_PROVEDOR, NADA_VIVO, PELA_FUNCAO, PELA_SESSAO].forEach((org, i) => criarOrg(org, `cob-exc-${i + 1}`));
  assinatura(VIVA, 1, { vivas: 1 });
  assinatura(DUAS_VIVAS, 2, { vivas: 2, cancelaNoFim: true });
  assinatura(CANCELA_NO_FIM, 3, { vivas: 1, cancelaNoFim: true });
  assinatura(SEM_PROVEDOR, 4, { provedor: false });
  assinatura(NADA_VIVO, 5, { vivas: 0 });
  assinatura(PELA_FUNCAO, 6, { vivas: 1 });
  assinatura(PELA_SESSAO, 7, { vivas: 1 });
});

describe("a exclusão recusa empresa com assinatura viva no provedor", () => {
  it("⭐ uma assinatura viva que não cancela no fim: PT409 e a empresa fica", () => {
    const e = apagar(VIVA);
    expect(e).toContain("PT409");
    expect(e).toContain("organizacao_com_assinatura_viva");
    expect(existe(VIVA)).toBe(1);
  });

  it("⭐ duas vivas (cobrança dupla), mesmo com a principal cancelando no fim: recusa", () => {
    expect(apagar(DUAS_VIVAS)).toContain("organizacao_com_assinatura_viva");
    expect(existe(DUAS_VIVAS)).toBe(1);
  });

  it("controle: a única viva cancela no fim do período — a empresa sai, e a assinatura vai junto", () => {
    expect(apagar(CANCELA_NO_FIM)).toBe("");
    expect(existe(CANCELA_NO_FIM)).toBe(0);
    expect(numero(`select count(*) from public.cobranca_assinaturas where organization_id = '${CANCELA_NO_FIM}';`)).toBe(0);
  });

  it("controle: sem provedor (teste grátis sem checkout), ou com zero vivas: sai", () => {
    expect(apagar(SEM_PROVEDOR)).toBe("");
    expect(apagar(NADA_VIVO)).toBe("");
    expect(existe(SEM_PROVEDOR) + existe(NADA_VIVO)).toBe(0);
  });

  it("⭐ pela função de exclusão do painel (#1967), quando ela existe nesta base", (ctx) => {
    const temFuncao =
      valor(`select (to_regprocedure('public.fn_excluir_organizacao(uuid,uuid,text,text,text)') is not null)::text;`) === "true";
    // Sem o #1967 na base não há função: o caso aparece como PULADO, nunca como verde.
    if (!temFuncao) ctx.skip();
    sql(`update public.organizations set status = 'suspended', suspended_kind = 'administrativa', suspended_at = now()
          where id = '${PELA_FUNCAO}';`);
    const e = erroDe(
      `select public.fn_excluir_organizacao('${PELA_FUNCAO}', '${ATOR}', 'cob-exc-6', 'contrato encerrado pelo cliente');`,
    );
    expect(e).toContain("organizacao_com_assinatura_viva");
    expect(existe(PELA_FUNCAO)).toBe(1);
  });

  it("⭐ admin de plataforma apagando pela SESSÃO (PostgREST, RLS ligada): a trava enxerga a assinatura e recusa", () => {
    // `orgs_write_platform_admin` é FOR ALL e `authenticated` tem GRANT ALL em organizations: o DELETE
    // direto passa pela policy. Com a função INVOKER, o EXISTS leria `cobranca_assinaturas` sob a RLS
    // (só admin da PRÓPRIA org vê a linha), voltaria falso e a empresa sairia. Se o erro for OUTRO
    // (permissão, policy), o caso está medindo outra coisa: leia o log antes de mexer na função.
    const e = erroDe(comoUsuario(ATOR, `delete from public.organizations where id = '${PELA_SESSAO}'`));
    expect(e).toContain("organizacao_com_assinatura_viva");
    expect(existe(PELA_SESSAO)).toBe(1);
  });

  it("a função do gatilho é só do servidor", () => {
    expect(
      valor(`select has_function_privilege('anon', 'public.fn_cobranca_trava_exclusao_com_assinatura_viva()', 'execute')::text;`),
    ).toBe("false");
  });
});
