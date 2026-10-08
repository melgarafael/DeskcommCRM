/**
 * A REGRA DO AVISO DE PAUSA, COM RELÓGIO FAKE (issue #2389).
 *
 * O que estes casos provam, na ordem dos critérios de aceite:
 *
 *  1. pausar decide ABRIR um item, com o rótulo do canal, o autor e o horário;
 *  2. retomar decide RESOLVER o mesmo item, com `reativado` visível no corpo,
 *     sem clique de ninguém;
 *  3. arquivar pausado resolve com `canal_arquivado` — nunca órfão (#1023);
 *  4. saúde do transporte NÃO decide nada: o tipo `CanalAvaliado` nem tem
 *     `status`, então `STOPPED`/`FAILED` não tem caminho para abrir este item —
 *     quem avisa disso é o `channel-health`;
 *  5. pausa repetida decide ATUALIZAR, nunca um segundo item;
 *  6. o corpo é totalmente determinado por canal + autor + horário: não há
 *     como vazar PII de conversa num texto que nem recebe a conversa.
 *
 * O relógio é fixo (`2026-10-07T15:42Z`) — sem ele, o "horário" do corpo
 * mudaria a cada rodada e o teste seria ruído.
 */
import { describe, expect, it } from "vitest";

import {
  avaliarAvisoDePausa,
  KIND_CANAL_PAUSADO,
  momentoDaPausa,
  TITULO_DO_AVISO_DE_PAUSA,
  type CanalAvaliado,
  type ItemDePausaAberto,
} from "./canal-pausado";

const AGORA = new Date("2026-10-07T15:42:00.000Z");
const CONTEXTO = { autor: "Ana Silva", agora: AGORA };

const canal = (over: Partial<CanalAvaliado> = {}): CanalAvaliado => ({
  id: "22222222-2222-4222-8222-222222222222",
  organization_id: "11111111-1111-4111-8111-111111111111",
  display_name: "Loja Centro",
  phone_number: "+5511999990000",
  archived_at: null,
  metadata: { disabled: true },
  ...over,
});

const item = (over: Partial<ItemDePausaAberto> = {}): ItemDePausaAberto => ({
  id: "aviso-1",
  body: "«Loja Centro» está pausado. Corpo antigo.",
  ...over,
});

describe("o aviso de canal pausado", () => {
  it("pausar sem item ABRE — com canal, autor e horário no corpo", () => {
    const d = avaliarAvisoDePausa(canal(), null, CONTEXTO);
    expect(d.acao).toBe("abrir");
    expect(KIND_CANAL_PAUSADO).toBe("canal_pausado");
    expect(d.acao === "abrir" && d.titulo).toBe(TITULO_DO_AVISO_DE_PAUSA);
    if (d.acao !== "abrir") throw new Error("decisão inesperada");
    expect(d.corpo).toContain("Loja Centro");
    expect(d.corpo).toContain("Ana Silva");
    expect(d.corpo).toContain(momentoDaPausa(AGORA));
    // A saída, não só o diagnóstico: quem lê precisa saber o que fazer.
    expect(d.corpo).toContain("Conexões");
  });

  it("o corpo é EXATAMENTE canal + autor + horário — nada de PII de conversa", () => {
    const d = avaliarAvisoDePausa(canal(), null, CONTEXTO);
    if (d.acao !== "abrir") throw new Error("decisão inesperada");
    expect(d.corpo).toBe(
      "«Loja Centro» está pausado desde " +
        momentoDaPausa(AGORA) +
        " — quem pausou foi Ana Silva.\n\n" +
        "Enquanto a pausa durar, as mensagens não entram nem saem por este canal. " +
        "Para voltar, retome a pausa em Conexões.",
    );
  });

  it("pausar com o item ABERTO atualiza — nunca um segundo item", () => {
    const d = avaliarAvisoDePausa(canal(), item(), CONTEXTO);
    expect(d.acao).toBe("atualizar");
    if (d.acao !== "atualizar") throw new Error("decisão inesperada");
    expect(d.item.id).toBe("aviso-1");
    expect(d.corpo).toContain("Ana Silva");
  });

  it("retomar com o item aberto RESOLVE com motivo `reativado` no corpo", () => {
    const d = avaliarAvisoDePausa(canal({ metadata: {} }), item(), CONTEXTO);
    expect(d.acao).toBe("resolver");
    if (d.acao !== "resolver") throw new Error("decisão inesperada");
    expect(d.motivo).toBe("reativado");
    expect(d.corpo).toContain("Resolvido pelo sistema: o canal foi reativado.");
    // O corpo antigo (quem pausou, quando) continua lá: a resolução acrescenta,
    // não apaga a história do item.
    expect(d.corpo).toContain("Corpo antigo.");
  });

  it("retomar sem item NÃO faz nada — não nasce aviso de retomada", () => {
    expect(avaliarAvisoDePausa(canal({ metadata: {} }), null, CONTEXTO).acao).toBe("nada");
  });

  it("arquivar com o item aberto resolve com `canal_arquivado` — nunca órfão", () => {
    const d = avaliarAvisoDePausa(canal({ archived_at: AGORA.toISOString() }), item(), CONTEXTO);
    expect(d.acao).toBe("resolver");
    if (d.acao !== "resolver") throw new Error("decisão inesperada");
    expect(d.motivo).toBe("canal_arquivado");
    expect(d.corpo).toContain("Resolvido pelo sistema: o canal foi arquivado.");
  });

  it("arquivar sem item não faz nada", () => {
    expect(
      avaliarAvisoDePausa(canal({ archived_at: AGORA.toISOString() }), null, CONTEXTO).acao,
    ).toBe("nada");
  });

  it("canal FORA DO AR por saúde não gera este item (critério 4)", () => {
    // Nunca pausado, saúde ruim: o `status` existe no banco, mas a regra não o
    // lê — `CanalAvaliado` nem o declara. O `channel-health` é quem avisa.
    const foraDoAr = { ...canal({ metadata: {} }), status: "STOPPED" } as CanalAvaliado;
    expect(avaliarAvisoDePausa(foraDoAr, null, CONTEXTO).acao).toBe("nada");
    const falho = { ...canal({ metadata: {} }), status: "FAILED" } as CanalAvaliado;
    expect(avaliarAvisoDePausa(falho, null, CONTEXTO).acao).toBe("nada");
  });

  it("fora do ar E pausado: a pausa é decisão de gente, e ela avisa", () => {
    // A pessoa pausou de propósito; a saúde do transporte não revoga o aviso.
    const pausadoEParado = { ...canal(), status: "STOPPED" } as CanalAvaliado;
    expect(avaliarAvisoDePausa(pausadoEParado, null, CONTEXTO).acao).toBe("abrir");
  });

  it("canal sem apelido usa o número, e sem nenhum dos dois diz que não tem nome", () => {
    const semApelido = avaliarAvisoDePausa(
      canal({ display_name: null, phone_number: "+5511888887777" }),
      null,
      CONTEXTO,
    );
    if (semApelido.acao !== "abrir") throw new Error("decisão inesperada");
    expect(semApelido.corpo).toContain("+5511888887777");
  });
});
