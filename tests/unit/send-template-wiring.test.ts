import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_TOOL_DEFS } from "@/lib/agent-engine/agent/inbound-turn";
import { CHANNEL_PROVIDER_META, CHANNEL_PROVIDER_WAHA, capabilitiesOf } from "@/lib/channels/capabilities";

/**
 * A LIGAÇÃO do `send_template` no turno do agente.
 *
 * ─── Por que este arquivo é diferente dos outros do seam ────────────────────
 * As **peças** do envio por template têm 127 casos entre `meta-render-template`,
 * `meta-build-components`, `meta-send-template`, `meta-template-binding` e companhia.
 * O que nenhum deles toca é a **ligação** dentro de `runAgentTurn`: qual tool entra no
 * prompt, o que o `execute` passa para a cadeia de guardrails, e o que chega ao canal.
 *
 * Rodar o turno de verdade até a tool exigiria um harness que **este repo não tem** — e
 * a lacuna é anterior a este trabalho, registrada em `tests/invariants/case-reply-turn.test.ts`:
 * *"não existe seam de harness pra rodar o núcleo do turno (LLM + envio) neste repo"*.
 * Os seams de injeção existem (`registry`, `channel`, `clock`, `sleep`), mas o
 * `openingContext` do turno vai ao CRM por MCP, e stubar isso é o harness que falta.
 *
 * ─── O que este guard prova, e o que NÃO prova ──────────────────────────────
 * **Prova:** que as quatro decisões abaixo estão escritas no código que roda, e que
 * removê-las produz vermelho. Cada uma quebraria **em silêncio** num refactor: o envio
 * continuaria compilando e passando nos testes das peças.
 *
 * **Não prova:** que o turno completo, com um modelo escolhendo a tool, envia.
 *
 * ATUALIZAÇÃO (2026-07-30): isso deixou de estar descoberto —
 * `tests/invariants/agent-send-template-turn.test.ts` roda o turno inteiro contra
 * Postgres real, com modelo e canal fakes. A conclusão de que faltava um harness
 * estava errada: os seams necessários já existiam, e `createFakeRegistry` estava
 * definido sem nenhum consumidor. Ver o cabeçalho daquele arquivo.
 *
 * Este guard continua valendo — ele é mais barato e falha mais perto do defeito —,
 * mas não é mais o único a cobrir a ligação.
 */

const FONTE = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
  "utf8",
);

/** O corpo do `execute` da tool — recortado para as asserções não casarem noutro lugar. */
function corpoDoExecute(): string {
  const i = FONTE.indexOf("send_template: tool({");
  expect(i, "âncora `send_template: tool({` sumiu do turno").toBeGreaterThan(-1);
  const j = FONTE.indexOf("search_knowledge: tool({", i);
  expect(j, "âncora de fim (a tool seguinte) sumiu").toBeGreaterThan(i);
  return FONTE.slice(i, j);
}

describe("send_template — a tool só existe onde o canal a exige", () => {
  it("a decisão vem de capabilitiesOf, não de um literal de provider", () => {
    // Invariante 1 da doutrina `docs/doctrine/restricao-de-canal.md`: nenhuma feature
    // nomeia um provider. Um `if (provider === 'meta_cloud')` aqui passaria nos testes
    // de hoje e quebraria no dia em que um segundo canal exigir template.
    const gate = FONTE.slice(FONTE.indexOf("delete rawTools.send_template") - 400);
    expect(gate).toMatch(/capabilitiesOf\([^)]*\)\.requiresTemplates/);
    expect(gate.slice(0, 400)).not.toMatch(/===\s*['"]meta_cloud['"]/);
  });

  it("a matriz sustenta a decisão: WAHA não exige template, Cloud API exige", () => {
    // Se esta expectativa inverter, o gate acima continua correto e o comportamento
    // muda junto — que é exatamente o ponto de decidir por capability.
    expect(capabilitiesOf(CHANNEL_PROVIDER_WAHA).requiresTemplates).toBe(false);
    expect(capabilitiesOf(CHANNEL_PROVIDER_META).requiresTemplates).toBe(true);
  });

  it("a remoção acontece de fato — a tool some do objeto, não só do prompt", () => {
    // `delete` sobre o mapa de tools, não uma flag lida adiante: tool que continua no
    // objeto continua chamável pelo modelo, mesmo que o prompt não a descreva.
    expect(FONTE).toMatch(/delete rawTools\.send_template;/);
  });
});

describe("send_template — o execute não pode virar rota de fuga dos guardrails", () => {
  it("o corpo RENDERIZADO passa pela cadeia before_send", () => {
    // Sem isto, "usar template" seria a forma de escapar dos gates de conteúdo
    // (promessa, spinning, disclosure): eles avaliariam vazio ou o nome do template,
    // e o contato leria um texto que ninguém checou.
    const corpo = corpoDoExecute();
    expect(corpo).toMatch(/renderTemplateBody\(/);
    expect(corpo).toMatch(/runBeforeSend\(/);
    expect(corpo).toMatch(/body:\s*rendered/);
  });

  it("declara isTemplate: true — senão o próprio gate de janela veta o template", () => {
    // A tool existe para o caso "janela fechada". Sem esta flag o gate
    // `messaging_window` recusaria o envio que ele mesmo instruiu a fazer, e a tool
    // seria um beco: o modelo tentaria, levaria veto, e o turno morreria sem resposta.
    expect(corpoDoExecute()).toMatch(/isTemplate:\s*true/);
  });

  it("o veto da cadeia devolve erro ao modelo em vez de enviar assim mesmo", () => {
    const corpo = corpoDoExecute();
    expect(corpo).toMatch(/chain\.status === 'vetoed'/);
    // O `return` do veto vem ANTES de qualquer uso do outcome: um veto que caísse no
    // caminho de sucesso reportaria "enviada" para algo que não saiu.
    expect(corpo.indexOf("chain.status === 'vetoed'")).toBeLessThan(corpo.indexOf("outcomes.push"));
  });

  it("o envio carrega o template como template, não como texto", () => {
    // `messages.type = 'template'` + `template_name` são as colunas de CUSTO
    // (template é cobrado por entrega) e de CONFORMIDADE (fora da janela, só template).
    // Mandar só o corpo renderizado gravaria `type: 'text'` — compila, e mente no banco.
    const corpo = corpoDoExecute();
    expect(corpo).toMatch(/template:\s*\{\s*name:\s*template_name,\s*language,\s*values\s*\}/);
  });

  it("'existe' não é 'pode disparar': status não-APPROVED é recusado ANTES da Meta", () => {
    // O buraco que este caso fecha, achado ao escrever o guard: o caminho HUMANO
    // recusava template não-aprovado (`template-binding.ts` → "not_approved", a regra
    // que a tela chama de *"só APPROVED pode ser disparado"*), e o caminho do AGENTE
    // — o único que age sem humano olhando — não consultava o status. Um template
    // PENDING ou REJECTED ia à Graph API, voltava erro genérico, e o modelo o lia
    // como falha de infraestrutura em vez de configuração pendente.
    const corpo = corpoDoExecute();
    expect(corpo).toMatch(/isStatusSendable\(/);
    expect(corpo).toMatch(/template_nao_aprovado/);
    // Selecionar `status` é o que torna a checagem possível: sem a coluna, o gate
    // acima compilaria contra `undefined` e aprovaria tudo.
    expect(corpo).toMatch(/definicaoNaConexao<[\s\S]*?\['components', 'parameter_format', 'status'\]/);
    // E a definição é a DESTA conexão (lib/channels/linha-do-espelho.ts): sem o
    // escopo, o agente conferia o modelo de outro número com o mesmo nome.
    expect(corpo).toMatch(/channelSessionId: input\.channelSessionId/);
  });

  it("as duas recusas são códigos DIFERENTES — pedem ações humanas diferentes", () => {
    // Colapsar "não existe" e "não aprovado" no mesmo erro manda o operador criar um
    // template que já existe, em vez de olhar a análise da Meta.
    const corpo = corpoDoExecute();
    expect(corpo).toMatch(/template_desconhecido/);
    expect(corpo).toMatch(/template_nao_aprovado/);
    expect(corpo.indexOf("template_desconhecido")).not.toBe(corpo.indexOf("template_nao_aprovado"));
  });

  it("template inexistente vira erro instrutivo, não exceção", () => {
    // O modelo pode inventar um nome. Estourar aqui mataria o turno inteiro por um
    // palpite errado do LLM, com o lead do outro lado esperando.
    const corpo = corpoDoExecute();
    expect(corpo).toMatch(/template_desconhecido/);
    expect(corpo).toMatch(/um humano precisa configurá-lo/);
  });
});

describe("send_template — a definição que o modelo lê", () => {
  const schema = AGENT_TOOL_DEFS.send_template.inputSchema;

  it("aceita a chamada bem-formada", () => {
    const r = schema.safeParse({
      template_name: "pedido_confirmado",
      language: "pt_BR",
      values: { "1": "Ana", "2": "1234" },
    });
    expect(r.success).toBe(true);
  });

  it("recusa idioma vazio — 'pt' e 'pt_BR' são templates DIFERENTES na Meta", () => {
    expect(schema.safeParse({ template_name: "x", language: "", values: {} }).success).toBe(false);
  });

  it("recusa nome vazio", () => {
    expect(schema.safeParse({ template_name: "", language: "pt_BR", values: {} }).success).toBe(false);
  });

  it("a descrição diz QUANDO usar — tool sem gatilho o modelo usa na hora errada", () => {
    // O texto é o único contrato que o modelo lê. Ele precisa amarrar o uso à recusa
    // do `send_message`, senão o agente manda template dentro da janela (que custa
    // dinheiro e é pior UX) ou nunca manda fora dela.
    const d = AGENT_TOOL_DEFS.send_template.description;
    expect(d).toMatch(/send_message/);
    expect(d).toMatch(/24 horas/);
  });
});

describe("a regra de disparabilidade tem UM dono", () => {
  it("isStatusSendable concorda com bindingState — a regra não se bifurcou", async () => {
    // Comportamento, não estrutura: se alguém mudar uma das duas, elas divergem e
    // este caso cai. É o que impede o caminho do agente e o do humano de voltarem a
    // ter opiniões diferentes sobre o que pode ser disparado.
    const { bindingState, isStatusSendable } = await import("@/lib/channels/meta/template-binding");
    const binding = { name: "t", language: "pt_BR", contractHash: "h", values: {} };
    for (const status of ["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED", "IN_APPEAL"]) {
      const viaBind = bindingState(binding, { name: binding.name, language: binding.language, contractHash: "h", status }) !== "not_approved";
      expect(isStatusSendable(status), `divergiram em ${status}`).toBe(viaBind);
    }
  });
});
