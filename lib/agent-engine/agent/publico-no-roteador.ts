/**
 * O PÚBLICO DO AGENTE NO ROTEADOR (#3722, fatia 2).
 *
 * A fatia 1 levou a régua à escolha do agente do NÚMERO
 * (`escolherAgenteDoNumero`): o agente que declara `exclude_tags: [cliente
 * ativo]` não atende quem tem a etiqueta, e o turno registra a fila no rastro.
 * Faltava o ROTEADOR: o membro barrado continuava sendo OFERECIDO ao
 * classificador (Jev e IA de sempre), e o agente "grudado" da conversa
 * continuava com a vez mesmo depois de deixar de ser elegível.
 *
 * ## O que este arquivo faz
 *
 * Filtra `router.members` pela MESMA régua (`avaliarPublico` de
 * `publico-do-gatilho.ts` — nenhuma cópia do predicado) ANTES de montar a
 * pergunta do classificador. Quem ficou de fora não é oferecido a ninguém: nem
 * ao Jev, nem à IA de sempre. Como o agente grudado é procurado na lista
 * filtrada (`resolve-turn-agent.ts`), ele perde a vez pelo mesmo mecanismo.
 *
 * ## Custo — quem não configura não paga
 *
 * Nenhum membro declara público ⇒ o roteador volta intocado, `lerFatos` NÃO é
 * chamado e o turno é o de hoje, byte a byte. A leitura dos fatos é uma
 * promessa memoizada do turno (`resolve-turn-agent.ts`), então mesmo quando o
 * fallback também tem público ela acontece UMA vez.
 *
 * O público dos membros vem da MESMA consulta que já carrega os membros (join
 * com a versão publicada, em `router-config.ts`); o do fallback vem da config
 * que o turno já carrega (`PublishedAgentConfig.publico`).
 *
 * ## Falha
 *
 * Configuração malformada falha ABERTA: `lerPublicoDoGatilho` devolve `null` e
 * o agente atende todo mundo (é do módulo). Erro ao LER os fatos do contato
 * falha FECHADA: sobe como `ErroDeLeituraDoPublico` e o turno NÃO escolhe
 * agente no escuro — a fila re-tenta o job.
 */
import type {
  CandidatoNoRastroDoPublico,
  RastroDoPublico,
} from './agent-config';
import {
  avaliarPublico,
  type DecisaoDoPublico,
  type FatosDoContato,
  type PublicoDoAgente,
} from './publico-do-gatilho';
import type { LoadedRouter } from './router-config';

/**
 * A leitura dos fatos do contato falhou. O turno propaga este erro em vez de
 * decidir sem os dados: `resolve-turn-agent.ts` re-lança (o `catch` geral não
 * pode engolir) e o job volta para a fila.
 */
export class ErroDeLeituraDoPublico extends Error {
  constructor(causa: unknown) {
    super('não foi possível ler os fatos do contato para o público do agente (#3722)');
    this.name = 'ErroDeLeituraDoPublico';
    this.cause = causa;
  }
}

/** O resultado de passar a régua do público sobre os membros do roteador. */
export interface FiltroDoPublicoNoRoteador {
  /** O roteador com só os membros elegíveis. Sem público, é o MESMO objeto. */
  router: LoadedRouter;
  /** `false` = ninguém declarou público: nada foi lido e nada mudou. */
  avaliado: boolean;
  /** Quantos membros o público barrou. */
  barrados: number;
  /** Quantos membros seguem elegíveis. */
  elegiveis: number;
  /**
   * O rastro no MESMO formato do número (`RastroDoPublico`), com
   * `origem: 'roteador'`. `null` quando ninguém declarou público — quem não
   * usa o recurso não ganha linha de log por turno.
   */
  rastro: RastroDoPublico | null;
}

function candidato(
  agentId: string,
  agentName: string | undefined,
  posicao: number,
  publico: PublicoDoAgente | null,
  decisao: DecisaoDoPublico | null,
): CandidatoNoRastroDoPublico {
  return {
    agentId,
    agentName: agentName ?? agentId,
    posicao,
    pausado: false,
    semPublico: publico === null,
    decisao,
  };
}

/**
 * Filtra os membros do roteador pelo público deste contato.
 *
 * `lerFatos` é chamado no MÁXIMO uma vez, e só quando algum membro declarou
 * público. Ele deve lançar `ErroDeLeituraDoPublico` (é o que o turno monta);
 * qualquer erro dele sobe — decidir no escuro calaria o cliente errado.
 */
export async function filtrarMembrosPeloPublico(
  router: LoadedRouter,
  lerFatos: () => Promise<FatosDoContato>,
): Promise<FiltroDoPublicoNoRoteador> {
  const algumDeclarou = router.members.some((m) => m.publico != null);
  if (!algumDeclarou) {
    // Nenhuma leitura, nenhum log, nenhuma mudança: o turno de hoje.
    return { router, avaliado: false, barrados: 0, elegiveis: router.members.length, rastro: null };
  }

  let fatos: FatosDoContato;
  try {
    fatos = await lerFatos();
  } catch (causa) {
    // Erro de LEITURA falha FECHADO: sobe tipado para o turno re-lançar e a
    // fila re-tentar. Um `lerFatos` que já veio tipado não é reembrulhado.
    throw causa instanceof ErroDeLeituraDoPublico ? causa : new ErroDeLeituraDoPublico(causa);
  }
  const decisoes: Array<DecisaoDoPublico | null> = router.members.map((m) =>
    m.publico == null ? null : avaliarPublico(m.publico, fatos),
  );
  const membros = router.members.filter((_, i) => decisoes[i]?.passa !== false);
  const barrados = decisoes.filter((d) => d?.passa === false).length;

  return {
    router: { ...router, members: membros },
    avaliado: true,
    barrados,
    elegiveis: membros.length,
    rastro: {
      contatoAvaliado: true,
      // A escolha de QUEM atende é do classificador e acontece depois; o
      // `resolve-turn-agent.ts` preenche o vencedor quando o resultado sai.
      escolhidoAgentId: null,
      origem: 'roteador',
      barrados,
      candidatos: router.members.map((m, i) =>
        candidato(m.agentId, m.agentName, i, m.publico ?? null, decisoes[i] ?? null),
      ),
    },
  };
}

/**
 * A régua sobre UM agente fora da lista de membros — hoje, o fallback do
 * roteador. Devolve o candidato para o rastro (com a decisão), ou `null`
 * quando o agente não declarou público: nesse caso ele atende todo mundo e não
 * há o que rastrear.
 */
export async function avaliarAgentePeloPublico(
  agentId: string,
  agentName: string | undefined,
  publico: PublicoDoAgente | null | undefined,
  lerFatos: () => Promise<FatosDoContato>,
  posicao: number,
): Promise<CandidatoNoRastroDoPublico | null> {
  if (publico == null) return null;
  const fatos = await lerFatos();
  return candidato(agentId, agentName, posicao, publico, avaliarPublico(publico, fatos));
}
