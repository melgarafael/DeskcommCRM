import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { countAs, lastLine, sql } from "./gov-helpers";

/** A exceção de own é claim para si com CAS; transferência continua fechada. */
const ORG = "b9017000-0000-4000-8000-000000000001";
const OUTRA_ORG = "b9017000-0000-4000-8000-000000000002";
const A = "b9017000-1111-4000-8000-000000000001";
const B = "b9017000-1111-4000-8000-000000000002";
const CANAL = "b9017000-2222-4000-8000-000000000001";
const OUTRO_CANAL = "b9017000-2222-4000-8000-000000000002";
const CONTATO = "b9017000-3333-4000-8000-000000000001";
const OUTRO_CONTATO = "b9017000-3333-4000-8000-000000000002";
const CONVERSA = "b9017000-4444-4000-8000-000000000001";
const OUTRA_CONVERSA = "b9017000-4444-4000-8000-000000000002";

beforeAll(() => {
  sql(`
    insert into auth.users(id,email) values
      ('${A}','claim-cas-a@invariant.test'), ('${B}','claim-cas-b@invariant.test') on conflict do nothing;
    insert into organizations(id,slug,legal_name,display_name,settings) values
      ('${ORG}','claim-cas-a','Claim CAS A','Claim CAS A','{"visibility_mode":"own"}'),
      ('${OUTRA_ORG}','claim-cas-b','Claim CAS B','Claim CAS B','{"visibility_mode":"own"}') on conflict do nothing;
    insert into user_organizations(user_id,organization_id,role,accepted_at) values
      ('${A}','${ORG}','agent',now()), ('${B}','${ORG}','agent',now()) on conflict do nothing;
    insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values
      ('${CANAL}','${ORG}','claim-cas-a','\\x00'::bytea),
      ('${OUTRO_CANAL}','${OUTRA_ORG}','claim-cas-b','\\x00'::bytea) on conflict do nothing;
    insert into contacts(id,organization_id,name,phone_number) values
      ('${CONTATO}','${ORG}','Claim CAS A','+5511999017001'),
      ('${OUTRO_CONTATO}','${OUTRA_ORG}','Claim CAS B','+5511999017002') on conflict do nothing;
    insert into conversations(id,organization_id,contact_id,channel_session_id,status) values
      ('${CONVERSA}','${ORG}','${CONTATO}','${CANAL}','open'),
      ('${OUTRA_CONVERSA}','${OUTRA_ORG}','${OUTRO_CONTATO}','${OUTRO_CANAL}','open') on conflict do nothing;
  `);
});

beforeEach(() => {
  sql(`update conversations set assigned_to_user_id=null, assigned_to_user_name=null,
    assigned_at=null, assignee_kind=null, status='open' where id in ('${CONVERSA}','${OUTRA_CONVERSA}');`);
});

const pedido = (conversa: string, alvo: string, motivo: string, cas: boolean) =>
  `select count(*) from fn_conversation_assign('${ORG}','${conversa}','${alvo}','${motivo}',null,${cas})`;

describe("conversa livre invisível: exceção restrita ao claim com CAS", () => {
  it.each([
    ["transfer", true],
    ["transfer", false],
    ["routing", true],
    ["claim", false],
  ] as const)("%s com CAS=%s não atravessa a visibilidade", (motivo, cas) => {
    const antes = sql(
      `select count(*) from conversation_assignment_events where conversation_id='${CONVERSA}'`,
    );
    expect(countAs(A, pedido(CONVERSA, A, motivo, cas))).toBe(0);
    expect(
      sql(
        `select count(*) from conversations where id='${CONVERSA}' and assigned_to_user_id is null`,
      ),
    ).toBe("1");
    expect(
      sql(
        `select count(*) from conversation_assignment_events where conversation_id='${CONVERSA}'`,
      ),
    ).toBe(antes);
  });

  it("claim com CAS assume para si, preservando a organização e a autoria", () => {
    const antes = Number(
      sql(
        `select count(*) from conversation_assignment_events where conversation_id='${CONVERSA}' and changed_by='${A}' and to_user_id='${A}' and reason='claim'`,
      ),
    );
    expect(countAs(A, pedido(CONVERSA, A, "claim", true))).toBe(1);
    expect(countAs(A, `select count(*) from conversations where id='${CONVERSA}'`)).toBe(1);
    const depois = Number(
      sql(
        `select count(*) from conversation_assignment_events where conversation_id='${CONVERSA}' and changed_by='${A}' and to_user_id='${A}' and reason='claim'`,
      ),
    );
    expect(depois - antes).toBe(1);
  });

  it("não atribui para terceiro e não alcança conversa de outra organização", () => {
    expect(countAs(A, pedido(CONVERSA, B, "claim", true))).toBe(0);
    expect(countAs(A, pedido(OUTRA_CONVERSA, A, "claim", true))).toBe(0);
    expect(
      sql(
        `select count(*) from conversations where id='${OUTRA_CONVERSA}' and assigned_to_user_id is null`,
      ),
    ).toBe("1");
  });

  it("dois atendentes em sessões concorrentes: só um vence e só um evento nasce", async () => {
    const antes = Number(
      sql(
        `select count(*) from conversation_assignment_events where conversation_id='${CONVERSA}'`,
      ),
    );
    const executar = promisify(execFile);
    const container = process.env.TEST_DB_CONTAINER;
    if (!container) throw new Error("rode pelo pnpm test:db");
    async function disputar(usuario: string) {
      const script = `set role authenticated; select set_config('request.jwt.claims','{"sub":"${usuario}"}',false); ${pedido(CONVERSA, usuario, "claim", true)};`;
      const { stdout } = await executar("docker", [
        "exec",
        container!,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-tA",
        "-c",
        script,
      ]);
      // sql() já entrega a saída sem o newline final; execFile não a corta.
      // Number("") seria zero e esconderia inclusive uma saída inválida.
      const ultimaLinha = lastLine(stdout.trim());
      if (!/^\d+$/.test(ultimaLinha)) {
        throw new Error("O claim concorrente não devolveu uma contagem inteira.");
      }
      return Number(ultimaLinha);
    }
    const vencedores = await Promise.all([disputar(A), disputar(B)]);
    expect(vencedores.sort()).toEqual([0, 1]);
    expect(
      sql(
        `select count(*) from conversations where id='${CONVERSA}' and assigned_to_user_id in ('${A}','${B}')`,
      ),
    ).toBe("1");
    const depois = Number(
      sql(
        `select count(*) from conversation_assignment_events where conversation_id='${CONVERSA}'`,
      ),
    );
    expect(depois - antes).toBe(1);
  });
});
