/**
 * COMO SE CHAMA, EM PORTUGUÊS, O ESTADO DE UM CANAL.
 *
 * ═══ O QUE ISTO RESOLVE ═══
 *
 * Medido nesta sessão: o produto tinha CINCO traduções do mesmo enum, e a tela
 * de edição de agente não tinha nenhuma — ela imprimia o valor cru. O dono lia
 * literalmente `org_2dd5e6ea · STARTING` no seletor "Número conectado", o que
 * junta dois vazamentos num campo só: o nome interno da sessão no transporte e o
 * estado em inglês, em caixa alta, do jeito que o banco guarda.
 *
 * As cinco: a do wizard (`connect-whatsapp/_client.tsx`), o `STATUS_MAP` da tela
 * de Conexões, o "— desconectado" binário do formulário de automação, o
 * `(${status})` que `lib/channels/health.ts` PERSISTE em `agent_inbox_items`, e o
 * nada da tela de agentes. Cinco lugares para consertar quando o vocabulário
 * mudar, e um deles grava no banco.
 *
 * ⚠️ O WIZARD NÃO ENTRA AQUI, E ISSO É DELIBERADO. Lá, `STARTING` é "Preparando
 * o código…" porque existe um QR sendo gerado na tela e a pessoa está esperando
 * por ele; aqui é "Conectando…" porque a pergunta é outra — "dá para usar este
 * número agora?". Uniformizar os dois pelo grep produziria um seletor de canal
 * dizendo "Preparando o código…" para quem não está pareando nada. Mesmo enum,
 * perguntas diferentes; ver `feedback_mesmo_texto_significados_opostos`.
 *
 * ⚠️ O VOCABULÁRIO É FECHADO PELO TIPO, não por `??`. `Record<EstadoDoCanal, …>`
 * força o TypeScript a reprovar o dia em que o CHECK do banco ganhar um valor e
 * ninguém escrever a frase dele — que é exatamente como o enum cru chegava à
 * tela: um `?? status` silencioso no fim da função.
 */

/**
 * Os cinco estados que `channel_sessions_status_check` aceita. Medido no banco:
 *
 *   CHECK (status = ANY (ARRAY['STARTING','SCAN_QR_CODE','WORKING','STOPPED','FAILED']))
 */
export const ESTADOS_DO_CANAL = [
  "STARTING",
  "SCAN_QR_CODE",
  "WORKING",
  "STOPPED",
  "FAILED",
] as const;

export type EstadoDoCanal = (typeof ESTADOS_DO_CANAL)[number];

/** A cor que a tela usa. Mesmos nomes que os badges do produto já esperam. */
export type TomDoEstado = "success" | "warning" | "error" | "neutral";

export interface LeituraDoEstado {
  /** Curto, para caber num badge ou numa opção de lista. */
  rotulo: string;
  tom: TomDoEstado;
  /** O canal consegue receber e enviar mensagem AGORA? */
  utilizavel: boolean;
}

const LEITURA: Record<EstadoDoCanal, LeituraDoEstado> = {
  WORKING: { rotulo: "Conectado", tom: "success", utilizavel: true },
  SCAN_QR_CODE: { rotulo: "Escaneie o QR", tom: "warning", utilizavel: false },
  STARTING: { rotulo: "Conectando…", tom: "warning", utilizavel: false },
  STOPPED: { rotulo: "Parado", tom: "error", utilizavel: false },
  FAILED: { rotulo: "Caiu", tom: "error", utilizavel: false },
};

/**
 * O DESCONHECIDO EXISTE E É HONESTO. O CHECK garante os cinco no banco, mas isto
 * também lê estado que veio da API do transporte, e essa não tem contrato com o
 * nosso CHECK. Devolver o valor cru "para não perder informação" era o defeito;
 * a informação crua pertence ao log, não à tela de quem vende.
 */
const DESCONHECIDO: LeituraDoEstado = {
  rotulo: "Situação desconhecida",
  tom: "neutral",
  utilizavel: false,
};

export function ehEstadoDoCanal(v: unknown): v is EstadoDoCanal {
  return typeof v === "string" && (ESTADOS_DO_CANAL as readonly string[]).includes(v);
}

export function lerEstadoDoCanal(status: string | null | undefined): LeituraDoEstado {
  return ehEstadoDoCanal(status) ? LEITURA[status] : DESCONHECIDO;
}

/** Só o rótulo — o caso mais comum na tela. */
export function rotuloDoEstadoDoCanal(
  status: string | null | undefined,
  t: (texto: string) => string = (texto) => texto,
): string {
  return t(lerEstadoDoCanal(status).rotulo);
}

/**
 * O nome do canal para quem o LÊ, com o último degrau honesto.
 *
 * ⚠️ `waha_session_name` NÃO ENTRA. Ele era o segundo degrau em
 * `lib/channels/selectable.ts`, e por isso um canal sem apelido aparecia como
 * `org_2dd5e6ea` — o identificador que nós geramos para o transporte, exposto
 * como se fosse o nome do número da pessoa. Um canal sem apelido e sem telefone
 * é um canal sem nome, e dizer isso é melhor do que inventar um.
 */
export function nomeDoCanal(
  c: {
    display_name?: string | null;
    phone_number?: string | null;
  },
  t: (texto: string) => string = (texto) => texto,
): string {
  const apelido = (c.display_name ?? "").trim();
  if (apelido) return apelido;
  const telefone = (c.phone_number ?? "").trim();
  if (telefone) return telefone;
  return t("Número sem nome");
}
