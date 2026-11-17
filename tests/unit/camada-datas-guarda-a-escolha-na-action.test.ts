/**
 * A GRAVAÇÃO DA ESCOLHA DA CAMADA "DATAS DOS NEGÓCIOS" (#4436, item 1).
 *
 * O componente entrega a escolha, mas quem a faz sobreviver é esta action: ela
 * escreve em `raw_user_meta_data`, por PESSOA, e o RSC da Agenda lê de lá na
 * visita seguinte. O que este arquivo prende:
 *
 *   1. **O objeto INTEIRO vai para `camada_datas_dos_negocios`** — ligada,
 *      funil, campo e campo-fim. `updateUser` faz merge por chave de topo, e
 *      uma gravação parcial deixaria o resto como estava.
 *   2. **A régua é a da consulta.** `funilId` que não é uuid ou chave de campo
 *      fora da régua do funil são RECUSADOS antes de qualquer escrita: o que a
 *      rota responderia com 422 não pode virar escolha guardada.
 *   3. **As portas continuam as das outras actions de configuração**: sem
 *      sessão não grava, e em acompanhamento somente-leitura também não.
 *   4. **Falha do GoTrue não derruba a tela**: devolve código, e a camada segue
 *      como a pessoa a deixou nesta visita.
 *
 * Nada de banco aqui: a action só fala com `auth.updateUser`, e o dublê é o
 * recorte mínimo dele.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateUserMock } = vi.hoisted(() => ({ updateUserMock: vi.fn() }));

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/cache-curto", () => ({ invalidarUsuario: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: vi.fn(() => null) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { updateUser: updateUserMock } })),
}));

import { definirCamadaDatasDosNegocios } from "@/app/actions/settings/definirCamadaDatasDosNegocios";
import { CHAVE_DA_CAMADA } from "@/lib/agenda/preferencia-da-camada";
import { invalidarUsuario } from "@/lib/auth/cache-curto";
import { loadAuthUser } from "@/lib/auth/server";
import { supportWriteError } from "@/lib/impersonate/support";

const ESCOLHA = {
  ligada: true,
  funilId: "3f1c2a9e-7b1d-4a55-9c2f-6e8b0d1a2c34",
  campo: "data_inicio",
  campoFim: "data_fim",
};

beforeEach(() => {
  vi.clearAllMocks();
  updateUserMock.mockResolvedValue({ error: null });
  vi.mocked(loadAuthUser).mockResolvedValue({ id: "user-1", support: null } as never);
  vi.mocked(supportWriteError).mockReturnValue(null);
});

describe("definirCamadaDatasDosNegocios — a escolha vai para o metadata da pessoa", () => {
  it("grava a escolha INTEIRA sob a chave da camada, e invalida o cache da sessão", async () => {
    const resposta = await definirCamadaDatasDosNegocios(ESCOLHA);

    expect(resposta).toEqual({ ok: true, escolha: ESCOLHA });
    // O objeto inteiro: é o que o RSC lê na visita seguinte.
    expect(updateUserMock).toHaveBeenCalledTimes(1);
    expect(updateUserMock).toHaveBeenCalledWith({ data: { [CHAVE_DA_CAMADA]: ESCOLHA } });
    // Sem isto, a próxima tela leria o metadata VELHO e a camada voltaria
    // desligada — o defeito que esta entrega fecha.
    expect(invalidarUsuario).toHaveBeenCalledWith("user-1");
  });

  it("grava também a camada DESLIGADA com o funil e o campo — desligar não esquece a escolha", async () => {
    const desligada = { ...ESCOLHA, ligada: false };

    expect(await definirCamadaDatasDosNegocios(desligada)).toEqual({ ok: true, escolha: desligada });
    expect(updateUserMock).toHaveBeenCalledWith({ data: { [CHAVE_DA_CAMADA]: desligada } });
  });

  it("NÃO grava escolha fora da régua da consulta: id que não é uuid e chave de campo inválida", async () => {
    const idTorto = { ...ESCOLHA, funilId: "p-viagens" };
    const chaveTorta = { ...ESCOLHA, campo: "data inicio" };

    expect(await definirCamadaDatasDosNegocios(idTorto)).toEqual({
      ok: false,
      erro: "validacao",
    });
    expect(await definirCamadaDatasDosNegocios(chaveTorta)).toEqual({
      ok: false,
      erro: "validacao",
    });
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("sem sessão não grava", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(null);

    expect(await definirCamadaDatasDosNegocios(ESCOLHA)).toEqual({ ok: false, erro: "sessao" });
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("em acompanhamento somente-leitura não grava", async () => {
    vi.mocked(supportWriteError).mockReturnValue("Este acompanhamento permite somente leitura.");

    expect(await definirCamadaDatasDosNegocios(ESCOLHA)).toEqual({
      ok: false,
      erro: "somente_leitura",
    });
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("falha do GoTrue vira código, não exceção: a camada não pode quebrar a Agenda", async () => {
    updateUserMock.mockResolvedValue({ error: { message: "indisponível" } });

    await expect(definirCamadaDatasDosNegocios(ESCOLHA)).resolves.toEqual({
      ok: false,
      erro: "falha",
    });
  });
});
