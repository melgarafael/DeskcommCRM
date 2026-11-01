/**
 * A régua do padrão do campo (#2730) no SERVIDOR: a regex vem da configuração
 * do funil e o texto vem de fora (API, IA), e a conferência roda no mesmo
 * processo que atende todas as organizações da instalação. Por isso ela tem
 * prazo: o que não termina em `PRAZO_DA_CONFERENCIA_MS` devolve `null`, e a
 * régua fecha a porta com a frase de padrão inválido.
 *
 * Só servidor: `node:vm` não existe no navegador, e o formulário usa a régua
 * de `padrao-do-campo.ts` com o `test` direto.
 */
import { createContext, Script } from "node:vm";

import type { TestaPadrao } from "@/lib/leads/padrao-do-campo";

/** Um formato de campo confere texto curto em microssegundos; isto é folga, não meta. */
export const PRAZO_DA_CONFERENCIA_MS = 100;

const contexto = createContext({ re: /$^/, texto: "" });
const conferencia = new Script("re.test(texto)");

export const testaComPrazo: TestaPadrao = (re, texto) => {
  contexto.re = re;
  contexto.texto = texto;
  try {
    return conferencia.runInContext(contexto, { timeout: PRAZO_DA_CONFERENCIA_MS }) === true;
  } catch (err) {
    if ((err as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return null;
    throw err;
  }
};
