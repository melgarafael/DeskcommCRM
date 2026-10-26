/**
 * A PORTA DO SUPABASE — a tradução tem de ser fiel.
 *
 * Os testes de decisão usam uma porta falsa e provam a REGRA. Este arquivo prova
 * a outra metade, que nenhum daqueles alcança: que a linha gravada tem os nomes,
 * os estados e a origem certos.
 *
 * O que se cobra aqui é o que quebra em produção sem quebrar teste nenhum:
 *
 * - a vaga segurada nasce `pending` com `source = 'waitlist'`, senão a tela e a
 *   timeline dizem que alguém marcou quando ninguém marcou;
 * - o instante ocupado por outra marcação vira `vaga_ja_ocupada` (23505) e NÃO
 *   um erro que derruba o cancelamento;
 * - o compromisso que era a vaga segurada de alguém é reconhecido como RECUSA —
 *   senão a mesma vaga volta para a mesma pessoa em laço;
 * - pedir encaixe duas vezes não duplica a pessoa na fila.
 */
import { describe, expect, it } from "vitest";

import {
  aposVagaLiberada,
  fecharEncaixeConfirmado,
  inscreverNaEspera,
} from "@/lib/agenda/encaixe-supabase";

const ORG = "org-1";
const INICIO = "2026-11-03T12:00:00.000Z";
const AGORA = new Date("2026-11-03T09:00:00.000Z");

interface Linha {
  [k: string]: unknown;
}

/**
 * Um Supabase de mentira com o mínimo que a porta usa: `from().select()/insert()/
 * update()` com `eq`, `lte`, `order`, `limit`, `maybeSingle` e `rpc`. O objetivo
 * não é imitar o PostgREST — é gravar as linhas e deixar o teste olhar para elas.
 */
function banco(estado: { appointments?: Linha[]; waitlist?: Linha[]; eventTypes?: Linha[] }) {
  const tabelas: Record<string, Linha[]> = {
    calendar_appointments: estado.appointments ?? [],
    calendar_waitlist: estado.waitlist ?? [],
    calendar_event_types: estado.eventTypes ?? [
      {
        id: "limpeza",
        organization_id: ORG,
        name: "Limpeza",
        duration_minutes: 60,
        minimum_notice_minutes: 0,
        is_active: true,
      },
    ],
  };
  let sequencia = 0;

  type ErroDoBanco = { message: string; code?: string } | null;

  class Consulta implements PromiseLike<{ data: unknown; error: ErroDoBanco }> {
    private filtros: Array<[string, unknown]> = [];
    private pertence: Array<[string, unknown[]]> = [];
    private intervalo: [string, unknown] | null = null;
    private ordem: Array<[string, "asc" | "desc"]> = [];
    private teto: number | null = null;
    private corpo: Linha | null = null;
    private colunas: string | null = null;

    constructor(private tabela: string, private acao: "select" | "insert" | "update") {}

    select(colunas?: string) {
      this.colunas = colunas ?? "*";
      return this;
    }
    insert(corpo: Linha) {
      this.corpo = corpo;
      return this;
    }
    update(corpo: Linha) {
      this.corpo = corpo;
      return this;
    }
    eq(coluna: string, valor: unknown) {
      this.filtros.push([coluna, valor]);
      return this;
    }
    lte(coluna: string, valor: unknown) {
      this.intervalo = [coluna, valor];
      return this;
    }
    in(coluna: string, valores: unknown[]) {
      this.pertence.push([coluna, valores]);
      return this;
    }
    order(coluna: string, opcoes?: { ascending?: boolean }) {
      this.ordem.push([coluna, opcoes?.ascending === false ? "desc" : "asc"]);
      return this;
    }
    limit(n: number) {
      this.teto = n;
      return this;
    }

    private casa(linha: Linha) {
      return (
        this.filtros.every(([c, v]) => linha[c] === v) &&
        this.pertence.every(([c, vs]) => vs.includes(linha[c]))
      );
    }

    private executar() {
      const linhas = tabelas[this.tabela] ?? [];
      if (this.acao === "insert") {
        const nova: Linha = {
          id: `${this.tabela}-${(sequencia += 1)}`,
          created_at: "2026-11-01T10:00:00.000Z",
          updated_at: "2026-11-01T10:00:00.000Z",
          ...(this.tabela === "calendar_waitlist"
            ? {
                status: "waiting",
                janelas: [],
                urgencia: 0,
                antecedencia_minima_horas: 0,
                created_by_kind: "user",
                oferta_appointment_id: null,
                oferta_expira_em: null,
                valido_ate: null,
              }
            : {}),
          ...(this.tabela === "calendar_appointments"
            ? { status: "pending", revision: 1, source: "ui" }
            : {}),
          ...this.corpo,
        };
        // O índice único parcial da agenda: um dono por instante.
        if (this.tabela === "calendar_appointments") {
          const batendo = linhas.find(
            (l) =>
              l.organization_id === nova.organization_id &&
              l.owner_user_id === nova.owner_user_id &&
              l.starts_at === nova.starts_at &&
              (l.status === "pending" || l.status === "confirmed"),
          );
          if (batendo) {
            return { data: null, error: { message: "duplicate key", code: "23505" } };
          }
        }
        if (this.tabela === "calendar_waitlist") {
          const batendo = linhas.find(
            (l) =>
              l.organization_id === nova.organization_id &&
              l.contact_id === nova.contact_id &&
              l.event_type_id === nova.event_type_id &&
              (l.status === "waiting" || l.status === "offered"),
          );
          if (batendo) {
            return { data: null, error: { message: "duplicate key", code: "23505" } };
          }
        }
        linhas.push(nova);
        const devolvidas = this.colunas && this.colunas !== "*" ? [selecionar(nova, this.colunas)] : [nova];
        return { data: devolvidas, error: null };
      }

      const alvo = linhas.filter((l) => this.casa(l));
      if (this.intervalo) {
        const [c, v] = this.intervalo;
        for (const l of [...alvo]) {
          if (String(l[c]) > String(v)) alvo.splice(alvo.indexOf(l), 1);
        }
      }
      if (this.acao === "update") {
        for (const l of alvo) Object.assign(l, this.corpo);
        return { data: alvo.map((l) => ({ id: l.id })), error: null };
      }
      for (const [c, dir] of [...this.ordem].reverse()) {
        alvo.sort((a, b) => {
          const va = String(a[c] ?? "");
          const vb = String(b[c] ?? "");
          return (va < vb ? -1 : va > vb ? 1 : 0) * (dir === "desc" ? -1 : 1);
        });
      }
      if (this.teto !== null) alvo.splice(this.teto);
      return {
        data: alvo.map((l) => (this.colunas && this.colunas !== "*" ? selecionar(l, this.colunas) : l)),
        error: null,
      };
    }

    /** `maybeSingle()` — o `null` de "não achei", que a porta traduz em regra. */
    async maybeSingle() {
      const { data, error } = this.executar();
      if (error) return { data: null, error };
      const lista = (data ?? []) as Linha[];
      return { data: lista[0] ?? null, error: null };
    }

    then<T1 = { data: unknown; error: ErroDoBanco }, T2 = never>(
      ok?: ((v: { data: unknown; error: ErroDoBanco }) => T1 | PromiseLike<T1>) | null,
      erro?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
    ): Promise<T1 | T2> {
      const r = this.executar();
      return Promise.resolve(r).then(ok, erro);
    }
  }

  function selecionar(linha: Linha, colunas: string): Linha {
    const pedidas = colunas.split(",").map((c) => c.trim()).filter(Boolean);
    if (pedidas.length === 0 || pedidas.includes("*")) return linha;
    const saida: Linha = {};
    for (const c of pedidas) {
      // `count` e afins não existem aqui; só colunas simples.
      if (c in linha) saida[c] = linha[c];
    }
    return saida;
  }

  return {
    from(tabela: string) {
      return {
        select: (colunas?: string) =>
          new Consulta(tabela, "select").select(colunas) as unknown as {
            eq: (c: string, v: unknown) => Consulta;
          },
        insert: (corpo: Linha) => new Consulta(tabela, "insert").insert(corpo),
        update: (corpo: Linha) => new Consulta(tabela, "update").update(corpo),
      };
    },
    async rpc(nome: string, args: Record<string, unknown>) {
      expect(nome).toBe("fn_appointment_change");
      const linha = (tabelas.calendar_appointments ?? []).find(
        (l) => l.id === args.p_id && l.organization_id === args.p_org,
      );
      if (!linha) return { data: null, error: { message: "appointment_not_found" } };
      if (Number(linha.revision) !== Number(args.p_revision)) {
        return { data: null, error: { message: "revision_conflict" } };
      }
      Object.assign(linha, args.p_patch, { revision: Number(linha.revision) + 1 });
      return { data: null, error: null };
    },
    linhas: (tabela: string) => tabelas[tabela] ?? [],
  };
}

function espera(id: string, over: Linha = {}): Linha {
  return {
    id,
    organization_id: ORG,
    contact_id: `contato-${id}`,
    event_type_id: "limpeza",
    owner_user_id: null,
    janelas: [],
    antecedencia_minima_horas: 0,
    valido_ate: null,
    urgencia: 0,
    status: "waiting",
    oferta_appointment_id: null,
    oferta_expira_em: null,
    created_at: `2026-11-0${id === "a" ? 1 : 2}T10:00:00.000Z`,
    ...over,
  };
}

function compromisso(id: string, over: Linha = {}): Linha {
  return {
    id,
    organization_id: ORG,
    contact_id: "contato-x",
    event_type_id: "limpeza",
    owner_user_id: "doutora-ana",
    starts_at: INICIO,
    ends_at: "2026-11-03T13:00:00.000Z",
    time_zone: "America/Sao_Paulo",
    status: "cancelled",
    revision: 1,
    ...over,
  };
}

describe("a vaga abriu e a fila tem gente", () => {
  it("grava a vaga segurada como `pending` com origem `waitlist` e marca a inscrição", async () => {
    const db = banco({
      appointments: [compromisso("vaga-1")],
      waitlist: [espera("a")],
    });

    const r = await aposVagaLiberada(db as never, {
      organizationId: ORG,
      appointmentId: "vaga-1",
      agora: AGORA,
    });

    expect(r.ofertada).toBe(true);
    if (!r.ofertada) return;
    expect(r.esperaId).toBe("a");
    expect(r.texto).toContain("Limpeza");

    const segurada = db.linhas("calendar_appointments").find((l) => l.id === r.compromissoId);
    expect(segurada).toMatchObject({
      status: "pending",
      source: "waitlist",
      created_by_kind: "system",
      contact_id: "contato-a",
      owner_user_id: "doutora-ana",
      starts_at: INICIO,
      ends_at: "2026-11-03T13:00:00.000Z",
    });
    expect(db.linhas("calendar_waitlist")[0]).toMatchObject({
      status: "offered",
      oferta_appointment_id: r.compromissoId,
      oferta_expira_em: r.expiraEm.toISOString(),
    });
  });

  it("sem ninguém que caiba, a vaga continua livre e nada é gravado", async () => {
    const db = banco({
      appointments: [compromisso("vaga-1")],
      waitlist: [espera("a", { antecedencia_minima_horas: 72 })],
    });
    const r = await aposVagaLiberada(db as never, {
      organizationId: ORG,
      appointmentId: "vaga-1",
      agora: AGORA,
    });
    expect(r).toEqual({ ofertada: false, motivo: "sem_candidato" });
    expect(db.linhas("calendar_appointments")).toHaveLength(1);
    expect(db.linhas("calendar_waitlist")[0]?.status).toBe("waiting");
  });

  it("compromisso que não está desmarcado não abre vaga", async () => {
    const db = banco({
      appointments: [compromisso("vaga-1", { status: "confirmed" })],
      waitlist: [espera("a")],
    });
    const r = await aposVagaLiberada(db as never, {
      organizationId: ORG,
      appointmentId: "vaga-1",
      agora: AGORA,
    });
    expect(r).toEqual({ ofertada: false, motivo: "vaga_indisponivel" });
  });

  it("instante já ocupado por outra marcação é corrida perdida, não erro", async () => {
    const db = banco({
      appointments: [
        compromisso("vaga-1"),
        compromisso("outro", { status: "pending", contact_id: "contato-y" }),
      ],
      waitlist: [espera("a")],
    });
    const r = await aposVagaLiberada(db as never, {
      organizationId: ORG,
      appointmentId: "vaga-1",
      agora: AGORA,
    });
    expect(r).toEqual({ ofertada: false, motivo: "vaga_ja_ocupada" });
    expect(db.linhas("calendar_waitlist")[0]?.status).toBe("waiting");
  });
});

describe("o compromisso segurado foi desmarcado", () => {
  it("é RECUSA de quem tinha a oferta: chama o próximo e só então devolve ela à fila", async () => {
    const db = banco({
      appointments: [
        compromisso("hold-a", { status: "cancelled", contact_id: "contato-a" }),
      ],
      waitlist: [
        espera("a", {
          status: "offered",
          oferta_appointment_id: "hold-a",
          oferta_expira_em: "2026-11-03T11:00:00.000Z",
        }),
        espera("b"),
      ],
    });

    const r = await aposVagaLiberada(db as never, {
      organizationId: ORG,
      appointmentId: "hold-a",
      agora: AGORA,
    });

    expect(r.ofertada).toBe(true);
    if (!r.ofertada) return;
    // O laço que este teste impede: a vaga voltando para quem recusou.
    expect(r.esperaId).toBe("b");
    expect(db.linhas("calendar_waitlist").find((l) => l.id === "a")?.status).toBe("waiting");
  });
});

describe("a resposta SIM", () => {
  it("fecha a inscrição como `booked` quando o compromisso segurado é confirmado", async () => {
    const db = banco({
      appointments: [compromisso("hold-a", { status: "confirmed" })],
      waitlist: [espera("a", { status: "offered", oferta_appointment_id: "hold-a" })],
    });
    await fecharEncaixeConfirmado(db as never, { organizationId: ORG, appointmentId: "hold-a" });
    expect(db.linhas("calendar_waitlist")[0]?.status).toBe("booked");
  });

  it("compromisso comum não mexe na fila", async () => {
    const db = banco({
      appointments: [compromisso("comum", { status: "confirmed" })],
      waitlist: [espera("a", { status: "waiting" })],
    });
    await fecharEncaixeConfirmado(db as never, { organizationId: ORG, appointmentId: "comum" });
    expect(db.linhas("calendar_waitlist")[0]?.status).toBe("waiting");
  });
});

describe("pedir encaixe", () => {
  const pedido = {
    organizationId: ORG,
    contactId: "contato-a",
    eventTypeId: "limpeza",
    createdByKind: "ai" as const,
  };

  it("inscreve uma vez", async () => {
    const db = banco({});
    const r = await inscreverNaEspera(db as never, pedido);
    expect(r).toMatchObject({ inscrito: true, jaEstava: false });
    expect(db.linhas("calendar_waitlist")[0]).toMatchObject({ status: "waiting", created_by_kind: "ai" });
  });

  it("pedir de novo devolve a MESMA inscrição, sem duplicar a pessoa", async () => {
    const db = banco({});
    const primeira = await inscreverNaEspera(db as never, pedido);
    const segunda = await inscreverNaEspera(db as never, pedido);
    expect(primeira.inscrito && segunda.inscrito).toBe(true);
    if (!primeira.inscrito || !segunda.inscrito) return;
    expect(segunda.esperaId).toBe(primeira.esperaId);
    expect(segunda.jaEstava).toBe(true);
    expect(db.linhas("calendar_waitlist")).toHaveLength(1);
  });
});
