/**
 * QUEM CHAMA A PORTA DE SAÍDA SABE O QUE FAZER COM A ORGANIZAÇÃO PARADA.
 *
 * `sendMessageHandler` lança `OrgNaoOperanteError` (403 `org_suspended`,
 * `terminal`) para org suspensa, redigida ou arquivada. Quem só propaga o erro
 * está certo. Quem tem `catch` próprio que GRAVA um desfecho (pausa a campanha,
 * marca o destinatário, retenta a cada rodada) precisa distinguir a suspensão —
 * senão o efeito sobrevive à reativação. Chamador novo entra aqui com a decisão
 * escrita; os que tratam têm teste de comportamento na tarefa citada.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

const TRATA = "trata";

const CHAMADORES: Record<string, string> = {
  "app/api/v1/cron/agenda-reminder/route.ts": TRATA, // tests/unit/lembrete-pula-org-parada.test.ts
  "lib/campanhas/rodada.ts": TRATA, // registrarExcecaoDoEnvio, tests/unit/suspensao-nao-dispara-campanha.test.ts
  "lib/prospecting/worker.ts": TRATA, // tests/unit/prospecting-worker.test.ts
  "lib/followup/enviar-texto-fixo.ts": TRATA, // lib/followup/enviar-texto-fixo.test.ts
  "lib/agent-engine/edge/crm/send-message.ts":
    "propaga o 403 como ApiError; sendWithLedger relança a suspensão e o agent-worker encerra o job terminal",
  "app/api/v1/messages/route.ts": "rota de API: o ApiError 403 org_suspended vira a resposta JSON de quem chamou",
  "app/api/v1/proposals/[id]/send/route.ts":
    "o catch devolve a proposta a rascunho; nada fica gravado como enviado, e a pessoa reenvia depois",
  "lib/ai/handoff/aviso-ao-lead.ts": "devolve avisado:false; é aviso de um instante, sem fila nem estado que sobreviva",
  "lib/agent-engine/agent/aviso-fora-do-horario.ts":
    "propaga ao chamador; o inbound-turn engole e só perde o aviso — nada gravado, sem retentativa, e o turno da org parada já é negado antes",
  "lib/ai/runtime/finalize.ts": "devolve null ao turno; o gate já nega a org parada antes de existir turno",
  "lib/automation/actions/send-ai-message.ts": "o desfecho vira failed na execução da regra; registro do instante, sem retentativa",
  "lib/automation/actions/send-whatsapp.ts": "o desfecho vira failed na execução da regra; registro do instante, sem retentativa",
  "lib/campanhas/acoes.ts": "ação disparada da tela: o erro sobe para quem clicou, sem estado gravado",
  "lib/mcp/tools/messages.ts": "ferramenta MCP: o erro sobe ao cliente; o token da org parada já é recusado antes",
  "lib/mcp/tools/start-conversation.ts": "ferramenta MCP: o erro sobe ao cliente; o token da org parada já é recusado antes",
};

const PORTA = "app/api/v1/messages/_handler.ts";
const FONTES = arquivosDeCodigo(["app", "lib", "workers"]).map((abs) => ({
  arquivo: caminhoRelativo(abs),
  fonte: readFileSync(abs, "utf8"),
}));
const QUEM_CHAMA = FONTES.filter(({ arquivo, fonte }) => arquivo !== PORTA && /\bsendMessageHandler\(/.test(fonte))
  .map(({ arquivo }) => arquivo)
  .sort();

describe("chamadores de sendMessageHandler × organização parada", () => {
  it("o instrumento enxerga os chamadores (controle positivo)", () => {
    expect(QUEM_CHAMA).toContain("lib/campanhas/rodada.ts");
    expect(QUEM_CHAMA.length).toBeGreaterThanOrEqual(10);
  });

  it("todo chamador consta da lista com a decisão — e a lista só tem quem chama", () => {
    expect(QUEM_CHAMA).toEqual(Object.keys(CHAMADORES).sort());
  });

  it("quem 'trata' distingue OrgNaoOperanteError no próprio arquivo; quem propaga diz por quê", () => {
    for (const [arquivo, decisao] of Object.entries(CHAMADORES)) {
      if (decisao === TRATA) {
        const fonte = FONTES.find((f) => f.arquivo === arquivo)?.fonte ?? "";
        expect(fonte, `${arquivo} diz que trata e não cita OrgNaoOperanteError`).toContain("OrgNaoOperanteError");
      } else {
        expect(decisao.length, arquivo).toBeGreaterThanOrEqual(20);
      }
    }
  });
});
