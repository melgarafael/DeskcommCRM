/**
 * A TELA DA AGENDA E O MOTOR DE DISPONIBILIDADE CONCORDAM SOBRE O COMPROMISSO
 * QUE ATRAVESSA O LIMITE DO RECORTE (#525).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * A ocupação do Google que a tela mostra vinha de uma comparação INGÊNUA de
 * limites (`starts_at >= de AND starts_at < ate` — o compromisso só aparecia se
 * COMEÇASSE dentro do recorte). O motor de disponibilidade
 * (`fn_agenda_ocupacao_google_do_dono` e `coletaOQueOcupa`) usa INTERSEÇÃO de
 * intervalos (`starts_at < ate AND ends_at > de`). Um compromisso que atravessa
 * o limite do recorte — 23:30 de ontem até 00:30 de hoje, pedindo a agenda de
 * HOJE — ocupava no motor e não existia na tela: a grade mostrava livre o
 * horário que a marcação recusa, e quem atende só descobria no erro.
 *
 * ─── O que este arquivo prende ──────────────────────────────────────────────
 *
 * 1. A leitura da tela (`lerOcupacaoExterna`) DEVOLVE o compromisso que
 *    atravessa o limite, já fatiado no recorte: é o que faz a grade desenhá-lo
 *    na coluna do dia (o componente atribui o bloco pelo início).
 * 2. O motor, sobre as MESMAS linhas, já recusava o horário — os dois lados
 *    passam a dizer a mesma coisa. Sem a segunda metade, "a tela mostra o
 *    compromisso" passaria com uma tela que mostra demais.
 * 3. O limite é ESTRITO dos dois lados: compromisso que ACABA exatamente no
 *    começo do recorte não ocupa minuto nenhum dele; `transparent` (livre no
 *    Google) e `cancelled` não viram bloco.
 *
 * ─── Como mede ──────────────────────────────────────────────────────────────
 *
 * Banco em memória que APLICA os filtros de verdade (`eq`, `neq`, `gte`, `lt`,
 * `gt`, `order` e o embed `calendar_connections.user_id` resolvido por caminho,
 * como o PostgREST faz) e as RPCs da migration 0260 com o corpo SQL que elas
 * têm — o mesmo dublê de `tests/unit/agenda-ocupacao-do-google-do-dono.test.ts`.
 * Dublê que ignorasse filtro mediria o dublê, não o recorte.
 *
 *     npx vitest run tests/unit/agenda-recorte-do-google-atravessa-o-limite.test.ts
 *
 * ─── O que este arquivo NÃO mede (declarado, não estimado) ──────────────────
 *
 * 1. **A grade desenhada.** O que se mede aqui é a LEITURA (o bloco sai com a
 *    fatia certa). O desenho da coluna do dia e o arraste ficam com
 *    `tests/unit/agenda-grade-*.test.*` e com o e2e
 *    (`tests/e2e/agenda-grade-interativa.spec.ts`, `pnpm test:e2e`, que sobe o
 *    app e não roda nesta máquina).
 * 2. **A rota por HTTP.** A rota e a semente consomem esta mesma leitura; o
 *    caminho HTTP exigiria a sessão (`getUser`/`resolveActiveOrg`) e não é
 *    medido aqui.
 * 3. **A RPC de verdade.** O dublê repete o corpo SQL da função; quem mede o
 *    Postgres é `tests/invariants/agenda-ocupacao-google-do-dono.test.ts`
 *    (`pnpm test:db`).
 * 4. **Evento de vários dias dentro do recorte.** Neste arquivo a fatia é a do
 *    LIMITE do recorte. A propagação de um compromisso longo para todas as
 *    colunas de dias que ele atravessa DENTRO do recorte é decisão da grade e
 *    segue como está — não medida aqui.
 */
import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

const { horariosLivresDaOrg } = await import("@/lib/agenda/consulta");
const { lerOcupacaoExterna } = await import("@/lib/agenda/ocupacao-externa");

const TZ = "America/Sao_Paulo";
const ORG = "org-1";
const DONO = "dono-1";
const TIPO_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Terça, 15/09/2026, 23:30 em São Paulo (02:30Z do dia 16) até 00:30 do dia 16 em
 * São Paulo (03:30Z). O compromisso ATRAVESSA a virada do dia.
 */
const EVENTO_QUE_ATRAVESSA = {
  starts_at: "2026-09-16T02:30:00.000Z",
  ends_at: "2026-09-16T03:30:00.000Z",
};

/** O recorte da TELA do dia 16/09 em São Paulo: 00:00 local = 03:00Z. */
const RECORTE = {
  de: "2026-09-16T03:00:00.000Z",
  ate: "2026-09-17T03:00:00.000Z",
};

/** A fatia do compromisso dentro do recorte: 00:00–00:30 locais. */
const FATIA = {
  de: "2026-09-16T03:00:00.000Z",
  ate: "2026-09-16T03:30:00.000Z",
};

/** O relógio é fixo: a grade desconta aviso mínimo e janela de reserva a partir de AGORA. */
const AGORA = new Date("2026-09-14T12:00:00.000Z");

interface Linha {
  [coluna: string]: unknown;
}

/**
 * O valor da coluna, resolvendo CAMINHO COM PONTO — que é o que o PostgREST faz
 * na relação embutida (`calendar_connections.user_id` do `!inner`).
 */
const valorDaColuna = (linha: Linha, coluna: string): unknown =>
  coluna.split(".").reduce<unknown>((acc, parte) => (acc as Linha | undefined)?.[parte], linha);

type Filtro = (linha: Linha) => boolean;

/**
 * Um `SupabaseClient` de mentira que FILTRA de verdade: aplica `eq`, `neq`,
 * `gte`, `lt` e `gt` sobre linhas em memória. A leitura da tela usa os cinco —
 * um dublê que ignorasse `gt` deixaria a solução certa passar pelo motivo
 * errado, e um que ignorasse `neq` traria `transparent` como ocupação.
 */
function clienteFalso(tabelas: Record<string, Linha[]>): SupabaseClient {
  function daTabela(tabela: string) {
    const filtros: Filtro[] = [];
    const linhas = () => (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    const compara = (coluna: string, valor: unknown, ok: (a: string, b: string) => boolean) => {
      filtros.push((l) => ok(String(valorDaColuna(l, coluna)), String(valor)));
      return api;
    };
    const api = {
      select: () => api,
      // `order` não muda o conjunto; a ordem aqui é de tela, não de regra.
      order: () => api,
      eq: (coluna: string, valor: unknown) => {
        filtros.push((l) => valorDaColuna(l, coluna) === valor);
        return api;
      },
      neq: (coluna: string, valor: unknown) => {
        filtros.push((l) => valorDaColuna(l, coluna) !== valor);
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

  /**
   * As RPCs da migration 0260, com o corpo SQL que elas têm. A ocupação do
   * Google é `starts_at < p_ate AND ends_at > p_de` — INTERSEÇÃO de intervalos.
   * É a referência contra a qual a leitura da tela é conferida.
   */
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

interface EventoDoGoogle {
  id: string;
  starts_at: string;
  ends_at: string;
  transparency?: string;
  status?: string;
}

/**
 * As tabelas que as duas leituras usam. A jornada cobre o DIA INTEIRO
 * (00:00–23:00) de propósito: é o que deixa o horário da virada existir na
 * grade, para o motor poder recusá-lo por causa do compromisso — e não por
 * causa do expediente.
 */
function tabelas(eventosDoGoogle: EventoDoGoogle[]): Record<string, Linha[]> {
  const conexao = {
    organization_id: ORG,
    user_id: DONO,
    status: "connected",
    last_sync_at: "2026-09-14T11:00:00.000Z",
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
    attendant_availability: [
      {
        organization_id: ORG,
        user_id: DONO,
        schedule: {
          timezone: TZ,
          windows: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: "00:00", end: "23:00" })),
        },
      },
    ],
    calendar_availability_exceptions: [],
    calendar_appointments: [],
    calendar_connections: [conexao],
    calendar_selected_external_events: eventosDoGoogle.map((evento) => ({
      organization_id: ORG,
      transparency: "opaque",
      status: "confirmed",
      // O embed `calendar_connections!inner(user_id, status)`, como o PostgREST
      // entrega. É por este caminho que a leitura da tela acha o dono.
      calendar_connections: { user_id: DONO, status: "connected" },
      ...evento,
    })),
  };
}

describe("a tela mostra — e o motor já recusava — o compromisso que atravessa o limite do recorte", () => {
  it("o compromisso de 23:30 até 00:30 aparece na tela do dia seguinte, fatiado no recorte", async () => {
    const leitura = await lerOcupacaoExterna(clienteFalso(tabelas([{ id: "ev-1", ...EVENTO_QUE_ATRAVESSA }])), {
      organizationId: ORG,
      de: RECORTE.de,
      ate: RECORTE.ate,
    });

    expect(leitura.erro).toBeNull();
    // Antes do conserto esta lista vinha VAZIA: o compromisso começa antes do
    // recorte, e a consulta perguntava só pelo começo.
    expect(leitura.blocos).toEqual([
      { id: "ev-1", donoId: DONO, iniciaEm: FATIA.de, terminaEm: FATIA.ate },
    ]);
  });

  it("o motor de disponibilidade recusa a vaga das 00:00 locais sobre o MESMO compromisso", async () => {
    const resultado = await horariosLivresDaOrg(
      clienteFalso(tabelas([{ id: "ev-1", ...EVENTO_QUE_ATRAVESSA }])),
      ORG,
      {
        eventTypeId: TIPO_ID,
        ownerUserId: DONO,
        de: new Date("2026-09-16T03:00:00.000Z"),
        ate: new Date("2026-09-16T04:00:00.000Z"),
        agora: AGORA,
      },
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    const oferecidas = resultado.slots.map((s) => s.inicio.toISOString());
    // 00:00 local está em cima do compromisso que veio de ontem: recusada.
    expect(oferecidas).not.toContain("2026-09-16T03:00:00.000Z");
    // E a vaga seguinte é oferecida — sem esta metade, "recusa tudo" passaria.
    expect(oferecidas).toContain("2026-09-16T03:30:00.000Z");
  });

  it("limite ESTRITO: compromisso que acaba no começo do recorte não ocupa, e transparent/cancelled não viram bloco", async () => {
    const leitura = await lerOcupacaoExterna(
      clienteFalso(
        tabelas([
          // Termina EXATAMENTE no começo do recorte (22:30–00:00 locais de 16/09).
          { id: "ev-antes", starts_at: "2026-09-16T01:30:00.000Z", ends_at: "2026-09-16T03:00:00.000Z" },
          // Atravessa o limite, mas é "livre" no Google.
          {
            id: "ev-transparente",
            starts_at: "2026-09-16T02:30:00.000Z",
            ends_at: "2026-09-16T03:30:00.000Z",
            transparency: "transparent",
          },
          // Atravessa o limite, mas foi cancelado.
          {
            id: "ev-cancelado",
            starts_at: "2026-09-16T02:30:00.000Z",
            ends_at: "2026-09-16T03:30:00.000Z",
            status: "cancelled",
          },
        ]),
      ),
      { organizationId: ORG, de: RECORTE.de, ate: RECORTE.ate },
    );

    expect(leitura.blocos).toEqual([]);
  });

  it("CONTROLE: o compromisso que começa DEPOIS do recorte continua fora", async () => {
    // Por que este caso existe: a catraca do conserto era de UM caso só. O caso
    // do limite estrito acima devolve `[]` também com o filtro ingênuo de volta
    // (`starts_at >= de`) — ali os três eventos saem por outro motivo —, e o do
    // motor nem passa por `lerOcupacaoExterna`. Este mede EXCLUSÃO pelo lado
    // oposto: o filtro ingênuo devolveria este evento (ele COMEÇA dentro da
    // janela ingênua? não — começa depois do fim), e a interseção também o
    // exclui. É o controle que impede "recusa tudo" de passar por acerto.
    const leitura = await lerOcupacaoExterna(
      clienteFalso(
        tabelas([
          {
            id: "ev-depois",
            starts_at: "2026-09-17T04:00:00.000Z",
            ends_at: "2026-09-17T05:00:00.000Z",
          },
        ]),
      ),
      { organizationId: ORG, de: RECORTE.de, ate: RECORTE.ate },
    );

    expect(leitura.erro).toBeNull();
    expect(leitura.blocos).toEqual([]);
  });

  it("CONTROLE: o compromisso INTEIRAMENTE dentro do recorte sai com os instantes CRUS", async () => {
    // A fatia é do LIMITE, não de todo bloco. Sem este caso, `iniciaEm: de` e
    // `terminaEm: ate` fixos — que achatariam TODO compromisso no recorte
    // inteiro — passariam nos outros casos, porque neles a fatia COINCIDE com a
    // borda. Aqui ela não coincide, e é isso que distingue as duas contas.
    const leitura = await lerOcupacaoExterna(
      clienteFalso(
        tabelas([
          {
            id: "ev-dentro",
            starts_at: "2026-09-16T15:00:00.000Z",
            ends_at: "2026-09-16T16:00:00.000Z",
          },
        ]),
      ),
      { organizationId: ORG, de: RECORTE.de, ate: RECORTE.ate },
    );

    expect(leitura.erro).toBeNull();
    expect(leitura.blocos).toEqual([
      {
        id: "ev-dentro",
        donoId: DONO,
        iniciaEm: "2026-09-16T15:00:00.000Z",
        terminaEm: "2026-09-16T16:00:00.000Z",
      },
    ]);
  });

  // ⚠️ O PONTO DE USO não é medido aqui: quem prova que a tela e a rota leem
  // DESTE módulo — e que nenhum outro arquivo de `app/` ou `lib/agenda/` abre a
  // view por conta própria — é
  // `tests/unit/ocupacao-do-google-vem-de-um-lugar-so.test.ts`, que varre a
  // classe inteira em vez das duas instâncias conhecidas.
});
