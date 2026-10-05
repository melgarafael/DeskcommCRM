import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { lastLine, sql, writeCountAs } from "./gov-helpers";

/**
 * A SUSPENSÃO QUE SUSPENDE (migration 0501; spec cobrança do revendedor §2.1,
 * §3.1 e §12, invariantes 2 a 4).
 *
 * Antes: suspender só tirava a pessoa da tela. A rota fazia leitura, UPDATE e
 * `event_log` sem await em três passos soltos; nada parava jobs `pending` nem
 * mensagens `queued`; e `status` era gravável pelo PostgREST por qualquer
 * platform admin — `orgs_write_platform_admin` aceita `fn_is_platform_admin()`,
 * que ignora o scope, então um `support_readonly` reativava uma suspensa.
 *
 *   inv. 2 — status, tipo, campos de suspensão e `created_by` só mudam pelo
 *            servidor; INSERT de organização pela sessão é recusado;
 *   inv. 3 — com a org suspensa, o barramento e a LGPD continuam vivos;
 *   inv. 4 — fn_suspender/fn_reativar: anti-backlog, a administrativa
 *            prevalece, idempotência, evento na mesma transação, item
 *            `org_reativada` com a contagem, resíduo de `redacted` não quebra.
 *
 * Os casos com ⭐ são os que o banco de antes deixava passar.
 *
 * ⚠️ O gatilho e a RLS recusam com o MESMO SQLSTATE (42501). Por isso cada
 * recusa confere também a MENSAGEM do gatilho — sem ela, uma recusa de RLS
 * passaria por prova do gatilho.
 *
 * Desde a 0508 (#2078) o `support_readonly` não passa nem da RLS de escrita de
 * `organizations` (`fn_is_platform_admin_full()` exige `scope = 'full'`): o
 * UPDATE dele altera 0 linhas e o gatilho nem roda. No inv. 2 o ramo
 * `support_readonly` mede isso (0 linhas + estado intacto), e é o ramo `full`
 * — que passa da RLS — que mantém o gatilho coberto. O INSERT segue recusado
 * pelo gatilho nos dois ramos: o BEFORE INSERT roda antes do WITH CHECK.
 */

const ORG_A = "c0de0496-0000-4000-8000-00000000000a"; // a que é suspensa
const ORG_B = "c0de0496-0000-4000-8000-00000000000b"; // a vizinha, sempre ativa
const ORG_C = "c0de0496-0000-4000-8000-00000000000c"; // alvo do inv. 2
const ORG_R = "c0de0496-0000-4000-8000-00000000000d"; // redigida com tipo residual
const ORG_FORJADA = "c0de0496-0000-4000-8000-00000000000e"; // nunca pode nascer

const DONO = "c0de0496-1111-4000-8000-000000000001"; // platform admin `full`
const SUPORTE = "c0de0496-1111-4000-8000-000000000002"; // platform admin `support_readonly`
const ADMIN_A = "c0de0496-1111-4000-8000-000000000003"; // admin do tenant A

const SESSAO_A = "c0de0496-2222-4000-8000-00000000000a";
const SESSAO_B = "c0de0496-2222-4000-8000-00000000000b";
const CONTATO_A1 = "c0de0496-3333-4000-8000-0000000000a1";
const CONTATO_A2 = "c0de0496-3333-4000-8000-0000000000a2";
const CONTATO_B = "c0de0496-3333-4000-8000-0000000000b1";
const CONTATO_GRUPO = "c0de0496-3333-4000-8000-0000000000a3";
const CONVERSA_A1 = "c0de0496-4444-4000-8000-0000000000a1";
const CONVERSA_A2 = "c0de0496-4444-4000-8000-0000000000a2";
const CONVERSA_B = "c0de0496-4444-4000-8000-0000000000b1";
const CONVERSA_GRUPO = "c0de0496-4444-4000-8000-0000000000a3"; // grupo da org A
const JOB_A = "c0de0496-5555-4000-8000-00000000000a";
const JOB_B = "c0de0496-5555-4000-8000-00000000000b";
const JOB_REMANESCENTE = "c0de0496-5555-4000-8000-00000000000c"; // escapa para a fila durante a suspensão
const MSG_A = "c0de0496-6666-4000-8000-00000000000a";
const MSG_B = "c0de0496-6666-4000-8000-00000000000b";
const PEDIDO_LGPD = "c0de0496-7777-4000-8000-000000000001";
const AGENTE_A = "c0de0496-8888-4000-8000-00000000000a";
const VERSAO_A = "c0de0496-8888-4000-8000-0000000000a1";
const JOB_RASCUNHO = "c0de0496-5555-4000-8000-0000000000d1"; // approved_reply do rascunho aprovado
const JOB_ENTREGA = "c0de0496-5555-4000-8000-0000000000e1"; // transactional_delivery do link do Meet
const COMPROMISSO_A = "c0de0496-9999-4000-8000-0000000000a1";

const MOTIVO = "motivo de teste do invariante 0501";

type Resultado = { changed: boolean; motivo?: string };

function valor(consulta: string): string {
  return lastLine(sql(consulta));
}

/** Chama uma função de estado como `service_role` (o único papel com EXECUTE). */
function servidor(chamada: string): Resultado {
  return JSON.parse(lastLine(sql(`set role service_role;\nselect ${chamada};`))) as Resultado;
}

function suspender(org: string, tipo: string): Resultado {
  return servidor(`public.fn_suspender_organizacao('${org}', '${tipo}', '${MOTIVO}', '${DONO}')`);
}

function reativar(org: string, tipo: string): Resultado {
  return servidor(`public.fn_reativar_organizacao('${org}', '${tipo}', '${DONO}')`);
}

function operante(org: string): string {
  return valor(`set role service_role;\nselect public.fn_org_operante('${org}')::text;`);
}

/** `status/tipo` numa linha só; `-` quando o tipo é nulo. */
function estado(org: string): string {
  return valor(
    `select status || '/' || coalesce(suspended_kind, '-') from public.organizations where id = '${org}';`,
  );
}

function eventos(org: string, tipo: string): number {
  return Number(
    valor(`select count(*) from public.event_log where organization_id = '${org}' and event_type = '${tipo}';`),
  );
}

/** Script que roda como `authenticated` com o JWT do usuário — o caminho do PostgREST. */
function comoUsuario(usuario: string, comando: string): string {
  return `set role authenticated;
select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
${comando};`;
}

/** stderr do psql com SQLSTATE (VERBOSITY verbose), ou "" se o script passou. */
function erroDe(script: string): string {
  try {
    sql(`\\set VERBOSITY verbose\n${script}`);
    return "";
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

/** Cada teste parte do mesmo estado: A, B e C ativas, fila cheia, sem item de reativação. */
function reiniciar(): void {
  sql(`
    update public.organizations
       set status = 'active', suspended_kind = null, suspended_at = null,
           suspended_reason = null, suspended_by = null, redacted_at = null
     where id in ('${ORG_A}', '${ORG_B}', '${ORG_C}');
    update public.job_queue set status = 'pending', last_error = null
     where id in ('${JOB_A}', '${JOB_B}', '${JOB_RASCUNHO}', '${JOB_ENTREGA}');
    update public.ai_reply_drafts set status = 'approved', error_code = null where send_job_id = '${JOB_RASCUNHO}';
    update public.calendar_appointments set meeting_delivery = '{"state":"queued","generation":"1"}' where id = '${COMPROMISSO_A}';
    delete from public.agent_inbox_items where organization_id = '${ORG_A}' and ref_kind = 'appointment';
    update public.messages set status = 'queued', error_code = null where id in ('${MSG_A}', '${MSG_B}');
    update public.conversations set last_inbound_at = null
     where id in ('${CONVERSA_A1}', '${CONVERSA_A2}', '${CONVERSA_GRUPO}');
    delete from public.agent_inbox_items where organization_id = '${ORG_A}' and kind = 'org_reativada';
  `);
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${DONO}', 'dono-0501@invariant.test'),
      ('${SUPORTE}', 'suporte-0501@invariant.test'),
      ('${ADMIN_A}', 'admin-a-0501@invariant.test')
      on conflict do nothing;
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason) values
      ('${DONO}', '${DONO}', 'full', false, 'fixture do invariante 0501'),
      ('${SUPORTE}', '${DONO}', 'support_readonly', false, 'fixture do invariante 0501')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'org-0501-a', 'Org 0501 A', 'Org 0501 A'),
      ('${ORG_B}', 'org-0501-b', 'Org 0501 B', 'Org 0501 B'),
      ('${ORG_C}', 'org-0501-c', 'Org 0501 C', 'Org 0501 C'),
      ('${ORG_R}', 'org-0501-r', 'Org 0501 R', 'Org 0501 R')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN_A}', '${ORG_A}', 'admin', now()) on conflict do nothing;
    do $s$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
        ('${SESSAO_A}', '${ORG_A}', 'org-0501-a', '\\x00'::bytea),
        ('${SESSAO_B}', '${ORG_B}', 'org-0501-b', '\\x00'::bytea);
    exception when unique_violation then null; end $s$;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO_A1}', '${ORG_A}', 'Contato 0501 A1'),
      ('${CONTATO_A2}', '${ORG_A}', 'Contato 0501 A2'),
      ('${CONTATO_B}', '${ORG_B}', 'Contato 0501 B'),
      ('${CONTATO_GRUPO}', '${ORG_A}', 'Grupo 0501 A')
      on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONVERSA_A1}', '${ORG_A}', '${CONTATO_A1}', '${SESSAO_A}', 'open'),
      ('${CONVERSA_A2}', '${ORG_A}', '${CONTATO_A2}', '${SESSAO_A}', 'open'),
      ('${CONVERSA_B}', '${ORG_B}', '${CONTATO_B}', '${SESSAO_B}', 'open')
      on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
      values ('${CONVERSA_GRUPO}', '${ORG_A}', '${CONTATO_GRUPO}', '${SESSAO_A}', 'open', true)
      on conflict (id) do nothing;
    -- 'watchdog' não tem contato nem fronteira de atendimento (fn_job_service_boundary
    -- devolve cedo): é a forma mais barata de um job 'pending' de verdade.
    insert into public.job_queue (id, organization_id, kind, status) values
      ('${JOB_A}', '${ORG_A}', 'watchdog', 'pending'),
      ('${JOB_B}', '${ORG_B}', 'watchdog', 'pending')
      on conflict (id) do nothing;
    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body) values
      ('${MSG_A}', '${ORG_A}', '${CONVERSA_A1}', '${SESSAO_A}', '${CONTATO_A1}', 'text', 'outbound', 'queued', 'user', 'resposta na fila'),
      ('${MSG_B}', '${ORG_B}', '${CONVERSA_B}', '${SESSAO_B}', '${CONTATO_B}', 'text', 'outbound', 'queued', 'user', 'resposta na fila')
      on conflict (id) do nothing;
    -- Rascunho aprovado com o envio na fila, e link do Meet com a entrega na fila:
    -- os dois estados que dependem de um job 'pending' e que o acerto normal
    -- (fn_reply_settle / fn_meet_delivery_settle) nunca alcança se o job é
    -- falhado por fora.
    insert into public.ai_agents (id, organization_id, name, system_prompt)
      values ('${AGENTE_A}', '${ORG_A}', 'Agente 0501', 'x') on conflict (id) do nothing;
    insert into public.ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt, provider, model)
      values ('${VERSAO_A}', '${ORG_A}', '${AGENTE_A}', 1, 'x', 'anthropic', 'm') on conflict (id) do nothing;
    insert into public.job_queue (id, organization_id, contact_id, kind, status) values
      ('${JOB_RASCUNHO}', '${ORG_A}', '${CONTATO_A1}', 'approved_reply', 'pending'),
      ('${JOB_ENTREGA}', '${ORG_A}', '${CONTATO_A1}', 'transactional_delivery', 'pending')
      on conflict (id) do nothing;
    insert into public.ai_reply_drafts
      (organization_id, conversation_id, contact_id, agent_id, agent_version_id, channel_session_id,
       service_boundary, context_revision, operation_revision, status, send_job_id)
      values ('${ORG_A}', '${CONVERSA_A1}', '${CONTATO_A1}', '${AGENTE_A}', '${VERSAO_A}', '${SESSAO_A}',
              '{}', 1, 1, 'approved', '${JOB_RASCUNHO}')
      on conflict do nothing;
    insert into public.calendar_appointments (id, organization_id, title, starts_at, ends_at, contact_id)
      values ('${COMPROMISSO_A}', '${ORG_A}', 'Reunião 0501', now() + interval '1 day', now() + interval '1 day 1 hour', '${CONTATO_A1}')
      on conflict (id) do nothing;
    update public.calendar_appointments set meeting_delivery_job_id = '${JOB_ENTREGA}' where id = '${COMPROMISSO_A}';
  `);
});

beforeEach(reiniciar);

describe("fn_org_operante — a régua SQL do predicado", () => {
  it("só `active` opera; suspensa, arquivada, redigida e inexistente não operam", () => {
    sql(`
      update public.organizations set status = 'suspended', suspended_kind = 'administrativa', suspended_at = now() where id = '${ORG_A}';
      update public.organizations set status = 'archived' where id = '${ORG_C}';
      update public.organizations set status = 'redacted', suspended_kind = 'cobranca' where id = '${ORG_R}';
    `);
    expect(operante(ORG_B)).toBe("true");
    expect(operante(ORG_A)).toBe("false");
    expect(operante(ORG_C)).toBe("false");
    expect(operante(ORG_R)).toBe("false");
    expect(operante(ORG_FORJADA)).toBe("false");
  });

  it("o COMMENT da coluna que todo self-hoster grava cita a migration certa (0501; na main, 0495 a 0499 são de outros PRs)", () => {
    expect(
      valor(`select col_description('public.organizations'::regclass, (select attnum from pg_attribute where attrelid = 'public.organizations'::regclass and attname = 'suspended_kind'));`),
    ).toContain("(migration 0501)");
  });

  it("⭐ o tipo da suspensão é vocabulário fechado", () => {
    const e = erroDe(`update public.organizations set suspended_kind = 'fraude' where id = '${ORG_A}';`);
    expect(e).toContain("23514");
    expect(e).toContain("organizations_suspended_kind_check");
  });

  it("a sessão não executa fn_org_operante (EXECUTE só do service_role)", () => {
    const e = erroDe(comoUsuario(ADMIN_A, `select public.fn_org_operante('${ORG_A}')`));
    expect(e).toContain("42501");
    expect(e).toContain("permission denied");
  });
});

describe("inv. 2 — status e suspensão só mudam pelo servidor", () => {
  for (const [scope, usuario] of [
    ["support_readonly", SUPORTE],
    ["full", DONO],
  ] as const) {
    /** `support_readonly` para na RLS (0 linhas, 0508); `full` passa dela e para no gatilho. */
    const recusaUpdate = (dml: string, rotulo?: string): void => {
      if (scope === "support_readonly") {
        expect(writeCountAs(usuario, dml), rotulo).toBe(0);
        return;
      }
      const e = erroDe(comoUsuario(usuario, dml));
      expect(e, rotulo).toContain("42501");
      expect(e, rotulo).toContain("estado_da_organizacao_so_pelo_servidor");
    };

    it(`⭐ platform admin ${scope} não reativa uma suspensa pelo PostgREST`, () => {
      sql(`update public.organizations set status = 'suspended', suspended_kind = 'cobranca', suspended_at = now() where id = '${ORG_C}';`);
      recusaUpdate(`update public.organizations set status = 'active' where id = '${ORG_C}'`);
      expect(estado(ORG_C)).toBe("suspended/cobranca");
    });

    it(`⭐ platform admin ${scope} não troca o tipo da suspensão`, () => {
      sql(`update public.organizations set status = 'suspended', suspended_kind = 'administrativa', suspended_at = now() where id = '${ORG_C}';`);
      recusaUpdate(`update public.organizations set suspended_kind = 'cobranca' where id = '${ORG_C}'`);
      expect(estado(ORG_C)).toBe("suspended/administrativa");
    });

    it(`⭐ platform admin ${scope} não suspende nem reescreve autoria pelo PostgREST`, () => {
      for (const atribuicao of [
        `status = 'suspended'`,
        `suspended_at = now()`,
        `suspended_reason = 'forjado'`,
        `suspended_by = '${usuario}'`,
        `created_by = '${usuario}'`,
      ]) {
        recusaUpdate(`update public.organizations set ${atribuicao} where id = '${ORG_C}'`, atribuicao);
      }
      expect(estado(ORG_C)).toBe("active/-");
    });

    it(`⭐ platform admin ${scope} não grava a data de anonimização pelo PostgREST`, () => {
      recusaUpdate(`update public.organizations set redacted_at = now() where id = '${ORG_C}'`);
      expect(valor(`select coalesce(redacted_at::text, '-') from public.organizations where id = '${ORG_C}';`)).toBe("-");
    });

    it(`⭐ platform admin ${scope} não cria organização pelo PostgREST`, () => {
      const e = erroDe(
        comoUsuario(
          usuario,
          `insert into public.organizations (id, slug, legal_name, display_name) values ('${ORG_FORJADA}', 'forjada-0501', 'Forjada', 'Forjada')`,
        ),
      );
      expect(e).toContain("42501");
      expect(e).toContain("organizacao_nasce_so_pelo_servidor");
      expect(valor(`select count(*) from public.organizations where id = '${ORG_FORJADA}';`)).toBe("0");
    });
  }

  it("controle: a RLS deixa o dono escrever nome e fuso pela sessão (o que o updateTenant grava)", () => {
    expect(
      writeCountAs(
        DONO,
        `update public.organizations set display_name = 'Org 0501 C renomeada', timezone = 'America/Manaus' where id = '${ORG_C}'`,
      ),
    ).toBe(1);
    expect(valor(`select display_name || '|' || timezone from public.organizations where id = '${ORG_C}';`)).toBe(
      "Org 0501 C renomeada|America/Manaus",
    );
  });

  it("controle: service_role (rota de servidor, worker de LGPD) escreve o status", () => {
    sql(`set role service_role;\nupdate public.organizations set status = 'redacted' where id = '${ORG_C}';`);
    expect(estado(ORG_C)).toBe("redacted/-");
    // A escrita real do lgpd-redact-worker leva a data junto.
    sql(`set role service_role;\nupdate public.organizations set redacted_at = now() where id = '${ORG_C}';`);
    expect(valor(`select (redacted_at is not null)::text from public.organizations where id = '${ORG_C}';`)).toBe("true");
  });
});

describe("inv. 4 — fn_suspender_organizacao para a fila e escreve numa transação só", () => {
  it("⭐ suspende: tipo e autoria gravados, pending → failed, queued → failed; a vizinha fica intocada", () => {
    const antes = eventos(ORG_A, "tenant.suspended");
    expect(suspender(ORG_A, "administrativa")).toEqual({ changed: true });
    expect(estado(ORG_A)).toBe("suspended/administrativa");
    expect(
      valor(
        `select suspended_reason || '|' || suspended_by || '|' || (suspended_at is not null)::text from public.organizations where id = '${ORG_A}';`,
      ),
    ).toBe(`${MOTIVO}|${DONO}|true`);
    expect(valor(`select status || '|' || last_error from public.job_queue where id = '${JOB_A}';`)).toBe(
      "failed|org_nao_operante",
    );
    expect(valor(`select status || '|' || error_code from public.messages where id = '${MSG_A}';`)).toBe(
      "failed|org_suspensa",
    );
    expect(eventos(ORG_A, "tenant.suspended")).toBe(antes + 1);
    expect(
      valor(
        `select payload->>'kind' || '|' || status from public.event_log where organization_id = '${ORG_A}' and event_type = 'tenant.suspended' order by created_at desc limit 1;`,
      ),
    ).toBe("administrativa|done");
    expect(estado(ORG_B)).toBe("active/-");
    expect(valor(`select status from public.job_queue where id = '${JOB_B}';`)).toBe("pending");
    expect(valor(`select status from public.messages where id = '${MSG_B}';`)).toBe("queued");
  });

  it("⭐ o rascunho aprovado cujo envio estava na fila vira failed|org_suspensa, e não fica 'aguardando envio'", () => {
    expect(suspender(ORG_A, "administrativa")).toEqual({ changed: true });
    expect(valor(`select status || '|' || last_error from public.job_queue where id = '${JOB_RASCUNHO}';`)).toBe(
      "failed|org_nao_operante",
    );
    expect(valor(`select status || '|' || error_code from public.ai_reply_drafts where send_job_id = '${JOB_RASCUNHO}';`)).toBe(
      "failed|org_suspensa",
    );
  });

  it("⭐ o link do Meet cuja entrega estava na fila fica com state failed e ganha o aviso na Central", () => {
    expect(suspender(ORG_A, "administrativa")).toEqual({ changed: true });
    expect(
      valor(
        `select (meeting_delivery->>'state') || '|' || (meeting_delivery->>'error') || '|' || (meeting_delivery ? 'settled_at')::text from public.calendar_appointments where id = '${COMPROMISSO_A}';`,
      ),
    ).toBe("failed|org_suspensa|true");
    expect(
      valor(
        `select count(*) from public.agent_inbox_items where organization_id = '${ORG_A}' and ref_kind = 'appointment' and ref_id = '${COMPROMISSO_A}' and status = 'open';`,
      ),
    ).toBe("1");
  });

  it("idempotente: suspender de novo pelo mesmo tipo não muda nada nem emite 2º evento", () => {
    suspender(ORG_A, "cobranca");
    const antes = eventos(ORG_A, "tenant.suspended");
    expect(suspender(ORG_A, "cobranca")).toEqual({ changed: false, motivo: "ja_suspensa" });
    expect(eventos(ORG_A, "tenant.suspended")).toBe(antes);
    expect(estado(ORG_A)).toBe("suspended/cobranca");
  });

  it("a administrativa prevalece nos dois sentidos, sem recomeçar o início da suspensão", () => {
    suspender(ORG_A, "administrativa");
    expect(suspender(ORG_A, "cobranca")).toEqual({ changed: false, motivo: "administrativa_prevalece" });
    expect(estado(ORG_A)).toBe("suspended/administrativa");

    reiniciar();
    suspender(ORG_A, "cobranca");
    const inicio = valor(`select suspended_at::text from public.organizations where id = '${ORG_A}';`);
    expect(suspender(ORG_A, "administrativa")).toEqual({ changed: true });
    expect(estado(ORG_A)).toBe("suspended/administrativa");
    expect(valor(`select suspended_at::text from public.organizations where id = '${ORG_A}';`)).toBe(inicio);
  });

  it("o evento nasce na MESMA transação: visível antes do commit, some no rollback", () => {
    const antes = eventos(ORG_A, "tenant.suspended");
    const saida = sql(`
      begin;
      set local role service_role;
      select public.fn_suspender_organizacao('${ORG_A}', 'administrativa', '${MOTIVO}', '${DONO}');
      reset role;
      select 'dentro:' || count(*) from public.event_log where organization_id = '${ORG_A}' and event_type = 'tenant.suspended';
      rollback;
    `);
    expect(saida.split("\n")).toContain(`dentro:${antes + 1}`);
    expect(eventos(ORG_A, "tenant.suspended")).toBe(antes);
    expect(estado(ORG_A)).toBe("active/-");
    expect(valor(`select status from public.job_queue where id = '${JOB_A}';`)).toBe("pending");
  });

  it("tipo fora do vocabulário é 22023; organização inexistente é P0002", () => {
    expect(erroDe(`set role service_role;\nselect public.fn_suspender_organizacao('${ORG_A}', 'fraude', '${MOTIVO}', null);`)).toContain("22023");
    expect(erroDe(`set role service_role;\nselect public.fn_suspender_organizacao('${ORG_FORJADA}', 'administrativa', '${MOTIVO}', null);`)).toContain("P0002");
    expect(estado(ORG_A)).toBe("active/-");
  });

  it("⭐ nenhuma sessão executa a função de suspensão", () => {
    for (const usuario of [DONO, SUPORTE, ADMIN_A]) {
      const e = erroDe(
        comoUsuario(usuario, `select public.fn_suspender_organizacao('${ORG_A}', 'administrativa', '${MOTIVO}', '${usuario}')`),
      );
      expect(e, usuario).toContain("42501");
      expect(e, usuario).toContain("permission denied");
    }
    expect(estado(ORG_A)).toBe("active/-");
  });
});

describe("inv. 3 — com a org suspensa, o barramento e a LGPD seguem vivos", () => {
  beforeEach(() => {
    suspender(ORG_A, "administrativa");
  });

  it("emit_event pelo servidor (o que a aprovação de LGPD faz) grava para a org suspensa", () => {
    const antes = eventos(ORG_A, "lgpd.data_request_received");
    sql(`set role service_role;
      select public.emit_event('lgpd.data_request_received', 'lgpd_request', '${PEDIDO_LGPD}',
        jsonb_build_object('request_id', '${PEDIDO_LGPD}', 'manually_approved', true), '{}'::jsonb, '${ORG_A}');`);
    expect(eventos(ORG_A, "lgpd.data_request_received")).toBe(antes + 1);
  });

  it("emit_event pela sessão do admin da org suspensa continua funcionando", () => {
    const antes = eventos(ORG_A, "contact.updated");
    sql(comoUsuario(ADMIN_A, `select public.emit_event('contact.updated', 'contact', '${CONTATO_A1}', '{}'::jsonb, '{}'::jsonb, '${ORG_A}')`));
    expect(eventos(ORG_A, "contact.updated")).toBe(antes + 1);
  });

  it("a vizinha ativa segue normal: opera, fila intacta, barramento vivo", () => {
    expect(operante(ORG_A)).toBe("false");
    expect(operante(ORG_B)).toBe("true");
    expect(valor(`select status from public.job_queue where id = '${JOB_B}';`)).toBe("pending");
    expect(valor(`select status from public.messages where id = '${MSG_B}';`)).toBe("queued");
    const antes = eventos(ORG_B, "contact.updated");
    sql(`set role service_role;
      select public.emit_event('contact.updated', 'contact', '${CONTATO_B}', '{}'::jsonb, '{}'::jsonb, '${ORG_B}');`);
    expect(eventos(ORG_B, "contact.updated")).toBe(antes + 1);
  });
});

describe("inv. 4 — fn_reativar_organizacao volta sem rajada e chama o humano", () => {
  const corpoDoItem = () =>
    valor(
      `select coalesce(string_agg(severity || '|' || coalesce(ref_kind, 'null') || '|' || body, ' ## '), '-') from public.agent_inbox_items where organization_id = '${ORG_A}' and kind = 'org_reativada';`,
    );

  it("⭐ reativa a administrativa, zera a suspensão, falha o pending remanescente e abre UM item com a contagem", () => {
    suspender(ORG_A, "administrativa");
    // Durante a suspensão: as duas conversas recebem mensagem e um job escapa para a fila.
    sql(`
      update public.conversations set last_inbound_at = clock_timestamp() where id in ('${CONVERSA_A1}', '${CONVERSA_A2}');
      insert into public.job_queue (id, organization_id, kind, status) values ('${JOB_REMANESCENTE}', '${ORG_A}', 'watchdog', 'pending');
    `);
    const antes = eventos(ORG_A, "tenant.reactivated");

    expect(reativar(ORG_A, "administrativa")).toEqual({ changed: true });

    expect(estado(ORG_A)).toBe("active/-");
    expect(
      valor(
        `select (suspended_at is null and suspended_reason is null and suspended_by is null)::text from public.organizations where id = '${ORG_A}';`,
      ),
    ).toBe("true");
    expect(valor(`select count(*) from public.job_queue where organization_id = '${ORG_A}' and status = 'pending';`)).toBe("0");
    // Sair de 'pending' não basta: apagado ou 'done' também passaria acima.
    expect(valor(`select status || '|' || last_error from public.job_queue where id = '${JOB_REMANESCENTE}';`)).toBe(
      "failed|org_nao_operante",
    );
    expect(corpoDoItem()).toBe(
      "warn|null|2 conversas receberam mensagem enquanto a conta estava suspensa.",
    );
    expect(eventos(ORG_A, "tenant.reactivated")).toBe(antes + 1);
    expect(
      valor(
        `select payload->>'conversas_com_mensagem' from public.event_log where organization_id = '${ORG_A}' and event_type = 'tenant.reactivated' order by created_at desc limit 1;`,
      ),
    ).toBe("2");
  });

  it("uma conversa só: frase no singular; mensagem de ANTES da suspensão não conta", () => {
    sql(`update public.conversations set last_inbound_at = now() - interval '1 day' where id = '${CONVERSA_A2}';`);
    suspender(ORG_A, "administrativa");
    sql(`update public.conversations set last_inbound_at = clock_timestamp() where id = '${CONVERSA_A1}';`);
    expect(reativar(ORG_A, "administrativa")).toEqual({ changed: true });
    expect(corpoDoItem()).toBe(
      "warn|null|1 conversa recebeu mensagem enquanto a conta estava suspensa.",
    );
  });

  it("⭐ conversa de grupo não entra na contagem: a IA não atende grupo", () => {
    suspender(ORG_A, "administrativa");
    sql(`update public.conversations set last_inbound_at = clock_timestamp() where id in ('${CONVERSA_A1}', '${CONVERSA_GRUPO}');`);
    expect(reativar(ORG_A, "administrativa")).toEqual({ changed: true });
    expect(corpoDoItem()).toBe("warn|null|1 conversa recebeu mensagem enquanto a conta estava suspensa.");
  });

  it("nenhuma conversa nova: reativa sem abrir item", () => {
    suspender(ORG_A, "administrativa");
    expect(reativar(ORG_A, "administrativa")).toEqual({ changed: true });
    expect(corpoDoItem()).toBe("-");
  });

  it("⭐ o tipo é exigido: administrativa não desfaz cobrança, cobrança não desfaz administrativa", () => {
    suspender(ORG_A, "cobranca");
    expect(reativar(ORG_A, "administrativa")).toEqual({ changed: false, motivo: "suspensao_de_cobranca" });
    expect(estado(ORG_A)).toBe("suspended/cobranca");
    expect(reativar(ORG_A, "cobranca")).toEqual({ changed: true });
    expect(estado(ORG_A)).toBe("active/-");

    suspender(ORG_A, "administrativa");
    expect(reativar(ORG_A, "cobranca")).toEqual({ changed: false, motivo: "suspensao_administrativa" });
    expect(estado(ORG_A)).toBe("suspended/administrativa");
  });

  it("idempotente: reativar uma org ativa é no-op sem evento", () => {
    const antes = eventos(ORG_A, "tenant.reactivated");
    expect(reativar(ORG_A, "administrativa")).toEqual({ changed: false, motivo: "nao_suspensa" });
    expect(eventos(ORG_A, "tenant.reactivated")).toBe(antes);
  });

  it("redigida com tipo residual: nem suspende, nem reativa, nem quebra", () => {
    sql(`update public.organizations set status = 'redacted', suspended_kind = 'cobranca' where id = '${ORG_R}';`);
    expect(suspender(ORG_R, "administrativa")).toEqual({ changed: false, motivo: "org_encerrada" });
    expect(reativar(ORG_R, "cobranca")).toEqual({ changed: false, motivo: "nao_suspensa" });
    expect(estado(ORG_R)).toBe("redacted/cobranca");
    expect(operante(ORG_R)).toBe("false");
  });

  it("suspensão legada sem tipo (imagem anterior à 0501) vale como administrativa", () => {
    sql(`update public.organizations set status = 'suspended', suspended_at = now() where id = '${ORG_A}';`);
    expect(reativar(ORG_A, "cobranca")).toEqual({ changed: false, motivo: "suspensao_administrativa" });
    expect(reativar(ORG_A, "administrativa")).toEqual({ changed: true });
    expect(estado(ORG_A)).toBe("active/-");
  });
});
