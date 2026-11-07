/**
 * QUEM VIRA CONVIDADO, E COM QUAL E-MAIL (#4006, itens 1 e 2).
 *
 * O convite do Google precisa do endereço da conta GOOGLE da pessoa (a
 * saudável; sem ela, o login) — mandar para o login de quem conectou outra
 * conta põe o convite numa caixa que ninguém abre. E o convidado não vira dono:
 * a lista é de participação, não de carteira.
 */
import { describe, expect, it } from "vitest";

import {
  MAXIMO_DE_CONVIDADOS,
  PAPEL_MINIMO_DO_CONVIDADO,
  convidadosDaEquipe,
  convidadosDaEquipeQuandoAutomatico,
  emailDoConvidado,
  normalizarIdsDeConvidados,
  podeConvidarDaEquipe,
  type MembroConvidavel,
} from "@/lib/agenda/convidados-da-equipe";

const SDR: MembroConvidavel = {
  user_id: "11111111-1111-4111-8111-111111111111",
  nome: "SDR",
  emailDeLogin: "sdr@empresa.test",
  emailGoogle: "sdr.agenda@gmail.test",
  googleSaudavel: true,
  ativo: true,
};

const GESTOR: MembroConvidavel = {
  user_id: "22222222-2222-4222-8222-222222222222",
  nome: "Gestor",
  emailDeLogin: "gestor@empresa.test",
  emailGoogle: "gestor.agenda@gmail.test",
  googleSaudavel: false,
  ativo: true,
};

describe("a mesma régua de permissão da agenda", () => {
  it("o piso é `agent` — o mesmo da lista de pessoas e dos verbos da agenda", () => {
    expect(PAPEL_MINIMO_DO_CONVIDADO).toBe("agent");
    expect(podeConvidarDaEquipe("agent")).toBe(true);
    expect(podeConvidarDaEquipe("manager")).toBe(true);
    expect(podeConvidarDaEquipe("admin")).toBe(true);
    expect(podeConvidarDaEquipe("viewer")).toBe(false);
    expect(podeConvidarDaEquipe(null)).toBe(false);
  });
});

describe("qual e-mail recebe o convite", () => {
  it("conta Google saudável vence o login", () => {
    expect(emailDoConvidado(SDR)).toBe("sdr.agenda@gmail.test");
  });

  it("conexão CAÍDA cai no e-mail de login — o convite não pode ir para conta morta", () => {
    expect(emailDoConvidado(GESTOR)).toBe("gestor@empresa.test");
  });

  it("sem login e sem Google não há convidado", () => {
    expect(emailDoConvidado({ ...SDR, emailDeLogin: "  ", googleSaudavel: false })).toBeNull();
  });
});

describe("normalizar a lista", () => {
  it("tira repetido, tira o DONO e mantém a ordem escolhida", () => {
    const ids = normalizarIdsDeConvidados(
      [SDR.user_id, SDR.user_id, GESTOR.user_id, "  ", SDR.user_id],
      GESTOR.user_id,
    );
    expect(ids).toEqual([SDR.user_id]);
  });

  it("respeita o teto de convidados", () => {
    const muitos = Array.from({ length: MAXIMO_DE_CONVIDADOS + 5 }, (_, i) => `id-${i}`);
    expect(normalizarIdsDeConvidados(muitos, null)).toHaveLength(MAXIMO_DE_CONVIDADOS);
  });

  it("lista ausente vira lista vazia, não erro", () => {
    expect(normalizarIdsDeConvidados(null, null)).toEqual([]);
    expect(normalizarIdsDeConvidados(undefined, "x")).toEqual([]);
  });
});

describe("resolver os convidados", () => {
  it("membro inativo (ou desconhecido) NÃO recebe convite", () => {
    const membros = [{ ...SDR, ativo: false }, GESTOR];
    expect(convidadosDaEquipe(membros, [SDR.user_id, GESTOR.user_id])).toEqual([
      { email: "gestor@empresa.test", nome: "Gestor" },
    ]);
    expect(convidadosDaEquipe(membros, ["33333333-3333-4333-8333-333333333333"])).toEqual([]);
  });

  it("dois membros com o MESMO e-mail entram uma vez só", () => {
    const mesmoEmail: MembroConvidavel = { ...GESTOR, emailDeLogin: "sdr.agenda@gmail.test" };
    const lista = convidadosDaEquipe([SDR, mesmoEmail], [SDR.user_id, GESTOR.user_id]);
    expect(lista).toEqual([{ email: "sdr.agenda@gmail.test", nome: "SDR" }]);
  });

  it("o caminho automático usa SÓ os padrão do tipo — a IA nunca escolhe gente", () => {
    expect(convidadosDaEquipeQuandoAutomatico([SDR.user_id])).toEqual([SDR.user_id]);
    expect(convidadosDaEquipeQuandoAutomatico(null)).toEqual([]);
  });
});
