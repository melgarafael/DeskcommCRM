/**
 * A CONTA DESCONECTADA VIRA **UM** AVISO NA CENTRAL — E ELE FECHA SOZINHO
 * (#3371, fatia 2).
 *
 * ## O que aconteceu em produção
 *
 * Cliente Obralivre: 107 turnos seguidos com `401 · Provided authentication token
 * is expired`, ~26 h sem a IA responder, cota sobrando — e a Central de avisos
 * VAZIA. O único vestígio era `llm_calls`, que ninguém abre para descobrir que o
 * problema é um login vencido.
 *
 * ## As duas metades que este arquivo mede
 *
 *  1. UM por incidente: 107 turnos não podem virar 107 avisos. Depois do
 *     primeiro, cada turno ATUALIZA o mesmo item — e a Central tem UM.
 *  2. Fecha sozinho quando o login volta: aviso que só sai no clique de alguém
 *     vira lista que ninguém lê (mesmo padrão do `canal-pausado` do #2389).
 *
 * E o recorte que impede o alarme falso: recusa que NÃO é de login (`recusa ===
 * null`) não anuncia conta desconectada — reconectar não conserta uma falha de
 * rede, e o aviso mandaria o operador mexer na conta certa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  avaliarAvisoDaAssinatura,
  corpoDoAvisoDeAssinatura,
  KIND_ASSINATURA_DESCONECTADA,
  TITULO_DO_AVISO_DE_ASSINATURA,
  type ItemDaAssinaturaAberto,
} from "@/lib/ai/credenciais/assinatura-desconectada";
import { sincronizarAvisoDaAssinatura } from "@/lib/ai/credenciais/aviso-da-assinatura";

import { FakeSupabase } from "./helpers/fake-ai-credentials";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = "44444444-4444-4444-8444-444444444444";

describe("a regra: 107 turnos, UM aviso", () => {
  it("⭐ a primeira recusa ABRE; as 106 seguintes ATUALIZAM o mesmo item", () => {
    const decisoes = [];
    let item: ItemDaAssinaturaAberto | null = null;
    for (let turno = 0; turno < 107; turno += 1) {
      const decisao = avaliarAvisoDaAssinatura(
        { conectada: false, recusa: "refresh_token_revoked" },
        item,
      );
      decisoes.push(decisao);
      // O que o aplicador faria depois de cada decisão.
      if (decisao.acao === "abrir") item = { id: "item-1", body: decisao.corpo };
      if (decisao.acao === "atualizar") item = { id: "item-1", body: decisao.corpo };
    }

    expect(decisoes.filter((d) => d.acao === "abrir")).toHaveLength(1);
    expect(decisoes.filter((d) => d.acao === "atualizar")).toHaveLength(106);
    expect(decisoes[0]?.acao).toBe("abrir");
    expect(decisoes.slice(1).every((d) => d.acao === "atualizar")).toBe(true);
    if (decisoes[0]?.acao !== "abrir") throw new Error("primeira decisão não abriu");
    expect(decisoes[0].titulo).toBe(TITULO_DO_AVISO_DE_ASSINATURA);
    // O corpo fala com quem atende, e diz que a cota não é o problema: foi a
    // primeira hipótese de quem olhou o caso.
    expect(decisoes[0].corpo).toContain("IA não responde aos clientes");
    expect(decisoes[0].corpo).toContain("cota da assinatura NÃO é o problema");
    // O rótulo cru da fatia 3 vira frase — `refresh_token_revoked` não pode
    // aparecer na tela de quem administra um negócio.
    expect(decisoes[0].corpo).not.toContain("refresh_token_revoked");
    expect(decisoes[0].corpo).toContain("revogou o acesso da conta");
  });

  it("⭐ o login voltando RESOLVE o item aberto — e nada acontece se ele não existia", () => {
    const resolvida = avaliarAvisoDaAssinatura({ conectada: true, recusa: null }, {
      id: "item-1",
      body: corpoDoAvisoDeAssinatura("invalid_grant"),
    });
    expect(resolvida.acao).toBe("resolver");

    expect(avaliarAvisoDaAssinatura({ conectada: true, recusa: null }, null)).toEqual({
      acao: "nada",
    });
  });

  it("⭐ o motivo chega no formato que o turno passa (`falha:<rótulo>`), não só o rótulo puro", () => {
    // `run-model-call.ts` grava `${r.motivo}:${r.motivoDetalhe}`; o mapa era
    // consultado pela string inteira e todo aviso real dizia "sem motivo".
    const corpo = corpoDoAvisoDeAssinatura("falha:refresh_token_revoked");
    expect(corpo).toContain("revogou o acesso da conta");
    expect(corpo).not.toContain("sem motivo identificado");
    expect(corpoDoAvisoDeAssinatura("falha")).toContain("sem motivo identificado");
  });

  it("recusa que NÃO é de login não anuncia conta desconectada", () => {
    expect(avaliarAvisoDaAssinatura({ conectada: false, recusa: null }, null)).toEqual({
      acao: "nada",
    });
  });
});

describe("o aplicador: o item é UM na Central", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("⭐ dois turnos seguidos: um INSERT só, e o segundo é UPDATE", async () => {
    const db = new FakeSupabase();

    const primeiro = await sincronizarAvisoDaAssinatura(db as never, {
      organizationId: ORG,
      conectada: false,
      recusa: "falha:refresh_token_revoked",
    });
    const segundo = await sincronizarAvisoDaAssinatura(db as never, {
      organizationId: ORG,
      conectada: false,
      recusa: "falha:refresh_token_revoked",
    });

    expect(primeiro).toBe("aberto");
    expect(segundo).toBe("atualizado");
    const insercoes = db.operacoes.filter((o) => o.tipo === "insert");
    expect(insercoes, "107 turnos = 107 avisos").toHaveLength(1);
    expect(insercoes[0]?.dados).toMatchObject({
      organization_id: ORG,
      kind: KIND_ASSINATURA_DESCONECTADA,
      // `critical`: o cliente já está sem resposta. É o alarme que a Central
      // reserva para o que já custou cliente.
      severity: "critical",
      status: "open",
      title: TITULO_DO_AVISO_DE_ASSINATURA,
    });
    // Nem `ref_kind` nem `ref_id`: o botão é o da tela de Credenciais.
    expect(insercoes[0]?.dados).not.toHaveProperty("ref_kind");
    expect(insercoes[0]?.dados).not.toHaveProperty("ref_id");
    expect(db.linha?.kind).toBe("assinatura_desconectada");
  });

  it("⭐ quando o login volta, o MESMO item fecha sozinho", async () => {
    const db = new FakeSupabase();
    await sincronizarAvisoDaAssinatura(db as never, {
      organizationId: ORG,
      conectada: false,
      recusa: "token_expired",
    });
    const idDoItem = db.linha?.id;
    expect(idDoItem).toBeDefined();

    const desfecho = await sincronizarAvisoDaAssinatura(db as never, {
      organizationId: ORG,
      conectada: true,
      recusa: null,
    });

    expect(desfecho).toBe("resolvido");
    expect(db.linha?.status).toBe("resolved");
    expect(db.linha?.id).toBe(idDoItem);
    expect(String(db.linha?.body)).toContain("login da conta foi renovado");
    // Fechar não cria um segundo item.
    expect(db.operacoes.filter((o) => o.tipo === "insert")).toHaveLength(1);
  });

  it("sem item aberto e com o login bom, não escreve nada", async () => {
    const db = new FakeSupabase();
    const desfecho = await sincronizarAvisoDaAssinatura(db as never, {
      organizationId: ORG,
      conectada: true,
      recusa: null,
    });
    expect(desfecho).toBe("sem_mudanca");
    expect(db.operacoes.filter((o) => o.tipo !== "select")).toHaveLength(0);
  });
});
