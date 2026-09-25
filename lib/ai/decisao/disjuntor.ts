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
 */
import type { MotivoDaAusencia } from "./cliente";

const FALHAS_PARA_ABRIR = 3;
const ABERTO_POR_FALHAS_MS = 5 * 60_000;
const ESPERA_SEM_CABECALHO_MS = 60_000;
const TETO_DA_ESPERA_MS = 10 * 60_000;

interface EstadoDoDisjuntor {
  falhasSeguidas: number;
  abertoAte: number;
}

// ponytail: um Map por processo, chave = organização. Cresce até o número de
// organizações da instalação e encolhe a cada sucesso.
const estados = new Map<string, EstadoDoDisjuntor>();

export function podeTentar(organizationId: string, agora: number = Date.now()): boolean {
  const estado = estados.get(organizationId);
  return estado === undefined || agora >= estado.abertoAte;
}

/**
 * Quantas falhas seguidas o Jev acumula nesta organização — zera no sucesso.
 * Com o disjuntor aberto nada sai para a rede e a conta não sobe, então ela
 * mede tentativas reais: é o que o worker usa para separar tropeço de queda.
 */
export function falhasSeguidas(organizationId: string): number {
  return estados.get(organizationId)?.falhasSeguidas ?? 0;
}

export function registrarSucesso(organizationId: string): void {
  estados.delete(organizationId);
}

export function registrarFalha(
  organizationId: string,
  motivo: MotivoDaAusencia,
  agora: number = Date.now(),
  retryAfterMs?: number,
): void {
  if (motivo === "sem_credencial" || motivo === "disjuntor_aberto") return;

  const estado = estados.get(organizationId) ?? { falhasSeguidas: 0, abertoAte: 0 };
  estado.falhasSeguidas += 1;

  if (motivo === "limite_de_taxa" || motivo === "provedor_sobrecarregado") {
    estado.abertoAte = agora + Math.min(retryAfterMs ?? ESPERA_SEM_CABECALHO_MS, TETO_DA_ESPERA_MS);
  } else if (estado.falhasSeguidas >= FALHAS_PARA_ABRIR) {
    estado.abertoAte = agora + ABERTO_POR_FALHAS_MS;
  }
  estados.set(organizationId, estado);
}
