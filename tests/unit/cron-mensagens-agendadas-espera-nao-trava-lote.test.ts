import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QUEM ESTÁ EM "ESPERAR" NÃO PODE OCUPAR AS 50 VAGAS DO LOTE PARA SEMPRE.
 *
 * ─── O defeito, medido (issue #5060) ────────────────────────────────────────
 *
 * O cron `mensagens-agendadas` lê sempre as 50 mensagens devidas mais antigas
 * (`order scheduled_at`, `limit 50`). Quando a sessão do número está fora do ar
 * e a pessoa escolheu `se_desconectado = 'esperar'`, a linha é SOLTA
 * (`claimed_until = null`) e a rodada segue. Só que soltar não tira a linha da
 * frente da fila: ela continua sendo a mais antiga, volta na rodada seguinte e
 * ocupa a vaga de novo. Com 50 mensagens presas assim, uma mensagem devida mais
 * nova — de sessão CONECTADA — nunca entra no lote, por mais que o cron rode.
 *
 * ─── O conserto que este teste trava ────────────────────────────────────────
 *
 * O lote passa a ordenar por `updated_at` (a última vez que o cron encostou na
 * linha) e a soltura da linha em espera carimba `updated_at = agora`. Quem
 * acabou de ser solto vai para o FIM da fila e cede a vez; quem nunca foi
 * tentado (ou foi tentado há mais tempo) vem na frente. O lote continua 50,
 * `TRAVA_S` continua o mesmo e a política `esperar` não vira `cancelar` — a
 * linha presa segue `agendada`, com o texto, e é retentada quando chegar a vez.
 *
 * ─── Por que o dublê é um banco de mentira, e não só um espião ──────────────
 *
 * O defeito mora na INTERAÇÃO entre a leitura ordenada/limitada e o UPDATE de
 * soltura, em duas rodadas. Um mock que devolve sempre a mesma lista não
 * distingue "a linha foi solta" de "a linha foi reordenada": só um estado que
 * aplica os UPDATEs e reordena a cada SELECT mede o progresso do lote.
 */

type LinhaAgendada = {
  id: string;
  organization_id: string;
  contact_id: string;
  channel_session_id: string;
  created_by_user_id: string | null;
  body: string;
  scheduled_at: string;
  se_desconectado: "esperar" | "cancelar";
  status: "agendada" | "encaminhada" | "falhou" | "cancelada";
  motivo: string | null;
  message_id: string | null;
  claimed_until: string | null;
  created_at: string;
  updated_at: string;
};

type Resumo = {
  processadas: number;
  encaminhadas: number;
  falhas: number;
  canceladas: number;
  esperando: number;
};

const banco = vi.hoisted(() => ({
  linhas: [] as LinhaAgendada[],
  orgs: new Map<string, string>(),
  conectadas: new Set<string>(),
  encaminhadas: [] as string[],
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

/**
 * Dublê do `createAdminClient`: um PostgREST mínimo, com estado.
 *
 * Só as formas que a rota usa: SELECT com `eq`/`lte`/`order`/`limit` e UPDATE
 * com `eq`/`or` (+ `select` para devolver a linha reservada). As ordens são
 * aplicadas na sequência em que a rota as pede — é isso que faz o teste
 * reprovar se alguém voltar a ordenar a fila só por `scheduled_at`.
 */
vi.mock("@/lib/supabase/admin", () => {
  type Linha = Record<string, unknown>;
  const texto = (v: unknown): string => String(v ?? "");

  function construtor(): unknown {
    let operacao: "select" | "update" | null = null;
    let patch: Record<string, unknown> = {};
    let devolverLinhas = false;
    let ou: string | null = null;
    let teto: number | null = null;
    const iguais: Array<[string, unknown]> = [];
    const menoresOuIguais: Array<[string, string]> = [];
    const ordens: Array<{ coluna: string; asc: boolean }> = [];

    const casaOu = (linha: Linha, expressao: string): boolean =>
      expressao.split(",").some((condicao) => {
        const [coluna, operador, ...resto] = condicao.split(".");
        const alvo = resto.join(".");
        if (coluna !== "claimed_until") return false;
        if (operador === "is" && alvo === "null") return linha.claimed_until == null;
        if (operador === "lt") return linha.claimed_until != null && texto(linha.claimed_until) < alvo;
        return false;
      });

    const executar = () => {
      let alvo = banco.linhas.filter(
        (linha) =>
          iguais.every(([coluna, valor]) =>
            coluna === "organizations.status"
              ? banco.orgs.get(String(linha.organization_id)) === valor
              : (linha as Linha)[coluna] === valor,
          ) && menoresOuIguais.every(([coluna, valor]) => texto((linha as Linha)[coluna]) <= valor),
      );
      if (ou) {
        const expressao = ou;
        alvo = alvo.filter((linha) => casaOu(linha as Linha, expressao));
      }

      if (operacao === "update") {
        for (const linha of alvo) Object.assign(linha, patch);
        return { data: devolverLinhas ? alvo.map((linha) => ({ ...linha })) : null, error: null };
      }

      const ordenada = [...alvo].sort((a, b) => {
        for (const { coluna, asc } of ordens) {
          const va = texto((a as Linha)[coluna]);
          const vb = texto((b as Linha)[coluna]);
          if (va === vb) continue;
          return (va < vb ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
      const recortada = teto == null ? ordenada : ordenada.slice(0, teto);
      return {
        data: recortada.map((linha) => ({
          id: linha.id,
          organizations: { status: banco.orgs.get(String(linha.organization_id)) },
        })),
        error: null,
      };
    };

    const cadeia: Record<string, unknown> = {
      select: () => {
        if (operacao === "update") devolverLinhas = true;
        else operacao = "select";
        return cadeia;
      },
      update: (alteracoes: Record<string, unknown>) => {
        operacao = "update";
        patch = alteracoes;
        return cadeia;
      },
      eq: (coluna: string, valor: unknown) => {
        iguais.push([coluna, valor]);
        return cadeia;
      },
      lte: (coluna: string, valor: string) => {
        menoresOuIguais.push([coluna, valor]);
        return cadeia;
      },
      or: (expressao: string) => {
        ou = expressao;
        return cadeia;
      },
      order: (coluna: string, opcoes?: { ascending?: boolean }) => {
        ordens.push({ coluna, asc: opcoes?.ascending !== false });
        return cadeia;
      },
      limit: (n: number) => {
        teto = n;
        return cadeia;
      },
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve(executar()),
    };
    return cadeia;
  }

  return { createAdminClient: () => ({ from: () => construtor() }) };
});

vi.mock("@/lib/agendamento-mensagem/envio", () => ({
  autorAindaTemAcesso: async () => true,
  encaminharAgendamento: async (_admin: unknown, ag: { id: string }) => {
    banco.encaminhadas.push(ag.id);
    return { desfecho: "encaminhada", message_id: `msg-${ag.id}` };
  },
}));

// A rota escolhe a conversa de envio por `resolverConversaConectada` (#5185): aqui, a
// sessão original está no ar ou não está, sem outra conexão com o mesmo número.
vi.mock("@/lib/agendamento-mensagem/sessao-do-contato", () => ({
  resolverConversaConectada: async (_admin: unknown, _org: string, _contato: string, sessao: string) =>
    banco.conectadas.has(sessao) ? { conversation_id: `conversa-${sessao}`, channel_session_id: sessao } : null,
}));

function semear(linhas: Array<Partial<LinhaAgendada> & Pick<LinhaAgendada, "id">>): void {
  for (const linha of linhas) {
    banco.linhas.push({
      organization_id: "org-a",
      contact_id: `contato-${linha.id}`,
      channel_session_id: "sessao-caida",
      created_by_user_id: "usuario-1",
      body: `corpo ${linha.id}`,
      scheduled_at: "2026-01-01T09:00:00.000Z",
      se_desconectado: "esperar",
      status: "agendada",
      motivo: null,
      message_id: null,
      claimed_until: null,
      created_at: "2026-01-01T08:00:00.000Z",
      updated_at: "2026-01-01T08:00:00.000Z",
      ...linha,
    });
  }
}

async function rodar(): Promise<Resumo> {
  const { GET } = await import("@/app/api/v1/cron/mensagens-agendadas/route");
  const resposta = await GET(new NextRequest("http://localhost/api/v1/cron/mensagens-agendadas"));
  expect(resposta.status).toBe(200);
  const corpo = (await resposta.json()) as { data: Resumo };
  return corpo.data;
}

function porId(id: string): LinhaAgendada {
  const linha = banco.linhas.find((l) => l.id === id);
  if (!linha) throw new Error(`linha ${id} sumiu do dublê`);
  return linha;
}

beforeEach(() => {
  banco.linhas.length = 0;
  banco.orgs.clear();
  banco.conectadas.clear();
  banco.encaminhadas.length = 0;
  banco.orgs.set("org-a", "active");
  banco.conectadas.add("sessao-conectada");
});

describe("mensagens agendadas — 'esperar' não trava o lote (#5060)", () => {
  it("encaminha a mensagem de sessão conectada na 2ª rodada mesmo com 50 presas em 'esperar'", async () => {
    // Reprodução da issue: 50 antigas numa sessão caída, política "esperar";
    // 1 nova (devida depois) numa sessão conectada.
    for (let i = 0; i < 50; i += 1) {
      semear([{ id: `presa-${i}` }]);
    }
    semear([
      {
        id: "nova-conectada",
        channel_session_id: "sessao-conectada",
        scheduled_at: "2026-01-02T10:00:00.000Z",
        updated_at: "2026-01-02T09:00:00.000Z",
      },
    ]);

    const primeira = await rodar();
    // A primeira rodada só alcança as 50 presas: nada a encaminhar ainda.
    expect(primeira.encaminhadas).toBe(0);
    expect(primeira.esperando).toBe(50);

    // A segunda rodada TEM de alcançar a mensagem da sessão conectada: as
    // presas acabaram de ser soltas e cedem a vez.
    const segunda = await rodar();
    expect(segunda.encaminhadas).toBeGreaterThanOrEqual(1);

    const nova = porId("nova-conectada");
    expect(nova.status).toBe("encaminhada");
    expect(nova.message_id).toBe("msg-nova-conectada");
    expect(banco.encaminhadas).toContain("nova-conectada");
  });

  // ── Controles: o conserto não pode ganhar comportamento novo de graça ──────

  it("controle (a): quem está em 'esperar' continua agendada, com o texto e sem a trava", async () => {
    semear([{ id: "presa", body: "texto original" }]);
    semear([
      {
        id: "nova",
        channel_session_id: "sessao-conectada",
        scheduled_at: "2026-01-02T10:00:00.000Z",
        updated_at: "2026-01-02T09:00:00.000Z",
      },
    ]);

    await rodar();
    await rodar();

    const presa = porId("presa");
    expect(presa.status).toBe("agendada");
    expect(presa.motivo).toBeNull();
    expect(presa.body).toBe("texto original");
    expect(presa.claimed_until).toBeNull();
  });

  it("controle (b): 'cancelar' segue cancelando a linha da sessão desconectada", async () => {
    semear([{ id: "cancelar", se_desconectado: "cancelar", body: "texto" }]);

    const resumo = await rodar();

    expect(resumo.canceladas).toBe(1);
    expect(resumo.encaminhadas).toBe(0);
    const linha = porId("cancelar");
    expect(linha.status).toBe("cancelada");
    expect(linha.motivo).toBe("numero_desconectado");
    expect(linha.body).toBe("texto");
  });

  it("controle (c): org pausada continua fora do lote", async () => {
    banco.orgs.set("org-pausada", "suspended");
    semear([
      {
        id: "pausada",
        organization_id: "org-pausada",
        channel_session_id: "sessao-conectada",
      },
    ]);

    const resumo = await rodar();

    expect(resumo.processadas).toBe(0);
    expect(resumo.encaminhadas).toBe(0);
    expect(banco.encaminhadas).toEqual([]);
    expect(porId("pausada").status).toBe("agendada");
  });
});
