import {
  capacidadeEhConhecida,
  ehRoteador,
  modelCapabilities,
} from "@/lib/agent-engine/edge/llm/capabilities";

/**
 * A CAPACIDADE QUE VALE — a mesma que o motor usa, para a tela e para o motor.
 *
 * ═══ O defeito: duas verdades sobre a mesma pergunta ════════════════════════
 *
 * "Este modelo enxerga imagem?" tinha DUAS respostas no repositório:
 *
 *   • o MOTOR perguntava a `modelCapabilities()` — registro por provedor, com
 *     `openai` e `anthropic` marcados como nativos;
 *   • a TELA perguntava à coluna `ai_models.supports_vision`.
 *
 * Medido numa instalação real: a coluna estava `false` para TODOS os modelos
 * do catálogo — `claude-sonnet-5`, `gpt-5.6-sol`, `gpt-5.6-luna`,
 * `gpt-5.6-terra`. Então a tela avisava
 *
 *     "gpt-5.6-sol não enxerga imagens. Em 'Ver a imagem do cliente', fotos e
 *      comprovantes que o cliente enviar vão ser ignorados pelo agente."
 *
 * enquanto o motor mandava a imagem normalmente — e ela era lida. O print que o
 * cliente enviou virou descrição correta na mesma instalação em que a tela
 * dizia que seria ignorado.
 *
 * ⚠️ E o aviso falso é PIOR que aviso nenhum: ele empurra quem opera a trocar
 * um modelo que funciona, ou a desistir de um recurso que está no ar.
 *
 * ═══ Por que a fonte é o motor, e não a tabela ══════════════════════════════
 *
 * Porque é o motor que decide, em tempo de execução, se a mídia vai como parte
 * nativa. A tabela é um catálogo de preço e contexto que alguém preenche; o
 * registro é o que o código faz. Corrigir a linha do `gpt-5.6-sol` apagaria o
 * sintoma e deixaria a divergência viva para o próximo modelo cadastrado.
 *
 * ═══ A exceção do roteador, e por que ela NÃO é uma segunda verdade ════════
 *
 * ⚠️ A primeira versão desta função dizia só "o registro manda, e o catálogo é
 * o que sobra". Isso estava errado num caso, e o caso é uma instalação real: a
 * opção [1] do instalador sincroniza o catálogo da OpenRouter. Medido rodando
 * a função:
 *
 *     openrouter/openai/gpt-3.5-turbo   catálogo=false  registro=true  → true
 *     openrouter/google/gemma-2-9b-it   catálogo=false  registro=true  → true
 *     openrouter/anthropic/claude-2.1   catálogo=false  registro=true  → true
 *
 * O catálogo estava CERTO nos três, e a função descartava. Num roteador, tudo
 * que o registro tem é o PREFIXO do id: ele vê `openai/` e responde pela
 * família. Mas `openai/gpt-4o` enxerga e `openai/gpt-3.5-turbo` não — mesmo
 * prefixo, respostas opostas. Já a coluna vem de `architecture.input_modalities`
 * que a própria OpenRouter declara (`lib/ai/catalogo/openrouter.ts`).
 *
 * Então a regra não é "registro vence catálogo". É **medida vence palpite**:
 *
 *   • provedor direto  → o registro conhece a família e a coluna é um default
 *     que ninguém preencheu (medido: `false` para TODOS os modelos numa
 *     instalação real). Registro vence.
 *   • roteador         → a coluna é sincronizada do provedor e o registro só
 *     tem o prefixo. Catálogo vence, quando ele tem opinião.
 *
 * O custo de errar aqui é assimétrico e nos dois sentidos, e é por isso que o
 * caso do roteador não podia ficar para depois: aviso FALSO empurra quem opera
 * a trocar um modelo que funciona; silêncio onde o aviso era VERDADEIRO deixa
 * a pessoa achando que o comprovante do cliente está sendo lido quando não
 * está. O segundo é pior, porque não tem sintoma.
 */
export function enxergaImagem(input: {
  provider: string;
  modelId: string;
  /** O que a tabela `ai_models` diz. Manda no roteador; é reserva no resto. */
  doCatalogo?: boolean | null;
}): boolean {
  // Num roteador o catálogo é medida (sincronizada do provedor) e o registro é
  // palpite (o prefixo do fabricante). Só quando o catálogo não tem opinião é
  // que o palpite é melhor que nada.
  if (ehRoteador(input.provider) && typeof input.doCatalogo === "boolean") {
    return input.doCatalogo;
  }
  if (capacidadeEhConhecida(input.provider, input.modelId)) {
    return modelCapabilities(input.provider, input.modelId).image;
  }
  return input.doCatalogo ?? false;
}

/**
 * A MESMA regra, para quem tem banco à mão — o motor.
 *
 * ⚠️ Esta função existe porque a divergência que este arquivo conserta tinha
 * DUAS metades, e consertar só a da tela deixaria viva justamente a que causa
 * dano: o motor lê `modelCapabilities` direto e, num roteador, ANEXA a imagem
 * nativa a um modelo que não a aceita. A tela mentindo desinforma quem opera; o
 * motor mentindo manda bytes que o provedor recusa.
 *
 * O roundtrip só acontece quando ele muda a resposta: no provedor direto o
 * registro decide sozinho e o catálogo é um default que ninguém preencheu, então
 * consultá-lo seria pagar uma ida ao banco por turno para confirmar o já sabido.
 *
 * Falha de leitura NÃO derruba o turno: sem catálogo, vale o registro — que é o
 * comportamento de antes desta função existir, nunca um desfecho novo.
 */
export async function visaoEmVigor(args: {
  provider: string;
  modelId: string;
  /** Só é chamado quando o provedor é roteador. */
  catalogo: () => Promise<boolean | null>;
}): Promise<{ enxerga: boolean; sabemos: boolean }> {
  if (!ehRoteador(args.provider)) {
    return {
      enxerga: enxergaImagem({ provider: args.provider, modelId: args.modelId }),
      sabemos: capacidadeEhConhecida(args.provider, args.modelId),
    };
  }
  let doCatalogo: boolean | null = null;
  try {
    doCatalogo = await args.catalogo();
  } catch {
    doCatalogo = null;
  }
  return {
    enxerga: enxergaImagem({ provider: args.provider, modelId: args.modelId, doCatalogo }),
    // Num roteador, o catálogo é a fonte que SABE — se ele tem linha para este
    // modelo, a resposta é conhecimento e não palpite. Sem linha, sobra o
    // prefixo, e aí vale o mesmo critério do provedor direto.
    sabemos:
      typeof doCatalogo === "boolean" || capacidadeEhConhecida(args.provider, args.modelId),
  };
}
