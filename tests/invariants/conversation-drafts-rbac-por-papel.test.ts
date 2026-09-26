/**
 * RASCUNHO SUGERIDO (migration 0419, #1611) — O PAPEL, NÃO SÓ A ORGANIZAÇÃO.
 *
 * O gate `0150` de `rbac-config-ia-canais.test.ts` lê o CATÁLOGO: ele reprova a
 * policy `for all` só-tenancy, mas fica verde com qualquer policy que cite
 * `fn_role_at_least` — inclusive uma que não barra nada. Este arquivo mede o
 * COMPORTAMENTO, como `authenticated` com o JWT de cada papel da organização
 * semeada por `seedGov()`:
 *
 * - `viewer` não lê, não cria e não consome (ele não envia; o texto escrito PARA
 *   o cliente não é dele);
 * - `agent`/`manager`/`admin` leem (controle positivo — senão a caixa de entrada
 *   quebra);
 * - `agent` cria pela sessão, mas não grava `created_by_api_token_id` (a origem
 *   de token é só do service role);
 * - o UPDATE da sessão só CONSOME: não edita o corpo, não consome em nome de
 *   outro, e não consome duas vezes;
 * - DELETE não tem caminho de sessão (quem apaga é o trigger definer da LGPD).
 *
 * A conversa usada é `GOV_CONV_UNASSIGNED`: sem dono, visível ao `agent` no
 * `visibility_mode` padrão (`own_and_unassigned`). Atribuí-la a outra pessoa
 * deixa os controles positivos do `agent` vermelhos por ACERTO.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONV_UNASSIGNED,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

const LIDO = "d0d0d0d0-0419-4000-8000-000000000001";
const CORPO = "d0d0d0d0-0419-4000-8000-000000000002";
const OUTRO = "d0d0d0d0-0419-4000-8000-000000000003";
const CONSUMO = "d0d0d0d0-0419-4000-8000-000000000004";

const contar = (id: string) => `select count(*) from public.conversation_drafts where id = '${id}';`;

function inserir(comToken = false): string {
  return `insert into public.conversation_drafts
    (organization_id, conversation_id, body, source, expires_at${comToken ? ", created_by_api_token_id" : ""})
    values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'sugerido', 'erp', now() + interval '1 hour'${comToken ? ", gen_random_uuid()" : ""})`;
}

function consumir(id: string, por: string): string {
  return `update public.conversation_drafts
     set consumed_at = now(), consumed_by_user_id = '${por}'
   where id = '${id}'`;
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.conversation_drafts (id, organization_id, conversation_id, body, source, expires_at) values
      ('${LIDO}',    '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'a', 'erp', now() + interval '1 hour'),
      ('${CORPO}',   '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'b', 'erp', now() + interval '1 hour'),
      ('${OUTRO}',   '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'c', 'erp', now() + interval '1 hour'),
      ('${CONSUMO}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'd', 'erp', now() + interval '1 hour')
      on conflict (id) do nothing;
  `);
});

describe("0419 — conversation_drafts: papel por operação", () => {
  it("viewer NÃO lê o rascunho", () => {
    expect(countAs(GOV_VIEWER, contar(LIDO))).toBe(0);
  });

  it("CONTROLE POSITIVO: agent, manager e admin leem", () => {
    expect(countAs(GOV_AGENT_A, contar(LIDO))).toBe(1);
    expect(countAs(GOV_MANAGER, contar(LIDO))).toBe(1);
    expect(countAs(GOV_ADMIN, contar(LIDO))).toBe(1);
  });

  it("viewer NÃO cria rascunho", () => {
    expect(writeCountAs(GOV_VIEWER, inserir())).toBe(0);
  });

  it("CONTROLE POSITIVO: agent cria rascunho pela sessão", () => {
    expect(writeCountAs(GOV_AGENT_A, inserir())).toBe(1);
  });

  it("agent NÃO forja a origem de token", () => {
    expect(writeCountAs(GOV_AGENT_A, inserir(true))).toBe(0);
  });

  it("agent NÃO edita o corpo sem consumir", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `update public.conversation_drafts set body = 'forjado' where id = '${CORPO}'`),
    ).toBe(0);
    expect(sql(`select body from public.conversation_drafts where id = '${CORPO}';`)).toBe("b");
  });

  it("agent NÃO consome em nome de outro atendente", () => {
    expect(writeCountAs(GOV_AGENT_A, consumir(OUTRO, GOV_AGENT_B))).toBe(0);
  });

  it("viewer NÃO consome", () => {
    expect(writeCountAs(GOV_VIEWER, consumir(CONSUMO, GOV_VIEWER))).toBe(0);
  });

  it("CONTROLE POSITIVO: agent consome como ele mesmo — e só uma vez", () => {
    expect(writeCountAs(GOV_AGENT_A, `${consumir(CONSUMO, GOV_AGENT_A)} and consumed_at is null`)).toBe(1);
    expect(writeCountAs(GOV_AGENT_A, consumir(CONSUMO, GOV_AGENT_A))).toBe(0);
  });

  it("ninguém apaga pela sessão — nem admin (sem GRANT de DELETE)", () => {
    expect(() =>
      writeCountAs(GOV_ADMIN, `delete from public.conversation_drafts where id = '${CORPO}'`),
    ).toThrow(/permission denied/);
    expect(sql(contar(CORPO))).toBe("1");
  });
});
