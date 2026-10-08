/**
 * O dry-run prepara a mídia COMO O ENVIO REAL (#2490).
 *
 * O defeito: o Testar avaliava só o texto, e a resposta saía "válida" mesmo
 * quando a foto não era encontrada, copiada ou preparada — o operador descobria
 * no atendimento real. O conserto é de FIÇÃO, não de reimplementação: o `send_message`
 * da prévia chama a MESMA `prepararFotosDoProduto` do caminho de produção
 * (injetada pelo turno), com a MESMA cópia por service role; só o destino muda —
 * a pasta `dry-run` da organização, porque anexo em conversa seria efeito no cliente.
 *
 * E a proibição de efeito externo continua intacta: nenhum cenário aqui chama
 * canal de entrega nem roda o executor original do `send_message` — a mensagem
 * não sai.
 *
 * Sabotagem medida (remover o bloco de mídia de `preview.ts`):
 * **7 vermelhos de 8** — sucesso, pasta de teste, sem-fotos, código inexistente,
 * cópia falhada, sem produto_codigo (a asserção do registro `midia`) e sem preparador;
 * verde só a fiação por fonte, que lê `inbound-turn.ts`. Previsão escrita antes da
 * rodada: 6 — o caso "sem produto_codigo" entrou porque também afirma que o registro
 * `midia` existe. Restaurado por `git checkout HEAD --` com árvore limpa.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels";
import { tool } from "@/lib/agent-engine/edge/llm/run-model-call";
import { type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import {
  PASTA_DE_TESTE_DE_MIDIA,
  prepararFotosDoProduto,
} from "@/lib/agent-engine/agent/fotos-do-produto";
import {
  applyPreviewPolicy,
  newPreviewResult,
  scenarioContext,
  type TurnPreview,
} from "@/lib/agent-engine/agent/preview";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const PRODUTO = "bbbbbbbb-0000-4000-8000-000000000001";
const CAPA = `${ORG}/${PRODUTO}/11111111-2222-4333-8444-555555555555.jpg`;
const SEGUNDA = `${ORG}/${PRODUTO}/66666666-7777-4888-8999-000000000000.png`;

/** O MESMO contexto que `preview.test.ts` usa — gates em paz, sem gate de pacing. */
const gate = (): GateContext => ({
  now: new Date("2026-09-07T15:00:00Z"),
  body: "iPhone 15 por R$ 5.499",
  optedOut: false,
  provider: DEFAULT_CHANNEL_PROVIDER,
  messagingWindow: { lastInboundAt: new Date("2026-09-07T14:00:00Z") },
  pacing: {
    knobs: PACING_DEFAULTS,
    state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
    crmDailyLimit: null,
  },
  spinning: { knobs: SPINNING_DEFAULTS, window: [] },
  promise: { table: null },
  semanticPromise: null,
  disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
  lgpd: null,
  casesEnabled: false,
  hasOpenCase: false,
  openedCaseThisTurn: false,
});

const preview = () =>
  ({
    kind: "sandbox",
    organizationId: ORG,
    runId: "preview-run",
    contactId: null,
    channelId: null,
    agent: {},
    context: scenarioContext([]),
    result: newPreviewResult(),
  }) as TurnPreview;

/** Banco falso no formato que `prepararFotosDoProduto` lê: `catalog_products`. */
function catalogo(produtos: Record<string, { fotos: string[] } | undefined>) {
  const query = vi.fn(async (_sql: string, valores: unknown[]) => {
    const linha = produtos[String(valores[1])];
    return { rows: linha ? [{ id: PRODUTO, fotos: linha.fotos }] : [] };
  });
  return { db: { query } as never, query };
}

const definition = () =>
  tool({
    inputSchema: z.object({ body: z.string(), produto_codigo: z.string().optional() }),
    // O executor original do envio real: NUNCA pode rodar dentro do preview.
    execute: vi.fn(async () => ({ ok: true })),
  });

/**
 * O cenario do teste: a prévia com a `prepararFotosDoProduto` REAL enfiada nela,
 * do jeito que `inbound-turn.ts` faz no caminho de produção.
 */
function cenario(
  db: never,
  opts: { copiar?: (origem: string, destino: string) => Promise<boolean>; semPreparador?: boolean } = {},
) {
  const p = preview();
  const original = definition();
  const copiar = opts.copiar ?? (async () => true);
  const preparar = opts.semPreparador
    ? undefined
    : (codigo: string) =>
        prepararFotosDoProduto(db, copiar, {
          tenantId: ORG,
          conversationId: PASTA_DE_TESTE_DE_MIDIA,
          codigo,
        });
  const tools = applyPreviewPolicy(
    { send_message: original },
    p,
    gate(),
    () => [],
    undefined,
    undefined,
    preparar,
  );
  const chamar = (args: unknown) =>
    tools.send_message!.execute!(args, { toolCallId: "test", messages: [], context: undefined });
  return { p, chamar, original, copiar };
}

describe("dry-run prepara a mídia do produto como o envio real (#2490)", () => {
  it("produto com fotos: resolve no catálogo, prepara as duas e registra os anexos previstos", async () => {
    const { db } = catalogo({ IP15: { fotos: [CAPA, SEGUNDA] } });
    const { p, chamar, original } = cenario(db);

    const r = await chamar({ body: "iPhone 15 por R$ 5.499", produto_codigo: "IP15" });

    expect(r.ok).toBe(true);
    // A cadeia do envio real rodou: candidato registrado, executor não.
    expect(p.result.candidates).toHaveLength(1);
    expect(original.execute).not.toHaveBeenCalled();
    expect(p.result.impediments).toEqual([]);
    expect(p.result.midia).toEqual([
      {
        codigo: "IP15",
        produtoResolvido: true,
        fotosCadastradas: 2,
        fotosPreparadas: 2,
        anexos: [
          {
            storagePath: `${ORG}/${PASTA_DE_TESTE_DE_MIDIA}/catalogo-11111111-2222-4333-8444-555555555555.jpg`,
            mime: "image/jpeg",
          },
          {
            storagePath: `${ORG}/${PASTA_DE_TESTE_DE_MIDIA}/catalogo-66666666-7777-4888-8999-000000000000.png`,
            mime: "image/png",
          },
        ],
      },
    ]);
  });

  it("a cópia sai para a pasta de TESTE — nunca para a pasta de uma conversa", async () => {
    const { db } = catalogo({ IP15: { fotos: [CAPA] } });
    const copias: Array<[origem: string, destino: string]> = [];
    const { chamar } = cenario(db, {
      copiar: async (origem, destino) => {
        copias.push([origem, destino]);
        return true;
      },
    });

    await chamar({ body: "Segue a foto", produto_codigo: "IP15" });

    expect(copias).toEqual([
      [CAPA, `${ORG}/${PASTA_DE_TESTE_DE_MIDIA}/catalogo-11111111-2222-4333-8444-555555555555.jpg`],
    ]);
    // O sandbox não tem conversa: anexo em pasta de conversa seria efeito
    // permanente num lugar que a issue manda deixar intocado.
    expect(copias.every(([, destino]) => destino.startsWith(`${ORG}/${PASTA_DE_TESTE_DE_MIDIA}/`))).toBe(
      true,
    );
  });

  it("produto sem fotos: segue com o texto e AVISA que nenhuma imagem sairia", async () => {
    const { db } = catalogo({ SEMFOTO: { fotos: [] } });
    const { p, chamar } = cenario(db);

    await chamar({ body: "Temos o item", produto_codigo: "SEMFOTO" });

    expect(p.result.candidates).toHaveLength(1);
    expect(p.result.impediments).toEqual([]);
    expect(p.result.midia[0]).toMatchObject({
      codigo: "SEMFOTO",
      produtoResolvido: true,
      fotosCadastradas: 0,
      fotosPreparadas: 0,
      anexos: [],
    });
    expect(p.result.midia[0]?.falha).toBeUndefined();
    expect(p.result.warnings.map((w) => w.code)).toContain("midia_sem_fotos");
  });

  it("código inexistente: falha EXPLÍCITA, nenhum candidato — o dry-run fica vermelho", async () => {
    const { db } = catalogo({});
    const { p, chamar, original } = cenario(db);

    const r = await chamar({ body: "Segue a foto", produto_codigo: "NAO-EXISTE" });

    expect(r.ok).toBe(false);
    expect(p.result.candidates).toEqual([]);
    expect(original.execute).not.toHaveBeenCalled();
    expect(p.result.impediments[0]?.code).toBe("produto_nao_encontrado");
    expect(p.result.midia[0]).toMatchObject({ codigo: "NAO-EXISTE", produtoResolvido: false });
    expect(p.result.midia[0]?.falha?.code).toBe("produto_nao_encontrado");
  });

  it("foto que não copiou: falha com o erro, NÃO degrada para só texto", async () => {
    const { db } = catalogo({ IP15: { fotos: [CAPA, SEGUNDA] } });
    const { p, chamar } = cenario(db, { copiar: async (origem) => origem !== CAPA });

    const r = await chamar({ body: "Segue a foto", produto_codigo: "IP15" });

    // O envio real degradaria (sai o texto sem a capa); o TESTE não passa pano.
    expect(r.ok).toBe(false);
    expect(p.result.candidates).toEqual([]);
    expect(p.result.impediments[0]?.code).toBe("midia_nao_preparada");
    expect(p.result.midia[0]).toMatchObject({ fotosCadastradas: 2, fotosPreparadas: 1 });
    expect(p.result.midia[0]?.falha?.code).toBe("midia_nao_preparada");
  });

  it("sem produto_codigo nenhuma preparação roda — como no envio real", async () => {
    const { db, query } = catalogo({ IP15: { fotos: [CAPA] } });
    const copiar = vi.fn(async () => true);
    const { p, chamar } = cenario(db, { copiar });

    await chamar({ body: "Olá, posso ajudar?" });

    expect(copiar).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(p.result.midia).toEqual([]);
    expect(p.result.candidates).toHaveLength(1);
  });

  it("produto_codigo SEM preparador injetado não atravessa o teste como aprovado", async () => {
    const { p, chamar } = cenario(catalogo({ IP15: { fotos: [CAPA] } }).db, { semPreparador: true });

    const r = await chamar({ body: "Segue a foto", produto_codigo: "IP15" });

    expect(r.ok).toBe(false);
    expect(p.result.candidates).toEqual([]);
    expect(p.result.impediments[0]?.code).toBe("midia_nao_preparada");
    expect(p.result.midia[0]?.falha?.code).toBe("midia_nao_preparada");
  });

  it("fia a prévia ao caminho de produção: o turno injeta prepararFotosDoProduto", () => {
    // A chamada real mora no fecho do turno (sem ponto de injeção barato), mesma
    // técnica de `send-message-manda-foto-do-produto.test.ts`: sem esta linha o
    // teste acima passaria com um injetor de mentira e nada provaria.
    const fonte = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
    const inicio = fonte.indexOf("applyPreviewPolicy(");
    const fim = fonte.indexOf(": rawTools;", inicio);
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
    const bloco = fonte.slice(inicio, fim);
    expect(bloco).toContain("prepararFotosDoProduto(pool, copiarFotoNoStorage(");
    expect(bloco).toContain(`conversationId: PASTA_DE_TESTE_DE_MIDIA`);
    // E o envio real continua com a dele — a prévia não pode tê-la substituído.
    const send = fonte.slice(fonte.indexOf("send_message: tool({"), fonte.indexOf("update_lead_state: tool({"));
    expect(send).toContain("prepararFotosDoProduto(pool, copiarFotoNoStorage(runLog),");
  });
});
