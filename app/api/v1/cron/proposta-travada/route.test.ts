import { afterEach, describe, expect, it, vi } from "vitest";

import { RECURSOS_DO_CRON, esquecerRetrato, semearRetrato, type RecursoDoCron } from "@/lib/cron/piso-ocioso";

const h = vi.hoisted(() => ({
  admin: vi.fn(),
  autoriza: vi.fn(() => true),
  audit: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: h.admin }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: h.autoriza }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
// O aviso nasce no idioma da organização; o dicionário fica de fora deste teste.
vi.mock("@/lib/i18n/idioma-do-aviso", () => ({
  idiomaDoAviso: async () => "pt-BR",
  preencher: (texto: string) => texto,
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { GET, recuperarPropostasTravadas } from "./route";

interface LinhaFalsa {
  id: string;
  organization_id: string;
  status: string;
  message_id?: string | null;
}

/**
 * Banco falso mínimo, mas que HONRA os filtros de verdade: o SELECT só
 * devolve linhas com `status = 'enviando'` (a sonda), e o UPDATE só toca
 * linha cujo status AINDA seja `enviando` no momento da escrita (a trava
 * atômica) — nunca as que a sonda listou. É essa diferença que prova o claim:
 * ignorar o `.eq("status","enviando")` do UPDATE faria o teste de corrida
 * (abaixo) reverter uma proposta que já tinha confirmado.
 *
 * `apósSelecionar` roda DEPOIS que a sonda já capturou seu retrato (mas antes
 * do UPDATE) — é o gancho que simula o ack chegando NO MEIO da rodada do cron.
 */
function bancoFalso(linhas: LinhaFalsa[], apósSelecionar?: () => void, mensagens: Record<string, string> = {}) {
  const avisos: Array<{ organization_id: string }> = [];
  const admin = {
    from: (tabela: string) => {
      if (tabela === "messages") {
        return {
          select: () => ({
            in: async (_c: string, ids: string[]) => ({
              data: ids.filter((id) => id in mensagens).map((id) => ({ id, status: mensagens[id] })),
              error: null,
            }),
          }),
        };
      }
      if (tabela === "crm_proposals") {
        return {
          select: () => ({
            eq: (_c: string, _v: string) => ({
              lt: () => ({
                limit: async () => {
                  const retrato = linhas
                    .filter((l) => l.status === "enviando")
                    .map((l) => ({ id: l.id, organization_id: l.organization_id, message_id: l.message_id ?? null }));
                  apósSelecionar?.();
                  return { data: retrato, error: null };
                },
              }),
            }),
          }),
          update: (_dados: unknown) => ({
            in: (_c: string, ids: string[]) => ({
              eq: (campo: string, valor: string) => ({
                select: async () => {
                  if (campo !== "status" || valor !== "enviando") throw new Error("UPDATE sem a trava .eq('status','enviando')");
                  const alvo = linhas.filter((l) => ids.includes(l.id) && l.status === "enviando");
                  for (const l of alvo) l.status = "rascunho";
                  return { data: alvo.map((l) => ({ id: l.id })), error: null };
                },
              }),
            }),
          }),
        };
      }
      if (tabela === "agent_inbox_items") {
        return { insert: async (linha: { organization_id: string }) => { avisos.push(linha); return { error: null }; } };
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
  };
  return { admin: admin as never, avisos, linhas };
}

describe("recuperarPropostasTravadas", () => {
  it("volta a rascunho proposta presa em enviando ha mais de 5 minutos, sem reenviar nada", async () => {
    const { admin } = bancoFalso([{ id: "prop-1", organization_id: "org-1", status: "enviando" }]);
    const result = await recuperarPropostasTravadas(admin, new Date(), "req-1", async () => true);
    expect(result).toEqual({ scanned: 1, revertidas: 1, organizations: 1 });
  });

  it("nao mexe em nada quando nao ha proposta presa", async () => {
    const { admin } = bancoFalso([]);
    const result = await recuperarPropostasTravadas(admin, new Date(), "req-1", async () => true);
    expect(result).toEqual({ scanned: 0, revertidas: 0, organizations: 0 });
  });

  it("agrupa por organizacao: duas propostas da mesma org geram UM aviso, nao dois", async () => {
    const { admin, avisos } = bancoFalso([
      { id: "prop-1", organization_id: "org-1", status: "enviando" },
      { id: "prop-2", organization_id: "org-1", status: "enviando" },
    ]);
    const result = await recuperarPropostasTravadas(admin, new Date(), "req-1", async () => true);
    expect(result).toEqual({ scanned: 2, revertidas: 2, organizations: 1 });
    expect(avisos.length).toBe(1);
  });

  it("corrida: a mensagem confirmou entre o SELECT e o UPDATE — a trava .eq('status','enviando') protege, não reverte", async () => {
    const linhas: LinhaFalsa[] = [{ id: "prop-1", organization_id: "org-1", status: "enviando" }];
    const { admin, avisos } = bancoFalso(linhas, () => {
      linhas[0]!.status = "enviada"; // o ack chega ENTRE o SELECT e o UPDATE.
    });

    const result = await recuperarPropostasTravadas(admin, new Date(), "req-1", async () => true);
    expect(result).toEqual({ scanned: 1, revertidas: 0, organizations: 0 });
    expect(avisos.length).toBe(0);
    expect(linhas[0]!.status).toBe("enviada"); // continua enviada — não foi revertida.
  });

  it("mensagem ainda 'queued' (sem credencial, o agent-engine reagenda): nao reverte, nao e' presa de verdade (I1)", async () => {
    const linhas: LinhaFalsa[] = [{ id: "prop-1", organization_id: "org-1", status: "enviando", message_id: "msg-1" }];
    const { admin, avisos } = bancoFalso(linhas, undefined, { "msg-1": "queued" });

    const result = await recuperarPropostasTravadas(admin, new Date(), "req-1", async () => true);
    expect(result).toEqual({ scanned: 1, revertidas: 0, organizations: 0 });
    expect(avisos.length).toBe(0);
    expect(linhas[0]!.status).toBe("enviando"); // continua tentando — não é presa de verdade.
  });

  it("mensagem 'failed' de verdade: reverte normalmente", async () => {
    const linhas: LinhaFalsa[] = [{ id: "prop-1", organization_id: "org-1", status: "enviando", message_id: "msg-1" }];
    const { admin, avisos } = bancoFalso(linhas, undefined, { "msg-1": "failed" });

    const result = await recuperarPropostasTravadas(admin, new Date(), "req-1", async () => true);
    expect(result).toEqual({ scanned: 1, revertidas: 1, organizations: 1 });
    expect(avisos.length).toBe(1);
    expect(linhas[0]!.status).toBe("rascunho");
  });

  it("sem message_id (processo morreu antes de enviar): reverte normalmente", async () => {
    const linhas: LinhaFalsa[] = [{ id: "prop-1", organization_id: "org-1", status: "enviando", message_id: null }];
    const { admin } = bancoFalso(linhas);

    const result = await recuperarPropostasTravadas(admin, new Date(), "req-1", async () => true);
    expect(result).toEqual({ scanned: 1, revertidas: 1, organizations: 1 });
  });
});

// ---------------------------------------------------------------------------
// A RODADA INTEIRA, com um admin de mentira (#4871).
//
// `proposta-travada` lê as propostas presas de TODAS as empresas num `select`
// só. A camada por empresa só vale se a rodada pular UMA empresa e processar a
// VIZINHA no mesmo passo — é o que os casos abaixo medem. A permissão entra por
// `permitida`, que é `moduloLigado(admin, "propostas", org)` na rota.
// ---------------------------------------------------------------------------

interface PresaNaCena {
  id: string;
  organization_id: string;
  message_id: string | null;
}

interface Cena {
  presas?: PresaNaCena[];
  instalacaoLigada?: boolean;
  linhas?: Array<{ organization_id: string; modulo: string; estado: string }>;
  erroLinhas?: string;
}

function adminDaRodada(cena: Cena) {
  const lidas: string[] = [];
  const revertidas: string[] = [];
  const avisos: Array<{ organization_id: string }> = [];
  /** O status de cada proposta viva: o UPDATE só toca quem ainda está `enviando`. */
  const estado = new Map((cena.presas ?? []).map((p) => [p.id, "enviando"]));

  function consulta(tabela: string) {
    lidas.push(tabela);
    const filtros: Record<string, unknown> = {};
    let escrita: Record<string, unknown> | null = null;

    const resolver = (): { data: unknown; error: unknown } => {
      if (tabela === "platform_config") {
        return {
          data: cena.instalacaoLigada ? [{ chave: "MODULO_PROPOSTAS", valor: "ligado" }] : [],
          error: null,
        };
      }
      if (tabela === "organization_modules") {
        return cena.erroLinhas
          ? { data: null, error: { message: cena.erroLinhas, code: "XX000" } }
          : {
              data: (cena.linhas ?? []).filter((l) => l.organization_id === filtros.organization_id),
              error: null,
            };
      }
      if (tabela === "crm_proposals") {
        if (escrita !== null) {
          const ids = (filtros.id as string[] | undefined) ?? [];
          const alvo = ids.filter((id) => estado.get(id) === "enviando");
          for (const id of alvo) {
            estado.set(id, "rascunho");
            revertidas.push(id);
          }
          return { data: alvo.map((id) => ({ id })), error: null };
        }
        return {
          data: (cena.presas ?? []).filter((p) => estado.get(p.id) === "enviando"),
          error: null,
        };
      }
      return { data: [], error: null };
    };

    const api: Record<string, unknown> = {};
    const devolver = () => api;
    api.select = devolver;
    api.not = devolver;
    api.lt = devolver;
    api.limit = devolver;
    api.order = devolver;
    api.in = (coluna: string, valor: unknown) => {
      filtros[coluna] = valor;
      return api;
    };
    api.eq = (coluna: string, valor: unknown) => {
      filtros[coluna] = valor;
      return api;
    };
    api.update = (dados: Record<string, unknown>) => {
      escrita = dados;
      return api;
    };
    api.insert = async (linha: { organization_id: string }) => {
      avisos.push(linha);
      return { error: null };
    };
    api.maybeSingle = async () => ({ data: null, error: null });
    api.then = (ok: (v: unknown) => unknown, falhou?: (e: unknown) => unknown) =>
      Promise.resolve(resolver()).then(ok, falhou);
    return api;
  }

  return { admin: { from: (tabela: string) => consulta(tabela) }, lidas, revertidas, avisos };
}

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const presa = (id: string, org: string): PresaNaCena => ({ id, organization_id: org, message_id: null });

/** O portão do piso ocioso é o REAL: semeia o retrato com trabalho em tudo. */
function retratoComTrabalho(): void {
  semearRetrato(Object.fromEntries(RECURSOS_DO_CRON.map((r) => [r, true])) as Record<RecursoDoCron, boolean>);
}

afterEach(() => {
  esquecerRetrato();
});

describe("GET /api/v1/cron/proposta-travada — a rodada por empresa (#4871)", () => {
  it("instalação desligada: não destrava nada e não lê proposta nenhuma", async () => {
    retratoComTrabalho();
    const cena = adminDaRodada({ presas: [presa("p-a", A)], instalacaoLigada: false });
    h.admin.mockReturnValue(cena.admin);

    const res = await GET({} as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { pulado: "modulo_desligado" } });
    expect(cena.lidas).not.toContain("crm_proposals");
    expect(cena.revertidas).toEqual([]);
  });

  it("MESMA execução: a empresa que desligou `propostas` continua presa, a ligada volta a rascunho", async () => {
    retratoComTrabalho();
    const cena = adminDaRodada({
      presas: [presa("p-a", A), presa("p-b", B)],
      instalacaoLigada: true,
      linhas: [{ organization_id: A, modulo: "propostas", estado: "desligado" }],
    });
    h.admin.mockReturnValue(cena.admin);

    const res = await GET({} as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { revertidas: 1, organizations: 1 } });
    expect(cena.revertidas).toEqual(["p-b"]);
    expect(cena.avisos.map((a) => a.organization_id)).toEqual([B]);
  });

  it("empresa SEM linha herda a instalação: as duas voltam a rascunho", async () => {
    retratoComTrabalho();
    const cena = adminDaRodada({ presas: [presa("p-a", A), presa("p-b", B)], instalacaoLigada: true, linhas: [] });
    h.admin.mockReturnValue(cena.admin);

    const res = await GET({} as never);

    expect(await res.json()).toMatchObject({ data: { revertidas: 2, organizations: 2 } });
    expect(cena.revertidas.sort()).toEqual(["p-a", "p-b"]);
  });

  it("falha de leitura das linhas da empresa não destrava ninguém", async () => {
    retratoComTrabalho();
    const cena = adminDaRodada({
      presas: [presa("p-a", A)],
      instalacaoLigada: true,
      linhas: [{ organization_id: A, modulo: "propostas", estado: "ligado" }],
      erroLinhas: "permission denied for table organization_modules",
    });
    h.admin.mockReturnValue(cena.admin);

    const res = await GET({} as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { revertidas: 0 } });
    expect(cena.revertidas).toEqual([]);
    expect(cena.avisos).toEqual([]);
  });
});
