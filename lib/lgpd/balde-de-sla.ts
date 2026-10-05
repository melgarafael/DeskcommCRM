/**
 * OS BALDES DE SLA — as DUAS superfícies que classificam um prazo.
 *
 * | superfície  | campo         | quem lê                          |
 * |-------------|---------------|----------------------------------|
 * | organização | `sla_bucket`  | lista de solicitações (#2100)    |
 * | plataforma  | `risk_level`  | painel Admin › LGPD              |
 *
 * Vivem no mesmo arquivo porque são a **mesma pergunta** ("em que balde este
 * prazo está?") com dois vocabulários — e porque a resposta honesta é que as duas
 * virem no **mesmo instante**. Lado a lado, isso vira uma propriedade que um teste
 * afirma; em arquivos separados, seria uma coincidência que alguém quebraria sem
 * perceber.
 *
 * ## Por que fora dos route handlers
 *
 * `due_at` guarda um DIA CIVIL (ver `sla.ts`), e um dia civil não é um instante.
 * Quem decide um balde precisa de aritmética de dia, e aritmética testada é uma
 * função pura — não um parágrafo dentro de um `GET`. O balde da plataforma vivia
 * em `app/api/v1/admin/lgpd/requests/route.ts` e veio para cá pelo mesmo caminho
 * que o da organização (#2101).
 *
 * ## A régua da organização (`sla_bucket`) — em DIAS
 *
 * `diasAtePrazo` vale `0` no dia do prazo, `1` no dia anterior, negativo quando
 * passou — então:
 *
 * - `overdue`: passou ao menos um dia civil inteiro;
 * - `critical`: 0 ou 1 dia restante, o que é o "menos de dois dias" de antes;
 * - `warning`: metade da janela já consumida. Esta continua em milissegundos de
 *   propósito — é uma RAZÃO entre duas pontas (recebido → prazo), não uma contagem
 *   de dias, e as duas pontas estão no mesmo eixo.
 *
 * `dueAt` ausente é "ok": quem não tem prazo não está vencendo nada.
 *
 * ## A régua da plataforma (`risk_level`) — em HORAS
 *
 * A mesma âncora, na unidade que a tela mostra. `horasAteOFimDoPrazo` vale as
 * horas até o FIM do dia guardado, e é `0` no último minuto desse dia:
 *
 * - `expired`: o dia do prazo acabou;
 * - `at_risk`: menos de 24h até o fim desse dia;
 * - `warning`: metade da janela já consumida.
 *
 * ## O defeito que este arquivo conserta na plataforma
 *
 * `computeRiskLevel` comparava milissegundos, como `computeSlaBucket` fazia:
 *
 * ```ts
 * const msUntilDue = new Date(dueAt).getTime() - Date.now();
 * if (msUntilDue < 0) return "expired";
 * ```
 *
 * Medido em São Paulo (UTC−3), com prazo no dia **05/10** — que é como o prazo
 * aparece gravado, `2026-10-05T00:00:00.000Z`:
 *
 * | quando (hora de São Paulo) | o selo dizia | o balde da organização | o que é verdade |
 * |---|---|---|---|
 * | 03/10 22:00 | **Crítico** | Crítico | faltam 40 h |
 * | 04/10 22:00 | **Vencido** | Crítico | o prazo é AMANHÃ |
 * | 05/10 09:00 | **Vencido** | Crítico | vence hoje |
 *
 * Três linhas, uma causa: o prazo vai até o FIM do dia 05, e a comparação tratava
 * a meia-noite UTC do dia 05 como o fim dele. O selo que o administrador da
 * plataforma lê para decidir o que cobrar estava errado nas 26 horas em que mais
 * importa decidir — e, pior, **discordava do balde da organização**, porque um
 * contava dias civis e o outro contava milissegundos.
 *
 * ## O que NÃO é deste arquivo
 *
 * As três horas entre o fim do dia UTC e a meia-noite local vêm do eixo do
 * MOTOR (`computeDueAt`), não da leitura. Ver `horasAteOFimDoPrazo`.
 */

import { diasAtePrazo, diasDeAtraso, fimDoPrazo, horasAteOFimDoPrazo } from "./sla";

export type SlaBucket = "overdue" | "critical" | "warning" | "ok";
export type RiskLevel = "expired" | "at_risk" | "warning" | "ok";

/** `dias < 2` — o "menos de dois dias" do balde `critical`. */
const JANELA_CRITICA_EM_DIAS = 2;
/** `horas < 24` — o "menos de um dia" do selo `at_risk`. */
const JANELA_DE_RISCO_EM_HORAS = 24;

/** Balde da ORGANIZAÇÃO, em dias civis. Ver o cabeçalho. */
export function computeSlaBucket(
  dueAt: string | null,
  receivedAt: string,
  agora: Date = new Date(),
): SlaBucket {
  if (!dueAt) return "ok";
  if (diasDeAtraso(dueAt, agora) > 0) return "overdue";
  if (diasAtePrazo(dueAt, agora) < JANELA_CRITICA_EM_DIAS) return "critical";

  const totalWindow = new Date(dueAt).getTime() - new Date(receivedAt).getTime();
  const ateFimDaJanela = new Date(dueAt).getTime() - agora.getTime();
  if (totalWindow > 0 && ateFimDaJanela < totalWindow * 0.5) return "warning";
  return "ok";
}

/**
 * Selo da PLATAFORMA, em horas até o fim do dia. Ver o cabeçalho.
 *
 * `expired` usa `diasDeAtraso`, e não `horas < 0`, **de propósito**: é o mesmo
 * predicado que faz o balde da organização virar `overdue`, e é o que garante
 * que os dois selos virem no mesmo instante. `horas` decide `at_risk`.
 *
 * `horas === null` = prazo ilegível, e ilegível é "ok": transformar lixo em linha
 * vermelha no painel de quem administra a instalação seria pior do que não
 * sinalizar. Mesmo critério do balde da organização com prazo ausente.
 */
export function computeRiskLevel(
  dueAt: string | null,
  receivedAt: string,
  agora: Date = new Date(),
): RiskLevel {
  const horas = horasAteOFimDoPrazo(dueAt, agora);
  const fim = fimDoPrazo(dueAt);
  if (!dueAt || horas === null || fim === null) return "ok";
  if (diasDeAtraso(dueAt, agora) > 0) return "expired";
  if (horas < JANELA_DE_RISCO_EM_HORAS) return "at_risk";

  const totalWindow = new Date(dueAt).getTime() - new Date(receivedAt).getTime();
  const msAteOFim = fim.getTime() - agora.getTime();
  if (totalWindow > 0 && msAteOFim < totalWindow * 0.5) return "warning";
  return "ok";
}
