/**
 * A JANELA DO RELATÓRIO COMERCIAL — dia civil no fuso da ORGANIZAÇÃO.
 *
 * ─── Por que a janela tem um lugar só ───────────────────────────────────────
 *
 * "Quanto vendemos em setembro" é uma pergunta de CALENDÁRIO, e calendário não
 * existe sem fuso. Em UTC, a venda fechada às 22h do dia 31 de agosto em São
 * Paulo (01h de 1º de setembro em UTC) cairia em setembro; em Tóquio, a mesma
 * venda cairia em agosto. As duas respostas seriam "verdadeiras" e uma delas
 * seria a errada para quem perguntou — por isso o recorte é o fuso da
 * ORGANIZAÇÃO (`organizations.timezone`), nunca o do navegador de quem olha:
 * duas pessoas da mesma empresa têm de ver o mesmo mês.
 *
 * ─── Semiaberta, e por quê ──────────────────────────────────────────────────
 *
 * A janela é `[início do dia 'de', início do dia seguinte a 'ate')`. O `ate` é
 * INCLUSIVO como dia civil (o operador escolhe "até 30/09" e espera ver o dia
 * 30 inteiro) e exclusivo como instante — que é o que impede a venda da
 * meia-noite do dia 1º de outubro de contar em setembro E em outubro.
 *
 * ─── Duas passadas, porque o offset depende do instante ─────────────────────
 *
 * `data + 'T00:00:00Z' - offset` erra na fronteira de horário de verão: o
 * deslocamento medido à meia-noite UTC pode não ser o do instante encontrado
 * depois de subtraído. `inicioDoDia` mede duas vezes e só aceita a segunda
 * quando ela confirma a primeira (o mesmo algoritmo de
 * `app/api/v1/reports/tags/route.ts`, escrito uma vez para os dois).
 */
import { fusoValido } from "@/lib/reports/atividades";

/** Fuso de reserva: organização sem `timezone` configurado. */
export const TZ_PADRAO = "UTC";

/**
 * Teto do intervalo, em dias de calendário (os dois extremos contam).
 *
 * Mesma ordem de grandeza de `/reports/financeiro` (400) e folgado em relação a
 * `/reports/tags` (90): aqui a leitura é de negócios GANHOS — uma fração da
 * base —, mas o relatório não é um "desde sempre": um ano fecha o ciclo
 * comercial e mantém a resposta abaixo do teto de páginas na maioria das
 * organizações.
 */
export const DIAS_MAXIMOS = 366;

/**
 * O fuso pedido serve? Nome torto vai para `Intl` e levanta exceção — a entrada
 * é do banco (ou de uma query string), então a validação é antes do uso.
 */
export function fusoDoRelatorio(tz: string | null | undefined): string {
  const limpo = (tz ?? "").trim();
  return limpo !== "" && fusoValido(limpo) ? limpo : TZ_PADRAO;
}

/** Dias de calendário cobertos pela janela, contando os dois extremos. */
export function diasDeJanela(de: string, ate: string): number {
  const ms = Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** O dia civil seguinte a `YYYY-MM-DD` (aritmética em UTC, sem fuso). */
export function proximoDia(data: string): string {
  const [ano, mes, dia] = data.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(ano, mes - 1, dia + 1)).toISOString().slice(0, 10);
}

/** As partes de parede de um instante no fuso pedido. */
export function partesLocais(
  instante: Date,
  tz: string,
): { ano: number; mes: number; dia: number; hora: number; minuto: number; segundo: number } {
  const formato = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const partes: Record<string, string> = {};
  for (const parte of formato.formatToParts(instante)) partes[parte.type] = parte.value;
  return {
    ano: Number(partes.year),
    mes: Number(partes.month),
    dia: Number(partes.day),
    hora: Number(partes.hour),
    minuto: Number(partes.minute),
    segundo: Number(partes.second),
  };
}

/** O dia civil de um instante, no fuso pedido. */
export function dataNoFuso(instante: Date, tz: string): string {
  const p = partesLocais(instante, tz);
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${p.ano}-${dois(p.mes)}-${dois(p.dia)}`;
}

/** `2026-09-01` em `tz` → instante UTC do começo daquele dia LOCAL. */
export function inicioDoDia(data: string, tz: string): Date {
  const pretendido = Date.parse(`${data}T00:00:00Z`);
  const primeira = deslocamentoDe(pretendido, tz);
  const tentativa = pretendido - primeira;
  const segunda = deslocamentoDe(tentativa, tz);
  return new Date(segunda === primeira ? tentativa : pretendido - segunda);
}

/** Quanto o relógio local está à frente do UTC naquele instante, em ms. */
function deslocamentoDe(instanteUtcMs: number, tz: string): number {
  const p = partesLocais(new Date(instanteUtcMs), tz);
  const localComoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return localComoUtc - instanteUtcMs;
}

/**
 * O período pedido, já resolvido em instantes: civil (para a resposta e para a
 * tela) e ISO (para o filtro no banco).
 */
export interface JanelaDoRelatorio {
  /** Primeiro dia civil, inclusivo. */
  de: string;
  /** Último dia civil, INCLUSIVO — o `to` é o começo do dia seguinte. */
  ate: string;
  tz: string;
  /** `[from, to)`: o que vai para `closed_at >= from` e `closed_at < to`. */
  from: string;
  to: string;
}

/** Monta a janela a partir dos dois dias civis e do fuso da organização. */
export function janelaDoRelatorio(de: string, ate: string, tz: string): JanelaDoRelatorio {
  const fuso = fusoDoRelatorio(tz);
  return {
    de,
    ate,
    tz: fuso,
    from: inicioDoDia(de, fuso).toISOString(),
    to: inicioDoDia(proximoDia(ate), fuso).toISOString(),
  };
}

/**
 * O período PADRÃO do painel: do primeiro dia do mês corrente até hoje, no fuso
 * da organização. É a pergunta que se faz de verdade ("como está o mês"), e o
 * default é declarado na resposta (`padrao: true`) para a tela poder dizer qual
 * período está mostrando.
 */
export function periodoPadrao(agora: Date, tz: string): { de: string; ate: string } {
  const fuso = fusoDoRelatorio(tz);
  const hoje = dataNoFuso(agora, fuso);
  return { de: `${hoje.slice(0, 7)}-01`, ate: hoje };
}
