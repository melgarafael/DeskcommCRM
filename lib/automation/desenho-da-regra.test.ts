/**
 * O desenho é outra FORMA da mesma regra — e só vale se a volta fechar.
 *
 * O designer de automações não tem régua própria: ele converte a regra gravada
 * em caixas e as caixas de volta no corpo que a API recebe. Se a volta perder
 * um byte, abrir e salvar sem mexer em nada mudaria uma automação que roda
 * sozinha para sempre. Por isso o teste principal é o da ida e volta, sobre uma
 * regra de cada forma que o schema aceita, comparando com o próprio schema.
 *
 *     npx vitest run lib/automation/desenho-da-regra.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  MENSAGEM_DO_LACO_DE_LEAD,
  MENSAGEM_DO_RODIZIO_FORA_DO_LUGAR,
  createAutomationRuleSchema,
} from "@/lib/schemas/webhooks";
import { evaluateConditions } from "@/lib/automation/conditions";

import {
  AVISO_LIGACAO_TROCADA,
  ID_DAS_CONDICOES,
  ID_DO_GATILHO,
  PROBLEMAS,
  PROBLEMA_DO_CAMPO,
  RECUSAS_DE_LIGACAO,
  corpoDoDesenho,
  desenhoDaRegra,
  desenhoDaTela,
  excluirCaixa,
  inserirDepois,
  ligar,
  organizar,
  percorrer,
  validarDesenho,
  type CaixaDoDesenho,
  type DadosDaAcao,
  type Desenho,
  type RegraGravada,
} from "./desenho-da-regra";

const U = (n: number) => `${String(n).repeat(8).slice(0, 8)}-1111-4111-8111-111111111111`;
const CANAL = U(1);
const FUNIL = U(2);
const ETAPA = U(3);
const PESSOA = U(4);
const AGENTE = U(5);
const FLUXO = U(6);
const FONTE = U(7);

const ACOES_FIXAS: RegraGravada["actions"] = [
  { type: "create_or_move_lead", config: { pipeline_id: FUNIL, stage_id: ETAPA } },
  { type: "send_whatsapp_message", config: { channel_session_id: CANAL, template: "Oi {{nome}}" } },
  { type: "add_tag", config: { tags: ["vip", "site"] } },
  { type: "send_ai_message", config: { agent_id: AGENTE, channel_session_id: CANAL, instruction: "Agradeça." } },
  { type: "call_webhook", config: { url: "https://erp.exemplo.com.br/hook", secret_enc: "abc123", include_owner: true } },
  { type: "start_message_flow", config: { flow_pointer_id: FLUXO } },
  {
    type: "create_task",
    config: { titulo: "Ligar para {{contact.name}}", vence_em_dias: 2, atribuir_a: { usuario_id: PESSOA }, prioridade: "high" },
  },
  { type: "apply_task_plan", config: { plano_id: "onboarding-comprador" } },
  { type: "assign_owner", config: { user_id: PESSOA } },
];

const PASSO_DA_IA = {
  type: "ai_decide",
  config: {
    custo_de_token: true,
    instrucao: "Decida se o cliente quer visita ou só tem dúvida.",
    opcoes: [
      { id: "visita", rotulo: "Quer visita", acao: { type: "create_or_move_lead", config: { pipeline_id: FUNIL, stage_id: ETAPA } } },
      { id: "duvida", rotulo: "Só dúvida", acao: { type: "add_tag", config: { tags: ["duvida"] } } },
    ],
  },
};

/** Uma regra de cada forma que importa: gatilho com e sem configuração, com e sem condições, IA no meio. */
const REGRAS: Array<[string, RegraGravada]> = [
  ["todas as ações fixas, sem condição", { trigger_event: "lead.stage_changed", trigger_config: {}, conditions: [], actions: ACOES_FIXAS }],
  [
    "contato novo de uma fonte, com condições de lista e de texto",
    {
      trigger_event: "lead.created",
      trigger_config: { webhook_source_id: FONTE },
      conditions: [
        { field: "lead.tags", op: "contains", value: "vip" },
        { field: "lead.source_metadata.utm_source", op: "eq", value: "google" },
        { field: "lead.custom_fields.bairro", op: "neq", value: "Centro" },
      ],
      actions: [ACOES_FIXAS[1]!],
    },
  ],
  [
    "data do funil com N negativo",
    { trigger_event: "lead.date_field_due", trigger_config: { pipeline_id: FUNIL, campo: "data_assinatura", dias: -60 }, conditions: [], actions: [ACOES_FIXAS[6]!] },
  ],
  [
    "silêncio do cliente protegido pela agenda",
    { trigger_event: "lead.silent_for", trigger_config: { dias: 3, direcao: "do_cliente", proteger_pela_agenda: true }, conditions: [], actions: [ACOES_FIXAS[6]!] },
  ],
  [
    "etapa parada com etapa de destino",
    {
      trigger_event: "lead.stage_stale",
      trigger_config: { dias: 7, proteger_pela_agenda: false },
      conditions: [{ field: "event.to_stage_id", op: "eq", value: ETAPA }],
      actions: [ACOES_FIXAS[6]!],
    },
  ],
  [
    "passo a IA decide no meio da fila (gravado pela API)",
    { trigger_event: "message.received", trigger_config: {}, conditions: [{ field: "contact.tags", op: "contains", value: "cliente" }], actions: [PASSO_DA_IA, ACOES_FIXAS[2]!] },
  ],
];

/** O que a API grava para a regra — o lado de referência da comparação. */
function oQueAApiGrava(nome: string, regra: RegraGravada) {
  return createAutomationRuleSchema.parse({ name: nome, ...regra, trigger_config: regra.trigger_config ?? {} });
}

function caixaDeAcao(id: string, acao: DadosDaAcao["acao"]): CaixaDoDesenho {
  return { id, type: "acao", position: { x: 0, y: 0 }, data: { kind: "acao", acao } };
}

describe("ida e volta: abrir no designer e salvar sem mexer não muda a regra", () => {
  it("o controle positivo: as regras de referência são válidas para o schema", () => {
    for (const [nome, regra] of REGRAS) expect(() => oQueAApiGrava(nome, regra), nome).not.toThrow();
  });

  it.each(REGRAS)("%s", (nome, regra) => {
    const resultado = validarDesenho({ nome, desenho: desenhoDaRegra(regra), regraGravada: regra });
    expect(resultado.problemas).toEqual([]);
    expect(resultado.ok).toBe(true);
    expect(resultado.corpo).toEqual(oQueAApiGrava(nome, regra));
  });

  it("o passo a IA decide volta byte a byte, na mesma posição da fila", () => {
    const regra = REGRAS[5]![1];
    const corpo = corpoDoDesenho({ nome: "x", desenho: desenhoDaRegra(regra), regraGravada: regra });
    expect(corpo.actions[0]).toBe(PASSO_DA_IA);
    expect(corpo.actions.map((a) => a.type)).toEqual(["ai_decide", "add_tag"]);
  });

  it("o que só a API grava no gatilho sobrevive ao salvar (issue #2483)", () => {
    const regra: RegraGravada = {
      trigger_event: "lead.stage_stale",
      trigger_config: { dias: 5, proteger_pela_agenda: false, pipeline_id: FUNIL, stage_id: ETAPA },
      conditions: [],
      actions: [ACOES_FIXAS[2]!],
    };
    const corpo = corpoDoDesenho({ nome: "x", desenho: desenhoDaRegra(regra), regraGravada: regra });
    expect(corpo.trigger_config).toEqual({ dias: 5, proteger_pela_agenda: false, pipeline_id: FUNIL, stage_id: ETAPA });
  });

  it("trocar o gatilho não arrasta a configuração do gatilho antigo", () => {
    const regra = REGRAS[3]![1];
    const desenho = desenhoDaRegra(regra);
    const gatilho = desenho.caixas[0]!;
    if (gatilho.data.kind !== "gatilho") throw new Error("a primeira caixa é o gatilho");
    gatilho.data.evento = "lead.won";
    expect(corpoDoDesenho({ nome: "x", desenho, regraGravada: regra }).trigger_config).toEqual({});
  });

  it("condições incompletas são descartadas, como no editor de hoje", () => {
    const desenho = desenhoDaRegra(REGRAS[1]![1]);
    const condicoes = desenho.caixas.find((c) => c.id === ID_DAS_CONDICOES)!;
    if (condicoes.data.kind !== "condicoes") throw new Error("caixa de condições");
    condicoes.data.linhas.push({ field: "lead.title", op: "eq", value: "  " }, { field: "", op: "eq", value: "x" });
    const corpo = corpoDoDesenho({ nome: "x", desenho, regraGravada: null });
    expect(corpo.conditions).toHaveLength(3);
  });

  it("automação nova: só o gatilho, sem evento", () => {
    const desenho = desenhoDaRegra(null);
    expect(desenho.caixas.map((c) => c.id)).toEqual([ID_DO_GATILHO]);
    const r = validarDesenho({ nome: "Nova", desenho, regraGravada: null });
    expect(r.ok).toBe(false);
    expect(r.problemas).toContainEqual({ caixa: ID_DO_GATILHO, mensagem: PROBLEMAS.semAcao });
    expect(r.problemas).toContainEqual({ caixa: ID_DO_GATILHO, mensagem: PROBLEMAS.semEvento });
  });
});

describe("a volta pela tela: o que só a tela usa não apaga a regra", () => {
  /** Os nós como o canvas os entrega: a regra mais a etapa, o evento da regra e os problemas da última gravação. */
  const naTela = (d: Desenho, evento: string) =>
    d.caixas.map((c) => ({
      ...c,
      data: { ...c.data, etapa: "Quando", eventoDaRegra: evento, problemas: [{ caixa: c.id, mensagem: "da gravação anterior" }] },
    }));

  it.each(REGRAS)("%s", (nome, regra) => {
    const desenho = desenhoDaRegra(regra);
    const volta = desenhoDaTela(naTela(desenho, regra.trigger_event), desenho.ligacoes);
    expect(volta).toEqual(desenho);
    expect(validarDesenho({ nome, desenho: volta, regraGravada: regra }).corpo).toEqual(oQueAApiGrava(nome, regra));
  });

  it("o gatilho de ganho continua de ganho depois da tela — é dele que a paleta tira a trava de laço", () => {
    const regra: RegraGravada = {
      trigger_event: "lead.won",
      trigger_config: {},
      conditions: [],
      actions: [{ type: "add_tag", config: { tags: ["ganho"] } }],
    };
    const desenho = desenhoDaRegra(regra);
    const gatilho = percorrer(desenhoDaTela(naTela(desenho, "lead.won"), desenho.ligacoes)).gatilho;
    expect(gatilho?.data).toMatchObject({ kind: "gatilho", evento: "lead.won" });
  });
});

describe("a fila: inserir, excluir e ligar mantêm uma fila", () => {
  const base = () => desenhoDaRegra(REGRAS[1]![1]); // gatilho → condições → acao-1
  const ordem = (d: Desenho) => percorrer(d).fila.map((c) => c.id);

  it("o clique na paleta põe a ação no fim quando nada está selecionado", () => {
    const d = inserirDepois(base(), null, caixaDeAcao("acao-2", ACOES_FIXAS[2]!));
    expect(ordem(d)).toEqual([ID_DO_GATILHO, ID_DAS_CONDICOES, "acao-1", "acao-2"]);
  });

  it("e logo depois da caixa selecionada quando há seleção, religando o resto", () => {
    let d = inserirDepois(base(), null, caixaDeAcao("acao-2", ACOES_FIXAS[2]!));
    d = inserirDepois(d, "acao-1", caixaDeAcao("acao-3", ACOES_FIXAS[8]!));
    expect(ordem(d)).toEqual([ID_DO_GATILHO, ID_DAS_CONDICOES, "acao-1", "acao-3", "acao-2"]);
    expect(percorrer(d).problemas).toEqual([]);
  });

  it("uma ação nunca entra entre o gatilho e as condições", () => {
    const d = inserirDepois(base(), ID_DO_GATILHO, caixaDeAcao("acao-2", ACOES_FIXAS[2]!));
    expect(ordem(d)).toEqual([ID_DO_GATILHO, ID_DAS_CONDICOES, "acao-2", "acao-1"]);
  });

  it("condições entram logo depois do gatilho", () => {
    const semCondicao = desenhoDaRegra({ ...REGRAS[0]![1], actions: [ACOES_FIXAS[2]!] });
    const d = inserirDepois(semCondicao, "acao-1", {
      id: ID_DAS_CONDICOES,
      type: "condicoes",
      position: { x: 0, y: 0 },
      data: { kind: "condicoes", linhas: [] },
    });
    expect(ordem(d)).toEqual([ID_DO_GATILHO, ID_DAS_CONDICOES, "acao-1"]);
  });

  it("excluir uma caixa do meio fecha a fila; o gatilho não sai", () => {
    const d = excluirCaixa(base(), ID_DAS_CONDICOES);
    expect(ordem(d)).toEqual([ID_DO_GATILHO, "acao-1"]);
    expect(excluirCaixa(base(), ID_DO_GATILHO)).toEqual(base());
  });

  it("ligar recusa o que quebraria a fila", () => {
    const d = inserirDepois(base(), null, caixaDeAcao("acao-2", ACOES_FIXAS[2]!));
    expect(ligar(d, "acao-1", ID_DO_GATILHO)).toEqual({ ok: false, recusa: RECUSAS_DE_LIGACAO.noGatilho });
    expect(ligar(d, "acao-2", ID_DAS_CONDICOES)).toEqual({ ok: false, recusa: RECUSAS_DE_LIGACAO.condicoesDepoisDoGatilho });
    expect(ligar(d, "acao-2", "acao-1")).toEqual({ ok: false, recusa: RECUSAS_DE_LIGACAO.circulo });
  });

  it("ligar numa caixa que já tinha entrada troca a ligação e avisa", () => {
    let d = inserirDepois(base(), null, caixaDeAcao("acao-2", ACOES_FIXAS[2]!));
    d = { ...d, caixas: [...d.caixas, caixaDeAcao("acao-3", ACOES_FIXAS[8]!)] };
    const r = ligar(d, "acao-3", "acao-2");
    if (!r.ok) throw new Error("devia ligar");
    expect(r.aviso).toBe(AVISO_LIGACAO_TROCADA);
    expect(r.desenho.ligacoes.filter((l) => l.target === "acao-2")).toHaveLength(1);
    // acao-3 não está ligada a nada que venha do gatilho: o desenho aponta isso.
    expect(percorrer(r.desenho).problemas).toContainEqual({ caixa: "acao-3", mensagem: PROBLEMAS.foraDaAutomacao });
  });

  it("organizar põe a fila numa coluna, na ordem, e o que está solto à esquerda", () => {
    const d = organizar({ ...base(), caixas: [...base().caixas, caixaDeAcao("solta-1", ACOES_FIXAS[2]!)] });
    const y = (id: string) => d.caixas.find((c) => c.id === id)!.position.y;
    const x = (id: string) => d.caixas.find((c) => c.id === id)!.position.x;
    expect(y(ID_DO_GATILHO)).toBeLessThan(y(ID_DAS_CONDICOES));
    expect(y(ID_DAS_CONDICOES)).toBeLessThan(y("acao-1"));
    expect(x("solta-1")).toBeLessThan(x("acao-1"));
  });
});

describe("cada problema aparece na caixa que o causou", () => {
  const regra = REGRAS[0]![1];

  it("campo vazio de uma ação vira a frase daquele campo, na caixa daquela ação", () => {
    const desenho = desenhoDaRegra({ ...regra, actions: [{ type: "send_whatsapp_message", config: { channel_session_id: "", template: "" } }] });
    const r = validarDesenho({ nome: "x", desenho, regraGravada: null });
    expect(r.problemas).toContainEqual({ caixa: "acao-1", mensagem: PROBLEMA_DO_CAMPO.channel_session_id });
    expect(r.problemas).toContainEqual({ caixa: "acao-1", mensagem: PROBLEMA_DO_CAMPO.template });
  });

  it("o laço dos gatilhos de encerramento marca a ação que o fecharia", () => {
    const desenho = desenhoDaRegra({ ...regra, trigger_event: "lead.won", actions: [ACOES_FIXAS[2]!, ACOES_FIXAS[8]!] });
    const r = validarDesenho({ nome: "x", desenho, regraGravada: null });
    expect(r.problemas).toEqual([{ caixa: "acao-2", mensagem: MENSAGEM_DO_LACO_DE_LEAD }]);
  });

  it("o laço escondido numa opção da IA marca o passo da IA", () => {
    const desenho = desenhoDaRegra({ ...regra, trigger_event: "lead.won", actions: [PASSO_DA_IA] });
    const r = validarDesenho({ nome: "x", desenho, regraGravada: null });
    expect(r.problemas).toEqual([{ caixa: "acao-1", mensagem: MENSAGEM_DO_LACO_DE_LEAD }]);
  });

  it("o rodízio escondido numa opção da IA diz por que, no passo da IA (#2041)", () => {
    const rodizio = { type: "assign_owner", config: { modo: "rodizio", fila: [{ user_id: PESSOA, pausado: false }] } };
    const passo = { ...PASSO_DA_IA, config: { ...PASSO_DA_IA.config, opcoes: [...PASSO_DA_IA.config.opcoes, { id: "r", rotulo: "Rodízio", acao: rodizio }] } };
    const desenho = desenhoDaRegra({ ...regra, actions: [passo] });
    const r = validarDesenho({ nome: "x", desenho, regraGravada: null });
    expect(r.problemas).toEqual([{ caixa: "acao-1", mensagem: MENSAGEM_DO_RODIZIO_FORA_DO_LUGAR }]);
  });

  it("gatilho de data sem funil usa a frase do próprio schema, no gatilho", () => {
    const desenho = desenhoDaRegra({ ...regra, trigger_event: "lead.date_field_due", trigger_config: {} });
    const r = validarDesenho({ nome: "x", desenho, regraGravada: null });
    expect(r.problemas).toEqual([{ caixa: ID_DO_GATILHO, mensagem: "Escolha o funil, o campo de data e em quantos dias avisar." }]);
  });

  it("sem nome, o problema é da automação, não de uma caixa", () => {
    const r = validarDesenho({ nome: "", desenho: desenhoDaRegra(regra), regraGravada: null });
    expect(r.problemas).toEqual([{ caixa: null, mensagem: PROBLEMAS.semNome }]);
  });

  it("onze ações: a décima primeira é a marcada", () => {
    const onze = Array.from({ length: 11 }, () => ACOES_FIXAS[2]!);
    const r = validarDesenho({ nome: "x", desenho: desenhoDaRegra({ ...regra, actions: onze }), regraGravada: null });
    expect(r.problemas).toEqual([{ caixa: "acao-11", mensagem: PROBLEMAS.acoesDemais }]);
  });

  it("uma caixa solta impede salvar, mesmo com o resto válido", () => {
    const d = desenhoDaRegra(regra);
    const r = validarDesenho({ nome: "x", desenho: { ...d, caixas: [...d.caixas, caixaDeAcao("acao-99", ACOES_FIXAS[2]!)] }, regraGravada: null });
    expect(r.ok).toBe(false);
    expect(r.problemas).toEqual([{ caixa: "acao-99", mensagem: PROBLEMAS.foraDaAutomacao }]);
  });

  it("condições depois de uma ação são apontadas como fora do lugar", () => {
    const d = desenhoDaRegra({ ...regra, actions: [ACOES_FIXAS[2]!] });
    d.caixas.push({ id: ID_DAS_CONDICOES, type: "condicoes", position: { x: 0, y: 0 }, data: { kind: "condicoes", linhas: [] } });
    d.ligacoes.push({ id: "ligacao-9", source: "acao-1", target: ID_DAS_CONDICOES });
    expect(percorrer(d).problemas).toContainEqual({ caixa: ID_DAS_CONDICOES, mensagem: PROBLEMAS.condicoesForaDoLugar });
  });
});

/**
 * A CAUSA DO CR DO #2727: o desenho DESTRUÍA a regra que não sabe representar.
 *
 * O `salvar` do designer manda o `corpo.conditions` INTEIRO (PATCH), então o que
 * a caixa de condições achar na hora de salvar é o que fica no banco. No head
 * `bea2021ac` a ida e volta perdia as duas formas que a caixa não representa:
 *
 *   - `{any:[a eq 1, b gte 5]}` voltava como a LISTA `[a, b]`, que vale "todas":
 *     com `{a:"1", b:"2"}` a mesma regra avaliava `true` antes e `false` depois;
 *   - `[x is_empty ""]` voltava `[]` (o filtro `c.value.trim()` da linha 397):
 *     a regra ficava SEM condição e passava a disparar para todo mundo.
 *
 * Os testes abaixo caem se alguém reintroduzir o achatamento ou tirar o
 * `grupoPreservado`. Eles não olham o byte: comparam o corpo salvo com o que a
 * própria API gravaria, e onde dá, com o que o AVALIADOR decide.
 */
describe("o desenho não destrói a regra que não representa (#2727)", () => {
  const QUALQUER_UMA: RegraGravada = {
    trigger_event: "lead.created",
    trigger_config: {},
    conditions: {
      any: [
        { field: "lead.custom_fields.a", op: "eq", value: "1" },
        { field: "lead.custom_fields.b", op: "gte", value: "5" },
      ],
    },
    actions: [ACOES_FIXAS[2]!],
  };

  it("`{any:[…]}` volta com o MESMO combinador — nunca achatado na lista", () => {
    const desenho = desenhoDaRegra(QUALQUER_UMA);
    const caixa = desenho.caixas.find((c) => c.id === ID_DAS_CONDICOES)!;
    if (caixa.data.kind !== "condicoes") throw new Error("a caixa de condições");
    // A caixa GUARDA o grupo: é ele que o salvar devolve, e a tela sabe que não
    // o edita (mostra o aviso e manda para o formulário).
    expect(caixa.data.grupoPreservado).toEqual(QUALQUER_UMA.conditions);

    const corpo = corpoDoDesenho({ nome: "Qualquer uma", desenho, regraGravada: QUALQUER_UMA });
    expect(corpo.conditions).toEqual(QUALQUER_UMA.conditions);

    const r = validarDesenho({ nome: "Qualquer uma", desenho, regraGravada: QUALQUER_UMA });
    expect(r.problemas).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.corpo.conditions).toEqual(QUALQUER_UMA.conditions);
  });

  it("a lista achatada NÃO é o mesmo: `[a,b]` é \"todas\"", () => {
    // Prova que o defeito era de COMPORTAMENTO, não de bytes: o mesmo contexto
    // que o mantenedor mediu decide diferente no grupo e na lista achatada.
    const contexto = { lead: { custom_fields: { a: "1", b: "2" } } };
    const grupo = QUALQUER_UMA.conditions;
    const achatado = Array.isArray(grupo) ? grupo : grupo.any!;
    expect(evaluateConditions(grupo, contexto)).toBe(true);
    expect(evaluateConditions(achatado, contexto)).toBe(false);
  });

  it("`is_empty` volta como condição — o filtro do `value.trim()` não a engole", () => {
    const regra: RegraGravada = {
      trigger_event: "message.received",
      trigger_config: {},
      conditions: [{ field: "contact.name", op: "is_empty", value: "" }],
      actions: [ACOES_FIXAS[2]!],
    };
    const corpo = corpoDoDesenho({ nome: "Sem nome", desenho: desenhoDaRegra(regra), regraGravada: regra });
    expect(corpo.conditions).toEqual([{ field: "contact.name", op: "is_empty", value: "" }]);
  });

  it("`is_not_empty` também volta — e o valor é gravado vazio, como o formulário faz", () => {
    const regra: RegraGravada = {
      trigger_event: "message.received",
      trigger_config: {},
      conditions: [{ field: "contact.name", op: "is_not_empty", value: "lixo" }],
      actions: [ACOES_FIXAS[2]!],
    };
    const desenho = desenhoDaRegra(regra);
    const caixa = desenho.caixas.find((c) => c.id === ID_DAS_CONDICOES)!;
    if (caixa.data.kind !== "condicoes") throw new Error("a caixa de condições");
    caixa.data.linhas[0] = { ...caixa.data.linhas[0]!, value: "  lixo  " };
    expect(corpoDoDesenho({ nome: "x", desenho, regraGravada: regra }).conditions).toEqual([
      { field: "contact.name", op: "is_not_empty", value: "" },
    ]);
  });

  it("o CONTROLE: `[x eq 1]` continua voltando com a condição", () => {
    const regra: RegraGravada = {
      trigger_event: "message.received",
      trigger_config: {},
      conditions: [{ field: "contact.name", op: "eq", value: "1" }],
      actions: [ACOES_FIXAS[2]!],
    };
    expect(corpoDoDesenho({ nome: "x", desenho: desenhoDaRegra(regra), regraGravada: regra }).conditions).toEqual([
      { field: "contact.name", op: "eq", value: "1" },
    ]);
  });

  it("um grupo VAZIO (`{any:[]}`, sempre falso) continua tendo a sua caixa: nunca vira `[]`", () => {
    // Sem caixa, o salvar mandaria `[]`, que vale "todas" — o OPOSTO de um
    // `any` vazio. A regra passaria a disparar para todo mundo.
    const regra: RegraGravada = { ...QUALQUER_UMA, conditions: { any: [] } };
    const desenho = desenhoDaRegra(regra);
    expect(desenho.caixas.some((c) => c.id === ID_DAS_CONDICOES)).toBe(true);
    const corpo = corpoDoDesenho({ nome: "x", desenho, regraGravada: regra });
    expect(corpo.conditions).toEqual({ any: [] });
    expect(validarDesenho({ nome: "x", desenho, regraGravada: regra }).problemas).toEqual([]);
  });

  it("o que o desenho grava para um grupo é o que a API grava — o schema aceita", () => {
    const desenho = desenhoDaRegra(QUALQUER_UMA);
    const r = validarDesenho({ nome: "Qualquer uma", desenho, regraGravada: QUALQUER_UMA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(createAutomationRuleSchema.parse(r.corpo).conditions).toEqual(QUALQUER_UMA.conditions);
  });
});
