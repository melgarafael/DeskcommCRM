/**
 * Os SDKs dos provedores montados direto, para os roteiros de avaliação que
 * falam com o modelo SEM o motor (o fechamento offline da frente G e o juiz do
 * F5). Montados como em `createDefaultRegistry` (providers.ts), que não pode ser
 * importado por eles: carrega `lib/env.ts`, e esses roteiros rodam sem as
 * variáveis do Supabase.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

// ponytail: gateway e assinatura ficam de fora; acrescente aqui quando uma avaliação precisar deles.
export const FABRICAS: Readonly<Record<string, (apiKey: string, modelo: string) => LanguageModel>> = {
  anthropic: (apiKey, modelo) => createAnthropic({ apiKey })(modelo),
  openai: (apiKey, modelo) => createOpenAI({ apiKey })(modelo),
  google: (apiKey, modelo) => createGoogleGenerativeAI({ apiKey })(modelo),
  openrouter: (apiKey, modelo) => createOpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" }).chat(modelo),
};

/** O modelo pronto, com a chave lida de `<PROVEDOR>_API_KEY` (maiúsculas, `-` vira `_`). */
export function modeloDireto(provedor: string, modelo: string, env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const fabrica = FABRICAS[provedor];
  if (fabrica === undefined) throw new Error(`provedor desconhecido: ${provedor} (use ${Object.keys(FABRICAS).join(", ")})`);
  const variavel = `${provedor.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  const chave = env[variavel];
  if (!chave) throw new Error(`${variavel} ausente no ambiente`);
  return fabrica(chave, modelo);
}
