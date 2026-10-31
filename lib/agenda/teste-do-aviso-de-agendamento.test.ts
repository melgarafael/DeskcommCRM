import { describe, expect, it, vi } from "vitest";

import type { CanalDoAviso } from "@/lib/escalacao/aviso-ao-suporte";
import type { DepsDoAvisoDeTeste } from "@/lib/escalacao/aviso-de-teste";

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
