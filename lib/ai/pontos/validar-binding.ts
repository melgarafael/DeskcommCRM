/**
 * O QUE IMPEDE O OPERADOR DE CONFIGURAR UM PONTO PARA FALHAR.
 *
 * Enquanto a OpenRouter não alcançava o agente, o risco de escolher um modelo
 * fraco era pequeno: os dois caminhos que ela roteava eram classificações, onde
 * um modelo ruim erra um rótulo e a vida segue. Com a migration 0127 isso mudou
 * — uma chave da OpenRouter passa a poder atender o ponto que CRIA O LEAD.
 *
 * E aí o risco muda de natureza. Um modelo sem tool calling, escolhido para
 * `agent_turn` ou `operator_turn`, produz o pior desfecho possível deste
 * produto: o agente conversa normalmente, o cliente é bem atendido, e **nada
 * chega ao funil**. Não há erro na tela, não há mensagem no log do operador —
 * só um funil que para de encher, e uma pessoa concluindo que o produto não
 * funciona sem nunca saber por quê.
 *
 * Este módulo é a catraca que torna essa configuração impossível de salvar. Ela
 * roda na ESCRITA (a API recusa), e não na leitura, por um motivo declarado: na
 * hora de salvar existe alguém olhando a tela para ler o motivo e corrigir; na
 * hora da chamada há um cliente esperando resposta, e recusar ali trocaria uma
 * configuração ruim por um atendimento perdido.
 *
 * A fonte da verdade sobre o que cada ponto exige é `registro.ts`; sobre o que
 * cada modelo sabe fazer, é `ai_models` — alimentado pelo catálogo do próprio
 * fabricante, não por heurística sobre o nome do modelo.
 */
import { PONTO_POR_ID } from "./registro";

/** O que o catálogo sabe sobre o modelo escolhido. */
export interface CapacidadeDoModelo {
  model_id: string;
  supports_tools: boolean;
  supports_vision: boolean;
  /** `null` quando o modelo não está no catálogo — ver `motivoDesconhecido`. */
  conhecido: boolean;
}

export type ResultadoDaValidacao =
  | { ok: true; avisos: string[] }
  | { ok: false; codigo: string; mensagem: string };

/**
 * Valida a escolha de um ponto contra o que o modelo sabe fazer.
 *
 * Recusa apenas o que é comprovadamente incompatível. Modelo fora do catálogo
 * NÃO é recusado: o operador pode estar apontando para um endpoint próprio ou
 * para um modelo local, que por definição não está no catálogo de ninguém —
 * recusar ali fecharia justamente o caminho que `base_url` existe para abrir.
 * Ele passa com aviso, e o aviso diz que a verificação não foi possível.
 */
export function validarBinding(entrada: {
  pontoId: string;
  /** Precisa vir junto do model_id: um ponto fixo-com-opções só aceita o PAR. */
  provider: string;
  modelo: CapacidadeDoModelo;
}): ResultadoDaValidacao {
  const ponto = PONTO_POR_ID.get(entrada.pontoId);
  if (ponto === undefined) {
    return {
      ok: false,
      codigo: "ponto_desconhecido",
      mensagem: `"${entrada.pontoId}" não é um ponto configurável do sistema.`,
    };
  }

  if (ponto.fixo !== undefined) {
    // Ponto fixo COM menu: não é a catraca de ferramentas/visão abaixo (que
    // pressupõe modelo de CONVERSA) — é "este par está no menu, ou não está".
    if (ponto.fixo.opcoes !== undefined) {
      const noMenu = ponto.fixo.opcoes.some(
        (o) => o.provider === entrada.provider && o.modelId === entrada.modelo.model_id,
      );
      if (!noMenu) {
        return {
          ok: false,
          codigo: "opcao_fora_do_menu",
          mensagem:
            `${ponto.rotulo} só aceita um dos serviços oferecidos para este ponto: ` +
            `${ponto.fixo.opcoes.map((o) => o.rotulo).join(", ")}.`,
        };
      }
      return { ok: true, avisos: [] };
    }
    return {
      ok: false,
      codigo: "ponto_fixo",
      mensagem: `${ponto.rotulo} não aceita troca de modelo. ${ponto.fixo.razao}`,
    };
  }

  if (!entrada.modelo.conhecido) {
    return {
      ok: true,
      avisos: [
        `Não conseguimos verificar o que "${entrada.modelo.model_id}" sabe fazer — ele não está no catálogo. ` +
          `Se for um modelo seu ou de um endpoint próprio, isso é esperado. Vale testar a conexão antes de confiar nele.`,
      ],
    };
  }

  if (ponto.exige.tools === true && !entrada.modelo.supports_tools) {
    return {
      ok: false,
      codigo: "modelo_sem_ferramentas",
      // A mensagem descreve a CONSEQUÊNCIA, não a limitação técnica. "Não
      // suporta function calling" não diz nada a quem não é engenheiro — e é
      // exatamente essa pessoa que está na tela escolhendo.
      mensagem:
        `"${entrada.modelo.model_id}" não sabe usar as ferramentas do CRM. Em "${ponto.rotulo}" isso significa que ` +
        `o agente conversaria normalmente com o cliente, mas não criaria o lead nem moveria o funil — e sem nenhum ` +
        `erro aparecer na tela. Escolha um modelo com suporte a ferramentas.`,
    };
  }

  const avisos: string[] = [];
  if (ponto.exige.imagem === true && !entrada.modelo.supports_vision) {
    // AVISO, não recusa: `agent_turn` exige imagem para ler o print que o
    // cliente manda, mas um agente que só lê texto ainda atende — mal, e o
    // operador precisa saber disso, não ser impedido.
    avisos.push(
      `"${entrada.modelo.model_id}" não enxerga imagens. Em "${ponto.rotulo}", fotos e comprovantes que o cliente ` +
        `enviar vão ser ignorados pelo agente.`,
    );
  }

  return { ok: true, avisos };
}
