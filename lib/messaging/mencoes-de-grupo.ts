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
 *  - menção a quem está no CRM mostra o nome;
 *  - menção a desconhecido continua mostrando o número — não inventamos nome
 *    nem apagamos a informação que o texto já tinha;
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
 * O texto que a bolha mostra: o corpo ORIGINAL com cada `@<lid>` conhecido
 * trocado por `@<nome>`. O corpo gravado não muda — esta função é de leitura.
 *
 * Uma passada só, com o mapa montado por LID. Trocar nome por nome (ou por
 * posição na lista) é o que faria duas pessoas chamadas "João" trocarem de
 * lugar, e um nome que veio com `@`/dígitos ser reprocessado.
 *
 * Menção cujo `name` é `null` (desconhecido no CRM, ou contato sem nome) fica
 * como veio: o número que já estava no texto é a informação disponível.
 */
export function textoComMencoesResolvidas(
  body: string | null,
  mencoes: readonly RemetenteDeGrupo[],
): string | null {
  if (body === null || mencoes.length === 0) return body;
  const nomePorLid = new Map<string, string>();
  for (const m of mencoes) {
    if (m.lid !== null && m.name !== null && m.name !== "") nomePorLid.set(m.lid, m.name);
  }
  // Nada resolvido: devolve o MESMO texto, sem passar pelo replace (o controle
  // "sem menção sai byte a byte igual" vale também aqui).
  if (nomePorLid.size === 0) return body;
  return body.replace(MENCAO_NO_TEXTO, (trecho, lid: string) => {
    const nome = nomePorLid.get(lid);
    return nome === undefined ? trecho : `@${nome}`;
  });
}
