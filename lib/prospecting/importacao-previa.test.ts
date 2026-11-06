import { describe, expect, it } from "vitest";

import type { Prospect } from "@/lib/prospecting/schema";
import {
  MOTIVOS_DE_EXCLUSAO,
  TEXTO_DO_MOTIVO,
  montarPrevia,
  type CandidatoNaPlanilha,
  type LinhaExcluida,
} from "./importacao-previa";

function prospect(phone: string, name = "Empresa Exemplo"): Prospect & { phone: string } {
  return {
    key: `planilha:${phone}`,
    name,
    phone,
    website: null,
    category: null,
    address: null,
    maps_url: null,
    rating: null,
    reviews: null,
    emails: [],
    socials: [],
  };
}

function candidato(linha: number, phone: string): CandidatoNaPlanilha {
  return { linha, prospect: prospect(phone) };
}

const FONE_A = "+5511900000001";
const FONE_B = "+5511900000002";
const FONE_C = "+5511900000003";

function semFontes() {
  return { contatos: new Set<string>(), suprimidos: new Set<string>() };
}

describe("montarPrevia — o que entra e o que fica de fora", () => {
  it("sem nada contra, todo mundo entra e ninguém é recusado", () => {
    const previa = montarPrevia(
      { candidatos: [candidato(2, FONE_A), candidato(3, FONE_B)], erros: [] },
      semFontes(),
    );
    expect(previa.entram.map((c) => c.linha)).toEqual([2, 3]);
    expect(previa.fora).toEqual([]);
    expect(previa.total_linhas).toBe(2);
  });

  it("o telefone que já é contato do CRM fica de fora com o motivo escrito", () => {
    const previa = montarPrevia(
      { candidatos: [candidato(2, FONE_A), candidato(3, FONE_B)], erros: [] },
      { contatos: new Set([FONE_B]), suprimidos: new Set<string>() },
    );
    expect(previa.entram.map((c) => c.prospect.phone)).toEqual([FONE_A]);
    expect(previa.fora).toEqual([
      {
        linha: 3,
        telefone: FONE_B,
        codigo: "contato_do_crm",
        motivo: TEXTO_DO_MOTIVO.contato_do_crm,
      },
    ]);
    expect(previa.resumo.contato_do_crm).toBe(1);
  });

  it("quem pediu exclusão (LGPD) sai como LGPD mesmo sendo contato do CRM", () => {
    // A ordem das perguntas é o contrato: um titular suprimido que também tem ficha no CRM
    // aparece como "excluído a pedido do titular", nunca como duplicata. Trocar o motivo
    // esconde a supressão de quem precisa vê-la.
    const previa = montarPrevia(
      { candidatos: [candidato(2, FONE_A)], erros: [] },
      { contatos: new Set([FONE_A]), suprimidos: new Set([FONE_A]) },
    );
    expect(previa.entram).toEqual([]);
    expect(previa.fora[0]).toMatchObject({ codigo: "suprimido_lgpd", linha: 2 });
    expect(previa.resumo.suprimido_lgpd).toBe(1);
    expect(previa.resumo.contato_do_crm).toBe(0);
  });

  it("as recusas da própria planilha contam no total e no resumo, sem perder a linha", () => {
    const erros: LinhaExcluida[] = [
      { linha: 3, telefone: null, codigo: "sem_telefone", motivo: TEXTO_DO_MOTIVO.sem_telefone },
      {
        linha: 4,
        telefone: null,
        codigo: "telefone_invalido",
        motivo: TEXTO_DO_MOTIVO.telefone_invalido,
      },
    ];
    const previa = montarPrevia({ candidatos: [candidato(2, FONE_A)], erros }, semFontes());
    expect(previa.total_linhas).toBe(3);
    expect(previa.resumo.sem_telefone).toBe(1);
    expect(previa.resumo.telefone_invalido).toBe(1);
  });

  it("a saída sai na ordem da planilha, misturando as recusas do arquivo com as do banco", () => {
    const erros: LinhaExcluida[] = [
      { linha: 4, telefone: null, codigo: "sem_nome", motivo: TEXTO_DO_MOTIVO.sem_nome },
    ];
    const previa = montarPrevia(
      { candidatos: [candidato(2, FONE_A), candidato(3, FONE_B), candidato(5, FONE_C)], erros },
      { contatos: new Set([FONE_C]), suprimidos: new Set([FONE_B]) },
    );
    expect(previa.fora.map((f) => [f.linha, f.codigo])).toEqual([
      [3, "suprimido_lgpd"],
      [4, "sem_nome"],
      [5, "contato_do_crm"],
    ]);
  });

  it("o resumo traz TODOS os motivos, inclusive os zerados, para a tela não esconder coluna", () => {
    const previa = montarPrevia({ candidatos: [candidato(2, FONE_A)], erros: [] }, semFontes());
    expect(Object.keys(previa.resumo).sort()).toEqual([...MOTIVOS_DE_EXCLUSAO].sort());
    expect(Object.values(previa.resumo).every((n) => n === 0)).toBe(true);
  });
});
