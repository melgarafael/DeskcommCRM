/**
 * AVALIAÇÃO OFFLINE DO FECHAMENTO NUM MODELO MAIS BARATO (Frente G).
 *
 * Para cada conversa de um corpus local (JSON), roda o fechamento do turno três
 * vezes com o MESMO pedido: no modelo do agente (`atual`), de novo no modelo do
 * agente (`controle`, A/A) e no modelo econômico (`sombra`). Mede cada braço contra
 * o atual com a régua pura de `lib/agent-engine/agent/abertura/comparar-fechamentos.ts`
 * e grava um JSON local só com números: o resumo (formatos e não-inferioridade da
 * sombra contra o controle em promessas, prazos, intenções e retenção) e a medida
 * de cada conversa.
 *
 * Fala direto com o provedor e não consulta o banco: nada vai para `llm_calls`,
 * nada é cobrado de organização nenhuma — a conta é a da chave passada aqui. O
 * corpus é o pedido do fechamento ANTES de `CHECKPOINT_INSTRUCTION` (formato em
 * `corpusSchema`); use conversas inventadas, nunca dado de cliente.
 *
 * Não precisa das variáveis do Supabase: nada aqui carrega `lib/env.ts` (é por
 * isso que a fábrica do modelo vem de `scripts/lib/fabricas-diretas.ts`, e não do
 * registry do motor). `tests/unit/comparar-fechamentos.test.ts` roda este arquivo
 * com o ambiente limpo.
 *   CORPUS=corpus.json SAIDA=resultado.json PROVEDOR=anthropic \
 *   MODELO_AGENTE=claude-sonnet-5 MODELO_ECONOMICO=claude-haiku-5-5 \
 *   PRECOS=precos-openrouter.json TETO_USD=10 \
 *   ANTHROPIC_API_KEY=... pnpm exec tsx scripts/avaliar-fechamento.ts
 *
 * A chave é lida de `<PROVEDOR>_API_KEY` (maiúsculas, `-` vira `_`). GASTA: o
 * custo de cada chamada sai do uso que o provedor devolve × o preço de `PRECOS`
 * (a resposta de GET https://openrouter.ai/api/v1/models), e o roteiro para — e
 * grava o que mediu — quando o gasto chega a `TETO_USD`. O corpus inventado e o
 * procedimento estão em docs/runbooks/avaliacoes-de-tokens.md.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { generateText } from "ai";
import { z } from "zod";

import {
  avaliarConversa,
  corpusSchema,
  resumir,
  TETO_DE_SAIDA_DA_AVALIACAO,
  type AvaliacaoDaConversa,
  type Chamar,
} from "@/lib/agent-engine/agent/abertura/comparar-fechamentos";

import { custoDosTokens, idNaOpenRouter, precoDaOpenRouter, tokensDoUso, type Preco } from "./lib/avaliacao-de-tokens";
import { modeloDireto } from "./lib/fabricas-diretas";

const env = z
  .object({
    CORPUS: z.string().min(1),
    SAIDA: z.string().min(1),
    PROVEDOR: z.string().min(1),
    MODELO_AGENTE: z.string().min(1),
    MODELO_ECONOMICO: z.string().min(1),
    PRECOS: z.string().min(1),
    TETO_USD: z.coerce.number().positive(),
  })
  .parse(process.env);

let gastoUsd = 0;
const precos = new Map<string, Preco>();

// A falha do fornecedor vira `falhou` na medida; o motivo vai para o terminal.
const chamar: Chamar = async (modelo, system, mensagens) => {
  try {
    const r = await generateText({ model: modeloDireto(env.PROVEDOR, modelo), system, messages: mensagens, maxOutputTokens: TETO_DE_SAIDA_DA_AVALIACAO });
    const preco = precos.get(modelo);
    if (preco !== undefined) gastoUsd += custoDosTokens(tokensDoUso(r.usage), preco);
    return { text: r.text };
  } catch (err) {
    console.error(`chamada a ${modelo} falhou: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
};

async function main(): Promise<void> {
  const corpus = corpusSchema.parse(JSON.parse(readFileSync(env.CORPUS, "utf8")));
  // Depois do corpus: modelo sem preço publicado não pode gastar sem conta.
  const catalogo: unknown = JSON.parse(readFileSync(env.PRECOS, "utf8"));
  for (const m of [env.MODELO_AGENTE, env.MODELO_ECONOMICO]) precos.set(m, precoDaOpenRouter(catalogo, idNaOpenRouter(env.PROVEDOR, m)));
  // Chave ausente ou provedor desconhecido param AQUI: dentro de `chamar` virariam
  // `falhou` em todas as conversas, um resultado que lê como medição.
  modeloDireto(env.PROVEDOR, env.MODELO_AGENTE);
  const conversas: AvaliacaoDaConversa[] = [];
  let interrompido: string | null = null;
  for (const c of corpus) {
    if (gastoUsd >= env.TETO_USD) {
      interrompido = `teto de US$ ${env.TETO_USD} atingido (gasto US$ ${gastoUsd.toFixed(4)})`;
      console.error(interrompido);
      process.exitCode = 3;
      break;
    }
    conversas.push(await avaliarConversa(c, chamar, { agente: env.MODELO_AGENTE, economico: env.MODELO_ECONOMICO }));
    console.info(`${conversas.length}/${corpus.length} ${c.id} · US$ ${gastoUsd.toFixed(4)}`);
  }
  const resumo = resumir(conversas);
  writeFileSync(
    env.SAIDA,
    JSON.stringify(
      { gerado_em: new Date().toISOString(), provedor: env.PROVEDOR, agente: env.MODELO_AGENTE, economico: env.MODELO_ECONOMICO, gasto_usd: gastoUsd, interrompido, resumo, conversas },
      null,
      2,
    ),
  );
  console.info(JSON.stringify(resumo, null, 2));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
