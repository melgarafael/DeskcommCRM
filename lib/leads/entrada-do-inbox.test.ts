/**
 * A LEITURA DO AJUSTE DA ENTRADA DO INBOX (#3011).
 *
 * Uma régua só para jsonb escrito por fora: `entradaDoInboxDeclarada` é o que a
 * TELA (para abrir o seletor na escolha feita), o `updatePipelineConfig` (para
 * gravar) e `nascimento-do-lead` (para escolher a etapa) leem. Lixo gravado à
 * mão — string onde devia haver objeto, `ativa: "sim"`, `stage_id` que não é
 * uuid — não pode virar etapa nenhuma, e `ativa: false` com etapa lembrada é um
 * estado VÁLIDO de propósito: desligar não apaga a escolha.
 */
import { describe, expect, it } from "vitest";

import { entradaDoInboxDeclarada } from "./entrada-do-inbox";

const ETAPA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("entradaDoInboxDeclarada", () => {
  it("sem settings, sem chave ou com lixo: tudo é o comportamento de sempre", () => {
    for (const settings of [
      null,
      undefined,
      {},
      { entrada_do_inbox: null },
      { entrada_do_inbox: "ligado" },
      { entrada_do_inbox: { ativa: "sim", stage_id: ETAPA } },
      { entrada_do_inbox: { stage_id: ETAPA } },
    ]) {
      expect(entradaDoInboxDeclarada(settings), JSON.stringify(settings)).toEqual({
        ativa: false,
        stage_id: null,
      });
    }
  });

  it("só o `true` explícito liga", () => {
    expect(entradaDoInboxDeclarada({ entrada_do_inbox: { ativa: true, stage_id: ETAPA } })).toEqual({
      ativa: true,
      stage_id: ETAPA,
    });
    expect(entradaDoInboxDeclarada({ entrada_do_inbox: { ativa: false, stage_id: ETAPA } })).toEqual({
      ativa: false,
      stage_id: ETAPA,
    });
  });

  it("etapa lembrada sobrevive ao ajuste desligado — religar não obriga a escolher de novo", () => {
    expect(entradaDoInboxDeclarada({ entrada_do_inbox: { ativa: false, stage_id: ETAPA } }).stage_id).toBe(
      ETAPA,
    );
  });

  it("ligado sem etapa não aponta para lugar nenhum, e etapa em branco derruba o bloco", () => {
    // Sem `stage_id` o schema aceita (a chave é opcional para a tela poder
    // desligar sem perder a etapa) — o ajuste fica ligado sem destino, e quem
    // aplica cai na primeira etapa.
    expect(entradaDoInboxDeclarada({ entrada_do_inbox: { ativa: true } })).toEqual({
      ativa: true,
      stage_id: null,
    });
    // `""` não tem forma de identificador, então o safeParse recusa o bloco
    // INTEIRO: é a mesma régua da gravação, e é de propósito — um ajuste com
    // valor corrompido não vale nada, e o comportamento de sempre volta.
    expect(entradaDoInboxDeclarada({ entrada_do_inbox: { ativa: true, stage_id: "" } })).toEqual({
      ativa: false,
      stage_id: null,
    });
    expect(
      entradaDoInboxDeclarada({ entrada_do_inbox: { ativa: true, stage_id: "primeira" } }),
    ).toEqual({ ativa: false, stage_id: null });
  });
});
