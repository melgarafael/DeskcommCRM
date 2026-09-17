import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A OCUPAÇÃO DO GOOGLE NÃO DEPENDE DE QUEM PERGUNTA (#879).
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * A coleta chega ao Google Agenda por junção com `calendar_connections`
 * (`calendar_selected_external_events` → `calendar_connections!inner`), e a RLS
 * dessa tabela mostra a conexão **ao próprio dono e a `manager` para cima**.
 * Com o cliente de SESSÃO, a junção de um Atendente volta vazia: medido num
 * Postgres descartável com o `baseline.sql`, a MESMA agenda rende **1** evento
 * para o dono, **1** para o gerente e **0** para o atendente. Quem marca na
 * agenda de outra pessoa, então, confere ocupação contra uma lista sem o Google
 * dela — e aceita por cima de um compromisso pessoal que existe.
 *
 * ─── O que este arquivo prende ──────────────────────────────────────────────
 *
 * Que as duas leituras do Google saem pelas RPCs `fn_agenda_ocupacao_google_do_dono`
 * e `fn_agenda_conexoes_google_do_dono` (migration 0260) — `security definer`
 * que conferem pertencimento e filtram o dono — e que o resultado é o MESMO
 * para quem pergunta: um Atendente (cuja sessão não enxerga a conexão) e um
 * dono (que a enxerga). A ocupação é uma propriedade da AGENDA, não da
 * visibilidade de quem consulta.
 *
 * ⚠️ A primeira versão deste arquivo (PR #883) dublava `createAdminClient`: o
 * conserto lia as duas tabelas com service role dentro da coleta. Na
 * reconciliação do lote 10 a leitura virou RPC (ver o cabeçalho de
 * `lib/agenda/consulta.ts` e o da migration 0260), e o dublê passou a ter o
 * olhar da SESSÃO nas tabelas e a resposta da FUNÇÃO nas RPCs. O que o arquivo
 * prova não mudou.
 *
 * ─── O que este arquivo NÃO mede (declarado, não estimado) ──────────────────
 *
 * 1. **A RLS e a função de verdade.** Aqui dois olhares são simulados (um vê a
 *    conexão, outro não). Quem mede o banco — dono, gerente e atendente recebem
 *    o mesmo pela função; atendente 0 pela junção direta; outra organização 0;
 *    `anon` recusado; nenhum título na resposta — é
 *    `tests/invariants/agenda-ocupacao-google-do-dono.test.ts`, via `pnpm test:db`.
 * 2. **Conteúdo de evento.** O que a coleta devolve é `Slot[]` — nenhum título,
 *    nenhuma descrição. A RPC dublada devolve as cinco colunas que a função
 *    declara, e nada além.
 * 3. **O encaixe da pessoa.** A mesma coleta serve o encaixe fora da grade; o
 *    caso do Atendente pelo handler mora em `tests/unit/pessoa-marca-fora-da-grade.test.ts`.
 */
const { horariosLivresDaOrg } = await import("@/lib/agenda/consulta");

const TZ = "America/Sao_Paulo";
const ORG = "org-1";
const DONO = "dono-1";
const TIPO_ID = "11111111-1111-4111-8111-111111111111";

/** 21:00 do dia 16 em São Paulo (00:00Z do dia 17) — a janela pedida. */
const DE = new Date("2026-09-17T00:00:00.000Z");
const ATE = new Date("2026-09-17T00:30:00.000Z");
const AGORA = new Date("2026-09-16T12:00:00.000Z");

/** O compromisso pessoal do dono, no Google, encostando na janela pedida. */
const EVENTO = { de: "2026-09-16T23:30:00.000Z", ate: "2026-09-17T00:30:00.000Z" };

interface Linha {
  [coluna: string]: unknown;
}

/**
 * O valor da coluna, resolvendo CAMINHO COM PONTO — que é o que o PostgREST faz
 * na relação embutida (`calendar_connections.user_id` do `!inner`).
 *
 * ⚠️ Sem isto o dublê não acha a linha, a ocupação some e o teste "prova" que o
 * conserto não funciona — ou pior, passaria aprovando um filtro de dono que não
 * existe.
 */
const valorDaColuna = (linha: Linha, coluna: string): unknown =>
  coluna.split(".").reduce<unknown>((acc, parte) => (acc as Linha | undefined)?.[parte], linha);

type Filtro = (linha: Linha) => boolean;

/**
 * Um `SupabaseClient` de mentira que FILTRA de verdade (mesmo dublê do teste da
 * exceção de data): aplica `eq/gte/lte/lt/gt` sobre linhas em memória. Um dublê
 * que ignorasse o filtro deixaria o teste passar pelo motivo errado.
 *
 * `veConexao` é o olhar da SESSÃO: `false` esconde `calendar_connections` e o
 * evento que chega pelo embed `!inner`, como a RLS faz com um Atendente. As
 * RPCs da migration 0260 NÃO dependem dele — são a resposta da função
 * `security definer`, lida da tabela inteira com os filtros do corpo SQL.
 */
function clienteFalso(tabelas: Record<string, Linha[]>, veConexao: boolean): SupabaseClient {
  const escondidas = new Set(veConexao ? [] : ["calendar_connections", "calendar_selected_external_events"]);
  function daTabela(tabela: string) {
    const filtros: Filtro[] = [];
    const linhas = () =>
      (escondidas.has(tabela) ? [] : (tabelas[tabela] ?? [])).filter((l) => filtros.every((f) => f(l)));
    const compara = (coluna: string, valor: unknown, ok: (a: string, b: string) => boolean) => {
      filtros.push((l) => ok(String(valorDaColuna(l, coluna)), String(valor)));
      return api;
    };
    const api = {
      select: () => api,
      eq: (coluna: string, valor: unknown) => {
        filtros.push((l) => valorDaColuna(l, coluna) === valor);
        return api;
      },
      gte: (coluna: string, valor: unknown) => compara(coluna, valor, (a, b) => a >= b),
      lte: (coluna: string, valor: unknown) => compara(coluna, valor, (a, b) => a <= b),
      lt: (coluna: string, valor: unknown) => compara(coluna, valor, (a, b) => a < b),
      gt: (coluna: string, valor: unknown) => compara(coluna, valor, (a, b) => a > b),
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: linhas(), error: null }).then(resolve),
    };
    return api;
  }

  async function rpc(fn: string, args: { p_org: string; p_owner: string; p_de: string; p_ate: string }) {
    if (fn === "fn_agenda_ocupacao_google_do_dono") {
      const ocupam = (tabelas.calendar_selected_external_events ?? []).filter(
        (l) =>
          l.organization_id === args.p_org &&
          valorDaColuna(l, "calendar_connections.user_id") === args.p_owner &&
          String(l.starts_at) < args.p_ate &&
          String(l.ends_at) > args.p_de,
      );
      return {
        data: ocupam.map((l) => ({
          starts_at: l.starts_at,
          ends_at: l.ends_at,
          transparency: l.transparency,
          status: l.status,
          connection_status: valorDaColuna(l, "calendar_connections.status"),
        })),
        error: null,
      };
    }
    if (fn === "fn_agenda_conexoes_google_do_dono") {
      const doDono = (tabelas.calendar_connections ?? []).filter(
        (l) => l.organization_id === args.p_org && l.user_id === args.p_owner,
      );
      return { data: doDono.map((l) => ({ status: l.status, last_sync_at: l.last_sync_at })), error: null };
    }
    if (fn === "fn_google_coverage") return { data: false, error: null };
    throw new Error(`[dublê] rpc não prevista: ${fn}`);
  }

  return { from: (tabela: string) => daTabela(tabela), rpc } as unknown as SupabaseClient;
}

/** As tabelas que a coleta lê; `comGoogle` diz se o dono tem compromisso no Google. */
function tabelas(comGoogle: boolean): Record<string, Linha[]> {
  const conexao = {
    organization_id: ORG,
    user_id: DONO,
    status: "connected",
    last_sync_at: "2026-09-16T11:00:00.000Z",
  };
  const evento = {
    organization_id: ORG,
    starts_at: EVENTO.de,
    ends_at: EVENTO.ate,
    transparency: "opaque",
    status: "confirmed",
    // O embed `calendar_connections!inner(user_id, status)`, como o PostgREST
    // entrega. Quem decide se a SESSÃO vê esta linha é `veConexao`.
    calendar_connections: { user_id: DONO, status: "connected" },
  };

  return {
    calendar_event_types: [
      {
        id: TIPO_ID,
        organization_id: ORG,
        name: "Consulta",
        is_active: true,
        duration_minutes: 30,
        buffer_before_minutes: 0,
        buffer_after_minutes: 0,
        minimum_notice_minutes: 0,
        slot_interval_minutes: 30,
        booking_window_days: 365,
        default_owner_user_id: DONO,
      },
    ],
    // Na AGENDA, `windows` vazio é "nada publicado" — jornada de verdade aqui.
    attendant_availability: [
      {
        organization_id: ORG,
        user_id: DONO,
        schedule: {
          timezone: TZ,
          windows: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: "09:00", end: "23:00" })),
        },
      },
    ],
    calendar_availability_exceptions: [],
    calendar_appointments: [],
    calendar_connections: [conexao],
    calendar_selected_external_events: comGoogle ? [evento] : [],
  };
}

describe("a ocupação do Google do dono barra a marcação de quem não enxerga a conexão", () => {
  it("Atendente (RLS esconde a conexão): o compromisso do Google do dono recusa o horário", async () => {
    // A sessão do Atendente não enxerga a conexão; a função responde pela agenda.
    const resultado = await horariosLivresDaOrg(clienteFalso(tabelas(true), false), ORG, {
      eventTypeId: TIPO_ID,
      ownerUserId: DONO,
      de: DE,
      ate: ATE,
      agora: AGORA,
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    // A vaga das 21:00 locais está em cima do compromisso; a das 21:30 está
    // livre. É EXATAMENTE isso que a lista tem que dizer — nem a mais, nem a
    // menos: `toEqual([])` esconderia a vaga seguinte ter sumido junto.
    expect(resultado.slots.map((s) => s.inicio.toISOString())).toEqual([
      "2026-09-17T00:30:00.000Z",
    ]);
  });

  it("o dono consultando recebe a MESMA resposta — a ocupação não depende de quem pergunta", async () => {
    const resultado = await horariosLivresDaOrg(clienteFalso(tabelas(true), true), ORG, {
      eventTypeId: TIPO_ID,
      ownerUserId: DONO,
      de: DE,
      ate: ATE,
      agora: AGORA,
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    // Mesma lista do caso anterior, com o cliente de sessão enxergando o evento:
    // a resposta não muda com quem pergunta.
    expect(resultado.slots.map((s) => s.inicio.toISOString())).toEqual([
      "2026-09-17T00:30:00.000Z",
    ]);
  });

  it("controle: sem compromisso no Google o horário das 21:00 é oferecido", async () => {
    const resultado = await horariosLivresDaOrg(clienteFalso(tabelas(false), false), ORG, {
      eventTypeId: TIPO_ID,
      ownerUserId: DONO,
      de: DE,
      ate: ATE,
      agora: AGORA,
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    // Sem esta metade, o teste acima passaria por "a grade nunca oferece nada".
    expect(resultado.slots.map((s) => s.inicio.toISOString())).toContain(
      "2026-09-17T00:00:00.000Z",
    );
  });
  it("a leitura das CONEXÕES também sai pela função: o Atendente vê a agenda do dono que nunca foi lida", async () => {
    // A segunda RPC (`fn_agenda_conexoes_google_do_dono`) alimenta o sinal
    // `agendaExternaNuncaLida`. Pela SESSÃO, o Atendente não enxerga a conexão:
    // a lista viria vazia e o sinal diria "não há agenda externa" — a mesma
    // cegueira do #879, só que no aviso em vez da ocupação. Sem este caso, voltar
    // a leitura para `from("calendar_connections")` deixava a suíte verde
    // (medido pelo cético do lote 10: 21 arquivos, 198 casos).
    const t = tabelas(false);
    const [conexao] = t.calendar_connections ?? [];
    expect(conexao, "o cenário precisa de uma conexão do dono").toBeDefined();
    t.calendar_connections = [{ ...conexao, last_sync_at: null }];
    const resultado = await horariosLivresDaOrg(clienteFalso(t, false), ORG, {
      eventTypeId: TIPO_ID,
      ownerUserId: DONO,
      de: DE,
      ate: ATE,
      agora: AGORA,
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.agendaExternaNuncaLida).toBe(true);
  });
});
