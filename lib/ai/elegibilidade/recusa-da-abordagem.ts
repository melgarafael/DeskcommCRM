/**
 * A RECUSA DO CANAL VIRA FRASE DE GENTE NA BORDA (#4170).
 *
 * ─── O defeito medido ───────────────────────────────────────────────────────
 *
 * A Prospecção pausava com `O canal ainda não permite esta abordagem:
 * fora_da_lista_de_teste.` — o código da constraint, cru, na cara de quem
 * tentou trabalhar. Ele não diz o que o produto está fazendo (todo canal nasce
 * em pré-go-live com a lista de teste vazia) nem o que fazer para sair disso
 * (liberar o número ao público em Conexões). Quem lê conclui "o produto está
 * quebrado" quando ele está funcionando exatamente como projetado.
 *
 * ─── Por que a tradução mora AQUI, e não na tela ────────────────────────────
 *
 * Quem decide a recusa é a borda (`lib/prospecting/worker.ts`, sobre
 * `decidirPreGoLiveDoCanalViaSupabase`). Traduzir na tela espalharia o
 * vocabulário do banco por cada consumidor — e o próximo consumidor nasce sem
 * tradução, que é como o defeito nasceu. Aqui o código entra, a frase humana
 * sai; o código CRU continua no log/telemetria de quem investiga, e não no
 * texto que a pessoa lê.
 *
 * ─── O que a frase NÃO promete ──────────────────────────────────────────────
 *
 * Ela não diz que a empresa está bloqueada, nem que o canal está com defeito:
 * diz que o número está em modo de teste e onde liberar. É a diferença entre
 * "seu número não está autorizado" (que ensina a mexer no que não está
 * quebrado) e "este número está em modo de teste, e é assim que ele sai dele".
 */
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import type { DecisaoPreGoLive } from "./consulta-pre-go-live";

/**
 * Os motivos de recusa que o pré-go-live sabe produzir, lidos do TIPO da
 * decisão. Motivo novo em `consulta-pre-go-live.ts` sem frase aqui para de
 * compilar — o `satisfies` abaixo é a catraca.
 */
export type MotivoDaRecusaDaAbordagem = Extract<DecisaoPreGoLive, { permite: false }>["motivo"];

export const MOTIVOS_DA_RECUSA_DA_ABORDAGEM = [
  "fora_da_lista_de_teste",
] as const satisfies readonly MotivoDaRecusaDaAbordagem[];

/**
 * A frase que a campanha pausada mostra. Diz o ESTADO (modo de teste), o que
 * ele significa na prática e o CAMINHO da solução, em três passos que existem
 * na tela de Conexões (`components/connections/ChannelAiAccess.tsx`).
 */
export const FRASE_DA_RECUSA_DA_ABORDAGEM = {
  fora_da_lista_de_teste:
    "Este número de WhatsApp está em modo de teste: a IA só conversa com os números da lista de teste, e a empresa que a prospecção tentou abordar não está nela. Para liberar o número ao público, abra Conexões › cartão do número › Configurar acesso da IA › Liberar atendimento ao público.",
} satisfies Record<MotivoDaRecusaDaAbordagem, string>;

/**
 * A frase de um motivo que este módulo ainda não conhece. Não repete o código —
 * é justamente o código que não pode chegar à tela — e continua apontando o
 * caminho, que é o mesmo para qualquer recusa do pré-go-live.
 */
const FRASE_GENERICA =
  "O canal recusou a abordagem e a campanha foi pausada para não repetir o mesmo erro. Confira o acesso da IA ao número em Conexões › cartão do número › Configurar acesso da IA.";

/**
 * O código cru → a frase que a pessoa lê, no idioma da instalação.
 *
 * `motivo` é `string` de propósito: o que vem do banco não é confiável, e um
 * valor desconhecido tem de cair na frase genérica em vez de vazar.
 */
export function fraseDaRecusaDaAbordagem(motivo: string, idioma: Idioma): string {
  const propria = (FRASE_DA_RECUSA_DA_ABORDAGEM as Readonly<Record<string, string | undefined>>)[motivo];
  return traduzir(propria ?? FRASE_GENERICA, idioma);
}
