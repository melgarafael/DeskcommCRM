import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql } from "./gov-helpers";
import {
  assinar, comoAnon, comoServidor, comoUsuario, criarOrg, criarPlano, criarUsuarios, erroDe, uuid, valor, vincular,
} from "./cobranca-helpers";

/**
 * ISOLAMENTO DA ASSINATURA ENTRE ORGANIZAÇÕES — invariante 1 da spec da cobrança
 * do revendedor (§12), migration 0510. A linha diz quem paga, quanto e se deve:
 * leitura só do `admin` da própria org, escrita só do servidor.
 *
 * NÃO está em TABLES de rls-isolation.test.ts de propósito: lá o usuário semeado
 * é `agent`, e aqui o agent lê ZERO, então o controle positivo falharia por
 * ACERTO (o mesmo caso de webhook_lead_captures). A prova vive aqui e está
 * declarada em PROVA_PROPRIA de rls-completude-varredura.test.ts.
 * O caso "viewer lê 0 linhas de webhook_events_log com provider stripe/asaas"
 * entra na PR 3a, quando o CHECK de provider passar a aceitá-los.
 */

const P = "c0b00002-0000-4000-8000";
const ORG_A = uuid(P, 1);
const ORG_B = uuid(P, 2);
const ADMIN_A = uuid(P, 11);
const AGENTE_A = uuid(P, 12);
const ADMIN_B = uuid(P, 13);
const PLANO = uuid(P, 101);

beforeAll(() => {
  criarUsuarios([
    [ADMIN_A, "admin-a-0510@invariant.test"],
    [AGENTE_A, "agente-a-0510@invariant.test"],
    [ADMIN_B, "admin-b-0510@invariant.test"],
  ]);
  criarOrg(ORG_A, "cob-iso-a");
  criarOrg(ORG_B, "cob-iso-b");
  vincular(ADMIN_A, ORG_A, "admin");
  vincular(AGENTE_A, ORG_A, "agent");
  vincular(ADMIN_B, ORG_B, "admin");
  criarPlano({ id: PLANO, nome: "Isolamento" });
  assinar(ORG_A, PLANO);
  assinar(ORG_B, PLANO);
});

describe("inv. 1 — a assinatura de uma org não vaza para a outra", () => {
  it("⭐ admin de A lê a de A e zero de B", () => {
    expect(countAs(ADMIN_A, `select count(*) from public.cobranca_assinaturas where organization_id = '${ORG_A}';`)).toBe(1);
    expect(countAs(ADMIN_A, `select count(*) from public.cobranca_assinaturas where organization_id = '${ORG_B}';`)).toBe(0);
    expect(countAs(ADMIN_A, `select count(*) from public.cobranca_assinaturas;`)).toBe(1);
  });

  it("⭐ admin de B lê a de B e zero de A", () => {
    expect(countAs(ADMIN_B, `select count(*) from public.cobranca_assinaturas where organization_id = '${ORG_B}';`)).toBe(1);
    expect(countAs(ADMIN_B, `select count(*) from public.cobranca_assinaturas where organization_id = '${ORG_A}';`)).toBe(0);
  });

  it("⭐ agent de A não lê nem a da própria organização", () => {
    expect(countAs(AGENTE_A, `select count(*) from public.cobranca_assinaturas;`)).toBe(0);
  });

  it("controle: promovido a admin, o mesmo usuário passa a ler (a policy mede o papel)", () => {
    sql(`update public.user_organizations set role = 'admin' where user_id = '${AGENTE_A}' and organization_id = '${ORG_A}';`);
    try {
      expect(countAs(AGENTE_A, `select count(*) from public.cobranca_assinaturas;`)).toBe(1);
    } finally {
      sql(`update public.user_organizations set role = 'agent' where user_id = '${AGENTE_A}' and organization_id = '${ORG_A}';`);
    }
  });

  it("⭐ a sessão não escreve, nem o admin de A na própria linha", () => {
    const comandos = [
      `update public.cobranca_assinaturas set estado = 'ativa' where organization_id = '${ORG_A}'`,
      `insert into public.cobranca_assinaturas (organization_id, plano_id) values ('${ORG_A}', '${PLANO}')`,
      `delete from public.cobranca_assinaturas where organization_id = '${ORG_A}'`,
    ];
    for (const comando of comandos) {
      const e = erroDe(comoUsuario(ADMIN_A, comando));
      expect(e, comando).toContain("42501");
      expect(e, comando).toContain("permission denied for table cobranca_assinaturas");
    }
    expect(valor(`select estado from public.cobranca_assinaturas where organization_id = '${ORG_A}';`)).toBe("trial");
  });

  it("⭐ a sessão não enxerga os planos da instalação, nem o admin", () => {
    const e = erroDe(comoUsuario(ADMIN_A, `select count(*) from public.cobranca_planos`));
    expect(e).toContain("42501");
    expect(e).toContain("permission denied for table cobranca_planos");
  });

  it("anon não lê nenhuma das duas", () => {
    for (const tabela of ["cobranca_assinaturas", "cobranca_planos"]) {
      const e = erroDe(comoAnon(`select count(*) from public.${tabela}`));
      expect(e, tabela).toContain(`permission denied for table ${tabela}`);
    }
  });

  it("controle: o servidor lê as duas organizações", () => {
    expect(valor(comoServidor(`select count(*) from public.cobranca_assinaturas where organization_id in ('${ORG_A}', '${ORG_B}')`))).toBe("2");
  });
});
