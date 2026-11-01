import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";
import type { DepsDeGrupos } from "@/lib/grupos/servico";

import { confereGrupoDaConexao } from "./grupo-do-aviso-de-agendamento";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONEXAO = "22222222-2222-4222-8222-222222222222";
const OUTRA_CONEXAO = "33333333-3333-4333-8333-333333333333";
const DA_CONEXAO = "120363000000000001@g.us";
const DE_OUTRO_NUMERO = "120363000000000002@g.us";
const QUE_O_NUMERO_SAIU = "120363000000000003@g.us";

function deps(opts: { canalFora?: boolean } = {}): DepsDeGrupos {
  return {
    db: {
      lerSessao: vi.fn(async () => ({ provider: DEFAULT_CHANNEL_PROVIDER, sessionRef: "s1", groupsCapability: "full" as const })),
      // Uma linha gravada de um grupo que o canal não lista mais: vira `presente: false`.
      listarLinhas: vi.fn(async () => [
        { group_chat_id: QUE_O_NUMERO_SAIU, subject: "Antigo", enabled: true, enabled_at: null, ia_responde: false },
      ]),
      contarLigados: vi.fn(async () => 1),
      gravarLinha: vi.fn(async () => ({ id: "x" })),
      definirIa: vi.fn(async () => null),
    },
    listGroups: vi.fn(async () => {
      if (opts.canalFora) throw new Error("timeout");
      return [{ chatId: DA_CONEXAO, subject: "Equipe" }];
    }),
    setGroupIntake: vi.fn(async () => true),
    audit: vi.fn(async () => {}),
    agora: () => new Date("2026-10-26T12:00:00.000Z"),
  };
}

const base = { organizationId: ORG, channelSessionId: CONEXAO, grupoAtual: null, conexaoAtual: null };

describe("confereGrupoDaConexao", () => {
  it("aceita um grupo em que o número da conexão está", async () => {
    expect(await confereGrupoDaConexao(deps(), { ...base, grupo: DA_CONEXAO })).toBe("ok");
  });

  it("recusa um grupo que não é desta conexão", async () => {
    expect(await confereGrupoDaConexao(deps(), { ...base, grupo: DE_OUTRO_NUMERO })).toBe("fora_da_conexao");
  });

  it("recusa como grupo novo um grupo de que o número já saiu", async () => {
    expect(await confereGrupoDaConexao(deps(), { ...base, grupo: QUE_O_NUMERO_SAIU })).toBe("fora_da_conexao");
  });

  it("o grupo já salvo passa sem perguntar ao canal", async () => {
    const d = deps({ canalFora: true });
    expect(
      await confereGrupoDaConexao(d, {
        ...base,
        grupo: QUE_O_NUMERO_SAIU,
        grupoAtual: QUE_O_NUMERO_SAIU,
        conexaoAtual: CONEXAO,
      }),
    ).toBe("ok");
    expect(d.listGroups).not.toHaveBeenCalled();
  });

  it("o mesmo grupo com OUTRA conexão consulta a lista da conexão nova", async () => {
    const d = deps();
    expect(
      await confereGrupoDaConexao(d, {
        ...base,
        grupo: QUE_O_NUMERO_SAIU,
        grupoAtual: QUE_O_NUMERO_SAIU,
        conexaoAtual: OUTRA_CONEXAO,
      }),
    ).toBe("fora_da_conexao");
    expect(d.listGroups).toHaveBeenCalled();
  });

  it("canal que não responde nunca vira `ok`", async () => {
    expect(await confereGrupoDaConexao(deps({ canalFora: true }), { ...base, grupo: DA_CONEXAO })).toBe("sem_resposta");
  });

  it("sem conexão não há grupo válido", async () => {
    expect(await confereGrupoDaConexao(deps(), { ...base, channelSessionId: null, grupo: DA_CONEXAO })).toBe(
      "fora_da_conexao",
    );
  });
});
