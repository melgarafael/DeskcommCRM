/**
 * O MESMO CASO NÃO VIRA DOIS AVISOS NO CELULAR DA EQUIPE.
 *
 * Três forças empurram para a duplicata, e nenhuma delas é hipotética:
 *
 *   1. o dreno do `event_log` REENTREGA a mesma linha em retry;
 *   2. há TRÊS drenos em processos diferentes (cron, worker, e o atalho de
 *      desenvolvimento dentro da requisição) lendo a mesma fila;
 *   3. o handler faz uma chamada de rede no meio — e um processo que morra
 *      entre o envio e a gravação do `enviado` deixa a linha `pendente` com a
 *      mensagem já no celular de alguém.
 *
 * A defesa é a `unique (organization_id, case_id, destino)`: o handler
 * REIVINDICA a entrega ANTES de tocar a rede, e o `23505` é o sinal de que
 * outro processo chegou primeiro. Mandar duas vezes é pior que mandar tarde —
 * a equipe aprende a ignorar um canal que repete.
 */
import { describe, expect, it } from "vitest";

import {
  EVENTO_CASO_ABERTO,
  TETO_ABSOLUTO_DE_TENTATIVAS,
  VALIDADE_DA_ENTREGA_MS,
  aplicaAvisoDeCaso,
  type AvisoDeps,
} from "@/lib/escalacao/aviso-ao-suporte";
import type { EventRow } from "@/lib/event-log/dispatcher";

const AGORA = new Date("2026-09-18T14:00:00.000Z");
const ORG = "11111111-1111-4111-8111-111111111111";
const CASO = "22222222-2222-4222-8222-222222222222";
const CANAL = "55555555-5555-4555-8555-555555555555";
const DESTINO = "+5531998966398";

const ROW: EventRow = {
  id: "66666666-6666-4666-8666-666666666666",
  organization_id: ORG,
  event_type: EVENTO_CASO_ABERTO,
  entity_kind: "agent_case",
  entity_id: CASO,
  payload: { case_id: CASO, conversation_id: "c", contact_id: "d", source: "agent" },
  metadata: {},
  consumed_by: [],
  attempts: 0,
  created_at: new Date(AGORA.getTime() - 30_000).toISOString(),
};

function entrega(over: Record<string, unknown> = {}) {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    organization_id: ORG,
    case_id: CASO,
    destino: DESTINO,
    status: "pendente",
    tentativas: 0,
    erro_codigo: null,
    created_at: new Date(AGORA.getTime() - 60_000).toISOString(),
    updated_at: new Date(AGORA.getTime() - 60_000).toISOString(),
    ...over,
  };
}

function monta(existente: Record<string, unknown> | null) {
  const enviados: string[] = [];
  const patches: Array<Record<string, unknown>> = [];
  const central: Array<Record<string, unknown>> = [];
  const deps: AvisoDeps = {
    clock: () => AGORA,
    urlPublica: "https://crm.exemplo.com.br",
    origemDoDreno: () => "worker",
    audita: () => {},
    db: {
      async carregaConfig() {
        return {
          organization_id: ORG,
          channel_session_id: CANAL,
          telefone_destino: DESTINO,
          destino_jid: null,
          ligado: true,
        } as never;
      },
      async carregaCaso() {
        return {
          id: CASO,
          organization_id: ORG,
          conversation_id: "c",
          kind: "financeiro",
          source: "agent",
          status: "awaiting_human",
          title: "t",
          summary: "s",
          blocker: "b",
        } as never;
      },
      async contatoAnonimizado() {
        return false;
      },
      async reivindicaEntrega(entrada) {
        // O adapter real faz o INSERT e, no `23505`, relê a linha. O falso
        // encena os DOIS desfechos: `criada:false` é a corrida perdida.
        if (existente) return { criada: false, entrega: existente as never };
        return { criada: true, entrega: entrega({ destino: entrada.destino }) as never };
      },
      async atualizaEntrega(_org, _id, patch) {
        patches.push(patch as Record<string, unknown>);
      },
      async cancelaPendentesDoCaso() {
        return 0;
      },
      async cancelaEntregaPendenteDoLembrete() {
        return 0;
      },
      async cancelaPendentesDeLembreteComOutroDestino() {
        return 0;
      },
      async carregaCanal() {
        return { id: CANAL, status: "WORKING", archived_at: null, aceitaMensagemLivre: true } as never;
      },
      async destinoEhDaPropriaOrganizacao() {
        return false;
      },
      async avisaNaCentral(e) {
        central.push(e as unknown as Record<string, unknown>);
      },
      async registraEventoDoCaso() {},
      async registraJidDoAviso() {},
      async nomeDoContato() {
        return "Maria";
      },
      async marcaDaOrganizacao() {
        return { nome: "Acme", idioma: "pt-BR" as const };
      },
    },
    transporte: {
      async configurado() {
        return true;
      },
      async resolveDestino(_org, _canal, tel) {
        return `${tel.replace(/\D/g, "")}@c.us`;
      },
      async envia(_org, _canal, to) {
        enviados.push(to);
        return { externalId: "wamid.X" };
      },
    },
    pacing: {
      async decide() {
        return { liberado: true };
      },
      async registraEnvio() {},
    },
  };
  return { deps, enviados, patches, central };
}

describe("idempotência do aviso", () => {
  it("primeira vez: reivindica e envia", async () => {
    const { deps, enviados } = monta(null);
    const r = await aplicaAvisoDeCaso(deps, ROW);
    expect(r.status).toBe("ok");
    expect(enviados).toHaveLength(1);
  });

  it("entrega já ENVIADA → não envia de novo", async () => {
    const { deps, enviados } = monta(entrega({ status: "enviado" }));
    const r = await aplicaAvisoDeCaso(deps, ROW);
    expect(r.status).toBe("skipped");
    expect(r.detail).toContain("ja_resolvido:enviado");
    expect(enviados).toHaveLength(0);
  });

  it("entrega já CANCELADA (o caso fechou antes) → não envia de novo", async () => {
    const { deps, enviados } = monta(entrega({ status: "cancelado", erro_codigo: "expirou" }));
    const r = await aplicaAvisoDeCaso(deps, ROW);
    expect(r.detail).toContain("ja_resolvido:cancelado");
    expect(enviados).toHaveLength(0);
  });

  it("crash entre o transporte e o `enviado`: a rodada seguinte NÃO reenvia enquanto a reivindicação é recente", async () => {
    // Este é o caso que justifica a janela dos 2 minutos. A linha ficou
    // `pendente` com a mensagem JÁ no celular de alguém; reenviar é o desfecho
    // caro, esperar é o barato.
    const { deps, enviados } = monta(
      entrega({ updated_at: new Date(AGORA.getTime() - 30_000).toISOString() }),
    );
    const r = await aplicaAvisoDeCaso(deps, ROW);
    expect(r.status).toBe("retry");
    expect(enviados).toHaveLength(0);
  });

  it("reivindicação ANTIGA (outro processo morreu de vez) → retoma e envia", async () => {
    const { deps, enviados } = monta(
      entrega({ updated_at: new Date(AGORA.getTime() - 10 * 60_000).toISOString() }),
    );
    const r = await aplicaAvisoDeCaso(deps, ROW);
    expect(r.status).toBe("ok");
    expect(enviados).toHaveLength(1);
  });

  it("tentativas além do teto absoluto → falha DEFINITIVA com `indeterminado` e item na Central", async () => {
    const { deps, enviados, patches, central } = monta(
      entrega({
        tentativas: TETO_ABSOLUTO_DE_TENTATIVAS,
        updated_at: new Date(AGORA.getTime() - 10 * 60_000).toISOString(),
      }),
    );
    const r = await aplicaAvisoDeCaso(deps, ROW);
    expect(r.status).toBe("skipped");
    expect(enviados).toHaveLength(0);
    expect(patches.at(-1)).toMatchObject({ status: "falhou", erro_codigo: "indeterminado" });
    expect(central).toHaveLength(1);
  });

  it("entrega com mais de 24 h vira `cancelado: expirou` — e a Central diz", async () => {
    // O aviso de um caso de ontem chega hoje como ruído: a equipe já viu o caso
    // na tela, ou o cliente já foi embora. O que precisa aparecer é que ele NÃO
    // saiu, e isso é o item na Central.
    const { deps, enviados, patches, central } = monta(
      entrega({
        created_at: new Date(AGORA.getTime() - VALIDADE_DA_ENTREGA_MS - 1000).toISOString(),
        updated_at: new Date(AGORA.getTime() - 10 * 60_000).toISOString(),
      }),
    );
    const r = await aplicaAvisoDeCaso(deps, ROW);
    expect(r.status).toBe("skipped");
    expect(enviados).toHaveLength(0);
    expect(patches.at(-1)).toMatchObject({ status: "cancelado", erro_codigo: "expirou" });
    expect(central).toHaveLength(1);
  });
});
