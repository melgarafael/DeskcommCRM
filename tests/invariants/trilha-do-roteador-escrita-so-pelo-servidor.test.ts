import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  lastLine,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * A TRILHA DAS DECISÕES DO ROTEADOR É ESCRITA SÓ PELO SERVIDOR (migration 9064, #3770).
 *
 * `ai_router_decisions` tinha uma policy `for all` por organização desde a 0085.
 * Com as colunas de quem pediu a passagem (`solicitado_por`, `origem`, `motivo`),
 * a escrita fica com o motor — o turno e a ação gravam pela conexão direta — e os
 * membros só leem (o painel de evolução lê pela sessão).
 *
 * Os casos com ⭐ são os que a policy `for all` deixava passar.
 */
const ORG_B = "cccccccc-3823-4000-8000-00000000000b";
const DECISAO = "cccccccc-3823-4000-8000-000000000001";
const DECISAO_B = "cccccccc-3823-4000-8000-00000000000c";
// `job_id` das linhas que o próprio teste insere, para limpar numa nova rodada.
const MARCA = "cccccccc-3823-4000-8000-0000000000ff";

function decisaoNova(org: string): string {
  return `insert into public.ai_router_decisions (organization_id, outcome, origem, motivo, job_id)
    values ('${org}', 'transferred', 'acao', 'pedido_do_operador', '${MARCA}')`;
}

function outcomeDe(id: string): string {
  return lastLine(sql(`select outcome from public.ai_router_decisions where id = '${id}';`));
}

beforeAll(() => {
  seedGov();
  sql(`
    delete from public.ai_router_decisions where job_id = '${MARCA}';
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_B}', 'trilha-roteador-3823-b', 'Trilha Roteador 3823 B', 'Trilha Roteador 3823 B')
      on conflict (id) do nothing;
    insert into public.ai_router_decisions (id, organization_id, outcome) values
      ('${DECISAO}', '${GOV_ORG}', 'no_match'),
      ('${DECISAO_B}', '${ORG_B}', 'no_match')
      on conflict (id) do update set outcome = 'no_match';
  `);
});

describe("nenhum papel da organização escreve na trilha pela sessão", () => {
  for (const [papel, usuario] of [
    ["viewer", GOV_VIEWER],
    ["agent", GOV_AGENT_A],
    ["manager", GOV_MANAGER],
    ["admin", GOV_ADMIN],
  ] as const) {
    it(`⭐ ${papel} não grava, não reescreve e não apaga decisão`, () => {
      expect(writeCountAs(usuario, decisaoNova(GOV_ORG))).toBe(0);
      expect(
        writeCountAs(usuario, `update public.ai_router_decisions set outcome = 'transferred' where id = '${DECISAO}'`),
      ).toBe(0);
      expect(writeCountAs(usuario, `delete from public.ai_router_decisions where id = '${DECISAO}'`)).toBe(0);
      expect(outcomeDe(DECISAO)).toBe("no_match");
      expect(lastLine(sql(`select count(*) from public.ai_router_decisions where job_id = '${MARCA}';`))).toBe("0");
    });

    it(`${papel} lê a trilha da própria organização — controle positivo`, () => {
      expect(countAs(usuario, `select count(*) from public.ai_router_decisions where id = '${DECISAO}';`)).toBe(1);
    });
  }
});

describe("ninguém lê outra organização", () => {
  it("admin da org A não vê a decisão da org B", () => {
    expect(countAs(GOV_ADMIN, `select count(*) from public.ai_router_decisions where id = '${DECISAO_B}';`)).toBe(0);
  });
});

describe("o servidor grava — controle positivo", () => {
  it("service_role insere a linha de trilha", () => {
    const out = sql(`
      set role service_role;
      with w as (${decisaoNova(GOV_ORG)} returning 1) select count(*) from w;
    `);
    expect(lastLine(out)).toBe("1");
  });
});
