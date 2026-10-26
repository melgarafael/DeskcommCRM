import { describe, expect, it } from "vitest";

import {
  CAPACIDADES_DE_EFEITO,
  CAPACIDADES_DE_PORTA,
  EFEITO_DA_CAPACIDADE,
  PORTA_DA_CAPACIDADE,
} from "@/lib/extensions/capacidades";
import { checkCompatibility } from "@/lib/extensions/manifest";
import { openRequestSchema } from "@/lib/extensions/requests";

/**
 * TODO PONTO DO CAMINHO ACEITA O VOCABULÁRIO INTEIRO — não só o que existia quando ele nasceu.
 *
 * ─── O defeito, que foi real e chegou ao CI ─────────────────────────────────
 *
 * A ADR-0003 ampliou as capacidades de uma para seis. O manifesto passou a aceitar as seis, o
 * mapa do host passou a resolver as seis — e `openRequestSchema`, que valida o PEDIDO HTTP do
 * clique, continuou com `z.literal("tasks.open")`.
 *
 * Efeito no produto: uma extensão com porta nova instalava, aparecia na tela, ativava — e o
 * botão dela NÃO ABRIA NADA. O servidor recusava o pedido antes de chegar ao resolvedor.
 *
 * ─── Por que nenhum teste pegou, e por que este é diferente ─────────────────
 *
 * Todos os testes exercitavam o manifesto e o mapa, e os dois estavam certos. O caminho HTTP
 * completo só era percorrido pela prova em tela — que achou, depois de sete rodadas.
 *
 * Este arquivo percorre CADA capacidade por TODOS os pontos do caminho, e é barato: roda em
 * milissegundos, no lugar onde a pessoa edita. Um ponto novo que nasça com literal em vez do
 * vocabulário reprova aqui, e não vinte minutos depois.
 */

const manifestoBase = {
  format_version: 1 as const,
  profile: "declarative" as const,
  host_api: { min: 1, max: 2 },
  dependencies: [] as [],
};

/**
 * O vocabulário tem DUAS naturezas desde o #3076, e o caminho é percorrido em cada uma:
 *
 *   `porta`  — `CAPACIDADES_DE_PORTA`: abre tela, tem destino no mapa do host e é aceita pelo
 *              pedido HTTP do clique (`openRequestSchema`).
 *   `efeito` — `CAPACIDADES_DE_EFEITO`: age na conversa, NÃO tem destino e o pedido de porta a
 *              RECUSA. Dar-lhe uma entrada aqui seria abrir navegação para o que não navega;
 *              recusá-la no schema é a mesma cerca vista do outro lado.
 *
 * Percorrer só a primeira lista deixaria a segunda sem prova; foi assim que o defeito original
 * (schema com `z.literal`) sobreviveu a sete rodadas até a prova em tela achar.
 */
describe("o caminho da porta aceita o vocabulário inteiro", () => {
  it.each([...CAPACIDADES_DE_PORTA])(
    "%s é aceita pelo schema do pedido HTTP",
    (capacidade) => {
      const r = openRequestSchema.safeParse({
        capability: capacidade,
        expected_revision: 1,
        card_id: "um-cartao",
      });
      expect(
        r.success,
        `o schema do pedido recusa ${capacidade}: o botão não abre nada, e o defeito só aparece em tela`,
      ).toBe(true);
    },
  );

  it.each([...CAPACIDADES_DE_PORTA])("%s tem porta no mapa do host", (capacidade) => {
    expect(PORTA_DA_CAPACIDADE[capacidade].destino).toBeTruthy();
  });

  it.each([...CAPACIDADES_DE_EFEITO])(
    "%s tem efeito no mapa do host e o pedido de PORTA a recusa",
    (capacidade) => {
      expect(EFEITO_DA_CAPACIDADE[capacidade].permissao).toMatch(/^turn\./);
      const r = openRequestSchema.safeParse({
        capability: capacidade,
        expected_revision: 1,
        card_id: "um-cartao",
      });
      expect(r.success, `${capacidade} navegaria: o schema do clique a aceitou`).toBe(false);
    },
  );

  it.each([...CAPACIDADES_DE_PORTA])(
    "%s é compatível quando a permissão dela está declarada",
    (capacidade) => {
      const permissao = PORTA_DA_CAPACIDADE[capacidade].permissao;
      const compat = checkCompatibility({
        ...manifestoBase,
        permissions: [permissao],
        contributions: {
          crm_cards: [{ action: { capability: capacidade } }],
        } as never,
      });
      expect(compat.reason, `${capacidade} recusada com ${permissao} declarada`).toBeNull();
    },
  );

  it("controle: o schema RECUSA o que não é capacidade", () => {
    // Sem este caso, um schema que aceitasse qualquer string passaria nos anteriores.
    for (const invalida of ["settings.open", "tasks.open ", "", "/app/tasks"]) {
      const r = openRequestSchema.safeParse({
        capability: invalida,
        expected_revision: 1,
        card_id: "um-cartao",
      });
      expect(r.success, `o schema aceitou ${JSON.stringify(invalida)}`).toBe(false);
    }
  });
});
