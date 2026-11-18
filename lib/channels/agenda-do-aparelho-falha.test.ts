// @vitest-environment node
/**
 * A CLASSIFICAÇÃO DA FALHA DA AGENDA (#4102).
 *
 * Cada linha desta tabela é uma AÇÃO diferente para o operador: um 400 em
 * `contacts/all` pede ligar "Guardar o histórico anterior à vinculação"; um
 * timeout pede conferir a conexão; 401/403 pede reconectar; 5xx pede esperar.
 * Enquanto os quatro viravam a mesma frase, quem tinha o número conectado lia
 * que ele não respondia.
 *
 * A entrada aqui é o erro CRU do transporte (`waha_<operação>_<status>` /
 * `waha_timeout: …`), que é exatamente o que `sincronizarAgendaDoCelular`
 * repassa sem tocar — por isso o teste não monta classe nenhuma: ele mede o
 * contrato que chega.
 */
import { describe, expect, it } from "vitest";

import {
  classificarFalhaDaAgenda,
  FalhaDaAgendaDoAparelho,
  type MotivoDaFalhaDaAgenda,
} from "./agenda-do-aparelho-falha";

function motivo(causa: string): MotivoDaFalhaDaAgenda {
  return classificarFalhaDaAgenda(new Error(causa)).motivo;
}

describe("classificarFalhaDaAgenda", () => {
  it("400 do contacts/all é o store da sessão desligado — não é queda do número", () => {
    // O relato do #4102: `"causa":"waha_contacts_all_400"` no log do servidor.
    expect(motivo("waha_contacts_all_400")).toBe("acervo_desligado");
  });

  it("401 e 403 são sessão recusada, não acervo desligado", () => {
    expect(motivo("waha_contacts_all_401")).toBe("sessao_recusada");
    expect(motivo("waha_contacts_all_403")).toBe("sessao_recusada");
  });

  it("5xx é falha do servidor do canal", () => {
    expect(motivo("waha_contacts_all_500")).toBe("servidor");
    expect(motivo("waha_contacts_all_503")).toBe("servidor");
  });

  it("relógio e rede são 'não respondeu' — o único caso que merece essa frase", () => {
    expect(motivo("waha_timeout: o WAHA não respondeu em 8000ms (/api/contacts/all)")).toBe(
      "sem_resposta",
    );
    expect(motivo("fetch failed")).toBe("sem_resposta");
    expect(motivo("connect ECONNREFUSED 10.0.0.2:3000")).toBe("sem_resposta");
  });

  it("o que não se sabe não ganha causa inventada", () => {
    expect(motivo("waha_not_configured")).toBe("indisponivel");
    expect(motivo("falha_do_transporte_503: corpo do provedor")).toBe("indisponivel");
  });

  it("preserva a causa técnica e não classifica duas vezes", () => {
    const falha = classificarFalhaDaAgenda(new Error("waha_contacts_all_400"));
    expect(falha).toBeInstanceOf(FalhaDaAgendaDoAparelho);
    expect(falha.causa).toBe("waha_contacts_all_400");
    // Já classificada, volta como está — o motivo não se perde no caminho.
    expect(classificarFalhaDaAgenda(falha)).toBe(falha);
  });
});
