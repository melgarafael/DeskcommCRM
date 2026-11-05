/**
 * O que o motor mandaria ao modelo para cada conversa do corpus, montado pelas
 * MESMAS funções de produção: a abertura (`buildOpeningMessage`, nos dois
 * formatos do histórico), o bloco `## Agora` e o peso de cada ferramenta como vai
 * ao fio (`esquemaParaOProvedor`, nos dois braços do knob C). É daqui que saem
 * as contas do plano e o corpus do G. Carrega o motor — e por isso `lib/env.ts`.
 */
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { z } from "zod";

import { buildOpeningMessage, type FormatoDoHistorico } from "@/lib/agent-engine/agent/abertura/ritual";
import { corpusSchema } from "@/lib/agent-engine/agent/abertura/comparar-fechamentos";
import { AGENT_TOOL_DEFS } from "@/lib/agent-engine/agent/inbound-turn";
import { esquemaParaOProvedor } from "@/lib/agent-engine/edge/llm/stable-prefix";
import { getToolByName } from "@/lib/mcp/tools";
import { renderAgora } from "@/lib/tempo/agora";

import { AGORA, checkpointAnterior, contextoDaConversa, FUSO, NATIVAS_DO_TURNO, PERSONAS, type Conversa, type PersonaId } from "./corpus-de-avaliacao";

/** A abertura do turno + o `## Agora`, como o turno inbound os entrega. */
export function abertura(c: Conversa, formato: FormatoDoHistorico): string {
  // `projeta` falso: todo agente de avaliação tem ferramenta de catálogo (`turnoProjeta`).
  const texto = buildOpeningMessage(checkpointAnterior(c), null, contextoDaConversa(c).context, "", false, [], "", undefined, undefined, "", formato);
  return `${texto}\n\n${renderAgora(new Date(AGORA), FUSO)}`;
}

/** Tokens o200k das ferramentas de um agente de avaliação (nativas do turno + catálogo dele). */
export async function pesoDasFerramentas(persona: PersonaId, semPadrao: boolean): Promise<number> {
  let total = 0;
  for (const nome of NATIVAS_DO_TURNO) {
    const d = AGENT_TOOL_DEFS[nome];
    total += countTokens(JSON.stringify({ name: nome, description: d.description, parameters: await esquemaParaOProvedor(d.inputSchema, { semPadrao }) }));
  }
  for (const nome of PERSONAS[persona].ferramentas) {
    const t = getToolByName(nome);
    if (t === undefined) throw new Error(`a capacidade ${nome} do agente ${persona} não existe no catálogo`);
    // ponytail: `z.object` direto, e não `shapeToZodObject` (que só difere no shape vazio — nenhuma ferramenta compilada tem).
    total += countTokens(JSON.stringify({ name: nome, description: t.description, parameters: await esquemaParaOProvedor(z.object(t.inputSchema), { semPadrao }) }));
  }
  return total;
}

/**
 * O corpus do G no formato de `scripts/avaliar-fechamento.ts`: o `system` do
 * agente, a abertura do turno e a fita do turno — as ações que voltaram ok e
 * cada envio, como o fechamento os leria (em texto: o corpus é de strings).
 */
export function pedidosDoFechamento(conversas: readonly Conversa[]) {
  return corpusSchema.parse(
    conversas.map((c) => {
      const fita = [...(c.acoes ?? []), ...c.resposta.map((body) => `send_message ${JSON.stringify({ body })} → enviada`)].join("\n");
      const anterior = checkpointAnterior(c);
      return {
        id: c.id,
        system: PERSONAS[c.persona].prompt,
        mensagens: [
          { role: "user", content: abertura(c, "json") },
          { role: "assistant", content: fita },
        ],
        anterior:
          anterior === null
            ? null
            : { commitments: anterior.commitments, objections: anterior.objections, next_action: anterior.next_action, rolling_summary: anterior.rolling_summary },
      };
    }),
  );
}
