/**
 * A ORDEM DO `system` É DINHEIRO, NÃO ESTILO (#4668).
 *
 * O cache de prefixo dos provedores só reaproveita o começo IGUAL do pedido.
 * Enquanto o `system` abria pelo prompt do agente, cada agente diferente — e
 * cada edição do prompt de um deles — invalidava também os blocos da plataforma,
 * que são iguais para todos. Este arquivo mede a única coisa que dá para medir
 * sem provedor: o PREFIXO COMUM entre dois agentes diferentes, byte a byte.
 *
 * O que fica provado aqui:
 *   1. dois agentes com playbooks diferentes produzem o mesmo prefixo da
 *      plataforma, byte a byte, e o prefixo comum não cresce nem encolhe com o
 *      tamanho do playbook;
 *   2. o bloco por-turno (prévia, voz) vem depois de TODOS os fixos e do prompt
 *      do agente — nada volátil entra antes do breakpoint;
 *   2b. a diretiva de idioma é o ÚLTIMO bloco, em toda combinação: o texto dela
 *      fala das "regras acima", e ela corrige a língua por ser a última;
 *   3. o controle negativo: na ordem antiga (prompt na frente) o prefixo comum
 *      cai a zero. Sem ele, um teste que só olhasse "os dois começam igual"
 *      passaria com qualquer ordem em que os dois textos coincidissem por acaso.
 *
 * O que NÃO se prova aqui, e é medição de produção: `prefixo_hash` de
 * `llm_calls` (migration 9105) nunca vai coincidir entre dois agentes com
 * playbooks diferentes — ele é o sha256 do prefixo INTEIRO (ferramentas +
 * system). O que se mede em produção é `cache_read_tokens` por turno, antes e
 * depois, numa instalação com mais de um agente.
 */
import { jsonSchema, tool } from 'ai';
import { describe, expect, it } from 'vitest';

import { serializeStablePrefix } from '@/lib/agent-engine/edge/llm/stable-prefix';
import {
  AUTORIA_SYSTEM_BLOCK,
  BLOCOS_FIXOS_DA_PLATAFORMA,
  CASES_SYSTEM_BLOCK,
  TRANSPARENCIA_SYSTEM_BLOCK,
  blocoDoModoDePrevia,
  blocosDeAgendaResidentes,
  blocosDeInteresseExternoResidentes,
  blocosDoSistemaDoTurno,
  comEvidenciaDoCadastroDaAgenda,
  temFerramentaDeAgenda,
  type BlocosDoSistemaDoTurno,
} from './inbound-turn';
import { criarEvidenciasComerciaisDoTurno } from '../guardrails/promise/evidencias-comerciais';
import { diretivaDeIdioma } from './idioma-do-turno';
import { composeSystemPrompt } from './org-memory';
import { BLOCO_DA_RESPOSTA_FALADA } from './voz-do-turno';

/** Ferramentas de agenda: as que ligam os dois blocos residentes condicionais. */
const FERRAMENTAS = ['crm_find_free_slots', 'crm_list_event_types', 'crm_book_appointment'];

/** O pedaço do `system` que é igual para todo agente desta instalação. */
function prefixoDaPlataforma(): string {
  return [
    TRANSPARENCIA_SYSTEM_BLOCK,
    AUTORIA_SYSTEM_BLOCK,
    CASES_SYSTEM_BLOCK,
    ...blocosDeAgendaResidentes(FERRAMENTAS),
  ].join('\n\n');
}

function blocosDoAgente(playbook: string, extra: Partial<BlocosDoSistemaDoTurno> = {}): string[] {
  return blocosDoSistemaDoTurno({
    promptDoAgente: composeSystemPrompt({
      playbookPrompt: playbook,
      orgMemoryBlock: '',
      skillIndex: '',
    }),
    casosLigados: true,
    toolIds: FERRAMENTAS,
    previewKind: null,
    idioma: 'pt-BR',
    blocoDaVoz: null,
    ...extra,
  });
}

function systemDoAgente(playbook: string, extra: Partial<BlocosDoSistemaDoTurno> = {}): string {
  return blocosDoAgente(playbook, extra).join('\n\n');
}

/** O maior começo idêntico entre dois textos — a régua do cache de prefixo. */
function prefixoComum(a: string, b: string): string {
  const limite = Math.min(a.length, b.length);
  let fim = 0;
  while (fim < limite && a[fim] === b[fim]) fim++;
  return a.slice(0, fim);
}

const CARLOS =
  '## Tom de voz\nFale como um vendedor animado, sem exagero.\n' +
  '## O que você faz\nApresente o catálogo e feche a venda com data de entrega.\n' +
  '## Limites\nNunca dê desconto acima de dez por cento sem aprovação.';
const CLARA =
  '## Quem você é\nVocê é a Clara, da Loja Exemplo. Atenda em português, com frases curtas.\n' +
  '## O que você faz\nTire dúvidas de preço, prazo e troca.';
const BRUNO =
  '## Identidade\nVocê é o Bruno, do Suporte Técnico. Fale como um técnico paciente.\n' +
  '## O que você faz\nAbra chamado, peça o número de série e devolva o diagnóstico.\n' +
  '## Regras\nNunca prometa prazo de conserto sem chamado aberto.';

describe('o prefixo do `system` entre dois agentes (#4668)', () => {
  it('dois agentes com playbooks diferentes começam pelos MESMOS bytes da plataforma', () => {
    const clara = systemDoAgente(CLARA);
    const bruno = systemDoAgente(BRUNO);

    // Controle: os dois `system` são diferentes (o teste não está medindo texto igual).
    expect(clara).not.toBe(bruno);

    const comum = prefixoComum(clara, bruno);
    // O bloco da plataforma inteiro está no comum, byte a byte.
    expect(comum.slice(0, prefixoDaPlataforma().length)).toBe(prefixoDaPlataforma());
    expect(clara.startsWith(prefixoDaPlataforma())).toBe(true);
    expect(bruno.startsWith(prefixoDaPlataforma())).toBe(true);
    // Depois dele só sobra o separador do `join` e o `## ` que todo playbook
    // tem no começo do título — nenhum byte do TEXTO do agente.
    expect(comum.length - prefixoDaPlataforma().length).toBeLessThanOrEqual(5);
  });

  it('o prefixo comum não depende do tamanho nem do conteúdo do playbook', () => {
    const clara = systemDoAgente(CLARA);
    const bruno = systemDoAgente(BRUNO);
    const carlosLongo = systemDoAgente(CARLOS.repeat(8));

    // Textos de tamanhos e assuntos diferentes: o comum tem o fixo inteiro e
    // não cresce com o playbook.
    const comum = (a: string, b: string): string => prefixoComum(a, b).slice(0, prefixoDaPlataforma().length);
    expect(comum(clara, bruno)).toBe(prefixoDaPlataforma());
    expect(comum(bruno, carlosLongo)).toBe(prefixoDaPlataforma());
    expect(comum(clara, carlosLongo)).toBe(prefixoDaPlataforma());
    expect(prefixoComum(clara, bruno).length - prefixoDaPlataforma().length).toBeLessThanOrEqual(5);

    // Agente sem prompt (array com string vazia): o fixo continua inteiro na
    // frente — o que sobra depois dele é o separador do `join`.
    const vazio = systemDoAgente('');
    expect(prefixoComum(vazio, clara).startsWith(prefixoDaPlataforma())).toBe(true);
    expect(prefixoComum(vazio, clara).length - prefixoDaPlataforma().length).toBeLessThanOrEqual(2);
  });

  it('o prefixo comum é o mesmo com as mesmas ferramentas, e a faixa fixa é a mesma nos dois', () => {
    const clara = blocosDoAgente(CLARA);
    const bruno = blocosDoAgente(BRUNO);
    // Os blocos da plataforma ocupam as MESMAS posições nos dois agentes.
    expect(clara.slice(0, BLOCOS_FIXOS_DA_PLATAFORMA.length)).toEqual([...BLOCOS_FIXOS_DA_PLATAFORMA]);
    expect(bruno.slice(0, BLOCOS_FIXOS_DA_PLATAFORMA.length)).toEqual([...BLOCOS_FIXOS_DA_PLATAFORMA]);
  });

  it('controle negativo: na ordem ANTIGA (prompt na frente) só sobra o "## " do título', () => {
    const antigo = (playbook: string): string => [playbook, prefixoDaPlataforma()].join('\n\n');
    // Sem a reordenação o comum para no primeiro caractere em que os dois
    // playbooks divergem — aqui, no título da seção. É a medida que discrimina:
    // com o fixo na frente o comum é o bloco inteiro; com o prompt na frente,
    // são 3 bytes.
    expect(prefixoComum(antigo(CLARA), antigo(BRUNO))).toBe('## ');
  });
});

describe('o que muda por turno fica no FIM (#4668)', () => {
  it('prévia e voz vêm depois de todos os fixos e do prompt do agente', () => {
    const blocos = blocosDoAgente(CLARA, {
      previewKind: 'assisted',
      blocoDaVoz: BLOCO_DA_RESPOSTA_FALADA,
    });
    const prompt = composeSystemPrompt({ playbookPrompt: CLARA, orgMemoryBlock: '', skillIndex: '' });

    const posicaoPrompt = blocos.indexOf(prompt);
    const posicaoPrevia = blocos.indexOf(blocoDoModoDePrevia('assisted'));
    const posicaoVoz = blocos.indexOf(BLOCO_DA_RESPOSTA_FALADA);

    expect(posicaoPrompt).toBeGreaterThan(-1);
    // Por-turno depois do prompt do agente (que é a última faixa por-agente).
    expect(posicaoPrevia).toBeGreaterThan(posicaoPrompt);
    expect(posicaoVoz).toBeGreaterThan(posicaoPrompt);
    // E são os últimos blocos, nesta ordem — só a diretiva de idioma vem depois.
    expect(blocos.slice(-3)).toEqual([
      blocoDoModoDePrevia('assisted'),
      BLOCO_DA_RESPOSTA_FALADA,
      diretivaDeIdioma('pt-BR'),
    ]);
  });

  it('a diretiva de idioma é o ÚLTIMO bloco em toda combinação de prévia, voz, casos e ferramentas', () => {
    // O texto dela diz "mesmo que as regras ACIMA estejam em português": só é
    // verdade se todo o resto estiver acima. Antes de qualquer outro bloco, ela
    // mentiria.
    for (const idioma of ['pt-BR', 'es'] as const)
      for (const previewKind of [null, 'sandbox', 'assisted'] as const)
        for (const blocoDaVoz of [null, BLOCO_DA_RESPOSTA_FALADA])
          for (const casosLigados of [false, true])
            for (const toolIds of [[], FERRAMENTAS, ['crm_consultar_receita']]) {
              const blocos = blocosDoSistemaDoTurno({
                promptDoAgente: 'P',
                casosLigados,
                toolIds,
                previewKind,
                idioma,
                blocoDaVoz,
              });
              expect(blocos.at(-1)).toBe(diretivaDeIdioma(idioma));
              expect(blocos.filter((b) => b === diretivaDeIdioma(idioma))).toHaveLength(1);
            }
  });

  it('a ordem completa: plataforma → agente → turno → diretiva de idioma', () => {
    const prompt = composeSystemPrompt({ playbookPrompt: CLARA, orgMemoryBlock: '', skillIndex: '' });
    const blocos = blocosDoSistemaDoTurno({
      promptDoAgente: prompt,
      casosLigados: true,
      toolIds: FERRAMENTAS,
      previewKind: 'sandbox',
      idioma: 'es',
      blocoDaVoz: BLOCO_DA_RESPOSTA_FALADA,
    });

    expect(blocos).toEqual([
      TRANSPARENCIA_SYSTEM_BLOCK,
      AUTORIA_SYSTEM_BLOCK,
      CASES_SYSTEM_BLOCK,
      ...blocosDeAgendaResidentes(FERRAMENTAS),
      prompt,
      blocoDoModoDePrevia('sandbox'),
      BLOCO_DA_RESPOSTA_FALADA,
      diretivaDeIdioma('es'),
    ]);
  });

  it('o interesse no banco externo (#3328) entra na faixa por-agente, antes do prompt', () => {
    const toolIds = ['crm_consultar_receita', 'crm_create_lead'];
    const blocos = blocosDoSistemaDoTurno({
      promptDoAgente: 'P',
      casosLigados: false,
      toolIds,
      previewKind: 'sandbox',
      idioma: 'pt-BR',
      blocoDaVoz: null,
    });
    expect(blocosDeInteresseExternoResidentes(toolIds)).toHaveLength(1);
    expect(blocos).toEqual([
      TRANSPARENCIA_SYSTEM_BLOCK,
      AUTORIA_SYSTEM_BLOCK,
      ...blocosDeInteresseExternoResidentes(toolIds),
      'P',
      blocoDoModoDePrevia('sandbox'),
      diretivaDeIdioma('pt-BR'),
    ]);
  });

  it('agente sem features não recebe bloco condicional nenhum, e o prompt dele continua depois dos fixos', () => {
    const blocos = blocosDoSistemaDoTurno({
      promptDoAgente: 'P',
      casosLigados: false,
      toolIds: [],
      previewKind: null,
      idioma: 'pt-BR',
      blocoDaVoz: null,
    });
    expect(blocos).toEqual([TRANSPARENCIA_SYSTEM_BLOCK, AUTORIA_SYSTEM_BLOCK, 'P', diretivaDeIdioma('pt-BR')]);
  });
});

describe('no pedido que o provedor recebe (serialização canônica)', () => {
  /** As mesmas ferramentas para os dois agentes: o cache casa por prefixo de bytes. */
  const ferramentas = {
    salvar_nota: tool({
      description: 'Salva uma nota sobre o lead.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { texto: { type: 'string' } },
        required: ['texto'],
        additionalProperties: false,
      }),
    }),
  };

  it('o prefixo comum cobre ferramentas + rótulo do sistema + blocos da plataforma', async () => {
    const clara = await serializeStablePrefix({ system: systemDoAgente(CLARA), tools: ferramentas });
    const bruno = await serializeStablePrefix({ system: systemDoAgente(BRUNO), tools: ferramentas });
    const soPlataforma = await serializeStablePrefix({
      system: prefixoDaPlataforma(),
      tools: ferramentas,
    });

    const comum = prefixoComum(clara, bruno);
    expect(comum.startsWith(soPlataforma)).toBe(true);
    // A continuação depois do bloco fixo é o separador do `join` + o `## ` do
    // título — nenhum byte de TEXTO do agente entra antes do fim do prefixo.
    expect(comum.length - soPlataforma.length).toBeLessThanOrEqual(5);
    expect(comum).toContain('=== system ===');
  });
});

/**
 * #4927 — a duração do tipo de atendimento ("a consulta dura 1h30") vem de
 * `crm_list_event_types`, que fica fora de `AGENDA_TOOL_NAMES`. Sem o ramo
 * próprio no loop das tools MCP, o retorno nunca chegava à conferência de
 * promessa e a frase seguia vetada em produção.
 */
describe('o cadastro da agenda vira evidência do turno (#4927)', () => {
  const TIPOS = { tipos: [{ nome: 'Consulta', slug: 'consulta', duracao_minutos: 90 }] };

  it('o retorno de crm_list_event_types chega à evidência com a duração falada', async () => {
    const evidencias = criarEvidenciasComerciaisDoTurno([]);
    const descartes: number[][] = [];
    const embrulhada = comEvidenciaDoCadastroDaAgenda(
      'crm_list_event_types',
      { execute: async () => TIPOS },
      evidencias,
      (t) => descartes.push(t),
    );
    expect(embrulhada).not.toBeNull();
    // O modelo recebe o retorno intacto.
    expect(await (embrulhada!.execute as () => Promise<unknown>)()).toBe(TIPOS);
    const conteudos = evidencias.ler('a consulta dura 1h30').map((e) => e.conteudo);
    expect(conteudos.some((c) => c.includes('90 minutos (1h30)'))).toBe(true);
    expect(descartes).toEqual([]);
  });

  it('não é ramo das tools que checam a agenda, e listar os tipos não arma o agendaStallGate', () => {
    const evidencias = criarEvidenciasComerciaisDoTurno([]);
    const tool = { execute: async () => ({}) };
    expect(comEvidenciaDoCadastroDaAgenda('crm_find_free_slots', tool, evidencias, () => {})).toBeNull();
    expect(comEvidenciaDoCadastroDaAgenda('crm_list_event_types', {}, evidencias, () => {})).toBeNull();
    expect(temFerramentaDeAgenda(['crm_list_event_types'])).toBe(false);
  });
});
