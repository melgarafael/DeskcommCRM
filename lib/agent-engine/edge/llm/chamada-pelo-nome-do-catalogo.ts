/**
 * A CHAMADA PELO NOME DO CATÁLOGO VAI PARA A NATIVA QUE O COBRE.
 *
 * No atendimento, a ferramenta do catálogo coberta por uma nativa sai do turno
 * (`COBERTA_PELA_NATIVA`: `crm_search_knowledge` → `search_knowledge`,
 * `crm_schedule_followup` → `schedule_followup`). Prompt e skill escritos antes disso
 * mandam chamar o nome do catálogo — e versão publicada é imutável, então o conserto
 * não pode ser reescrever o texto. Sem isto, o modelo chama um nome que não está no
 * turno, recebe erro e gasta um passo para chamar o certo.
 *
 * Só o `NoSuchToolError` de um nome coberto, e só quando a nativa ESTÁ no turno; a
 * entrada leva apenas os campos que a nativa declara (ela valida a própria whitelist
 * por dentro, e campo do catálogo viraria erro de ensino). Qualquer outro caso devolve
 * `null`: o SDK segue com o erro original, como sempre.
 */
import { NoSuchToolError, type ToolCallRepairFunction, type ToolSet } from 'ai';

import { COBERTA_PELA_NATIVA } from '@/lib/mcp/tools/ferramentas-do-harness';

export const chamadaPeloNomeDoCatalogo: ToolCallRepairFunction<ToolSet> = async ({ toolCall, tools, inputSchema, error }) => {
  if (!NoSuchToolError.isInstance(error)) return null;
  const nativa = COBERTA_PELA_NATIVA[toolCall.toolName]?.nativa;
  // Hoje o SDK também recusa o conserto para nome ausente; a guarda não depende disso, e o
  // teste "sem a nativa no turno" vigia o resultado (o erro fala do nome que o modelo chamou).
  if (nativa === undefined || !(nativa in tools)) return null;
  let entrada: unknown;
  try {
    entrada = JSON.parse(toolCall.input);
  } catch {
    return null; // entrada ilegível: o erro original segue para o modelo
  }
  if (entrada === null || typeof entrada !== 'object' || Array.isArray(entrada)) return null;
  const { properties } = (await inputSchema({ toolName: nativa })) as { properties?: Record<string, unknown> };
  const campos = properties ?? {};
  const doNativo = Object.fromEntries(Object.entries(entrada).filter(([campo]) => Object.hasOwn(campos, campo)));
  return { ...toolCall, toolName: nativa, input: JSON.stringify(doNativo) };
};
