/**
 * As MENÇÕES de uma mensagem de grupo (`messages.metadata.mentions`).
 *
 * ─── O defeito que este arquivo fecha (#3566) ────────────────────────────────
 *
 * Em grupo, o WhatsApp escreve a menção no texto como o identificador opaco do
 * participante — `@75235009282237` —, e não como o nome que o celular mostra.
 * A mensagem chegava ao CRM com o código na tela porque ninguém lia a lista de
 * quem foi mencionado: `metadata.group_sender` já dizia quem ESCREVEU, e a lista
 * de menções simplesmente não era guardada. Quem foi mencionado se perdia na
 * entrada, e nenhuma tela podia recuperar depois.
 *
 * ─── O desenho, e por que ele não tem régua própria ─────────────────────────
 *
 * O ingest grava `mentions: [{ lid, phone, name }]` — o MESMO formato do
 * `group_sender` (`lib/messaging/remetente-de-grupo.ts`), lido pelo MESMO leitor
 * de JID (`identidadeDoParticipante`, no ingest do transporte). `name` é o nome
 * do contato no CRM quando ele existe; `null` quando não existe.
 *
 * O TEXTO CRU NÃO É TOCADO: `messages.body` continua com `@<lid>`, e é a
 * exibição que resolve (`textoComMencoesResolvidas`). Isso mantém o dado
 * original auditável e deixa a resolução ser refeita um dia sem migration.
 *
 * ─── Regras que a exibição tem de cumprir (cada uma com teste) ───────────────
 *
 *  - menção a quem está no CRM mostra o nome do contato;
 *  - menção a quem NÃO está no CRM sai com a palavra do dicionário
 *    ("Participante"): o número bruto NUNCA aparece na tela (era o defeito
 *    relatado na issue). O payload do WhatsApp não traz o nome de quem foi
 *    mencionado, e o `metadata.group_sender` é o AUTOR da mensagem — usar o
 *    nome dele como rótulo da menção atribuiria a menção à pessoa errada
 *    ("@João e @João" para duas pessoas que o João marcou);
 *  - a troca é por LID, numa passada só: menção repetida resolve CADA ocorrência
 *    pelo próprio identificador. Dois contatos chamados "João" não trocam de
 *    lugar, e um nome que contenha `@` ou dígitos não é reprocessado;
 *  - mensagem sem menção sai idêntica, byte a byte.
 */
import { remetenteDeGrupoSchema, type RemetenteDeGrupo } from "@/lib/messaging/remetente-de-grupo";

/**
 * A chave em `messages.metadata`. `mentions` (e não `mencoes`) porque é o nome
 * que o autor da issue leu no banco e o que uma consulta manual vai procurar.
 */
export const CHAVE_DAS_MENCOES = "mentions";

/**
 * O que a exibição tem de resolver: um identificador de participante dentro do
 * texto. Mesma faixa de `LID_DE_REMETENTE` (no ingest do transporte): o
 * WhatsApp usa ids longos, e um `@` seguido de 5 a 40 dígitos é a forma com que
 * a menção chega. Fora dessa faixa nada é tocado — arroba de e-mail, `@todos`, texto
 * comum.
 */
const MENCAO_NO_TEXTO = /@(\d{5,40})/g;

/**
 * A lista de menções de uma mensagem, já validada. Item fora do contrato é
 * descartado um a um: uma menção malformada não pode derrubar a leitura das
 * outras (mesma doutrina do `group_sender`).
 */
export function lerMencoesDeGrupo(metadata: unknown): RemetenteDeGrupo[] {
  if (!metadata || typeof metadata !== "object") return [];
  const bruto = (metadata as Record<string, unknown>)[CHAVE_DAS_MENCOES];
  if (!Array.isArray(bruto)) return [];
  const mencoes: RemetenteDeGrupo[] = [];
  for (const item of bruto) {
    const r = remetenteDeGrupoSchema.safeParse(item);
    if (r.success) mencoes.push(r.data);
  }
  return mencoes;
}

/**
 * A palavra que substitui a menção quando o mencionado não é contato do CRM.
 * O número bruto nunca vai à tela
 * (era o defeito da issue); a chave é a mesma no dicionário (`lib/i18n`), e a
 * tela passa a versão traduzida por `t()`.
 */
export const PALAVRA_DE_MENCAO_DESCONHECIDA = "Participante";

/**
 * O que a exibição sabe ALÉM da lista de menções: a palavra de reserva
 * traduzida. Opcional porque o ingest (que monta a prévia da lista) não conhece
 * idioma de tela; a bolha passa a versão de `t()`.
 *
 * NÃO há degrau com o nome do `group_sender`: ele é quem ESCREVEU a mensagem,
 * não quem foi mencionado, e o payload não traz nome por menção.
 */
export type ReservaDaMencao = {
  palavraDesconhecida?: string;
};

/**
 * A ordem de resolução de UMA menção, e ela é curta de propósito:
 *
 *   1. `name` da própria menção — é o contato do CRM, resolvido no ingest;
 *   2. `palavraDesconhecida` — a palavra do dicionário.
 *
 * O passo 2 é o que faltava: antes, quem não estava no CRM via o LID cru na
 * tela, que é o defeito relatado. Nunca devolve dígitos.
 */
function rotuloDaMencao(m: RemetenteDeGrupo, reserva: ReservaDaMencao): string {
  const doContato = m.name?.trim();
  if (doContato) return doContato;
  return reserva.palavraDesconhecida?.trim() || PALAVRA_DE_MENCAO_DESCONHECIDA;
}

/**
 * O texto que a bolha mostra: o corpo ORIGINAL com cada `@<lid>` conhecido
 * trocado por `@<nome>`. O corpo gravado não muda — esta função é de leitura.
 *
 * Uma passada só, com o mapa montado por LID. Trocar nome por nome (ou por
 * posição na lista) é o que faria duas pessoas chamadas "João" trocarem de
 * lugar, e um nome que veio com `@`/dígitos ser reprocessado.
 *
 * Só o que está na LISTA de menções é tocado: `@` de e-mail, `@todos` e um
 * número solto no texto continuam como vieram. Mensagem antiga, sem a chave no
 * metadata, sai byte a byte igual.
 *
 * `@<telefone>` (menção que chegou como número, não como LID) resolve pelo
 * telefone da menção, pela mesma ordem.
 */
export function textoComMencoesResolvidas(
  body: string | null,
  mencoes: readonly RemetenteDeGrupo[],
  reserva: ReservaDaMencao = {},
): string | null {
  if (body === null || mencoes.length === 0) return body;
  const nomePorIdentificador = new Map<string, string>();
  for (const m of mencoes) {
    const nome = rotuloDaMencao(m, reserva);
    if (m.lid !== null) nomePorIdentificador.set(m.lid, nome);
    const digitosDoTelefone = m.phone?.replace(/\D/g, "");
    if (digitosDoTelefone) nomePorIdentificador.set(digitosDoTelefone, nome);
  }
  // Nada na lista: devolve o MESMO texto, sem passar pelo replace (o controle
  // "sem menção sai byte a byte igual" vale também aqui).
  if (nomePorIdentificador.size === 0) return body;
  return body.replace(MENCAO_NO_TEXTO, (trecho, lid: string) => {
    const nome = nomePorIdentificador.get(lid);
    return nome === undefined ? trecho : `@${nome}`;
  });
}
