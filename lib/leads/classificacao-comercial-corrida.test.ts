/**
 * #4191, item 4 — A CORRIDA entre a leitura e a escrita da classificação.
 *
 * O defeito medido pelo mantenedor (comentário de 17/11 no PR #4195): o UPDATE
 * de classificar só exigia `nao_comercial_em is null`; o `status` era lido na
 * linha 128 e NÃO entrava no filtro da gravação. Um negócio fechado (ganho ou
 * perdido) entre a leitura e a escrita era classificado assim mesmo, e o
 * classificado ficava com `status = 'won'` — estado que a própria régua pura
 * recusa (`negocio_encerrado`). No reverter era pior: o filtro só pedia
 * `nao_comercial_em is not null`, então uma reversão atrasada apagava uma
 * classificação MAIS NOVA que chegou no meio.
 *
 * ─── Como a corrida é reproduzida aqui, sem depender de tempo ───────────────
 *
 * Um banco falso com UMA linha compartilhada. Cada `cliente()` é uma sessão
 * separada, como dois navegadores: filtra a linha ATUAL no instante da escrita,
 * não a que leu. O gancho `aoLer` comita a escrita da outra sessão entre a
 * leitura e a escrita da primeira — a janela exata que o defeito explorava, e
 * determinística (nada de sleep, nada de sorte).
 *
 * O que se prova: a sessão que perdeu a corrida NÃO grava, NÃO mente dizendo
 * que deu certo, e a linha fica com o estado que a outra sessão comitou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import {
  classificaNegocioComoNaoComercial,
  reverteClassificacaoNaoComercial,
} from "./classificacao-comercial";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn() }));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const ATOR = "11111111-1111-4111-8111-111111111111";
const T1 = "2026-11-18T10:00:00.000Z";
const T2 = "2026-11-18T10:05:00.000Z";

type Linha = Record<string, unknown>;
type Filtro = { op: "eq" | "is" | "not"; coluna: string; valor: unknown };

/**
 * O filtro como o PostgREST o aplica: contra a linha do instante da escrita.
 * `nao_comercial_em` do banco é `timestamptz`; aqui comparamos o texto ISO que
 * a sessão leu, que é o que o cliente devolve e o que a escrita reenvia.
 */
function casa(linha: Linha, filtros: Filtro[]): boolean {
  return filtros.every((f) => {
    const atual = linha[f.coluna] ?? null;
    if (f.op === "eq") return atual === f.valor;
    if (f.op === "is") return f.valor === null ? atual === null : atual === f.valor;
    // `not(coluna, "is", null)` = a coluna está preenchida.
    return f.valor === null ? atual !== null : atual === f.valor;
  });
}

function banco(linhaInicial: Linha) {
  const estado = { linha: { ...linhaInicial }, escritas: 0, filtrosDaEscrita: [] as Filtro[][] };
  // Gancho: roda DEPOIS da leitura e ANTES da escrita. É onde a outra sessão
  // comita.
  let aposALeitura: (() => void) | null = null;

  function cliente(): SupabaseClient {
    let alvo: "leitura" | "escrita" | null = null;
    let patch: Linha | null = null;
    let filtros: Filtro[] = [];
    const api = {
      from: () => {
        alvo = null;
        patch = null;
        filtros = [];
        return api;
      },
      select: () => {
        if (alvo === null) alvo = "leitura";
        return api;
      },
      update: (p: Linha) => {
        alvo = "escrita";
        patch = p;
        return api;
      },
      eq: (coluna: string, valor: unknown) => {
        filtros.push({ op: "eq", coluna, valor });
        return api;
      },
      is: (coluna: string, valor: unknown) => {
        filtros.push({ op: "is", coluna, valor });
        return api;
      },
      not: (coluna: string, _operador: string, valor: unknown) => {
        filtros.push({ op: "not", coluna, valor });
        return api;
      },
      maybeSingle: async () => {
        if (alvo === "leitura") {
          // A FOTO é tirada ANTES do gancho: é o que a sessão A viu. O gancho
          // roda logo depois, e é onde a outra sessão comita — ou seja, entre o
          // SELECT e o UPDATE de A, que é a janela que o defeito explorava.
          const lida = { ...estado.linha };
          aposALeitura?.();
          return { data: lida, error: null };
        }
        estado.filtrosDaEscrita.push([...filtros]);
        if (!casa(estado.linha, filtros)) return { data: null, error: null };
        estado.linha = { ...estado.linha, ...patch };
        estado.escritas += 1;
        return { data: { ...estado.linha }, error: null };
      },
    };
    return api as unknown as SupabaseClient;
  }

  /**
   * A leitura devolve a linha e, no MESMO tique, comita a escrita da outra
   * sessão. Não dá para disparar do `maybeSingle` async e esperar: o módulo
   * faria a escrita antes. Por isso o gancho entra por `Promise.resolve().then`
   * logo após o valor — a microtarefa roda antes da continuação do `await` do
   * módulo, que é exatamente a ordem de um commit concorrente.
   */
  function aoLer(fn: () => void) {
    aposALeitura = fn;
  }

  return { estado, cliente, aoLer };
}

const aberto = (extra: Linha = {}): Linha => ({
  id: LEAD,
  organization_id: ORG,
  contact_id: "44444444-4444-4444-8444-444444444444",
  status: "open",
  nao_comercial_em: null,
  nao_comercial_motivo: null,
  nao_comercial_por: null,
  ...extra,
});

beforeEach(() => {
  vi.mocked(emitLeadActivity).mockReset().mockResolvedValue({ ok: true } as never);
  vi.mocked(audit).mockReset().mockResolvedValue(undefined);
});

describe("#4191 item 4 — classificar é compare-and-set", () => {
  it("não classifica um negócio que foi FECHADO entre a leitura e a escrita", async () => {
    const b = banco(aberto());
    // A sessão A leu `status: 'open'`. Antes de gravar, a sessão B fecha o
    // negócio como ganho.
    b.aoLer(() => {
      b.estado.linha = { ...b.estado.linha, status: "won", closed_at: T1 };
    });

    const r = await classificaNegocioComoNaoComercial(b.cliente(), {
      organizationId: ORG,
      leadId: LEAD,
      motivo: "golpe",
      actorUserId: ATOR,
      requestId: "req-corrida-1",
    });

    // O veredito: recusa explícita, não "deu certo" silencioso.
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("classificou um negócio que a outra sessão fechou");
    expect(r.codigo).toBe("negocio_encerrado");
    expect(r.httpStatus).toBe(409);

    // E a linha continua como a outra sessão deixou.
    expect(b.estado.linha.status).toBe("won");
    expect(b.estado.linha.nao_comercial_em).toBeNull();
    expect(b.estado.escritas).toBe(0);

    // A timeline não recebeu linha de uma classificação que não aconteceu.
    expect(emitLeadActivity).not.toHaveBeenCalled();
  });

  it("o filtro da escrita exige o MESMO status que a leitura viu", async () => {
    const b = banco(aberto());
    await classificaNegocioComoNaoComercial(b.cliente(), {
      organizationId: ORG,
      leadId: LEAD,
      motivo: "golpe",
      actorUserId: ATOR,
      requestId: "req-corrida-1b",
    });
    const filtros = b.estado.filtrosDaEscrita.at(-1) ?? [];
    expect(filtros).toEqual(
      expect.arrayContaining([
        { op: "is", coluna: "nao_comercial_em", valor: null },
        { op: "eq", coluna: "status", valor: "open" },
      ]),
    );
  });
});

describe("#4191 item 4 — reverter é compare-and-set", () => {
  const classificado = (quando: string): Linha =>
    aberto({ nao_comercial_em: quando, nao_comercial_motivo: "spam", nao_comercial_por: ATOR });

  it("não apaga uma classificação MAIS NOVA que chegou entre a leitura e a escrita", async () => {
    const b = banco(classificado(T1));
    // A sessão A leu a classificação de T1. A sessão B REVERTEU e
    // RECLASSIFICOU (T2) antes de A gravar — o ciclo A-B-A.
    b.aoLer(() => {
      b.estado.linha = {
        ...b.estado.linha,
        nao_comercial_em: T2,
        nao_comercial_motivo: "sem finalidade comercial",
        nao_comercial_por: "55555555-5555-4555-8555-555555555555",
      };
    });

    const r = await reverteClassificacaoNaoComercial(b.cliente(), {
      organizationId: ORG,
      leadId: LEAD,
      actorUserId: ATOR,
      requestId: "req-corrida-2",
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("a reversão atrasada apagou a classificação nova");
    expect(r.codigo).toBe("classificacao_conflitante");
    expect(r.httpStatus).toBe(409);

    // A classificação de T2 está de pé.
    expect(b.estado.linha.nao_comercial_em).toBe(T2);
    expect(b.estado.linha.nao_comercial_motivo).toBe("sem finalidade comercial");
    expect(emitLeadActivity).not.toHaveBeenCalled();
  });

  it("o filtro da reversão exige a classificação EXATA que a leitura viu", async () => {
    const b = banco(classificado(T1));
    await reverteClassificacaoNaoComercial(b.cliente(), {
      organizationId: ORG,
      leadId: LEAD,
      actorUserId: ATOR,
      requestId: "req-corrida-2b",
    });
    const filtros = b.estado.filtrosDaEscrita.at(-1) ?? [];
    expect(filtros).toEqual(
      expect.arrayContaining([{ op: "eq", coluna: "nao_comercial_em", valor: T1 }]),
    );
  });

  it("reversão repetida num negócio já comercial continua idempotente (não é corrida)", async () => {
    const b = banco(aberto());
    const r = await reverteClassificacaoNaoComercial(b.cliente(), {
      organizationId: ORG,
      leadId: LEAD,
      actorUserId: ATOR,
      requestId: "req-corrida-3",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("reversão de negócio comercial não é erro");
    expect(r.jaEstava).toBe(true);
    expect(b.estado.escritas).toBe(0);
  });
});
