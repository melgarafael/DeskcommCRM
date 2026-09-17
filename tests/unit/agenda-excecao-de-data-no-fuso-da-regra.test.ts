import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { horariosLivresDaOrg, type ResultadoDaConsulta } from "@/lib/agenda/consulta";

/**
 * DIA BLOQUEADO NUMA CONSULTA DA NOITE — a exceção de data é do dia LOCAL (#878).
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * A coleta de exceções de data pedia ao banco o intervalo nos DIAS UTC do
 * instante pedido (`toISOString().slice(0, 10)`). Com `America/Sao_Paulo` (-03),
 * 21:00 do dia 16 JÁ É 00:00Z do dia 17: a coleta começava no dia 17 e a exceção
 * do dia 16 (folga, feriado, dia inteiro bloqueado) ficava fora do `.gte()`.
 * Medido na triagem, com o handler de marcação e ator `ai_agent`: exceção de dia
 * inteiro em D, 21:00 local de D → **aceito**.
 *
 * A régua certa é a MESMA de `horariosLivres`: `exception_date` é `date` sem
 * fuso, comparado ao dia local da regra (`leitura.jornada.timezone`).
 *
 * ─── Por que o caso medido aqui é a COLETA, e não o handler ─────────────────
 *
 * A escrita não tem coleta própria: `exigeHorarioLivre`
 * (`app/api/v1/agenda/agendamentos/_handler.ts`) confere o horário pedido pela
 * MESMA `horariosLivresDaOrg` que responde o GET, e recusa com
 * `agenda_horario_indisponivel` quando o início pedido não está entre os slots
 * oferecidos. Consertar a coleta conserta leitura e escrita pela mesma régua —
 * que é o que o cabeçalho daquele arquivo exige em voz alta ("duas coletas
 * divergem no primeiro ajuste").
 *
 * ─── O que este arquivo NÃO mede (declarado, não estimado) ──────────────────
 *
 * 1. **Postgres.** O client é um duble que aplica os filtros sobre linhas em
 *    memória. `exception_date` chega como STRING `YYYY-MM-DD` e a comparação é
 *    lexicográfica — igual ao `date` do Postgres para ISO, mas é igualdade
 *    ARGUMENTADA, não medida em banco (quem mede banco é `pnpm test:db`).
 * 2. **A rota e o handler de escrita.** Nenhum `NextRequest`, nenhum papel,
 *    nenhum insert. Aqui mora a régua; a escrita ponta a ponta tem dono.
 * 3. **O Google.** Nenhuma conexão e nenhum evento externo neste cenário.
 */

/** O fuso da regra. Negativo, que é onde o dia UTC passa na frente do local. */
const TZ = "America/Sao_Paulo";
const ORG = "org-1";
const DONO = "dono-1";
const TIPO_ID = "11111111-1111-4111-8111-111111111111";

/**
 * 21:00 do dia 16 em São Paulo = 00:00Z do dia 17.
 *
 * ⚠️ É A VIRADA. Qualquer asserção deste arquivo que dependa do dia UTC está
 * provando o defeito, não a correção.
 */
const DE = new Date("2026-09-17T00:00:00.000Z");
const ATE = new Date("2026-09-17T00:30:00.000Z");
/** 09:00 local do mesmo dia — antecedência satisfeita, relógio injetado. */
const AGORA = new Date("2026-09-16T12:00:00.000Z");

const DIA_BLOQUEADO = "2026-09-16";
const DIA_SEGUINTE = "2026-09-17";

/**
 * Uma jornada de verdade, com janela em TODOS os dias (09:00–23:00 locais).
 *
 * ⚠️ `windows` VAZIO NÃO SERVE: na AGENDA ele significa "nada publicado ⇒ zero
 * horário", o oposto do mesmo campo em `isWithinSchedule` (roteamento), onde
 * vazio é 24/7. As duas réguas estão documentadas lado a lado em
 * `lib/agenda/horarios-livres.ts` — e uma delas ofereceria consulta às 3 da
 * manhã se fosse unificada. Só com janela publicada a grade existe e a exceção
 * de data tem o que barrar.
 */
const JANELA = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: "09:00", end: "23:00" }));

interface Linha {
  [coluna: string]: unknown;
}

type Filtro = (linha: Linha) => boolean;

/**
 * Um `SupabaseClient` de mentira que FILTRA de verdade.
 *
 * Aplica `eq/gte/lte/lt/gt` sobre as linhas em memória, com comparação de
 * STRING — que é como o PostgREST devolve `date` e como o Postgres compara ISO.
 * Um duble que ignorasse o `.gte()` faria este arquivo passar pelo motivo errado
 * (a exceção entraria na coleta houvesse ou não o filtro), então o próprio duble
 * tem caso de teste abaixo: filtro que não filtra é medido antes de medir.
 */
function clienteFalso(tabelas: Record<string, Linha[]>): SupabaseClient {
  function daTabela(tabela: string) {
    const filtros: Filtro[] = [];
    const linhas = () => (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    const compara = (coluna: string, valor: unknown, ok: (a: string, b: string) => boolean) => {
      filtros.push((l) => ok(String(l[coluna]), String(valor)));
      return api;
    };
    const api = {
      select: () => api,
      eq: (coluna: string, valor: unknown) => {
        filtros.push((l) => l[coluna] === valor);
        return api;
      },
      gte: (coluna: string, valor: unknown) => compara(coluna, valor, (a, b) => a >= b),
      lte: (coluna: string, valor: unknown) => compara(coluna, valor, (a, b) => a <= b),
      lt: (coluna: string, valor: unknown) => compara(coluna, valor, (a, b) => a < b),
      gt: (coluna: string, valor: unknown) => compara(coluna, valor, (a, b) => a > b),
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      // `then` é o que faz `await client.from(...).select(...).eq(...)` resolver a
      // lista — a coleta espera a cadeia dessa forma em quatro consultas.
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: linhas(), error: null }).then(resolve),
    };
    return api;
  }

  return {
    from: (tabela: string) => daTabela(tabela),
    // Aqui não há Google. `fn_google_coverage` responde "não afirma cobertura";
    // as duas leituras do Google do dono (migration 0260) respondem lista vazia —
    // devolver `false` a elas faria a coleta quebrar pelo dublê, não pela regra.
    rpc: async (fn: string) => {
      if (fn === "fn_google_coverage") return { data: false, error: null };
      if (fn === "fn_agenda_ocupacao_google_do_dono" || fn === "fn_agenda_conexoes_google_do_dono") {
        return { data: [], error: null };
      }
      throw new Error(`[duble] rpc não prevista: ${fn}`);
    },
  } as unknown as SupabaseClient;
}

/** As tabelas que a coleta lê, com a exceção de data no dia pedido. */
function tabelas(excecaoEm: string | null): Record<string, Linha[]> {
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
    // A grade do dia vem da jornada publicada (`JANELA`); quem BARRA é a exceção
    // de data — que é o objeto deste arquivo.
    attendant_availability: [
      { organization_id: ORG, user_id: DONO, schedule: { timezone: TZ, windows: JANELA } },
    ],
    calendar_availability_exceptions:
      excecaoEm === null
        ? []
        : [
            {
              organization_id: ORG,
              user_id: DONO,
              exception_date: excecaoEm,
              is_unavailable: true,
              start_minute: 0,
              end_minute: 1440,
            },
          ],
    calendar_appointments: [],
    calendar_connections: [],
    calendar_selected_external_events: [],
  };
}

function consultar(excecaoEm: string | null) {
  return horariosLivresDaOrg(clienteFalso(tabelas(excecaoEm)), ORG, {
    eventTypeId: TIPO_ID,
    ownerUserId: DONO,
    de: DE,
    ate: ATE,
    agora: AGORA,
  });
}

/**
 * A recusa da coleta, EM VOZ ALTA.
 *
 * Um `expect(resultado.ok).toBe(true)` que falha diz só "false não é true", e a
 * rodada seguinte custa uma investigação inteira. O motivo nomeado
 * (`codigo` + `motivoParaOperador`) é o que o próprio módulo já devolve para
 * quem opera — o teste usa a mesma porta.
 */
function exigirOk(resultado: ResultadoDaConsulta) {
  if (!resultado.ok) {
    throw new Error(`a coleta recusou: ${resultado.codigo} — ${resultado.motivoParaOperador}`);
  }
  return resultado;
}

describe("o duble filtra o que diz filtrar", () => {
  it("a faixa em dia UTC (17..17) NÃO alcança a exceção do dia 16", async () => {
    const client = clienteFalso(tabelas(DIA_BLOQUEADO));
    const faixaUtc = await client
      .from("calendar_availability_exceptions")
      .select("exception_date")
      .gte("exception_date", DIA_SEGUINTE)
      .lte("exception_date", DIA_SEGUINTE);
    expect((faixaUtc as unknown as { data: Linha[] }).data).toEqual([]);

    const faixaLarga = await client
      .from("calendar_availability_exceptions")
      .select("exception_date")
      .gte("exception_date", "2026-09-15")
      .lte("exception_date", DIA_SEGUINTE);
    expect((faixaLarga as unknown as { data: Linha[] }).data).toHaveLength(1);
  });
});

describe("exceção de data é buscada no dia local da regra", () => {
  it("dia inteiro bloqueado recusa o horário das 21:00 (00:00Z do dia seguinte)", async () => {
    const resultado = exigirOk(await consultar(DIA_BLOQUEADO));

    // A janela pedida (21:00–21:30 local) cai inteira no dia bloqueado: não
    // pode sobrar slot nenhum. Com a data UTC na coleta sobrava um.
    expect(resultado.slots).toEqual([]);
  });

  it("controle: a exceção do dia SEGUINTE não derruba o horário das 21:00", async () => {
    const resultado = exigirOk(await consultar(DIA_SEGUINTE));

    // Sem esta metade o teste acima passaria por "a grade nunca oferece nada".
    expect(resultado.slots.map((s) => s.inicio.toISOString())).toContain(
      "2026-09-17T00:00:00.000Z",
    );
  });

  it("sem exceção nenhuma o horário das 21:00 é oferecido", async () => {
    const resultado = exigirOk(await consultar(null));

    expect(resultado.slots.map((s) => s.inicio.toISOString())).toContain(
      "2026-09-17T00:00:00.000Z",
    );
  });
});
