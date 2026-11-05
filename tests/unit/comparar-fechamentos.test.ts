/**
 * A RÉGUA DA AVALIAÇÃO OFFLINE DO FECHAMENTO (Frente G, `scripts/avaliar-fechamento.ts`).
 *
 * O que decide trocar o modelo do checkpoint é a diferença sombra − controle, e
 * ela só vale se a régua não inflar o acerto. O que este arquivo prende:
 * - o pareamento é 1-para-1: uma promessa do braço nunca casa com duas do atual;
 * - o prazo só reforça: prazo sozinho nunca casa, nem null × null;
 * - "quer remarcar" × "quer cancelar" não é a mesma intenção;
 * - a retenção conta as entidades do resumo anterior que o novo resumo manteve;
 * - a avaliação de uma conversa chama atual, controle e sombra com o MESMO pedido,
 *   classifica o formato e devolve só números (nenhum texto da conversa);
 * - a não-inferioridade é o estimador de razão do desenho, com o limite inferior;
 * - o roteiro roda SEM as variáveis do Supabase: num processo filho com o ambiente
 *   limpo, ele carrega tudo e só para no corpus inválido, antes de qualquer chamada.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  avaliarConversa,
  entidades,
  instante,
  jaccard,
  medirPar,
  naoInferioridade,
  notaDaIntencao,
  notaDaPromessa,
  parear,
  resumir,
  TETO_DE_SAIDA_DA_AVALIACAO,
  tokens,
  type ConversaDoCorpus,
  type MensagemDoFechamento,
} from "@/lib/agent-engine/agent/abertura/comparar-fechamentos";
import { CHECKPOINT_INSTRUCTION, type CheckpointContent } from "@/lib/agent-engine/agent/abertura/checkpoint";
import { TETO_DE_SAIDA_PADRAO } from "@/lib/agent-engine/edge/llm/run-model-call";

function fechamento(p: Partial<CheckpointContent> = {}): CheckpointContent {
  return {
    commitments: [],
    objections: [],
    next_action: "aguardar o cliente",
    rolling_summary: "",
    declaracao: { intencoes: [], promessas: [], nada_a_declarar: true },
    ...p,
  };
}

const promessa = (o_que: string, prazo: string | null = null) => ({ o_que, prazo });
const intencao = (o_que: string) => ({ o_que, evidencia: "trecho" });

describe("tokens e Jaccard", () => {
  it("tira acento e caixa, corta palavras curtas e a stoplist", () => {
    expect([...tokens("Você VAI receber o Boleto amanhã")].sort()).toEqual(["amanha", "boleto", "receber"]);
  });

  it("vazio de um lado dá 0", () => {
    expect(jaccard("", "boleto")).toBe(0);
    expect(jaccard("quer remarcar", "quer remarcar")).toBe(1);
  });
});

describe("instante do prazo", () => {
  it("datas iguais em fusos diferentes são o mesmo minuto; texto não parseável vira texto normalizado; null fica null", () => {
    expect(instante("2026-11-12T10:00:00-03:00")).toBe(instante("2026-11-12T13:00:00Z"));
    expect(instante("Amanhã  de manhã")).toBe("amanha de manha");
    expect(instante(null)).toBeNull();
  });

  it("texto livre que o Date.parse do V8 aceita não vira o mesmo minuto", () => {
    expect(instante("sexta 10")).not.toBe(instante("segunda 10"));
    expect(instante("dia 12")).not.toBe(instante("até dia 12"));
    expect(instante("2026-11-12")).toBe(instante(" 2026-11-12 "));
    expect(typeof instante("2026-11-12")).toBe("number");
  });
});

describe("pareamento de promessas", () => {
  it("1-para-1: duas promessas distintas no mesmo instante contra uma só no braço → 1 em comum", () => {
    const prazo = "2026-11-12T10:00:00-03:00";
    const atual = fechamento({
      declaracao: {
        intencoes: [],
        promessas: [promessa("enviar o boleto do pedido", prazo), promessa("enviar o contrato do pedido", prazo)],
        nada_a_declarar: false,
      },
    });
    const braco = fechamento({
      declaracao: { intencoes: [], promessas: [promessa("enviar o boleto do pedido", prazo)], nada_a_declarar: false },
    });
    const m = medirPar(atual, braco, null);
    expect(m.promessas_atual).toBe(2);
    expect(m.promessas_braco).toBe(1);
    expect(m.promessas_em_comum).toBe(1);
    expect(m.prazos_atual).toBe(2);
    expect(m.prazos_em_comum).toBe(1);
  });

  it("uma promessa do braço nunca casa com duas do atual, e o par de nota maior vence", () => {
    const a = [promessa("enviar o boleto hoje"), promessa("enviar o boleto do pedido hoje")];
    const b = [promessa("enviar o boleto do pedido hoje")];
    expect(parear(a, b, notaDaPromessa)).toEqual([[1, 0]]);
  });

  it("o horário igual não faz duas promessas diferentes casarem — nem com o mesmo prazo", () => {
    const prazo = "2026-11-12T10:00:00-03:00";
    expect(notaDaPromessa(promessa("te mando o boleto amanhã 10h"), promessa("vou confirmar a disponibilidade amanhã 10h"))).toBeNull();
    expect(
      notaDaPromessa(promessa("te mando o boleto amanhã 10h", prazo), promessa("vou confirmar a disponibilidade amanhã 10h", prazo)),
    ).toBeNull();
  });

  it("o prazo igual reforça uma paráfrase do mesmo QUE (controle positivo do reforço)", () => {
    const prazo = "2026-11-12T10:00:00-03:00";
    // J = 2/5 = 0,4: abaixo de 0,5 sem prazo, acima de 0,3 com o mesmo instante.
    const x = promessa("enviar boleto atualizado", prazo);
    const y = promessa("mandar boleto atualizado hoje", prazo);
    expect(jaccard(x.o_que, y.o_que)).toBeCloseTo(0.4, 5);
    expect(notaDaPromessa(x, y)).not.toBeNull();
    expect(notaDaPromessa({ ...x, prazo: null }, { ...y, prazo: null })).toBeNull();
  });

  it("prazo null × null com textos diferentes não casa", () => {
    expect(notaDaPromessa(promessa("verificar o estoque"), promessa("retornar com o orçamento"))).toBeNull();
  });
});

describe("intenções", () => {
  it("'quer remarcar' × 'quer cancelar' → 0 em comum (J = 1/3)", () => {
    expect(jaccard("quer remarcar", "quer cancelar")).toBeCloseTo(1 / 3, 5);
    expect(notaDaIntencao(intencao("quer remarcar"), intencao("quer cancelar"))).toBeNull();
    const m = medirPar(
      fechamento({ declaracao: { intencoes: [intencao("quer remarcar")], promessas: [], nada_a_declarar: false } }),
      fechamento({ declaracao: { intencoes: [intencao("quer cancelar")], promessas: [], nada_a_declarar: false } }),
      null,
    );
    expect(m.intencoes_atual).toBe(1);
    expect(m.intencoes_em_comum).toBe(0);
  });
});

describe("retenção do resumo anterior", () => {
  it("o resumo anterior tem 'R$ 1.200', '12/11' e 'Joana'; o braço perde '12/11' → 3 anteriores, 2 retidas", () => {
    const anterior = fechamento({ rolling_summary: "cliente quer pagar R$ 1.200 até 12/11 e falou com Joana." });
    expect([...entidades(anterior.rolling_summary)].sort()).toEqual(["12/11", "joana", "r$1.200"]);
    const atual = fechamento({ rolling_summary: "Joana confirmou: pagamento de R$ 1.200 até 12/11." });
    const braco = fechamento({ rolling_summary: "Joana confirmou o pagamento de R$1.200 no mês que vem." });
    const m = medirPar(atual, braco, anterior);
    expect(m.entidades_anteriores).toBe(3);
    expect(m.retidas_atual).toBe(3);
    expect(m.retidas_braco).toBe(2);
  });

  it("sem resumo anterior, nada a reter", () => {
    const m = medirPar(fechamento(), fechamento(), null);
    expect([m.entidades_anteriores, m.retidas_atual, m.retidas_braco]).toEqual([0, 0, 0]);
  });
});

describe("as demais medidas do par", () => {
  it("declaração ausente, nada_a_declarar, next_action nulo e similaridade do resumo", () => {
    const atual = fechamento({ next_action: null, rolling_summary: "cliente quer remarcar a consulta" });
    const braco = fechamento({ declaracao: undefined, rolling_summary: "cliente quer remarcar a consulta" });
    const m = medirPar(atual, braco, null);
    expect(m.declaracao_ausente_atual).toBe(false);
    expect(m.declaracao_ausente_braco).toBe(true);
    expect(m.nada_atual).toBe(true);
    expect(m.nada_braco).toBeNull();
    expect(m.next_nulo_atual).toBe(true);
    expect(m.next_nulo_braco).toBe(false);
    expect(m.similaridade_resumo).toBe(1);
  });
});

describe("a não-inferioridade (estimador de razão do desenho)", () => {
  it("braço igual ao controle: delta 0 e limite 0", () => {
    expect(naoInferioridade([{ n: 2, braco: 2, controle: 2 }, { n: 1, braco: 1, controle: 1 }])).toEqual({
      n: 3,
      delta: 0,
      limite_inferior: 0,
    });
  });

  it("perda do braço: delta negativo e limite abaixo dele; sem amostra, null", () => {
    // Σn = 4, Σps − Σpc = −1 → d = −0,25; resíduos (−1 + 0,5) e (0 + 0,5) → √0,5.
    const r = naoInferioridade([{ n: 2, braco: 1, controle: 2 }, { n: 2, braco: 2, controle: 2 }]);
    expect(r?.n).toBe(4);
    expect(r?.delta).toBeCloseTo(-0.25, 10);
    expect(r?.limite_inferior).toBeCloseTo(-0.25 - (1.96 * Math.sqrt(0.5)) / 4, 10);
    expect(naoInferioridade([{ n: 0, braco: 0, controle: 0 }])).toBeNull();
  });
});

describe("avaliar uma conversa do corpus", () => {
  const VALIDO = JSON.stringify(
    fechamento({
      rolling_summary: "SEGREDO-DO-RESUMO Joana",
      declaracao: { intencoes: [intencao("SEGREDO-DA-INTENCAO")], promessas: [promessa("SEGREDO-DA-PROMESSA")], nada_a_declarar: false },
    }),
  );
  const conversa: ConversaDoCorpus = {
    id: "c1",
    system: "system do agente",
    mensagens: [{ role: "user", content: "oi, quero remarcar" }],
    anterior: fechamento({ rolling_summary: "falou com Joana" }),
  };

  it("⭐ atual, controle e sombra recebem o MESMO pedido; o braço que recusa duas vezes sai 'recusado', e o resultado só tem números", async () => {
    const pedidos: Array<{ modelo: string; system: string; mensagens: MensagemDoFechamento[] }> = [];
    const chamar = vi.fn(async (modelo: string, system: string, mensagens: MensagemDoFechamento[]) => {
      pedidos.push({ modelo, system, mensagens });
      return { text: modelo === "barato" ? "sem json" : VALIDO };
    });
    const r = await avaliarConversa(conversa, chamar, { agente: "agente", economico: "barato" });

    // atual (1) + controle (1) + sombra (2: a correção antes de desistir).
    expect(pedidos.map((p) => p.modelo)).toEqual(["agente", "agente", "barato", "barato"]);
    const base = [...conversa.mensagens, { role: "user", content: CHECKPOINT_INSTRUCTION }];
    expect(pedidos[0]!.mensagens).toEqual(base);
    expect(pedidos[1]!.mensagens).toEqual(base);
    expect(pedidos[2]!.mensagens).toEqual(base);
    expect(pedidos.every((p) => p.system === "system do agente")).toBe(true);

    expect(r.atual).toEqual({ modelo: "agente", formato: "ok" });
    expect(r.bracos.map((b) => [b.braco, b.formato])).toEqual([
      ["controle", "ok"],
      ["sombra", "recusado"],
    ]);
    expect(r.bracos[0]!.medida?.promessas_em_comum).toBe(1);
    expect(r.bracos[0]!.medida?.retidas_braco).toBe(1);
    expect(r.bracos[1]!.medida).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/SEGREDO|quero remarcar|Joana/);
  });

  it("falha do fornecedor no braço sai 'falhou' e não derruba a avaliação; atual sem formato não gasta os braços", async () => {
    const falhaNoBarato = vi.fn(async (modelo: string) => {
      if (modelo === "barato") throw new Error("provider 503");
      return { text: VALIDO };
    });
    const r = await avaliarConversa(conversa, falhaNoBarato, { agente: "agente", economico: "barato" });
    expect(r.bracos.find((b) => b.braco === "sombra")?.formato).toBe("falhou");

    const atualRecusa = vi.fn(async () => ({ text: "sem json" }));
    const semAtual = await avaliarConversa(conversa, atualRecusa, { agente: "agente", economico: "barato" });
    expect(semAtual.atual.formato).toBe("recusado");
    expect(semAtual.bracos).toEqual([]);
    expect(atualRecusa).toHaveBeenCalledTimes(2);
  });

  it("o resumo do corpus junta os pares válidos de sombra e controle", async () => {
    const chamar = async () => ({ text: VALIDO });
    const avaliacoes = [
      await avaliarConversa(conversa, chamar, { agente: "agente", economico: "barato" }),
      await avaliarConversa({ ...conversa, id: "c2" }, chamar, { agente: "agente", economico: "barato" }),
    ];
    const resumo = resumir(avaliacoes);
    expect(resumo.conversas).toBe(2);
    expect(resumo.pares_validos).toBe(2);
    expect(resumo.formato.sombra).toEqual({ ok: 2, corrigido: 0, recusado: 0, falhou: 0 });
    expect(resumo.promessas).toEqual({ n: 2, delta: 0, limite_inferior: 0 });
    expect(resumo.prazos).toBeNull();
    expect(resumo.retencao).toEqual({ n: 2, delta: 0, limite_inferior: 0 });
  });
});

describe("o roteiro roda sem as variáveis do Supabase", () => {
  const RAIZ = join(__dirname, "..", "..");
  /** O CLI do tsx como arquivo, pelo `process.execPath` — ver `import-puro-sem-env.test.ts`. */
  const TSX_CLI = join(RAIZ, "node_modules", "tsx", "dist", "cli.mjs");
  const DIR = mkdtempSync(join(tmpdir(), "avaliar-fechamento-"));
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("o teto de saída da avaliação é o padrão do seam", () => {
    expect(TETO_DE_SAIDA_DA_AVALIACAO).toBe(TETO_DE_SAIDA_PADRAO);
  });

  // Processo filho: o setup do vitest já pôs placeholders do Supabase neste processo,
  // e importar aqui mediria nada. Nenhuma chamada sai: o corpus reprova antes.
  it("com o ambiente limpo, carrega tudo e para no corpus inválido", { timeout: 150_000 }, () => {
    const corpus = join(DIR, "corpus.json");
    const saidaJson = join(DIR, "saida.json");
    writeFileSync(corpus, JSON.stringify([{ id: "c1" }]));
    const r = spawnSync(process.execPath, [TSX_CLI, join("scripts", "avaliar-fechamento.ts")], {
      cwd: RAIZ,
      // `NODE_ENV` só porque o tipo `ProcessEnv` do Next o exige; o roteiro não o lê.
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        CORPUS: corpus,
        SAIDA: saidaJson,
        PROVEDOR: "anthropic",
        MODELO_AGENTE: "modelo-do-agente",
        MODELO_ECONOMICO: "modelo-economico",
        // O preço é lido DEPOIS do corpus: o arquivo nem precisa existir para o corpus reprovar antes.
        PRECOS: join(DIR, "precos-que-nao-existem.json"),
        TETO_USD: "1",
        ANTHROPIC_API_KEY: "chave-falsa-que-nunca-sai-daqui",
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    const saida = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(saida, "o roteiro carregou lib/env.ts").not.toContain("Variáveis de ambiente inválidas");
    // O caminho do erro do Zod prova que o filho rodou até o parse do corpus.
    expect(saida, saida).toContain("mensagens");
    expect(r.status, saida).toBe(1);
    expect(existsSync(saidaJson)).toBe(false);
  });
});
