/**
 * O BLOCO QUE DIZ AO MODELO QUE HORAS SÃO.
 *
 * ─── O defeito, medido ─────────────────────────────────────────────────────
 *
 * O modelo do agente NUNCA soube a data. O ritual de abertura do turno
 * (`inbound-turn.ts`) entrega checkpoint, funil, notas e histórico — e nenhum
 * relógio. O follow-up entrega um DELTA ("passaram 3 horas"), que responde "há
 * quanto tempo" e não "que dia é hoje".
 *
 * Quem paga é o agendamento. `crm_book_appointment` exige `starts_at` como
 * instante absoluto e `crm_schedule_followup` exige `promised_at` no mesmo
 * formato; sem relógio, o modelo não tem de onde tirar nenhum dos dois, e
 * "quinta às 14h" não vira nada. A prova de que isso dói em produção não é
 * teórica: o system prompt de um agente real desta instalação tem um parágrafo
 * chamado "Você não tem relógio, mas tem carimbo", ensinando a IA a inferir a
 * data pelo timestamp da última mensagem do histórico. Contorno de prompt para
 * um buraco de runtime — e um contorno que cada tenant teria de reinventar.
 *
 * ─── Por que as duas formas, e não uma ─────────────────────────────────────
 *
 * A linha humana ("sexta-feira, 04/09/2026, 14:32") é a que responde ao que a
 * PESSOA disse: "quinta que vem", "amanhã de manhã", "depois do fim de semana".
 * Sem o dia da semana por extenso o modelo teria de derivá-lo de uma data, que
 * é exatamente o cálculo que ele erra.
 *
 * O `instante_absoluto` é a string que as ferramentas EXIGEM de volta —
 * `z.string().datetime({ offset: true })` em `lib/mcp/tools/agendamento.ts`.
 * Dar ao modelo o formato exato que ele terá de produzir remove um passo de
 * conversão, que é onde ele erra o segundo.
 *
 * ─── Falha ABERTA, sempre ──────────────────────────────────────────────────
 *
 * `Intl.DateTimeFormat({ timeZone })` LANÇA `RangeError` num fuso que não
 * existe, e `organizations.timezone` não é validado por escritor nenhum
 * (`lib/schemas/settings.ts` e `lib/schemas/onboarding.ts` são `z.string()` sem
 * `refine`, e a coluna não tem CHECK). Este bloco roda na montagem do prompt,
 * ANTES da chamada de modelo: um throw aqui mata o turno inteiro e o sintoma
 * chega ao dono como agente mudo, sem erro nenhum para investigar. Por isso o
 * fuso torto degrada para o padrão e o turno segue.
 */

import { partesNoFuso, diaDaSemanaLocal, offsetEmMinutos } from "@/lib/agenda/fuso";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";

/**
 * Domingo = 0, a mesma régua de `diaDaSemanaLocal` e do `dow` da jornada.
 *
 * Tabela nossa, e não `Intl.DateTimeFormat('pt-BR', { weekday: 'long' })`, por
 * uma razão de instrumento: a saída do `Intl` depende dos dados de locale do
 * ICU compilado no runtime, e um Node `small-icu` devolve o nome em inglês sem
 * lançar. O bloco passaria a dizer "friday" para o cliente brasileiro, e nenhum
 * teste que rode no runtime completo veria isso.
 */
const DIAS_DA_SEMANA = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
] as const;

const doisDigitos = (n: number): string => String(n).padStart(2, "0");

/**
 * O bloco `## Agora`, pronto para entrar no sufixo por-lead da abertura.
 *
 * `agora` é PARÂMETRO e nunca `new Date()` interno: o turno tem relógio
 * injetável (`deps.clock`), e um segundo relógio aqui dentro faria o teste com
 * clock fixo medir uma coisa e a produção outra. O repo já pagou esse defeito
 * uma vez, no invariante da janela de envio.
 *
 * Fuso ausente, vazio ou inválido cai em {@link FUSO_PADRAO} — nunca lança.
 */
export function renderAgora(agora: Date, fuso: string): string {
  const fusoEmVigor = fusoValido(fuso) ? fuso : FUSO_PADRAO;
  const p = partesNoFuso(agora, fusoEmVigor);
  const diaDaSemana = DIAS_DA_SEMANA[diaDaSemanaLocal(agora, fusoEmVigor)] ?? "";

  return [
    "## Agora",
    `${diaDaSemana}, ${doisDigitos(p.dia)}/${doisDigitos(p.mes)}/${p.ano}, ` +
      `${doisDigitos(p.hora)}:${doisDigitos(p.minuto)} (${fusoEmVigor})`,
    `instante_absoluto: ${agora.toISOString()}`,
    "É daqui que sai toda data: o que a pessoa disser em palavras (\"amanhã\", \"quinta\", " +
      "\"semana que vem\") você resolve a partir desta data, nunca de memória. " +
      "Ferramenta que pede um instante recebe o formato de `instante_absoluto`; " +
      "com a pessoa você fala como gente (\"quinta às 14h\").",
  ].join("\n");
}

/**
 * "quinta-feira 04/09 às 14:00" — um instante na parede daquele fuso.
 *
 * Existe para os HORÁRIOS LIVRES. `crm_find_free_slots` devolvia só o ISO em
 * UTC, e pedir ao modelo que converta cada um para o fuso da clínica antes de
 * dizer "quinta às 14h" é pedir exatamente o cálculo que ele erra — o mesmo que
 * `renderAgora` existe para eliminar no turno.
 *
 * ⚠️ NÃO É `renderAgora` com outro formato, e a diferença não é cosmética: aqui
 * não entra o ano nem o `instante_absoluto`, porque isto se repete uma vez por
 * horário oferecido e o ISO já vai no campo ao lado. As duas compartilham as
 * constantes, não o corpo.
 *
 * ⚠️ O dia da semana sai da data JÁ LIDA, e não de uma segunda consulta ao
 * `Intl`: `partesNoFuso` reusa um formatador em cache por fuso, enquanto
 * `diaDaSemanaLocal` constrói um formatador novo a cada chamada — o que numa
 * lista de horários vira um por linha. Uma data civil não tem horário de verão,
 * então derivar o dia dela é exato.
 */
/**
 * O instante, escrito na hora de parede do fuso da organização — ISO 8601 com o
 * OFFSET REAL daquele fuso naquele instante (`2026-09-02T15:45:38-03:00`), nunca
 * `+00:00`/`Z`.
 *
 * ─── O defeito que esta função existe para consertar ──────────────────────────
 *
 * `get-lead-context.ts` entregava cada mensagem do histórico ao modelo com
 * `sent_at` cru do banco (`timestamptz::text` no fuso da SESSÃO do Postgres, que
 * é UTC) — enquanto o bloco `## Agora` acima, no mesmo prompt, já mostrava o
 * relógio certo no fuso da organização. Um agente instruído a "usar o horário
 * exato de cada mensagem para saber se a loja está aberta" comparava um horário
 * em UTC contra uma janela em hora local: medido em produção (YADEA, fuso
 * America/Sao_Paulo, expediente 09:00–18:00), uma mensagem enviada às 15:45
 * local chegou ao modelo como `18:45+00`, e o agente respondeu "a oficina está
 * fechada" dentro do próprio horário de atendimento que ele citou na resposta.
 *
 * A saída ISO com offset (em vez de hora de parede nua) preserva o instante
 * exato para quem ainda faz `Date.parse` sobre este campo (cálculo de "quanto
 * tempo passou" em `followup-turn.ts`) — só o FUSO em que a hora é lida muda.
 *
 * Fuso ausente, vazio ou inválido cai em {@link FUSO_PADRAO} — nunca lança
 * (mesma regra de falha aberta de `renderAgora`).
 */
export function isoLocalComOffset(instante: Date, fuso: string): string {
  const fusoEmVigor = fusoValido(fuso) ? fuso : FUSO_PADRAO;
  const p = partesNoFuso(instante, fusoEmVigor);
  const offsetMin = Math.round(offsetEmMinutos(instante, fusoEmVigor));
  const sinal = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const offsetHoras = doisDigitos(Math.floor(abs / 60));
  const offsetMinutos = doisDigitos(abs % 60);
  return (
    `${p.ano}-${doisDigitos(p.mes)}-${doisDigitos(p.dia)}T` +
    `${doisDigitos(p.hora)}:${doisDigitos(p.minuto)}:${doisDigitos(p.segundo)}` +
    `${sinal}${offsetHoras}:${offsetMinutos}`
  );
}

export function rotuloLocal(instante: Date, fuso: string): string {
  const fusoEmVigor = fusoValido(fuso) ? fuso : FUSO_PADRAO;
  const p = partesNoFuso(instante, fusoEmVigor);
  const diaDaSemana = DIAS_DA_SEMANA[new Date(Date.UTC(p.ano, p.mes - 1, p.dia)).getUTCDay()] ?? "";
  return `${diaDaSemana} ${doisDigitos(p.dia)}/${doisDigitos(p.mes)} às ${doisDigitos(p.hora)}:${doisDigitos(p.minuto)}`;
}
