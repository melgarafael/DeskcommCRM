/**
 * O AVISO DE PROCESSAMENTO QUE PAROU É LIDO POR QUEM NÃO PROGRAMA.
 *
 * Na QA do lote 9 da triagem, pela tela: o corpo do `event_dead` abria com
 * `O evento "media.persist_requested" falhou 5 vezes… Motivo: media_persist_v1:
 * fetch failed`, e o do despacho da IA com a frase do Postgres em inglês
 * `insert or update on table "job_queue" violates foreign key constraint…`.
 *
 * A regra: o que aconteceu e o que fazer vêm primeiro, em português; o nome do
 * evento e o motivo cru ficam no fim, depois de `DETALHE_TECNICO` — presentes,
 * porque são a pista de quem der suporte.
 */
import { describe, expect, it } from "vitest";

import { avisoDeEventoMorto, DETALHE_TECNICO, IA_QUE_NAO_RESPONDEU } from "@/lib/event-log/aviso-de-evento-morto";

/** `media.persist_requested`, `ai_agent.dispatch_requested`, `media_persist_v1`. */
const IDENTIFICADOR_TECNICO = /\b[a-z][a-z0-9]*(?:[._][a-z0-9]+)+\b/;

/** Inglês que chega cru de banco e de rede — os motivos medidos na QA e vizinhos. */
const INGLES_DE_INFRA = /violates|foreign key|constraint|insert or update|duplicate key|null value|fetch failed|does not exist|timeout|ECONNREFUSED/i;

const CASOS = [
  {
    nome: "genérico (mídia)",
    evento: { eventType: "media.persist_requested", tentativas: 5, motivo: "media_persist_v1: fetch failed" },
  },
  {
    nome: "despacho da IA",
    evento: {
      eventType: "ai_agent.dispatch_requested",
      tentativas: 5,
      motivo:
        'insert or update on table "job_queue" violates foreign key constraint "job_queue_contact_id_fkey"',
      efeito: IA_QUE_NAO_RESPONDEU,
    },
  },
];

function partes(corpo: string): { leitura: string; detalhe: string } {
  const i = corpo.indexOf(DETALHE_TECNICO);
  return { leitura: i < 0 ? corpo : corpo.slice(0, i), detalhe: i < 0 ? "" : corpo.slice(i) };
}

describe("aviso de evento morto, para quem lê a Central", () => {
  it("o instrumento reconhece o texto técnico (controle)", () => {
    // Sem isto, uma regex que não casasse nada deixaria os casos abaixo verdes.
    expect('O evento "media.persist_requested" falhou').toMatch(IDENTIFICADOR_TECNICO);
    expect("media_persist_v1: fetch failed").toMatch(IDENTIFICADOR_TECNICO);
    expect('insert or update on table "job_queue" violates foreign key').toMatch(INGLES_DE_INFRA);
    expect("Um cliente escreveu e a IA não respondeu. Abra o Inbox.").not.toMatch(IDENTIFICADOR_TECNICO);
  });

  for (const { nome, evento } of CASOS) {
    it(`${nome}: o corpo começa sem nome de evento nem inglês de infraestrutura`, () => {
      // O TÍTULO fica de fora de propósito: o genérico ainda leva o nome do
      // evento, fixado por um invariante congelado (ver o cabeçalho de
      // `aviso-de-evento-morto.ts`).
      const { body } = avisoDeEventoMorto(evento);
      const { leitura } = partes(body);

      expect(leitura.trim().length, "o corpo começa direto no detalhe técnico").toBeGreaterThan(40);
      expect(leitura, "nome técnico antes do rótulo").not.toMatch(IDENTIFICADOR_TECNICO);
      expect(leitura, "inglês de infraestrutura antes do rótulo").not.toMatch(INGLES_DE_INFRA);
      // O que a tela oferece continua dito: resolver o aviso para voltar a ser avisado.
      expect(leitura).toMatch(/marque-o como resolvido/);
    });

    it(`${nome}: o detalhe técnico continua lá, inteiro e no fim`, () => {
      const { body } = avisoDeEventoMorto(evento);
      const { detalhe } = partes(body);

      expect(body.split(DETALHE_TECNICO).length - 1, "o rótulo aparece uma vez").toBe(1);
      expect(detalhe).toContain(evento.eventType);
      expect(detalhe).toContain(evento.motivo);
      expect(detalhe).toContain(`${evento.tentativas} tentativas`);
      expect(body.endsWith(evento.motivo), "algo veio depois do detalhe técnico").toBe(true);
    });
  }
});
