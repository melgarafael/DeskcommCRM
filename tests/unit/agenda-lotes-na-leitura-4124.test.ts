import { afterEach, describe, expect, it, vi } from "vitest";

import { protecaoAgendaSupabase, protecaoDaAgenda } from "@/lib/agenda/protecao-followup";
import { IDS_POR_LOTE } from "@/lib/supabase/em-lotes";
import { logger } from "@/lib/logger";

/**
 * #4124 — `.in("contact_id", …)` SEM LOTES DERRUBA A PROTEÇÃO DE AGENDA.
 *
 * O PostgREST devolve a URL inteira no header `Content-Location`: com ~430
 * uuids a URL passa de 16 KB e o `fetch` morre com `UND_ERR_HEADERS_OVERFLOW`
 * antes de ler o corpo. O `catch` transformava isso em `leitura_indisponivel`
 * para TODO contato, a cada rodada — o `risk-watcher` parou numa instalação de
 * 507 contatos abertos e o radar nunca mais atualizou.
 *
 * O banco falso APLICA os filtros (org, contact_id, status, keyset). Um dublê
 * que os ignorasse passaria com ou sem o conserto, e é justamente o tamanho da
 * lista que este arquivo mede.
 */

const ORG = "11111111-1111-1111-1111-111111111111";
const OUTRA_ORG = "22222222-2222-2222-2222-222222222222";
const AGORA = new Date("2026-11-05T12:00:00.000Z");

type Agendamento = {
  id: string;
  organization_id: string;
  contact_id: string | null;
  revision: number;
  starts_at: string;
  ends_at: string;
  status: string;
};

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const dentroDeUmaHora = (n: number) => ({
  starts_at: new Date(AGORA.getTime() + 30 * 60_000).toISOString(),
  ends_at: new Date(AGORA.getTime() + 60 * 60_000).toISOString(),
  status: "confirmed",
  revision: 1,
  __n: n,
});

function agendamento(contactId: string, n: number, org = ORG): Agendamento {
  return {
    id: String(n).padStart(6, "0"),
    organization_id: org,
    contact_id: contactId,
    ...dentroDeUmaHora(n),
  };
}

type Consulta = { tabela: string; org: string | null; ids: string[]; depois: string | null };

function bancoFalso(config: {
  agendamentos?: Agendamento[];
  settings?: unknown;
  capa?: number;
  falharLote?: (ids: string[]) => boolean;
}) {
  const consultas: Consulta[] = [];
  let emVoo = 0;
  let pico = 0;
  const agendamentos = config.agendamentos ?? [];

  const db = {
    from(tabela: string) {
      const filtros: { org: string | null; ids: string[]; status: string[] } = {
        org: null,
        ids: [],
        status: [],
      };
      let depois: string | null = null;
      const cadeia = {
        select: () => cadeia,
        eq: (coluna: string, valor: unknown) => {
          if (coluna === "organization_id") filtros.org = String(valor);
          return cadeia;
        },
        in: (coluna: string, valores: unknown[]) => {
          if (coluna === "contact_id") filtros.ids = valores as string[];
          if (coluna === "status") filtros.status = valores as string[];
          return cadeia;
        },
        order: () => cadeia,
        limit: () => cadeia,
        gt: (_coluna: string, valor: string) => {
          depois = valor;
          return cadeia;
        },
        single: async () => ({ data: { settings: config.settings ?? {} }, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          if (tabela === "organizations") {
            return Promise.resolve({ data: { settings: config.settings ?? {} }, error: null }).then(
              resolve,
            );
          }
          consultas.push({ tabela, org: filtros.org, ids: [...filtros.ids], depois });
          emVoo += 1;
          pico = Math.max(pico, emVoo);
          const deveFalhar = config.falharLote?.(filtros.ids) ?? false;
          const linhas = agendamentos
            .filter((a) => a.organization_id === filtros.org)
            .filter((a) => a.contact_id !== null && filtros.ids.includes(a.contact_id))
            .filter((a) => filtros.status.length === 0 || filtros.status.includes(a.status))
            .filter((a) => depois === null || a.id > depois)
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, config.capa ?? 500);
          // Um tick de verdade para as consultas conviverem: o teto de lotes em
          // voo só é observável se o `await` não resolver na mesma microtask.
          return new Promise((r) => setTimeout(r, 1))
            .then(() => {
              emVoo -= 1;
              return deveFalhar
                ? { data: null, error: { message: "lote indisponível" } }
                : { data: linhas, error: null };
            })
            .then(resolve);
        },
      };
      return cadeia;
    },
  };

  return {
    db: db as never,
    consultas: () => consultas,
    consultasDaAgenda: () => consultas.filter((c) => c.tabela === "calendar_appointments"),
    picoEmVoo: () => pico,
  };
}

/** O que a leitura deveria devolver, contato a contato, sem lote nenhum. */
function esperado(contatos: string[], agendamentos: Agendamento[], settings: unknown = {}) {
  return new Map(
    contatos.map((id) => [
      id,
      protecaoDaAgenda(
        agendamentos.filter((a) => a.contact_id === id),
        settings,
        AGORA,
      ),
    ]),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("protecaoAgendaSupabase — .in() em lotes (#4124)", () => {
  it.each([430, 1000, 5000])(
    "%i contatos: nenhuma consulta leva mais que IDS_POR_LOTE ids e ninguém fica de fora",
    async (volume) => {
      const contatos = Array.from({ length: volume }, (_, n) => uuid(n));
      const agendamentos = contatos.map((c, n) => agendamento(c, n + 1));
      const banco = bancoFalso({ agendamentos });
      const protecoes = await protecaoAgendaSupabase(banco.db, ORG, contatos, AGORA);

      const consultas = banco.consultasDaAgenda();
      // Uma consulta por LOTE (mais a página vazia que prova o fim de cada
      // lote), não uma por contato (N+1) nem uma com todos.
      const lotes = new Set(consultas.map((c) => c.ids.join(",")));
      expect(lotes.size).toBe(Math.ceil(volume / IDS_POR_LOTE));
      expect(consultas.length).toBeLessThanOrEqual(2 * lotes.size);
      for (const consulta of consultas) {
        expect(consulta.ids.length).toBeLessThanOrEqual(IDS_POR_LOTE);
      }
      // Cobertura exata: cada contato em UM lote, sem repetir e sem sobrar.
      const vistos = [...new Set(consultas.flatMap((c) => c.ids))];
      expect(vistos).toHaveLength(volume);
      expect(new Set(vistos)).toEqual(new Set(contatos));
      // O resultado é o de sempre, contato a contato.
      expect(protecoes).toEqual(esperado(contatos, agendamentos));
      expect([...protecoes.values()].every((p) => p.adiar)).toBe(true);
    },
  );

  it("a URL de cada lote cabe no teto com folga (modelo medido: 249 B fixos + 39 B por uuid)", () => {
    // 4.149 B medidos para 100 uuids, contra 8.192 B do gateway e 16.384 B do
    // header do Node. Este teste trava o teto por BYTES, não por contagem: se
    // alguém subir `IDS_POR_LOTE`, ele reprova aqui antes de estourar em produção.
    const bytes = 249 + 39 * IDS_POR_LOTE;
    expect(bytes).toBeLessThan(8_192);
    expect(bytes).toBeLessThan(16_384);
  });

  it("10 contatos (caminho comum): duas consultas de agenda (a página + a prova de fim), como antes", async () => {
    const contatos = Array.from({ length: 10 }, (_, n) => uuid(n));
    const agendamentos = contatos.map((c, n) => agendamento(c, n + 1));
    const banco = bancoFalso({ agendamentos });

    const protecoes = await protecaoAgendaSupabase(banco.db, ORG, contatos, AGORA);

    // Exatamente o que a versão de antes fazia para uma lista pequena: a
    // primeira página com TODOS os ids e a segunda, vazia, fechando o keyset.
    expect(banco.consultasDaAgenda()).toHaveLength(2);
    expect(banco.consultasDaAgenda()[0]!.ids).toEqual(contatos);
    expect(banco.consultasDaAgenda()[1]!.depois).toBe("000010");
    expect(protecoes).toEqual(esperado(contatos, agendamentos));
  });

  it("lista vazia não faz requisição nenhuma", async () => {
    const banco = bancoFalso({});
    const protecoes = await protecaoAgendaSupabase(banco.db, ORG, [], AGORA);
    expect(protecoes.size).toBe(0);
    expect(banco.consultas()).toHaveLength(0);
  });

  it("lote que falha adia QUEM ESTAVA NELE e não contamina os outros lotes", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const contatos = Array.from({ length: 250 }, (_, n) => uuid(n));
    const agendamentos = contatos.map((c, n) => agendamento(c, n + 1));
    const doLoteQueFalha = contatos.slice(100, 200);
    const banco = bancoFalso({
      agendamentos,
      falharLote: (ids) => ids.includes(doLoteQueFalha[0]!),
    });

    const protecoes = await protecaoAgendaSupabase(banco.db, ORG, contatos, AGORA);

    // O risco real desta mudança: falha de LEITURA virando liberação de envio.
    for (const id of doLoteQueFalha) {
      expect(protecoes.get(id)).toMatchObject({ adiar: true, motivo: "leitura_indisponivel" });
    }
    // Nenhum contato do lote que falhou pode ser lido como "sem compromisso".
    expect(
      doLoteQueFalha.some((id) => protecoes.get(id)?.motivo === "sem_compromisso"),
    ).toBe(false);
    // Os outros dois lotes seguem com a proteção de verdade.
    const esperadoSemFalha = esperado(contatos, agendamentos);
    for (const id of [...contatos.slice(0, 100), ...contatos.slice(200)]) {
      expect(protecoes.get(id)).toEqual(esperadoSemFalha.get(id));
      expect(protecoes.get(id)).toMatchObject({ adiar: true, motivo: "agendado" });
    }
    // Um aviso por leitura (com a causa), não 100 linhas iguais.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[agenda] proteção indisponível; cobrança adiada",
      expect.objectContaining({ lotes_com_falha: 1, contatos_adiados: 100, error: "lote indisponível" }),
    );
  });

  it("outra organização fica intacta: o filtro de org vai em cada lote", async () => {
    const contatos = Array.from({ length: 150 }, (_, n) => uuid(n));
    const meus = contatos.map((c, n) => agendamento(c, n + 1));
    // Mesmos contact_id, mas de OUTRA organização: não podem proteger ninguém.
    const alheios = contatos.map((c, n) => agendamento(c, n + 1001, OUTRA_ORG));
    const banco = bancoFalso({ agendamentos: [...meus, ...alheios] });

    const protecoes = await protecaoAgendaSupabase(banco.db, ORG, contatos, AGORA);

    expect(banco.consultasDaAgenda().every((c) => c.org === ORG)).toBe(true);
    expect(protecoes).toEqual(esperado(contatos, meus));
    // Cada contato tem UM compromisso protetor: o da minha org, contado uma vez.
    expect([...protecoes.values()].filter((p) => p.adiar)).toHaveLength(150);
  });

  it("página truncada é lida até vazio DENTRO do lote (keyset preservado)", async () => {
    const contatos = Array.from({ length: 150 }, (_, n) => uuid(n));
    const doSegundoLote = contatos[140]!;
    const agendamentos = [
      ...contatos.map((c, n) => agendamento(c, n + 1)),
      // 300 compromissos antigos do mesmo contato: só a página VAZIA prova o fim.
      ...Array.from({ length: 300 }, (_, n) => ({
        ...agendamento(doSegundoLote, 2000 + n),
        starts_at: new Date(AGORA.getTime() - 48 * 60 * 60_000).toISOString(),
        ends_at: new Date(AGORA.getTime() - 47 * 60 * 60_000).toISOString(),
        status: "confirmed",
      })),
    ];
    const banco = bancoFalso({ agendamentos, capa: 127 });

    const protecoes = await protecaoAgendaSupabase(banco.db, ORG, contatos, AGORA);

    const doLoteTruncado = banco
      .consultasDaAgenda()
      .filter((c) => c.ids.includes(doSegundoLote));
    // 301 linhas com teto de 127 por página: 127 + 127 + 47 + vazia.
    expect(doLoteTruncado).toHaveLength(4);
    expect(protecoes.get(doSegundoLote)).toEqual(
      esperado([doSegundoLote], agendamentos).get(doSegundoLote),
    );
  });

  it("lotes em paralelo com teto: 5.000 contatos não disparam 50 consultas de uma vez", async () => {
    const contatos = Array.from({ length: 5000 }, (_, n) => uuid(n));
    const banco = bancoFalso({ agendamentos: [] });

    await protecaoAgendaSupabase(banco.db, ORG, contatos, AGORA);

    expect(banco.consultasDaAgenda()).toHaveLength(50);
    expect(banco.picoEmVoo()).toBeGreaterThan(1); // não é sequencial
    expect(banco.picoEmVoo()).toBeLessThanOrEqual(4); // e não é uma rajada de 50
  });
});
