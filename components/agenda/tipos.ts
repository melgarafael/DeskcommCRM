/**
 * Vocabulário da Agenda — em pt-br, como o resto do produto.
 *
 * O produto renomeia termo técnico na cara do usuário ("Kanban" virou "Funis",
 * "Templates" virou "Respostas rápidas"), então aqui não existe `Booking`,
 * `Event` nem `Slot`: existe agendamento, pessoa e horário.
 *
 * Este arquivo é só forma. Enquanto o schema da Wave 0 não existe, a tela é
 * alimentada por `dados-de-mentira.ts` — e quando existir, o que muda é a
 * origem, não o formato.
 */

/** As três visões da grade. A semana é o padrão de quem atende. */
export type VisaoDaAgenda = "dia" | "semana" | "mes";

/**
 * Índice da trilha de cor, 1..8 — casa com `--agenda-pessoa-N` no globals.css.
 *
 * Vem de `lib/agenda/tipos.ts` e não é redeclarado aqui: o Arquiteto expôs
 * `TRILHAS_DA_AGENDA` depois de adotar o argumento deste módulo (o modelo
 * escolhe QUAL trilha, nunca QUE cor). Manter uma segunda declaração de 1..8
 * seria repetir, no eixo do número, o mesmo defeito que o vocabulário de
 * situação teve — dois símbolos com o mesmo sentido em módulos diferentes.
 */
export type TrilhaDeCor = TrilhaDaAgenda;

export type Pessoa = {
  id: string;
  nome: string;
  /** Atribuída na entrada da pessoa na organização, não sorteada a cada render. */
  trilha: TrilhaDeCor;
};

/**
 * O VOCABULÁRIO DE BANCO NÃO MORA AQUI — é importado.
 *
 * Estes dois tipos tinham definição PRÓPRIA neste arquivo, com valores em pt-br
 * (`faltou`, `deskcomm`) enquanto `lib/agenda/tipos.ts` — que espelha o CHECK
 * da migration 0176 — declara `no_show` e `google_sync`. Mesmo NOME de símbolo,
 * conjuntos sem intersecção, em módulos diferentes.
 *
 * O modo de falha era o pior dos três possíveis: **não** dava erro de
 * compilação (são módulos distintos) e **não** dava erro em runtime — daria
 * CARD EM BRANCO no dia em que a frente 1 ligasse a tela ao banco, porque o
 * dado chegaria `no_show` e o `Record` de rótulos não teria a chave. Achado
 * pelo Arquiteto antes de a ligação existir.
 *
 * A regra que fica: o que tem lado no BANCO vem de `lib/agenda/tipos.ts`; o que
 * é só da TELA (visão, trilha de cor, Pessoa) fica aqui, porque não tem lado no
 * banco e não deve ter.
 */
export type { OrigemDoAgendamento, SituacaoDoAgendamento } from "@/lib/agenda/tipos";

import type { OrigemDoAgendamento, SituacaoDoAgendamento, TrilhaDaAgenda } from "@/lib/agenda/tipos";

export type Agendamento = {
  revision?:number;
  id: string;
  titulo: string;
  /** Quem vai ser atendido. Ausente em ocupação vinda do Google. */
  quemSeraAtendido?: string;
  /** Quem atende — é dele a cor do bloco. */
  responsavelId: string;
  /** ISO-8601. */
  comeca: string;
  termina: string;
  tipo?: string;
  local?: string;
  origem: OrigemDoAgendamento;
  situacao: SituacaoDoAgendamento;
};

/** Um horário oferecido pelo painel de marcação. */
export type HorarioLivre = {
  /** ISO-8601 do início. */
  instante: string;
  /** Rótulo já formatado no fuso de apresentação (ex.: "09:30"). */
  rotulo: string;
};
