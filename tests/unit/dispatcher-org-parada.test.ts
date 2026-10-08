/**
 * ORGANIZAÇÃO PARADA NÃO GASTA NEM FALA — pelo barramento de eventos.
 *
 * Todo consumidor do `event_log` declara o que faz quando a organização do
 * evento não está operante (`lib/organizacao/operante.ts`):
 *
 *   "roda" — escrita interna, LGPD ou entrada: segue normal;
 *   "pula" — custa dinheiro ou sai para fora: vira `skipped` com
 *            `org_nao_operante`, entra em `consumed_by` e NÃO volta na
 *            reativação (reativação é sem rajada, spec §1.3).
 *
 * O campo é obrigatório no tipo: handler novo sem classificação não compila.
 * A lista literal abaixo é a segunda metade — ela reprova quem registrar um
 * handler sem passar por aqui.
 */
import { describe, expect, it, vi } from "vitest";

import {
  dispatchEvent,
  getRegisteredHandlers,
  registerHandler,
  type EventHandler,
  type EventRow,
} from "@/lib/event-log/dispatcher";
import { drainEventLog } from "@/lib/event-log/drain";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import { pinoReintentoHandler } from "@/lib/channels/zernio/pino-reintento.handler";
import { automationRulesHandler } from "@/lib/automation/engine.handler";
import { campanhaRespostaHandler } from "@/lib/campanhas/resposta.handler";
import { conversaoDeVendaHandler } from "@/lib/conversoes/envio.handler";
import { conversaoDeQualificacaoHandler } from "@/lib/conversoes/qualificacao.handler";
import { conversaoDeEtapaMetaHandler } from "@/lib/conversoes/etapa-meta.handler";
import { avisoDeCasoAoSuporteHandler } from "@/lib/escalacao/aviso-ao-suporte.handler";
import { casoNaCentralHandler } from "@/lib/escalacao/caso-na-central.handler";
import { followupGatilhoCasoHandler } from "@/lib/followup/gatilho-caso.handler";
import { followupGatilhoEtapaHandler } from "@/lib/followup/gatilho-etapa.handler";
import { followupGatilhoLeadHandler } from "@/lib/followup/gatilho-lead.handler";
import { followupGatilhoPresencaHandler } from "@/lib/followup/gatilho-presenca.handler";
import { followupGatilhoRetornoHandler } from "@/lib/followup/gatilho-retorno.handler";
import { followupReactivityHandler } from "@/lib/followup/reactivity.handler";
import { avisoDeEtapaHandler } from "@/lib/leads/aviso-de-etapa.handler";
import { comandaDoGanhoHandler } from "@/lib/financeiro/comanda-do-ganho.handler";
import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import { avisoDePropostaNoWhatsAppHandler } from "@/lib/propostas/aviso-no-whatsapp.handler";
import { aiHandoffFromSentimentHandler } from "@/workers/ai-handoff-from-sentiment.handler";
import { aiResponseHandler } from "@/workers/ai-response-worker.handler";
import { aiSentimentHandler } from "@/workers/ai-sentiment-worker.handler";
import { lgpdExportHandler } from "@/workers/lgpd-export-worker.handler";
import { lgpdRedactHandler } from "@/workers/lgpd-redact-worker.handler";
import { mediaDeriveHandler } from "@/workers/media-derive-worker.handler";
import { mediaPersistHandler } from "@/workers/media-persist-worker.handler";
import { ragIndexerHandler } from "@/workers/rag-indexer.handler";

const RODA: EventHandler[] = [
  followupReactivityHandler,
  campanhaRespostaHandler,
  avisoDeEtapaHandler,
  casoNaCentralHandler,
  comandaDoGanhoHandler,
  mediaPersistHandler,
  lgpdExportHandler,
  lgpdRedactHandler,
];

const PULA: EventHandler[] = [
  aiResponseHandler,
  aiSentimentHandler,
  aiHandoffFromSentimentHandler,
  ragIndexerHandler,
  mediaDeriveHandler,
  automationRulesHandler,
  followupGatilhoRetornoHandler,
  followupGatilhoEtapaHandler,
  followupGatilhoLeadHandler,
  followupGatilhoCasoHandler,
  followupGatilhoPresencaHandler,
  webPushInboundHandler,
  avisoDeCasoAoSuporteHandler,
  avisoDePropostaNoWhatsAppHandler,
  conversaoDeVendaHandler,
  conversaoDeQualificacaoHandler,
  conversaoDeEtapaMetaHandler,
  pinoReintentoHandler,
];

const PREFIXO_DE_TESTE = "teste-org-parada";
const EVENTO_DE_TESTE = "teste.org_parada";
const handleRoda = vi.fn(async () => ({ consumer_key: `${PREFIXO_DE_TESTE}-roda`, status: "ok" as const }));
const handlePula = vi.fn(async () => ({ consumer_key: `${PREFIXO_DE_TESTE}-pula`, status: "ok" as const }));
registerHandler({ key: `${PREFIXO_DE_TESTE}-roda`, events: [EVENTO_DE_TESTE], naOrgParada: "roda", handle: handleRoda });
registerHandler({ key: `${PREFIXO_DE_TESTE}-pula`, events: [EVENTO_DE_TESTE], naOrgParada: "pula", handle: handlePula });

function linha(): EventRow {
  return {
    id: "ev-1",
    organization_id: "org-1",
    event_type: EVENTO_DE_TESTE,
    entity_kind: "teste",
    entity_id: null,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date().toISOString(),
  };
}

type Resposta = { data: unknown; error: { message: string } | null };

/** Dublê do supabase-js: responde ao que o dreno pede e registra os updates do `event_log`. */
function dublarAdmin(opts: {
  linhas: EventRow[];
  orgs: Array<{ id: string; status: string }> | { erro: string };
}) {
  const updates: Array<{ tabela: string; payload: Record<string, unknown> }> = [];
  const from = (tabela: string) => {
    let ehUpdate = false;
    let pedeProcessing = false;
    const q: Record<string, unknown> = {
      select: () => q,
      update: (payload: Record<string, unknown>) => {
        ehUpdate = true;
        updates.push({ tabela, payload });
        return q;
      },
      eq: (coluna: string, valor: unknown) => {
        if (coluna === "status" && valor === "processing") pedeProcessing = true;
        return q;
      },
      lt: () => q,
      or: () => q,
      in: () => q,
      order: () => q,
      limit: () => q,
      then: (resolve: (r: Resposta) => unknown) => {
        if (ehUpdate) return resolve({ data: [{ id: "ev-1" }], error: null });
        if (tabela === "organizations") {
          return resolve(
            "erro" in opts.orgs
              ? { data: null, error: { message: opts.orgs.erro } }
              : { data: opts.orgs, error: null },
          );
        }
        if (tabela === "event_log") return resolve({ data: pedeProcessing ? [] : opts.linhas, error: null });
        return resolve({ data: null, error: null });
      },
    };
    return q;
  };
  return { admin: { from } as never, updates };
}

describe("classificação literal dos handlers registrados", () => {
  it.each(RODA.map((h) => [h.key, h] as const))("%s roda na org parada", (_chave, h) => {
    expect(h.naOrgParada).toBe("roda");
  });

  it.each(PULA.map((h) => [h.key, h] as const))("%s pula na org parada", (_chave, h) => {
    expect(h.naOrgParada).toBe("pula");
  });

  it("a lista literal cobre EXATAMENTE o registro de produção — handler novo tem de entrar aqui", () => {
    ensureHandlersRegistered();
    const registrados = getRegisteredHandlers()
      .map((h) => h.key)
      .filter((k) => !k.startsWith(PREFIXO_DE_TESTE))
      .sort();
    expect(registrados).toEqual([...RODA, ...PULA].map((h) => h.key).sort());
  });
});

describe("dispatchEvent × org parada", () => {
  it("org parada: 'pula' vira skipped/org_nao_operante SEM rodar; 'roda' roda", async () => {
    handleRoda.mockClear();
    handlePula.mockClear();
    const r = await dispatchEvent(linha(), { orgParada: true });
    expect(handlePula).not.toHaveBeenCalled();
    expect(handleRoda).toHaveBeenCalledOnce();
    expect(r).toContainEqual({
      consumer_key: `${PREFIXO_DE_TESTE}-pula`,
      status: "skipped",
      detail: "org_nao_operante",
    });
  });

  it("org operante: os dois rodam (controle)", async () => {
    handleRoda.mockClear();
    handlePula.mockClear();
    await dispatchEvent(linha(), { orgParada: false });
    expect(handlePula).toHaveBeenCalledOnce();
    expect(handleRoda).toHaveBeenCalledOnce();
  });
});

describe("drainEventLog lê o status das orgs do lote", () => {
  it("org parada: o 'pula' entra em consumed_by e o evento fecha done — não volta na reativação", async () => {
    handlePula.mockClear();
    const { admin, updates } = dublarAdmin({ linhas: [linha()], orgs: [{ id: "org-1", status: "suspended" }] });
    const resumo = await drainEventLog(admin);
    const fim = updates.filter((u) => u.tabela === "event_log").pop()!.payload;
    expect(fim.status).toBe("done");
    expect(fim.consumed_by).toEqual(
      expect.arrayContaining([`${PREFIXO_DE_TESTE}-pula`, `${PREFIXO_DE_TESTE}-roda`]),
    );
    expect(String(fim.last_error)).toContain(`${PREFIXO_DE_TESTE}-pula: org_nao_operante`);
    expect(handlePula).not.toHaveBeenCalled();
    expect(resumo.pulados).toContain(`${EVENTO_DE_TESTE}/${PREFIXO_DE_TESTE}-pula: org_nao_operante`);
  });

  // Controle do lado que mais pesa. Medido por sabotagem: inverter a régua
  // (`!ehOperante`) já deixa o caso acima vermelho; o que passava com a suíte
  // verde era tratar TODA org como parada (`ehOperante(o.status) && false`), que
  // calaria a IA e as automações de todas as empresas ativas. Só este caso pega.
  it("org operante: o handler 'pula' roda e o evento fecha done com a chave em consumed_by, sem org_nao_operante", async () => {
    handlePula.mockClear();
    const { admin, updates } = dublarAdmin({ linhas: [linha()], orgs: [{ id: "org-1", status: "active" }] });
    const resumo = await drainEventLog(admin);
    const fim = updates.filter((u) => u.tabela === "event_log").pop()!.payload;
    expect(handlePula).toHaveBeenCalledOnce();
    expect(fim.status).toBe("done");
    expect(fim.consumed_by).toEqual(expect.arrayContaining([`${PREFIXO_DE_TESTE}-pula`]));
    expect(String(fim.last_error ?? "")).not.toContain("org_nao_operante");
    expect(resumo.pulados ?? []).not.toContain(`${EVENTO_DE_TESTE}/${PREFIXO_DE_TESTE}-pula: org_nao_operante`);
  });

  it("org que não volta da leitura conta como parada (falha fechada)", async () => {
    handlePula.mockClear();
    const { admin } = dublarAdmin({ linhas: [linha()], orgs: [] });
    await drainEventLog(admin);
    expect(handlePula).not.toHaveBeenCalled();
  });

  it("leitura do status falha: nada é reclamado, o lote espera o próximo tique", async () => {
    handlePula.mockClear();
    handleRoda.mockClear();
    const { admin, updates } = dublarAdmin({ linhas: [linha()], orgs: { erro: "connection reset" } });
    await drainEventLog(admin);
    expect(updates.some((u) => u.payload.status === "processing")).toBe(false);
    expect(handlePula).not.toHaveBeenCalled();
    expect(handleRoda).not.toHaveBeenCalled();
  });
});
