import { describe, expect, it, vi } from "vitest";

import type { CanalDoAviso } from "@/lib/escalacao/aviso-ao-suporte";
import type { DepsDoAvisoDeTeste } from "@/lib/escalacao/aviso-de-teste";
import { decidirEspacamento } from "@/lib/agent-engine/pacing/ledger-supabase";

import { ESPERA_MAXIMA_DO_GRUPO_MS, enviarTesteDoAvisoDeAgendamento } from "./teste-do-aviso-de-agendamento";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const TELEFONE = "+5531998966398";
const GRUPO = "120363000000000001@g.us";
const AGORA = new Date("2026-10-25T12:00:00.000Z");

const canal: CanalDoAviso = { id: CANAL, status: "WORKING", archived_at: null, aceitaMensagemLivre: true };

type Decisao = Awaited<ReturnType<DepsDoAvisoDeTeste["pacing"]["decide"]>>;

function cenario(opcoes: { decisoes?: Decisao[]; enviaGrupo?: () => Promise<{ externalId: string | null }> } = {}) {
  const enviados: string[] = [];
  let relogio = AGORA.getTime();
  const decisoes = [...(opcoes.decisoes ?? [])];
  const deps: DepsDoAvisoDeTeste = {
    db: {
      carregaCanal: vi.fn(async () => canal),
      marcaDaOrganizacao: vi.fn(async () => ({ nome: "Acme", idioma: "pt-BR" as const })),
      destinoEhDaPropriaOrganizacao: vi.fn(async () => false),
    },
    transporte: {
      configurado: vi.fn(async () => true),
      resolveDestino: vi.fn(async (_o, _c, destino: string) =>
        destino.endsWith("@g.us") ? destino : `${destino.slice(1)}@c.us`,
      ),
      envia: vi.fn(async (_o, _c, to: string) => {
        if (to.endsWith("@g.us") && opcoes.enviaGrupo) return await opcoes.enviaGrupo();
        enviados.push(to);
        return { externalId: "wamid.TESTE" };
      }),
    },
    pacing: {
      decide: vi.fn(async () => decisoes.shift() ?? ({ liberado: true } as Decisao)),
      registraEnvio: vi.fn(async () => {}),
    },
    clock: () => new Date(relogio),
    urlPublica: "https://crm.exemplo.com.br",
  };
  const esperar = vi.fn(async (ms: number) => {
    relogio += ms;
  });
  return { deps, enviados, esperar };
}

const entrada = (grupo: string | null) => ({
  organizationId: ORG,
  channelSessionId: CANAL,
  telefone: TELEFONE,
  grupo,
  corpo: () => "teste do aviso de agendamento",
});

describe("'Enviar teste' do aviso de agendamento manda também para o grupo (issue #1)", () => {
  it("sem grupo escolhido, manda só ao número e diz que não há grupo", async () => {
    const { deps, enviados, esperar } = cenario();
    const r = await enviarTesteDoAvisoDeAgendamento(deps, entrada(null), esperar);

    expect(r.enviado).toBe(true);
    expect(r.grupo).toBeNull();
    expect(enviados).toEqual(["5531998966398@c.us"]);
  });

  it("com grupo escolhido, manda ao número e ao grupo, e diz que os dois saíram", async () => {
    const { deps, enviados, esperar } = cenario();
    const r = await enviarTesteDoAvisoDeAgendamento(deps, entrada(GRUPO), esperar);

    expect(r.enviado).toBe(true);
    expect(r.grupo).toEqual({ enviado: true });
    expect(enviados).toEqual(["5531998966398@c.us", GRUPO]);
    expect(deps.pacing.registraEnvio).toHaveBeenCalledTimes(2);
    // O endereço do grupo não volta na resposta.
    expect(JSON.stringify(r)).not.toContain("120363");
  });

  it("o intervalo do anti-ban entre número e grupo é esperado, e o grupo sai na segunda tentativa", async () => {
    const liberaEm = new Date(AGORA.getTime() + 1_500);
    const { deps, enviados, esperar } = cenario({
      decisoes: [{ liberado: true }, { liberado: false, motivo: "espacamento", liberaEm } as Decisao],
    });
    const r = await enviarTesteDoAvisoDeAgendamento(deps, entrada(GRUPO), esperar);

    expect(esperar).toHaveBeenCalledWith(1_500);
    expect(r.grupo).toEqual({ enviado: true });
    expect(enviados).toEqual(["5531998966398@c.us", GRUPO]);
  });

  it("o jitter sorteado de novo a cada consulta não derruba o grupo: espera até liberar, sem furar o espaçamento", async () => {
    // A regra de produção, com o rng mudando entre as consultas: a 1ª manda
    // esperar 1.280 ms, a 2ª (já em +1.280) sorteia +1.920 e recusa de novo,
    // a 3ª (em +1.920) libera. Com uma tentativa só, o grupo voltava "espacamento".
    const { deps, enviados, esperar } = cenario();
    const sorteios = [0.1, 0.9, 0.5];
    let ultimoEnvio: Date | null = null;
    const liberadoEm: number[] = [];
    deps.pacing.decide = vi.fn(async (_o, _c, agora: Date) => {
      const d = decidirEspacamento({
        agora,
        estado: { lastSentAt: ultimoEnvio, sentToday: 0, numberActivatedAt: null },
        throttleMs: 1_200,
        jitterMaxMs: 800,
        timezone: "America/Sao_Paulo",
        warmupDailyCaps: [],
        crmDailyLimit: null,
        rng: () => sorteios.shift() ?? 0,
      });
      if (d.liberado) liberadoEm.push(agora.getTime() - AGORA.getTime());
      return d;
    });
    deps.pacing.registraEnvio = vi.fn(async (_o, _c, agora: Date) => {
      ultimoEnvio = agora;
    });

    const r = await enviarTesteDoAvisoDeAgendamento(deps, entrada(GRUPO), esperar);

    expect(r.grupo).toEqual({ enviado: true });
    expect(enviados).toEqual(["5531998966398@c.us", GRUPO]);
    expect(esperar.mock.calls.map(([ms]) => ms)).toEqual([1_280, 640]);
    // O grupo só saiu quando a regra liberou: nunca antes de 1,2 s do número.
    expect(liberadoEm).toEqual([0, 1_920]);
  });

  it("espera longa demais não é esperada: o grupo volta com o motivo, e o número segue enviado", async () => {
    const liberaEm = new Date(AGORA.getTime() + ESPERA_MAXIMA_DO_GRUPO_MS + 1);
    const { deps, esperar } = cenario({
      decisoes: [{ liberado: true }, { liberado: false, motivo: "espacamento", liberaEm } as Decisao],
    });
    const r = await enviarTesteDoAvisoDeAgendamento(deps, entrada(GRUPO), esperar);

    expect(esperar).not.toHaveBeenCalled();
    expect(r.enviado).toBe(true);
    expect(r.grupo).toEqual({ enviado: false, codigo: "espacamento", liberaEm: liberaEm.toISOString() });
  });

  it("envio recusado no grupo devolve a falha só do grupo; o número saiu", async () => {
    const { deps, enviados, esperar } = cenario({
      enviaGrupo: async () => {
        throw new Error("group not found");
      },
    });
    const r = await enviarTesteDoAvisoDeAgendamento(deps, entrada(GRUPO), esperar);

    expect(r.enviado).toBe(true);
    expect(r.grupo).toEqual({ enviado: false, codigo: "falha_no_envio" });
    expect(enviados).toEqual(["5531998966398@c.us"]);
  });
});
