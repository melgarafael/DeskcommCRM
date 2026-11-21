/**
 * Por que o follow-up segurou o envio — dito com o motivo de VERDADE.
 *
 * ─── O defeito que este arquivo existe para consertar ───────────────────────
 *
 * `action_deferred` tem UM texto na tela ("Segurou o envio até o horário
 * permitido — a janela estava fechada") para TODOS os motivos de adiamento. O
 * motivo real está em `payload.reason` desde sempre, mas ninguém o lia.
 *
 * Medido numa instalação com número pareado por QR: o passo da IA escreveu a
 * mensagem, o envio não saiu, e o histórico culpou "a janela fechada" — que,
 * naquela conexão, é uma regra que NÃO existe (o QR não tem janela regulatória;
 * ver `aJanelaRegulatoriaSeAplica` em `lib/channels/janela.ts`). O operador foi
 * procurar a janela de 24 h da API oficial num número que nem está na aba API
 * Oficial. O adiamento era outro: a conversa tinha uma pessoa no comando.
 *
 * A regra que sai daqui: o texto do adiamento é uma DECISÃO sobre
 * (motivo, escopo do canal). O escopo vem da capacidade do canal — nunca do
 * nome do provedor —, e a frase da janela regulatória só aparece onde ela é
 * verdadeira. Um canal sem janela regulatória nunca lê "a janela estava
 * fechada": ele lê o horário de envio da conexão, a faixa do acompanhamento, a
 * pessoa no comando ou a repetição, que é o que de fato o segurou.
 *
 * Puro e sem I/O: quem chama já formatou o instante (`quando`) no idioma da
 * tela, e o resto é tabela.
 */

/** O que segurou o envio, na granularidade que o operador precisa ler. */
export type GrupoDoAdiamento =
  /** A janela de 24 h da API oficial. Só existe onde o canal a impõe. */
  | "janela_regulatoria"
  /** O horário de envio da conexão (a tela de Proteção de envio / anti-ban). */
  | "horario_do_canal"
  /** A faixa própria do acompanhamento (`followup.send_window` do agente). */
  | "faixa_do_acompanhamento"
  /** Uma pessoa assumiu a conversa e a política do fluxo manda esperar. */
  | "pessoa_no_comando"
  /** A trava anti-repetição do número. */
  | "repeticao"
  /** Espaçamento/teto do número (ritmo anti-ban). */
  | "ritmo"
  /** Motivo desconhecido (payload antigo ou vocabulário novo) — sem inventar causa. */
  | "generico";

/**
 * Os motivos que significam "a janela de 24 h da plataforma". São os únicos em
 * que a frase da janela regulatória é legítima — e, mesmo neles, só quando o
 * canal realmente tem essa janela.
 */
const MOTIVOS_DA_JANELA_REGULATORIA: ReadonlySet<string> = new Set([
  "janela_regulatoria",
  "janela_fechada",
  "messaging_window_closed",
]);

const MOTIVOS_DE_RITMO: ReadonlySet<string> = new Set([
  "pacing_throttle",
  "daily_cap",
  "warmup_cap",
]);

/**
 * A que grupo pertence este `reason`.
 *
 * `janelaRegulatoria` é o escopo do CANAL (a capability), não o do motivo: um
 * motivo de janela num canal sem janela cai em `horario_do_canal`, porque ali
 * o que pode ter fechado é o horário de envio da conexão — nunca a regra da
 * Meta.
 */
export function grupoDoAdiamento(
  reason: unknown,
  janelaRegulatoria: boolean,
): GrupoDoAdiamento {
  const motivo = typeof reason === "string" ? reason : "";
  if (MOTIVOS_DA_JANELA_REGULATORIA.has(motivo)) {
    return janelaRegulatoria ? "janela_regulatoria" : "horario_do_canal";
  }
  if (motivo === "outside_window") return "horario_do_canal";
  if (motivo === "followup_send_window") return "faixa_do_acompanhamento";
  if (motivo === "pessoa_no_comando") return "pessoa_no_comando";
  if (motivo === "mass_identical") return "repeticao";
  if (MOTIVOS_DE_RITMO.has(motivo)) return "ritmo";
  return "generico";
}

export interface EntradaDoAdiamento {
  /** `payload.reason` do evento `action_deferred`. */
  reason: unknown;
  /** `payload.until` já formatado no idioma da tela (`quandoLegivel`). */
  quando: string | null;
  /** O canal desta conversa tem janela regulatória? (capability, não nome) */
  janelaRegulatoria: boolean;
}

export interface AdiamentoLegivel {
  titulo: string;
  detalhe: string | null;
}

/**
 * A frase do adiamento.
 *
 * A frase antiga ("a janela estava fechada") sobrevive só nos motivos de janela
 * de 24 h, e só em canal que tem essa janela. Todo outro motivo — inclusive
 * `outside_window` no canal oficial — passa a nomear o que de fato segurou o
 * envio. O título "Segurou o envio até o horário permitido" se mantém nos dois
 * grupos de horário.
 */
export function descreverAdiamento(entrada: EntradaDoAdiamento): AdiamentoLegivel {
  const { quando, janelaRegulatoria } = entrada;
  switch (grupoDoAdiamento(entrada.reason, janelaRegulatoria)) {
    case "janela_regulatoria":
      return {
        titulo: "Segurou o envio até o horário permitido",
        detalhe: quando ? `a janela estava fechada; envia em ${quando}` : "a janela estava fechada",
      };
    case "horario_do_canal":
      return {
        titulo: "Segurou o envio até o horário permitido",
        detalhe: quando
          ? `o horário de envio desta conexão estava fechado; envia em ${quando}`
          : "o horário de envio desta conexão estava fechado",
      };
    case "faixa_do_acompanhamento":
      return {
        titulo: "Segurou o envio até a faixa do acompanhamento",
        detalhe: quando
          ? `a faixa de envio do acompanhamento estava fechada; envia em ${quando}`
          : "a faixa de envio do acompanhamento estava fechada",
      };
    case "pessoa_no_comando":
      return {
        titulo: "Esperou uma pessoa devolver a conversa ao automático",
        detalhe: quando ? `confere de novo em ${quando}` : null,
      };
    case "repeticao":
      return {
        titulo: "Segurou para não repetir a mesma mensagem",
        detalhe: quando ? `volta a tentar em ${quando}` : null,
      };
    case "ritmo":
      return {
        titulo: "Segurou o envio pelo ritmo deste número",
        detalhe: quando ? `volta a tentar em ${quando}` : null,
      };
    case "generico":
      return {
        titulo: "Segurou o envio",
        detalhe: quando ? `volta a tentar em ${quando}` : null,
      };
  }
}
