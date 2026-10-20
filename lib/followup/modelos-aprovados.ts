/**
 * Os modelos APROVADOS do canal que um passo de fluxo consegue mandar sozinho.
 *
 * O construtor de fluxo só oferecia os textos prontos de `message_templates` — e
 * texto livre é justamente o que o canal oficial recusa quando a janela de 24 h
 * fechou, que é quando um fluxo de reengajamento mais precisa falar. Esta é a
 * lista que falta: o que a plataforma aprovou, NESTA organização.
 *
 * Duas exclusões, pelas mesmas razões que o turno do fluxo recusa o envio
 * (`resolveModeloAprovado` em `lib/agent-engine/agent/followup-turn.ts`) — a
 * tela não oferece o que o motor depois pula:
 *   - status que não dispara (pendente, rejeitado, pausado);
 *   - variável que não é texto (imagem do cabeçalho, sufixo de link de botão):
 *     contato e negócio não têm de onde tirar.
 *
 * Variável de TEXTO entra, com a lista das variáveis: o passo escolhe de onde
 * sai cada uma (`lib/channels/meta/variaveis-do-fluxo.ts`). O plano B da
 * mensagem por IA não tem esse mapa, e por isso a tela só oferece a ele os
 * modelos SEM variável.
 */
import { slotKey } from "@/lib/channels/meta/build-components";
import { renderTemplateBody } from "@/lib/channels/meta/render-template";
import { isStatusSendable } from "@/lib/channels/meta/template-binding";
import { deriveTemplateContract } from "@/lib/channels/meta/template-contract";
import { variavelPreenchivelPeloFluxo } from "@/lib/channels/meta/variaveis-do-fluxo";

export interface LinhaDeModeloDoCanal {
  id: string;
  name: string;
  language: string;
  status: string;
  parameter_format: string | null;
  components: unknown;
}

export interface ModeloAprovadoDoFluxo {
  /** `meta_templates.id` — o que o passo grava em `template_id`/`fallback_template_id`. */
  id: string;
  name: string;
  language: string;
  /** O texto que o cliente lê, para a pessoa escolher pelo conteúdo e não pelo nome técnico. */
  texto: string;
  /** As variáveis, na ordem do modelo. Vazio = modelo sem variável. */
  variaveis: VariavelDoModelo[];
}

export interface VariavelDoModelo {
  /** A chave que o passo usa no mapa (`"1"`, `"header:1"`). */
  chave: string;
  /** Como aparece no modelo: `{{1}}`. */
  marcador: string;
  /** O texto em volta, para a pessoa saber o que vai no lugar ("Hola", "!"). */
  antes: string;
  depois: string;
  noCabecalho: boolean;
}

export function modelosQueOFluxoEnvia(linhas: LinhaDeModeloDoCanal[]): ModeloAprovadoDoFluxo[] {
  const saida: ModeloAprovadoDoFluxo[] = [];
  for (const l of linhas) {
    if (!isStatusSendable(l.status)) continue;
    const contrato = deriveTemplateContract({
      name: l.name,
      language: l.language,
      ...(l.parameter_format ? { parameter_format: l.parameter_format } : {}),
      components: l.components as never,
    });
    if (contrato.slots.some((slot) => !variavelPreenchivelPeloFluxo(slot))) continue;
    saida.push({
      id: l.id,
      name: l.name,
      language: l.language,
      texto: renderTemplateBody(l.components, {}, {
        name: l.name,
        language: l.language,
        ...(l.parameter_format ? { parameterFormat: l.parameter_format } : {}),
      }),
      variaveis: contrato.slots.map((slot) => ({
        chave: slotKey(slot.address, slot.key),
        marcador: `{{${slot.key}}}`,
        antes: slot.contextBefore,
        depois: slot.contextAfter,
        noCabecalho: slot.address.kind === "header",
      })),
    });
  }
  return saida;
}
