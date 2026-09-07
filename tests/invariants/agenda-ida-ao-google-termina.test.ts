import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/** A coluna gerada seleciona intenção publicável, sem comparar dois relógios.
 * Migration0225 mantém a prova de entrada/saída/edição e o carimbo legado.
 * O aceite agora captura a revisão local; retry não inventa uma edição nova.
 * O defeito histórico era um filtro PostgREST que comparava coluna com string
 * literal; dublês o aceitavam. O filtro novo é exercitado pelo PostgREST na
 * jornada agenda-google-sync, além das provas de coluna abaixo.
 * Claims/CAS/HTTP reais estão em agenda-google-reconciliacao.test.ts.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG = "aaaaaaaa-0200-4000-8000-000000000001";
const DONO = "aaaaaaaa-0200-4000-8000-000000000002";
const TIPO = "aaaaaaaa-0200-4000-8000-000000000003";

/** Um compromisso novo, sempre em estado "nunca foi ao Google". */
function marcar(id: string, quando: string): void {
  sql(`
    insert into public.calendar_appointments
      (id, organization_id, event_type_id, owner_user_id, title, starts_at, ends_at, time_zone, status)
    values ('${id}', '${ORG}', '${TIPO}', '${DONO}', 'Compromisso ${id}',
            '${quando}'::timestamptz, '${quando}'::timestamptz + interval '30 min',
            'America/Sao_Paulo', 'confirmed');
  `);
}

function precisaIr(id: string): boolean {
  return sql(`select needs_google_push from public.calendar_appointments where id = '${id}';`) === "t";
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${DONO}', 'dono-0200@deskcomm.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, display_name, legal_name)
      values ('${ORG}', 'org-0200', 'Org 0200', 'Org 0200')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${DONO}', '${ORG}', 'admin', now())
      on conflict do nothing;
    insert into public.calendar_event_types
      (id, organization_id, name, slug, duration_minutes, default_owner_user_id)
      values ('${TIPO}', '${ORG}', 'Tipo 0200', 'tipo-0200', 30, '${DONO}')
      on conflict (id) do nothing;
    delete from public.calendar_appointments where organization_id = '${ORG}';
  `);
});

describe("needs_google_push: quem entra na fila do Google", () => {
  it("a coluna derivada existe e é GERADA (ninguém a escreve à mão)", () => {
    // Controle do instrumento: sem isto, uma coluna comum de mesmo nome faria
    // todos os casos abaixo passarem por motivo errado — ela seria só um
    // booleano que o teste mesmo preenche.
    const gerada = sql(`
      select is_generated from information_schema.columns
       where table_schema = 'public' and table_name = 'calendar_appointments'
         and column_name = 'needs_google_push';
    `);
    expect(gerada, "needs_google_push não é GENERATED — derivado escrito à mão diverge").toBe("ALWAYS");
  });

  it("compromisso que nunca foi ao Google ENTRA na fila", () => {
    const id = "bbbbbbbb-0200-4000-8000-000000000001";
    marcar(id, "2030-03-10 14:00:00-03");
    expect(precisaIr(id)).toBe(true);
  });

  it("depois de sincronizar, a linha SAI da fila", () => {
    // ⚠️ O CARIMBO VAI COM UM INSTANTE DO PASSADO, e isso reproduz o cenário legado em que
    // o worker mandava: `new Date().toISOString()` do Node é calculado antes de a
    // requisição sair, então chega ao banco já velho. Um teste que escrevesse
    // `now()` aqui mediria um mundo que não existe e ficaria verde sem o trigger.
    const id = "bbbbbbbb-0200-4000-8000-000000000002";
    marcar(id, "2030-03-11 14:00:00-03");
    sql(`
      update public.calendar_appointments
         set google_event_id = 'evt_0200',
             google_synced_at = now() - interval '5 seconds',
             google_synced_local_revision = google_local_revision
       where id = '${id}';
    `);
    expect(
      precisaIr(id),
      "a linha continuou na fila logo depois de sincronizar — é o LAÇO: o worker " +
        "reenviaria o mesmo evento ao Google a cada 5 minutos, para sempre. " +
        "O aceite precisa alcançar a revisão publicável capturada.",
    ).toBe(false);
  });

  it("o carimbo é do BANCO, não de quem escreveu", () => {
    // A propriedade estrutural, dita diretamente: o valor gravado é descartado e
    // trocado pelo `now()` da transação. É o que faz o caso acima valer para
    // qualquer escritor futuro, não só para este worker.
    const id = "bbbbbbbb-0200-4000-8000-000000000003";
    marcar(id, "2030-03-12 14:00:00-03");
    sql(`
      update public.calendar_appointments
         set google_synced_at = '2001-01-01 00:00:00-03'::timestamptz
       where id = '${id}';
    `);
    const ano = sql(`
      select extract(year from google_synced_at)::int
        from public.calendar_appointments where id = '${id}';
    `);
    expect(ano, "o banco aceitou o carimbo de quem escreveu em vez de pôr o dele").not.toBe("2001");
  });

  it("editar depois de sincronizar RECOLOCA na fila", () => {
    // O outro lado, e sem ele a coluna poderia estar sempre falsa e os casos
    // acima passariam: uma alteração de verdade tem de voltar a pedir ida.
    const id = "bbbbbbbb-0200-4000-8000-000000000004";
    marcar(id, "2030-03-13 14:00:00-03");
    sql(`update public.calendar_appointments set google_synced_at = now(), google_synced_local_revision = google_local_revision where id = '${id}';`);
    expect(precisaIr(id), "a linha nem chegou a sair da fila — o caso anterior é quem cobre isso").toBe(false);

    sql(`update public.calendar_appointments set title = 'Retorno remarcado' where id = '${id}';`);
    expect(
      precisaIr(id),
      "editei o compromisso e ele não voltou para a fila — a mudança nunca chegaria ao Google",
    ).toBe(true);
  });

  it("retry rearma a próxima tentativa sem inventar edição; carimbo não é intenção", () => {
    const id = "bbbbbbbb-0200-4000-8000-000000000005";
    marcar(id, "2030-03-14 14:00:00-03");
    sql(`update public.calendar_appointments set google_synced_at = now(), google_synced_local_revision = google_local_revision where id = '${id}';`);
    expect(precisaIr(id)).toBe(false);

    sql(`update public.calendar_appointments set google_synced_at = null where id = '${id}';`);
    expect(precisaIr(id), "zerar um diagnóstico não pode fabricar uma intenção nova").toBe(false);
    const revision = sql(`select google_local_revision from public.calendar_appointments where id='${id}'`);
    sql(`update public.calendar_appointments set google_next_attempt_at=now() where id='${id}'`);
    expect(sql(`select google_local_revision from public.calendar_appointments where id='${id}'`)).toBe(revision);
    sql(`update public.calendar_appointments set title='Nova intenção' where id='${id}'`);
    expect(precisaIr(id)).toBe(true);
    sql(`update public.calendar_appointments set google_synced_local_revision=${revision} where id='${id}'`);
    expect(precisaIr(id), "aceite da revisão antiga não confirma a nova").toBe(true);
  });

  it("o índice parcial do worker existe e casa o recorte que ele lê", () => {
    const achou = sql(`
      select count(*) from pg_indexes
       where schemaname = 'public'
         and indexname = 'calendar_appointments_pendente_no_google_idx';
    `);
    expect(achou, "sem o índice, o worker varre a tabela inteira a cada 5 minutos").toBe("1");
  });
});
