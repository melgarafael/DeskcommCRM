import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import { assinar, comoAnon, comoServidor, comoUsuario, criarOrg, criarPlano, erroDe, uuid, valor } from "./cobranca-helpers";

/**
 * QUEM A RECONCILIAÇÃO RELÊ — invariante 10 da spec da cobrança do revendedor
 * (§8, §12), migration 0601.
 *
 * `fn_cobranca_reconciliaveis()` é o predicado ÚNICO: o cron da cobrança relê
 * as linhas com `precisa_reler` (ordem `relida_em nulls first`, 50 por rodada),
 * e a Visão geral de /admin/cobranca lê `max(relida_em)` do conjunto inteiro
 * ("última leitura bem-sucedida"). Duas consultas escritas à mão divergiriam, e
 * a tela diria "saudável" sobre linhas que o cron nunca relê.
 */

const P = "c0b3a002-0000-4000-8000";
const PLANO = uuid(P, 101);
const NUNCA_LIDA = uuid(P, 1);
const CANCELADA_SUSPENSA = uuid(P, 2);
const CANCELADA_CHECKOUT_RECENTE = uuid(P, 3);
const CANCELADA_ANTIGA = uuid(P, 4);
const SEM_PROVEDOR = uuid(P, 5);
const LIDA_AGORA = uuid(P, 6);
const AVISO_FINAL = uuid(P, 7);
const SO_VENCEU = uuid(P, 8);
const LIDA_HA_7H = uuid(P, 9);
const CANCELADA_ADMINISTRATIVA = uuid(P, 10);

function comProvedor(
  org: string,
  n: number,
  estado: string,
  o: { relidaHa?: string; aviso?: string; checkoutHa?: string } = {},
): void {
  const ha = (intervalo?: string) => (intervalo ? `now() - interval '${intervalo}'` : "null");
  sql(`insert into public.cobranca_assinaturas
         (organization_id, plano_id, estado, provedor, provedor_cliente_id, modo, relida_em, ultimo_aviso, checkout_expira_em)
       values ('${org}', '${PLANO}', '${estado}', 'stripe', 'cus_rec_${n}', 'teste', ${ha(o.relidaHa)},
               ${o.aviso ? `'${o.aviso}'` : "null"}, ${ha(o.checkoutHa)});`);
}

/** Como postgres (o gatilho da PR 1 só recusa authenticated/anon). */
function suspender(org: string, kind: "administrativa" | "cobranca"): void {
  sql(`update public.organizations set status = 'suspended', suspended_kind = '${kind}', suspended_at = now()
        where id = '${org}';`);
}

/** org → precisa_reler, lido como o servidor lê. */
function selecionadas(): Map<string, boolean> {
  const bruto = valor(
    comoServidor(
      `select coalesce(string_agg(organization_id::text || '=' || precisa_reler::text, ','), '') from public.fn_cobranca_reconciliaveis()`,
    ),
  );
  return new Map(
    bruto
      .split(",")
      .filter(Boolean)
      .map((par) => {
        const [org, precisa] = par.split("=");
        return [org ?? "", precisa === "true"] as const;
      }),
  );
}

beforeAll(() => {
  criarPlano({ id: PLANO, nome: "Reconciliação" });
  const orgs = [
    NUNCA_LIDA, CANCELADA_SUSPENSA, CANCELADA_CHECKOUT_RECENTE, CANCELADA_ANTIGA, SEM_PROVEDOR,
    LIDA_AGORA, AVISO_FINAL, SO_VENCEU, LIDA_HA_7H, CANCELADA_ADMINISTRATIVA,
  ];
  orgs.forEach((org, i) => criarOrg(org, `cob-rec-${i + 1}`));
  comProvedor(NUNCA_LIDA, 1, "ativa");
  comProvedor(CANCELADA_SUSPENSA, 2, "cancelada", { relidaHa: "1 day" });
  comProvedor(CANCELADA_CHECKOUT_RECENTE, 3, "cancelada", { relidaHa: "1 day", checkoutHa: "10 days" });
  comProvedor(CANCELADA_ANTIGA, 4, "cancelada", { relidaHa: "1 day", checkoutHa: "40 days" });
  assinar(SEM_PROVEDOR, PLANO);
  comProvedor(LIDA_AGORA, 6, "ativa", { relidaHa: "5 minutes" });
  comProvedor(AVISO_FINAL, 7, "em_atraso", { relidaHa: "2 hours", aviso: "suspende_em_breve" });
  comProvedor(SO_VENCEU, 8, "em_atraso", { relidaHa: "2 hours", aviso: "venceu" });
  comProvedor(LIDA_HA_7H, 9, "ativa", { relidaHa: "7 hours" });
  comProvedor(CANCELADA_ADMINISTRATIVA, 10, "cancelada", { relidaHa: "1 day" });
  suspender(CANCELADA_SUSPENSA, "cobranca");
  suspender(CANCELADA_ADMINISTRATIVA, "administrativa");
});

describe("inv. 10 — a reconciliação alcança quem pode ter pago sem o webhook chegar", () => {
  it("⭐ a cancelada de org suspensa por cobrança e a cancelada com checkout de 10 dias entram", () => {
    const s = selecionadas();
    expect(s.has(CANCELADA_SUSPENSA)).toBe(true);
    expect(s.has(CANCELADA_CHECKOUT_RECENTE)).toBe(true);
  });

  it("⭐ a cancelada antiga de org ativa, e a de org suspensa por motivo administrativo, ficam fora", () => {
    const s = selecionadas();
    expect(s.has(CANCELADA_ANTIGA)).toBe(false);
    expect(s.has(CANCELADA_ADMINISTRATIVA)).toBe(false);
  });

  it("sem provedor (teste grátis sem checkout) fica fora: a régua cuida dela só com o banco", () => {
    expect(selecionadas().has(SEM_PROVEDOR)).toBe(false);
  });

  it("precisa_reler: nunca lida, lida há mais de 6h, e aviso final sem leitura da última hora", () => {
    const s = selecionadas();
    expect(s.get(NUNCA_LIDA)).toBe(true);
    expect(s.get(LIDA_HA_7H)).toBe(true);
    expect(s.get(AVISO_FINAL)).toBe(true);
    expect(s.get(CANCELADA_SUSPENSA)).toBe(true);
  });

  it("controle: lida há minutos, ou em atraso só com o aviso 'venceu', espera a vez (mas segue no conjunto)", () => {
    const s = selecionadas();
    expect(s.get(LIDA_AGORA)).toBe(false);
    expect(s.get(SO_VENCEU)).toBe(false);
  });

  it("EXECUTE só do servidor: a sessão e anon recebem permission denied", () => {
    for (const e of [
      erroDe(comoUsuario(uuid(P, 99), "select * from public.fn_cobranca_reconciliaveis()")),
      erroDe(comoAnon("select * from public.fn_cobranca_reconciliaveis()")),
    ]) {
      expect(e).toContain("42501");
      expect(e).toContain("permission denied for function fn_cobranca_reconciliaveis");
    }
    expect(valor(`select has_function_privilege('service_role', 'public.fn_cobranca_reconciliaveis()', 'execute')::text;`)).toBe("true");
  });
});
