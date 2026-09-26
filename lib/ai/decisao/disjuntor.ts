/**
 * O DISJUNTOR DO JEV — para de bater num fornecedor que não está respondendo.
 *
 * O dreno de eventos roda os handlers em série. Com o Jev fora do ar, cada
 * mensagem pagaria o teto inteiro (1,5 s) antes de a reserva assumir, e uma
 * chave revogada seria reenviada a cada mensagem do dia. O disjuntor corta
 * isso: depois de falhar, o Jev fica de fora por um tempo e a reserva assume
 * no mesmo milissegundo, sem rede.
 *
 * ═══ AS REGRAS ═══
 *
 *  - 3 falhas SEGUIDAS abrem por 5 minutos. Depois disso a próxima chamada
 *    passa; se falhar de novo, reabre na hora (a contagem só zera com sucesso).
 *  - Limite de taxa e sobrecarga abrem NA HORA: o próprio fornecedor pediu para
 *    esperar. Vale o `retry-after` dele, ou 60 s sem cabeçalho, com teto de
 *    10 minutos — um cabeçalho absurdo não desliga o Jev pelo dia.
 *  - `sem_credencial` não conta: é configuração, não falha, e nada saiu para a
 *    rede. `disjuntor_aberto` também não, pelo mesmo motivo.
 *
 * ═══ POR QUE EM MEMÓRIA ═══
 *
 * O dreno é um processo Node de vida longa na VPS, então o estado sobrevive
 * entre rodadas. Reiniciar o processo zera o disjuntor, e o pior efeito disso é
 * UMA tentativa a mais — não vale uma tabela.
 *
 * ═══ O QUE É DA CONTA, E O QUE É DA TAREFA ═══
 *
 * Chave recusada, crédito esgotado, limite de taxa e sobrecarga são da CONTA:
 * valem para toda tarefa, e o disjuntor delas é da organização. O resto é de
 * UMA tarefa: a pergunta recusada (`contrato_invalido` — a API derruba a
 * chamada inteira quando uma pergunta vem malformada, e a das outras está
 * certa), a demora (`provedor_indisponivel`) e a resposta ilegível. A demora
 * era da organização, e o sucesso de uma tarefa a zerava: o roteador, a
 * pergunta mais pesada, podia estourar o teto em todo turno sem o disjuntor
 * dele abrir nunca, enquanto três demoras só dele cortavam o clima e a
 * manipulação. Numa queda de verdade cada tarefa abre o seu depois das três
 * dela. Quem chama sem tarefa (a string da organização) fica no disjuntor da
 * organização para tudo, como antes.
 */
import type { MotivoDaAusencia } from "./cliente";

/** As falhas da CONTA — ver o cabeçalho. */
const DA_CONTA: ReadonlySet<MotivoDaAusencia> = new Set([
  "credencial_invalida",
  "sem_credito",
  "limite_de_taxa",
  "provedor_sobrecarregado",
]);

const FALHAS_PARA_ABRIR = 3;
const ABERTO_POR_FALHAS_MS = 5 * 60_000;
const ESPERA_SEM_CABECALHO_MS = 60_000;
const TETO_DA_ESPERA_MS = 10 * 60_000;

interface EstadoDoDisjuntor {
  falhasSeguidas: number;
  abertoAte: number;
}

/** A organização, ou a organização numa tarefa. */
export type AlvoDoDisjuntor = string | { organizationId: string; tarefa: string };

// ponytail: um Map por processo. Chave = organização, ou organização+tarefa
// para a pergunta recusada. Cresce até organizações × tarefas e encolhe a cada
// sucesso.
const estados = new Map<string, EstadoDoDisjuntor>();

function chaves(alvo: AlvoDoDisjuntor): { daOrganizacao: string; daTarefa: string | null } {
  if (typeof alvo === "string") return { daOrganizacao: alvo, daTarefa: null };
  return { daOrganizacao: alvo.organizationId, daTarefa: `${alvo.organizationId}:${alvo.tarefa}` };
}

function fechado(chave: string | null, agora: number): boolean {
  const estado = chave === null ? undefined : estados.get(chave);
  return estado === undefined || agora >= estado.abertoAte;
}

export function podeTentar(alvo: AlvoDoDisjuntor, agora: number = Date.now()): boolean {
  const { daOrganizacao, daTarefa } = chaves(alvo);
  return fechado(daOrganizacao, agora) && fechado(daTarefa, agora);
}

/**
 * Quantas falhas seguidas o Jev acumula para quem chama — as da conta e as da
 * tarefa, que o sucesso da tarefa zera juntas. Com o disjuntor aberto nada sai
 * para a rede e a conta não sobe, então ela mede tentativas reais: é o que o
 * worker usa para separar tropeço de queda.
 */
export function falhasSeguidas(alvo: AlvoDoDisjuntor): number {
  const { daOrganizacao, daTarefa } = chaves(alvo);
  return (estados.get(daOrganizacao)?.falhasSeguidas ?? 0) + (daTarefa ? (estados.get(daTarefa)?.falhasSeguidas ?? 0) : 0);
}

/** O sucesso prova a conta e a pergunta DESTA tarefa — nunca a de outra. */
export function registrarSucesso(alvo: AlvoDoDisjuntor): void {
  const { daOrganizacao, daTarefa } = chaves(alvo);
  estados.delete(daOrganizacao);
  if (daTarefa !== null) estados.delete(daTarefa);
}

export function registrarFalha(
  alvo: AlvoDoDisjuntor,
  motivo: MotivoDaAusencia,
  agora: number = Date.now(),
  retryAfterMs?: number,
): void {
  if (motivo === "sem_credencial" || motivo === "disjuntor_aberto") return;

  const { daOrganizacao, daTarefa } = chaves(alvo);
  const chave = DA_CONTA.has(motivo) || daTarefa === null ? daOrganizacao : daTarefa;
  const estado = estados.get(chave) ?? { falhasSeguidas: 0, abertoAte: 0 };
  estado.falhasSeguidas += 1;

  if (motivo === "limite_de_taxa" || motivo === "provedor_sobrecarregado") {
    estado.abertoAte = agora + Math.min(retryAfterMs ?? ESPERA_SEM_CABECALHO_MS, TETO_DA_ESPERA_MS);
  } else if (estado.falhasSeguidas >= FALHAS_PARA_ABRIR) {
    estado.abertoAte = agora + ABERTO_POR_FALHAS_MS;
  }
  estados.set(chave, estado);
}
