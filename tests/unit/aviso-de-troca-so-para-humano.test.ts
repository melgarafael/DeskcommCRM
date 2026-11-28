/**
 * #5328 — A TROCA ENTRE DOIS AGENTES DE IA NÃO AVISA O CLIENTE.
 *
 * O defeito medido em 26/11/2026: o roteador trocava o agente geral pelo agente
 * de anúncio no meio da qualificação e o cliente lia "Só um instante, vou te
 * passar para quem cuida desse assunto". Segundos depois era outro AGENTE DE IA
 * perguntando quantas pessoas — para o cliente, uma transferência para pessoa
 * que nunca aconteceu.
 *
 * O que este arquivo mede, e por que assim:
 *
 *   1. IA → IA: a ferramenta `transfer_to_agent` NÃO pede anúncio nenhum. A
 *      regra mora em `trocaPedeAvisoAoCliente` (destino por PARÂMETRO, nunca
 *      por palavra no texto) e as duas frases que o modelo lê — descrição e
 *      retorno — saem dela.
 *   2. IA → humano: o aviso continua. `trocaPedeAvisoAoCliente('humano')` é
 *      `true` e a frase de `textoDoAviso` continua falando de pessoa/equipe —
 *      a frase NÃO saiu do catálogo.
 *   3. humano → IA: não há troca de agente de IA a anunciar (o roteador não
 *      tinha agente anterior), e nada é enviado.
 */
import { describe, expect, it } from 'vitest';

import {
  descricaoDaFerramentaDePassagem,
  instrucaoDeAvisoDaPassagem,
  mensagemDoResultadoDaPassagem,
} from '@/lib/agent-engine/agent/transferir-agente';
import { textoDaPassagemAoCliente } from '@/lib/agent-engine/agent/passagem-do-roteador';
import { textoDoAviso, trocaPedeAvisoAoCliente } from '@/lib/escalacao/aviso-ao-lead';

const DESTINOS = [
  { intentName: 'automacao', intentDescription: 'assuntos de automação' },
  { intentName: 'suporte', intentDescription: 'assuntos de suporte' },
];

describe('aviso de troca de agente: só quando o destino é humano (#5328)', () => {
  it('IA → IA: a regra é falsa por PARÂMETRO e a ferramenta manda NÃO anunciar', () => {
    expect(trocaPedeAvisoAoCliente('agente_de_ia')).toBe(false);

    const descricao = descricaoDaFerramentaDePassagem(DESTINOS);
    expect(descricao).not.toMatch(/avise o cliente antes/i);
    expect(descricao).toMatch(/NÃO anuncie a troca ao cliente/);
    // O enum dos destinos continua na descrição — não é um texto solto.
    expect(descricao).toContain('- automacao: assuntos de automação');
    expect(descricao).toContain('- suporte: assuntos de suporte');

    const retorno = mensagemDoResultadoDaPassagem('suporte');
    expect(retorno).not.toMatch(/avise o cliente|avise agora/i);
    expect(retorno).toMatch(/NÃO anuncie a troca ao cliente/);
    expect(retorno).toContain('Encerre o turno.');
  });

  it('IA → humano: a instrução de aviso continua e a frase segue no catálogo', () => {
    expect(trocaPedeAvisoAoCliente('humano')).toBe(true);
    expect(instrucaoDeAvisoDaPassagem('humano')).toMatch(/avise o cliente antes/i);

    const frase = textoDoAviso('pediu_humano', { total: 2, disponiveis: 1 }, 'lead-5328');
    expect(frase).toMatch(/pessoa|equipe|atendente/i);
  });

  it('humano → IA: sem agente de IA anterior, não há passagem a anunciar', () => {
    expect(
      textoDaPassagemAoCliente({
        outcome: 'reclassified',
        textoConfigurado: 'Só um instante, vou te passar para quem cuida desse assunto.',
        // A conversa vinha de atendimento humano: o roteador não tinha agente
        // de IA sticky, então não existe troca de agente de IA para anunciar.
        agenteAnteriorId: null,
        agenteNovoId: 'agent-anuncio',
      }),
    ).toBeNull();
  });
});
