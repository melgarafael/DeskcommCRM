/**
 * A SESSÃO PRESA EM `STARTING` — prazo, intervalo e limite num lugar SÓ.
 *
 * ─── O defeito, medido na issue #4870 ───────────────────────────────────────
 *
 * O número ficou dias sem receber mensagem. O espelho dizia `STARTING` e não
 * saía de lá; `deveRetomarSessao` só aceita `STOPPED`, o watchdog de restart era
 * Fase 4 (nunca escrito) e `STATUS_QUE_AVISAM` deixa `STARTING` de fora de
 * propósito — porque é o estado normal de todo boot, e avisar nele faria o
 * sistema gritar a cada reinício. O resultado é o pior dos mundos: um estado que
 * é NORMAL por trinta segundos e GRAVE por três dias, tratado igual o tempo
 * todo. Ninguém religa, ninguém avisa, e o único sinal é a pausa da campanha —
 * que só existe para quem tem campanha ativa.
 *
 * ─── Por que este arquivo é a régua, e não cada consumidor ───────────────────
 *
 * Dois consumidores decidem sobre o MESMO episódio:
 *
 *   1. o vigia do worker (`session-reconciler.ts`) reinicia a sessão;
 *   2. o aviso de saúde (`health.ts`, chamado pelo cron `channel-health` e pelo
 *      webhook) avisa na Central.
 *
 * Se cada um trouxesse o próprio número, o aviso diria "presa há 5 minutos"
 * enquanto o vigia só agisse aos 10 — duas verdades sobre o mesmo relógio, que é
 * como o operador aprende a desconfiar dos dois. Aqui ficam o prazo, o intervalo
 * entre tentativas e o limite; os dois leem daqui.
 *
 * ─── Por que o relógio é `last_status_change_at` do espelho ─────────────────
 *
 * É o único carimbo que sobrevive a um deploy do worker: contador em memória
 * zeraria a cada subida da imagem, e "limite de 3 tentativas" viraria "3
 * tentativas por deploy" — exatamente o comportamento que deixa a sessão presa
 * por dias. O espelho é a fonte que os DOIS consumidores já leem, então não há
 * segunda contagem para divergir.
 *
 * A exceção conhecida: a ingestão regrava o carimbo a cada evento de status,
 * então um transporte que reemita `STARTING` em intervalos menores que o prazo
 * reinicia a contagem. Isso erra para o lado seguro (age depois, não antes) e é
 * o mesmo compromisso de `canal-mudo.ts`.
 *
 * Módulo PURO: recebe dado e devolve decisão. Quem fala com WAHA é o vigia, quem
 * fala com a Central é o aviso.
 */

/**
 * Quanto tempo em `STARTING` já não é boot.
 *
 * Cinco minutos, e o número vem do que está medido no repo: um boot normal
 * observado fica em `STARTING` por SEGUNDOS (o PUT do WAHA volta a `WORKING` em
 * ≤5 s, 6/6 polls em `lib/waha/__fixtures__`), e o próprio WAHA devolve 422/409
 * para quem pede `start` numa sessão que já está subindo — ou seja, cinco
 * minutos é ~60× o pior boot medido. Curto o bastante para o operador não passar
 * a manhã sem receber mensagem, longo o bastante para não reiniciar um boot de
 * verdade.
 */
export const PRAZO_STARTING_MS = 5 * 60_000;

/**
 * Espaço entre duas tentativas de restart do MESMO episódio.
 *
 * Igual ao prazo de propósito: depois de reiniciar, a sessão precisa do mesmo
 * tempo que um boot normal ganhou para chegar a `WORKING` antes de o vigia
 * mexer nela outra vez. Reiniciar em cima de um restart em curso é o caminho
 * para o transporte nunca terminar de subir.
 */
export const INTERVALO_ENTRE_RESTARTS_MS = 5 * 60_000;

/**
 * Quantas tentativas antes de parar e chamar gente.
 *
 * Três, com o intervalo acima: 5 min (prazo) + 3 × 5 min = ~20 minutos até o
 * aviso de esgotamento. Uma trava de transporte que não cede a três restarts não
 * cede ao quarto, e insistir num número que pode estar banido é o mesmo erro que
 * `deveRetomarSessao` já recusa para `FAILED`. Quem resolve daqui é humano, e o
 * botão Reconectar de Conexões faz stop + start sem pedir QR.
 */
export const LIMITE_DE_RESTARTS = 3;

/** A chave do contador dentro de `channel_sessions.metadata` (jsonb). */
export const CHAVE_DO_VIGIA_DE_STARTING = "vigia_starting";

export interface LimitesDoStartingPreso {
  prazoMs: number;
  intervaloMs: number;
  limite: number;
}

/** Inteiro positivo ou o padrão — env torto não pode derrubar o worker. */
function inteiroPositivo(bruto: string | undefined, padrao: number): number {
  if (bruto === undefined || bruto.trim() === "") return padrao;
  const n = Number(bruto);
  return Number.isInteger(n) && n > 0 ? n : padrao;
}

/**
 * Os três números, do ambiente, com default conservador.
 *
 * Lidos por CHAMADA (e não no topo do módulo) porque o worker e a rota do cron
 * são processos diferentes com o mesmo `.env`, e porque um teste precisa poder
 * mudar o valor sem recarregar o módulo.
 */
export function limitesDoStartingPreso(
  env: Record<string, string | undefined> = process.env,
): LimitesDoStartingPreso {
  return {
    prazoMs: inteiroPositivo(env["WHATSAPP_STARTING_PRAZO_MS"], PRAZO_STARTING_MS),
    intervaloMs: inteiroPositivo(env["WHATSAPP_STARTING_INTERVALO_MS"], INTERVALO_ENTRE_RESTARTS_MS),
    limite: inteiroPositivo(env["WHATSAPP_STARTING_LIMITE"], LIMITE_DE_RESTARTS),
  };
}

/**
 * O status já dura mais que o prazo?
 *
 * `null`/`undefined` (quem não leu o carimbo) NUNCA é "preso": quem não sabe a
 * idade não acusa. É a mesma regra de `CanalParaAvaliar.last_status_change_at`
 * em `canal-mudo.ts`, e o que mantém um boot normal em silêncio.
 */
export function startingPresoHa(
  msNoStatus: number | null | undefined,
  prazoMs: number = PRAZO_STARTING_MS,
): boolean {
  if (msNoStatus === null || msNoStatus === undefined) return false;
  if (!Number.isFinite(msNoStatus) || msNoStatus < 0) return false;
  return msNoStatus >= prazoMs;
}

/** O contador do vigia, como ele mora em `metadata` e como o aviso o lê. */
export interface EstadoDoVigiaDeStarting {
  tentativas: number;
  /** Instante (epoch ms) do último restart pedido, ou `null` se ainda não houve. */
  ultimoRestartEm: number | null;
  /** O limite já estourou — o aviso crítico já foi aberto para este episódio. */
  esgotado: boolean;
}

export const ESTADO_INICIAL_DO_VIGIA: EstadoDoVigiaDeStarting = {
  tentativas: 0,
  ultimoRestartEm: null,
  esgotado: false,
};

/**
 * Lê o contador de uma linha de `channel_sessions`.
 *
 * Tolerante de propósito: `metadata` é um blob compartilhado com `ai_gate`,
 * `pre_go_live` e companhia, e um valor estranho na nossa chave não pode virar
 * restart em laço. O que não se entende vira o estado inicial (inclusive
 * `tentativas` fracionário ou negativo).
 */
export function lerEstadoDoVigia(metadata: unknown): EstadoDoVigiaDeStarting {
  if (metadata === null || typeof metadata !== "object") return { ...ESTADO_INICIAL_DO_VIGIA };
  const cru = (metadata as Record<string, unknown>)[CHAVE_DO_VIGIA_DE_STARTING];
  if (cru === null || typeof cru !== "object") return { ...ESTADO_INICIAL_DO_VIGIA };
  const bruto = cru as Record<string, unknown>;
  const tentativas = Number(bruto["tentativas"]);
  const ultimo = bruto["ultimo_restart_em"];
  const ultimoMs = typeof ultimo === "string" ? Date.parse(ultimo) : Number(ultimo);
  return {
    tentativas: Number.isInteger(tentativas) && tentativas > 0 ? tentativas : 0,
    ultimoRestartEm: Number.isFinite(ultimoMs) ? ultimoMs : null,
    esgotado: bruto["esgotado"] === true,
  };
}

/** O vigia já gastou as tentativas deste episódio? (é o que o aviso lê) */
export function restartsEsgotados(metadata: unknown): boolean {
  return lerEstadoDoVigia(metadata).esgotado;
}

/** A linha já passou por um episódio de `STARTING` preso? (é o que se limpa na volta) */
export function temEstadoDoVigia(metadata: unknown): boolean {
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    Object.prototype.hasOwnProperty.call(metadata, CHAVE_DO_VIGIA_DE_STARTING)
  );
}

/**
 * O contador como vai para `metadata`, na forma que `lerEstadoDoVigia` entende.
 * O instante vai em ISO porque é o que sobrevive a um dump e ao olho humano.
 */
export function estadoParaMetadata(estado: EstadoDoVigiaDeStarting): Record<string, unknown> {
  return {
    ...estado,
    ultimo_restart_em:
      estado.ultimoRestartEm === null ? null : new Date(estado.ultimoRestartEm).toISOString(),
  };
}

export type DecisaoDoStartingPreso =
  | {
      acao: "aguardar";
      motivo: "fora_do_starting" | "sem_relogio" | "dentro_do_prazo" | "intervalo" | "esgotado";
    }
  /** Chamar o restart AGORA; `tentativas` já é o número desta tentativa. */
  | { acao: "reiniciar"; tentativas: number }
  /** Parar de tentar e avisar. `avisarAgora` falso = o aviso já foi aberto. */
  | { acao: "esgotado"; tentativas: number; avisarAgora: boolean };

export interface EntradaDaDecisao {
  status: string;
  /** Idade do status no espelho, em ms (`null` = não leu o carimbo). */
  msNoStatus: number | null;
  estado: EstadoDoVigiaDeStarting;
  agoraMs: number;
  limites?: LimitesDoStartingPreso;
}

/**
 * A decisão para UMA sessão, num instante.
 *
 * A ordem das guardas é a regra:
 *
 *   1. fora de `STARTING` não se toca — é aqui que `WORKING` (conectada) fica
 *      imune: nenhum caminho deste arquivo reinicia sessão no ar;
 *   2. sem carimbo, não acusa;
 *   3. dentro do prazo, ainda é boot;
 *   4. limite já estourado: espera o intervalo da última tentativa ANTES de
 *      declarar — senão o aviso sairia no minuto seguinte ao terceiro restart,
 *      sem ter dado à sessão o mesmo tempo de boot que as outras ganharam;
 *   5. limite atingido com a janela cumprida: esgotou (avisa uma vez);
 *   6. intervalo entre tentativas ainda não venceu: espera;
 *   7. senão, reinicia.
 */
export function decidirStartingPreso(entrada: EntradaDaDecisao): DecisaoDoStartingPreso {
  const limites = entrada.limites ?? limitesDoStartingPreso();
  const status = (entrada.status ?? "").toUpperCase();

  if (status !== "STARTING") return { acao: "aguardar", motivo: "fora_do_starting" };
  if (entrada.msNoStatus === null) return { acao: "aguardar", motivo: "sem_relogio" };
  if (!startingPresoHa(entrada.msNoStatus, limites.prazoMs)) {
    return { acao: "aguardar", motivo: "dentro_do_prazo" };
  }

  const desdeUltimo =
    entrada.estado.ultimoRestartEm === null ? null : entrada.agoraMs - entrada.estado.ultimoRestartEm;
  const janelaCumprida = desdeUltimo === null || desdeUltimo >= limites.intervaloMs;

  if (entrada.estado.tentativas >= limites.limite) {
    if (!janelaCumprida) return { acao: "aguardar", motivo: "intervalo" };
    return {
      acao: "esgotado",
      tentativas: entrada.estado.tentativas,
      avisarAgora: !entrada.estado.esgotado,
    };
  }

  if (!janelaCumprida) return { acao: "aguardar", motivo: "intervalo" };
  return { acao: "reiniciar", tentativas: entrada.estado.tentativas + 1 };
}
