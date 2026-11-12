import { execFileSync } from "node:child_process";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { googlePushCandidates } from "@/lib/agenda/google/candidates";

/**
 * A FILA DO PUSH DRENA (#4448, segunda porta).
 *
 * O defeito medido na issue: o cron `agenda-google-push` roda a cada 5 minutos e
 * a seleção de candidatos (`lib/agenda/google/candidates.ts` sobre a view
 * `calendar_service_google_candidates`) não olhava `status` nem data. Todo
 * compromisso já publicado entrava por causa do ramo
 * `google_event_id is not null and google_conflict is null` — inclusive os que
 * já terminaram. O compromisso morto volta a cada ciclo e o lote nunca drena.
 *
 * A view é a única porta que o cron lê (o comentário do `or` em `candidates.ts`
 * diz "seleção comum do cron e da prova PostgREST": a seleção é a view). Por
 * isso o recorte mora nela e o teste mede os DOIS lados contra o banco real:
 *
 *   - a contagem que a fila tinha ANTES do recorte, com o MESMO `or` aplicado
 *     direto na tabela (o predicado da view antiga). É o controle do
 *     instrumento: sem ele, uma fila que nunca teve candidato passaria verde;
 *   - a contagem DEPOIS, pela função que o cron chama, com o cliente PostgREST
 *     traduzido para SQL — e a igualdade com a mesma consulta feita na view por
 *     SQL direto. Se os dois lados discordarem (só um com o filtro), o teste
 *     reprova pelo conjunto, não por um número redondo.
 *
 * ⚠️ AS DATAS DAS FIXTURES FICAM LONGE DA BORDA da janela (3 dias para trás ou
 * para frente, nunca "1 dia e 2 segundos"). O recorte de data é
 * `ends_at > agora - 1 dia`, com `agora` do RELÓGIO DO PROCESSO no lado TS e
 * `now()` do BANCO no lado SQL — a mesma classe de diferença que a
 * `agenda-google-recovery` documenta. Perto da borda o veredito dependeria de
 * os dois relógios concordarem na casa dos milissegundos; longe dela, não.
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

const ORG = "aaaaaaaa-0300-4000-8000-000000000001";
const DONO = "aaaaaaaa-0300-4000-8000-000000000002";
const CONEXAO = "aaaaaaaa-0300-4000-8000-000000000003";
const CALENDARIO = "aaaaaaaa-0300-4000-8000-000000000004";

/** O `or` da fila, na tradução que o PostgREST faz dele. */
const O_DA_FILA =
  "(needs_google_push or (google_event_id is not null and google_conflict is null) or google_conflict->'resolution' is not null)";

/**
 * O predicado da view ANTES deste conserto, sem `status` e sem data — a fila que
 * a issue mediu. Fica aqui como CONTROLE: se ele também devolvesse vazio, o
 * teste estaria medindo um banco sem candidato nenhum e passaria por motivo
 * errado.
 */
const PREDICADO_ANTIGO = `
  from public.calendar_appointments a
 where a.organization_id = '${ORG}'
   and ((a.service_occurrence_id is null and not a.service_block) or a.service_publication_mode <> 'none')
   and not exists (select 1 from public.contacts c
                    where c.organization_id = a.organization_id and c.id = a.contact_id and c.is_anonymized)
   and ${O_DA_FILA}
   and a.google_next_attempt_at <= now()
   and a.owner_user_id is not null`;

interface Caso {
  id: string;
  rotulo: string;
  status: "pending" | "confirmed" | "cancelled" | "completed" | "no_show";
  /** Deslocamento em dias em relação a `now()` do banco: negativo = encerrado. */
  dias: number;
  /** Já publicado no Google (`google_event_id` preenchido). */
  publicado: boolean;
  /** Já convergiu (nada pendente de envio). */
  convergiu: boolean;
  naFila: boolean;
}

/**
 * As fixtures são os casos da issue, um por linha: os oito compromissos
 * encerrados (6 `completed`, 1 `cancelled`, 1 `no_show`), o nono — saudável e
 * encerrado —, o controle de compromisso FUTURO que precisa continuar entrando e
 * as bordas do recorte novo (cancelado futuro com evento a apagar, cancelado sem
 * evento, desfecho registrado no futuro).
 */
const CASOS: Caso[] = [
  { id: "cccccccc-0300-4000-8000-000000000001", rotulo: "completed encerrado", status: "completed", dias: -3, publicado: true, convergiu: true, naFila: false },
  { id: "cccccccc-0300-4000-8000-000000000002", rotulo: "completed encerrado", status: "completed", dias: -5, publicado: true, convergiu: true, naFila: false },
  { id: "cccccccc-0300-4000-8000-000000000003", rotulo: "completed encerrado", status: "completed", dias: -7, publicado: true, convergiu: true, naFila: false },
  { id: "cccccccc-0300-4000-8000-000000000004", rotulo: "completed encerrado", status: "completed", dias: -9, publicado: true, convergiu: true, naFila: false },
  { id: "cccccccc-0300-4000-8000-000000000005", rotulo: "completed encerrado", status: "completed", dias: -11, publicado: true, convergiu: true, naFila: false },
  { id: "cccccccc-0300-4000-8000-000000000006", rotulo: "completed encerrado", status: "completed", dias: -13, publicado: true, convergiu: true, naFila: false },
  { id: "cccccccc-0300-4000-8000-000000000007", rotulo: "cancelled encerrado", status: "cancelled", dias: -3, publicado: true, convergiu: true, naFila: false },
  { id: "cccccccc-0300-4000-8000-000000000008", rotulo: "no_show encerrado", status: "no_show", dias: -3, publicado: true, convergiu: true, naFila: false },
  { id: "cccccccc-0300-4000-8000-000000000009", rotulo: "saudável e encerrado (o nono)", status: "confirmed", dias: -3, publicado: true, convergiu: true, naFila: false },
  { id: "cccccccc-0300-4000-8000-000000000010", rotulo: "futuro nunca publicado", status: "confirmed", dias: 3, publicado: false, convergiu: false, naFila: true },
  { id: "cccccccc-0300-4000-8000-000000000011", rotulo: "futuro publicado e convergido", status: "confirmed", dias: 3, publicado: true, convergiu: true, naFila: true },
  { id: "cccccccc-0300-4000-8000-000000000012", rotulo: "cancelado futuro com evento a apagar", status: "cancelled", dias: 3, publicado: true, convergiu: false, naFila: true },
  { id: "cccccccc-0300-4000-8000-000000000013", rotulo: "cancelado futuro sem evento no Google", status: "cancelled", dias: 3, publicado: false, convergiu: true, naFila: false },
  { id: "cccccccc-0300-4000-8000-000000000014", rotulo: "desfecho registrado no futuro", status: "completed", dias: 3, publicado: true, convergiu: true, naFila: false },
  { id: "cccccccc-0300-4000-8000-000000000015", rotulo: "falta registrada no futuro", status: "no_show", dias: 3, publicado: true, convergiu: true, naFila: false },
];

const ESPERADOS = CASOS.filter((c) => c.naFila).map((c) => c.id);
const FORA = CASOS.filter((c) => !c.naFila).map((c) => c.id);

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${DONO}', 'dono-0300@deskcomm.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, display_name, legal_name)
      values ('${ORG}', 'org-0300', 'Org 0300', 'Org 0300')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${DONO}', '${ORG}', 'admin', now())
      on conflict do nothing;
    insert into public.calendar_connections
      (id, organization_id, user_id, provider, account_email, status)
      values ('${CONEXAO}', '${ORG}', '${DONO}', 'google_calendar', 'dono-0300@deskcomm.test', 'healthy')
      on conflict (id) do nothing;
    insert into public.calendar_connection_calendars
      (id, organization_id, connection_id, external_calendar_id, name, is_destination, counts_for_conflicts, access_role, time_zone)
      values ('${CALENDARIO}', '${ORG}', '${CONEXAO}', 'destino-0300', 'Destino', true, true, 'owner', 'America/Sao_Paulo')
      on conflict (id) do nothing;
    delete from public.calendar_appointments where organization_id = '${ORG}';
  `);

  for (const c of CASOS) {
    const inicio = `now() + ${c.dias} * interval '1 day'`;
    const evento = c.publicado ? `'evt-${c.id.slice(-3)}'` : "null";
    // `google_synced_at` preenchido = a linha já foi aceita pelo executor; quem
    // decide "nada pendente" é o par de revisões logo abaixo.
    const carimbo = c.convergiu ? "now()" : "null";
    // `cancelled` sem `cancelled_at` viola `calendar_appointments_cancelamento_coerente`.
    const canceladoEm = c.status === "cancelled" ? "now()" : "null";
    sql(`
      insert into public.calendar_appointments
        (id, organization_id, owner_user_id, title, starts_at, ends_at, time_zone, status,
         cancelled_at, google_connection_id, google_calendar_id, google_event_id, google_synced_at,
         google_next_attempt_at)
      values ('${c.id}', '${ORG}', '${DONO}', '${c.rotulo}',
              ${inicio}, ${inicio} + interval '1 hour', 'America/Sao_Paulo', '${c.status}',
              ${canceladoEm},
              ${c.publicado ? `'${CONEXAO}'` : "null"},
              ${c.publicado ? `'destino-0300'` : "null"},
              ${evento}, ${carimbo}, now() - interval '1 minute');
    `);
    if (c.convergiu) {
      // A coluna gerada que este repo tem de fato é
      // `google_local_revision > google_synced_local_revision and google_conflict is null`
      // (o caminho de aceite do `fn_google_appointment` grava o par). Igualar as
      // revisões é o que significa "já convergiu" aqui — carimbar só
      // `google_synced_at` deixaria a linha pedindo envio.
      sql(`
        update public.calendar_appointments
           set google_synced_local_revision = google_local_revision,
               google_synced_at = now()
         where id = '${c.id}';
      `);
    }
  }
});

/** Quantos candidatos a fila tinha por ciclo ANTES do recorte (predicado antigo). */
function contagemAntiga(): number {
  return Number(sql(`select count(*) ${PREDICADO_ANTIGO};`));
}

/** A fila como o banco a entrega para quem lê a view direto (SQL). */
function idsDaViewPelaFila(): string[] {
  const saida = sql(`
    select a.id from public.calendar_service_google_candidates a
     where ${O_DA_FILA}
       and a.google_next_attempt_at <= now()
       and a.owner_user_id is not null
       and a.organization_id = '${ORG}'
     order by a.google_next_attempt_at, a.id;
  `);
  return saida ? saida.split("\n") : [];
}

/**
 * A ponte de testes: traduz o que `googlePushCandidates` pede para SQL e roda no
 * Postgres real. O `.or` é CONFERIDO antes da tradução (texto exato), então
 * mudar a definição da fila em `candidates.ts` sem passar por aqui reprova.
 */
function clienteDaFila(): SupabaseClient {
  const ident = (nome: string) => {
    if (!/^[a-z_]+$/.test(nome)) throw new Error(`identificador inesperado: ${nome}`);
    return `"${nome}"`;
  };
  const literal = (valor: string) => {
    if (!/^[A-Za-z0-9_:+\-\.\[\]]+$/.test(valor)) throw new Error(`valor inesperado: ${valor}`);
    return `'${valor}'`;
  };
  return {
    from: (tabela: string) => {
      let colunas = "*";
      let ordem = "";
      let limite: number | undefined;
      const filtros: string[] = [];
      const q = {
        select: (s: string) => {
          colunas = s
            .split(",")
            .map((c) => {
              const [alias, origem] = c.split(":");
              return origem ? `${ident(origem)} as ${ident(alias!)}` : ident(alias!);
            })
            .join(",");
          return q;
        },
        or: (s: string) => {
          expect(s, "a definição da fila mudou em candidates.ts — este teste mede a fila antiga").toBe(
            "needs_google_push.eq.true,and(google_event_id.not.is.null,google_conflict.is.null),google_conflict->resolution.not.is.null",
          );
          filtros.push(O_DA_FILA);
          return q;
        },
        in: (coluna: string, valores: readonly string[]) => {
          filtros.push(`${ident(coluna)} in (${valores.map(literal).join(",")})`);
          return q;
        },
        gt: (coluna: string, valor: string) => {
          filtros.push(`${ident(coluna)} > ${literal(valor)}::timestamptz`);
          return q;
        },
        lte: (coluna: string, valor: string) => {
          filtros.push(`${ident(coluna)} <= ${literal(valor)}::timestamptz`);
          return q;
        },
        not: (coluna: string, operador: string, valor: null) => {
          expect([operador, valor]).toEqual(["is", null]);
          filtros.push(`${ident(coluna)} is not null`);
          return q;
        },
        order: (coluna: string) => {
          ordem = ` order by ${ident(coluna)}`;
          return q;
        },
        limit: (n: number) => {
          limite = n;
          return q;
        },
        then: (resolve: (valor: unknown) => void) => {
          try {
            const saida = sql(
              `select ${colunas} from ${ident(tabela)}${filtros.length ? ` where ${filtros.join(" and ")}` : ""}${ordem}${limite === undefined ? "" : ` limit ${limite}`};`,
            );
            resolve({
              data: saida
                ? saida.split("\n").map((linha) => {
                    const [id, organization_id, user_id] = linha.split("|");
                    return { id, organization_id, user_id };
                  })
                : [],
              error: null,
            });
          } catch (error) {
            resolve({ data: null, error });
          }
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

async function idsDaFilaDoSistema(): Promise<string[]> {
  const { data, error } = await googlePushCandidates(clienteDaFila());
  expect(error, `a fila devolveu erro: ${String(error)}`).toBeNull();
  return (data ?? [])
    .map((linha) => (linha as { id: string }).id)
    .filter((id) => FORA.includes(id) || ESPERADOS.includes(id))
    .sort();
}

describe("a fila do push drena: o que já terminou sai, o que falta fazer fica (#4448)", () => {
  it("o controle do instrumento: o predicado ANTIGO enxerga os mortos", () => {
    // Sem este número o resto passaria num banco sem candidato nenhum. 14 = os
    // 13 publicados (9 encerrados + 2 futuros + 1 cancelado futuro + 1 desfecho
    // futuro) + o futuro nunca publicado; o cancelado sem evento não entra.
    expect(contagemAntiga(), "o predicado antigo não mediu nada — a fixture não exercita o defeito").toBe(14);
  });

  it("compromisso encerrado NÃO volta no ciclo seguinte", async () => {
    const ids = await idsDaFilaDoSistema();
    for (const id of FORA) {
      const caso = CASOS.find((c) => c.id === id)!;
      expect(ids, `${caso.rotulo} continua na fila — é o laço de 5 em 5 minutos`).not.toContain(id);
    }
  });

  it("compromisso futuro continua entrando — inclusive o cancelado que ainda precisa apagar", async () => {
    const ids = await idsDaFilaDoSistema();
    expect(ids.sort()).toEqual([...ESPERADOS].sort());
  });

  it("a contagem por ciclo cai de 14 para 3, e não a zero", async () => {
    const ids = await idsDaFilaDoSistema();
    expect(contagemAntiga()).toBe(14);
    expect(ids.length, "a fila esvaziou demais: o controle futuro saiu junto").toBe(3);
  });

  it("view e função de candidatos concordam: o mesmo conjunto, pelo SQL e pelo PostgREST", async () => {
    const pelaView = idsDaViewPelaFila().sort();
    const peloTS = (await idsDaFilaDoSistema()).sort();
    expect(
      peloTS,
      "a função de candidatos e a view devolveram conjuntos diferentes — um dos lados ficou sem o recorte",
    ).toEqual(pelaView);
  });
});
