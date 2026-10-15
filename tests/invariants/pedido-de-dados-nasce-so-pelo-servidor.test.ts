import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_ORG, GOV_VIEWER, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * O PEDIDO DE DADOS NASCE E ANDA SÓ PELO CAMINHO DO SERVIDOR (migration 0672, doc 134).
 *
 * A exportação dos dados do titular só começa pela aprovação de alguém da
 * equipe, e a rota de aprovação emite o evento com a chave de serviço. Aqui o
 * banco garante as duas pontas pela sessão de usuário (o caminho do PostgREST):
 *
 *   - `lgpd.data_request_received` e `lgpd.redact_received` não nascem de login,
 *     nem de viewer nem de admin — e nascem do servidor (controle positivo);
 *   - `lgpd_requests` não recebe INSERT/UPDATE/DELETE da sessão — e recebe do
 *     servidor; a leitura do admin pela RLS continua.
 *
 * ⚠️ RLS e grant recusam com o MESMO SQLSTATE (42501). Cada recusa confere
 * também a MENSAGEM: `reserved_server_event` (o gatilho) e `permission denied
 * for table` (o grant). Sem isso, a recusa do viewer pela RLS — que já existia —
 * passaria por prova do que esta migration acrescentou.
 */

const PEDIDO = "c0de0672-7777-4000-8000-000000000001";
const PEDIDO_DO_ADMIN = "c0de0672-7777-4000-8000-000000000002";
/** Id próprio do controle positivo: não depende de o INSERT do admin ter sido recusado. */
const PEDIDO_DO_SERVIDOR = "c0de0672-7777-4000-8000-000000000003";
const ENTIDADE_COMUM = "c0de0672-3333-4000-8000-000000000001";
const TIPOS_DO_SERVIDOR = ["lgpd.data_request_received", "lgpd.redact_received"] as const;

function comoUsuario(usuario: string, comando: string): string {
  return `set role authenticated;
select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
${comando};`;
}

/** stderr do psql com SQLSTATE, ou "" se o script passou. */
function erroDe(script: string): string {
  try {
    sql(`\\set VERBOSITY verbose\n${script}`);
    return "";
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

function eventos(tipo: string, entidade: string): number {
  return Number(
    lastLine(
      sql(`select count(*) from public.event_log
            where organization_id = '${GOV_ORG}' and event_type = '${tipo}' and entity_id = '${entidade}';`),
    ),
  );
}

function emitir(tipo: string, entidade: string): string {
  return `select public.emit_event('${tipo}', 'lgpd_request', '${entidade}',
    jsonb_build_object('request_id', '${entidade}', 'manually_approved', true,
                       'approved_by', '${GOV_ADMIN}'),
    '{}'::jsonb, '${GOV_ORG}')`;
}

function pedidoExiste(id: string): boolean {
  return lastLine(sql(`select exists(select 1 from public.lgpd_requests where id = '${id}')::text;`)) === "true";
}

beforeAll(() => {
  seedGov();
  sql(`
    delete from public.lgpd_requests where id in ('${PEDIDO}', '${PEDIDO_DO_ADMIN}', '${PEDIDO_DO_SERVIDOR}');
    insert into public.lgpd_requests (id, organization_id, request_type, source, scope, due_at, request_payload)
      values ('${PEDIDO}', '${GOV_ORG}', 'data_request', 'nuvemshop', 'contact', now() + interval '7 days',
              '{"delivery":{"method":"email","address":"titular@invariant.test"}}'::jsonb);
  `);
});

describe("os eventos que acordam os workers de LGPD nascem só do servidor", () => {
  for (const tipo of TIPOS_DO_SERVIDOR) {
    for (const [papel, usuario] of [
      ["viewer", GOV_VIEWER],
      ["admin", GOV_ADMIN],
    ] as const) {
      it(`⭐ ${papel} não emite ${tipo} pela sessão`, () => {
        const antes = eventos(tipo, PEDIDO);
        const e = erroDe(comoUsuario(usuario, emitir(tipo, PEDIDO)));
        expect(e, `${papel} emitiu ${tipo}`).toContain("42501");
        expect(e).toContain("reserved_server_event");
        expect(eventos(tipo, PEDIDO)).toBe(antes);
      });
    }

    it(`controle positivo: o servidor (service_role) emite ${tipo}`, () => {
      const antes = eventos(tipo, PEDIDO);
      sql(`set role service_role;\n${emitir(tipo, PEDIDO)};`);
      expect(eventos(tipo, PEDIDO)).toBe(antes + 1);
    });
  }

  it("tipo comum segue livre para a sessão (o gatilho não alcança outros eventos)", () => {
    const antes = eventos("contact.updated", ENTIDADE_COMUM);
    sql(
      comoUsuario(
        GOV_ADMIN,
        `select public.emit_event('contact.updated', 'contact', '${ENTIDADE_COMUM}', '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}')`,
      ),
    );
    expect(eventos("contact.updated", ENTIDADE_COMUM)).toBe(antes + 1);
  });
});

describe("o pedido de dados é gravado só pelo servidor", () => {
  it("⭐ admin não cria pedido pela sessão (destino escolhido por ele)", () => {
    const e = erroDe(
      comoUsuario(
        GOV_ADMIN,
        `insert into public.lgpd_requests (id, organization_id, request_type, source, scope, due_at, request_payload)
           values ('${PEDIDO_DO_ADMIN}', '${GOV_ORG}', 'data_request', 'manual', 'contact', now() + interval '7 days',
                   '{"delivery":{"method":"email","address":"fora@invariant.test"}}'::jsonb)`,
      ),
    );
    expect(e).toContain("42501");
    expect(e).toContain("permission denied for table lgpd_requests");
    expect(pedidoExiste(PEDIDO_DO_ADMIN)).toBe(false);
  });

  it("viewer também não cria", () => {
    const e = erroDe(
      comoUsuario(
        GOV_VIEWER,
        `insert into public.lgpd_requests (id, organization_id, request_type, source, scope, due_at)
           values ('${PEDIDO_DO_ADMIN}', '${GOV_ORG}', 'data_request', 'manual', 'contact', now() + interval '7 days')`,
      ),
    );
    expect(e).toContain("permission denied for table lgpd_requests");
    expect(pedidoExiste(PEDIDO_DO_ADMIN)).toBe(false);
  });

  it("⭐ admin não troca o destino nem apaga o pedido pela sessão", () => {
    const troca = erroDe(
      comoUsuario(
        GOV_ADMIN,
        `update public.lgpd_requests
            set request_payload = '{"delivery":{"method":"email","address":"fora@invariant.test"}}'::jsonb
          where id = '${PEDIDO}'`,
      ),
    );
    expect(troca).toContain("permission denied for table lgpd_requests");
    const apaga = erroDe(comoUsuario(GOV_ADMIN, `delete from public.lgpd_requests where id = '${PEDIDO}'`));
    expect(apaga).toContain("permission denied for table lgpd_requests");
    expect(
      lastLine(sql(`select request_payload->'delivery'->>'address' from public.lgpd_requests where id = '${PEDIDO}';`)),
    ).toBe("titular@invariant.test");
  });

  it("admin continua LENDO o pedido pela sessão (a tela não muda)", () => {
    const lido = lastLine(
      sql(comoUsuario(GOV_ADMIN, `select count(*) from public.lgpd_requests where id = '${PEDIDO}'`)),
    );
    expect(lido).toBe("1");
  });

  it("controle positivo: o servidor (service_role) cria e atualiza o pedido", () => {
    sql(`set role service_role;
      insert into public.lgpd_requests (id, organization_id, request_type, source, scope, due_at)
        values ('${PEDIDO_DO_SERVIDOR}', '${GOV_ORG}', 'data_request', 'nuvemshop', 'contact', now() + interval '7 days');
      update public.lgpd_requests set status = 'processing' where id = '${PEDIDO_DO_SERVIDOR}';`);
    expect(lastLine(sql(`select status from public.lgpd_requests where id = '${PEDIDO_DO_SERVIDOR}';`))).toBe(
      "processing",
    );
    sql(`delete from public.lgpd_requests where id = '${PEDIDO_DO_SERVIDOR}';`);
  });
});

describe("migration e apêndice do baseline são o mesmo bloco", () => {
  it("o bloco da 0672 está letra a letra no baseline, antes da VARREDURA anon", () => {
    const raiz = join(__dirname, "..", "..");
    const migration = readFileSync(
      join(raiz, "supabase/migrations/20261017060004_0672_o_pedido_de_dados_nasce_so_pelo_servidor.sql"),
      "utf8",
    );
    const baseline = readFileSync(join(raiz, "supabase/baseline.sql"), "utf8");
    const rotulo = "-- ---- o pedido de dados nasce só pelo caminho do servidor (migration 0672) ----";
    const bloco = migration.slice(migration.indexOf(rotulo));
    expect(migration.indexOf(rotulo)).toBeGreaterThan(0);
    const onde = baseline.indexOf(bloco);
    expect(onde, "o apêndice do baseline divergiu da migration").toBeGreaterThan(0);
    expect(onde).toBeLessThan(baseline.indexOf("-- ---- VARREDURA anon: função nova nasce exposta"));
  });
});
