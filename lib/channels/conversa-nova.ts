/**
 * Os canais que o seletor da CONVERSA NOVA pode oferecer (issue #2382).
 *
 * ─── Por que isto mora em `lib/channels/` ───────────────────────────────────
 * O seletor mostra o TIPO do canal ("Meta Cloud API", "WAHA (QR Code)"), e a
 * doutrina `docs/doctrine/restricao-de-canal.md` (invariante 1) proíbe qualquer
 * nome de provider fora desta pasta. O rótulo nasce aqui e só ele atravessa a
 * fronteira: a tela pergunta "que tipo é?", nunca "com quem falo?".
 *
 * ─── Duas peneiras, e por que são duas ──────────────────────────────────────
 * `candidatosParaConversaNova` decide quem APARECE:
 *
 *   - canal de MENSAGEM (a linha de voz da spec 18 não manda texto);
 *   - com TELEFONE gravado, porque esta porta inicia a conversa por telefone:
 *     rede social não tem telefone e só responde a quem escreveu primeiro. É a
 *     mesma régua de `lib/inbox/outros-numeros.ts`, e testa o telefone, não o
 *     provider;
 *   - não arquivado (mesma régua de `lib/channels/selectable.ts` — o invariante
 *     `canais-selecionaveis` nasceu justamente de três seletores que liam
 *     `channel_sessions` à mão e ofereciam canal já excluído);
 *   - não DESATIVADO pelo operador (`metadata.disabled`, #2318) — quem desligou
 *     o canal de propósito não quer vê-lo como saída de uma conversa nova;
 *   - não é linha de seed do e2e (mesma lista que o vigia de saúde ignora).
 *
 * `elegiveisParaConversaNova` decide quem, entre os que aparecem, PODE SER
 * ESCOLHIDO. A régua é `lerEstadoDoCanal(...).utilizavel` — a MESMA resposta que
 * o resto do produto dá para "dá para usar este número agora?", e não um novo
 * `if (status === "WORKING")` por tela. Um canal fora do ar APARECE com o seu
 * estado e fica marcado como não escolhível: quem lê vê POR QUE não dá, e o
 * critério "canais indisponíveis não podem ser escolhidos" fica visível, não
 * apenas obedecido.
 *
 * ─── Com zero ou um canal elegível ninguém precisa escolher ─────────────────
 * Um elegível: o fluxo segue direto, já com aquele canal gravado na conversa.
 * Zero elegíveis: o fluxo TAMBÉM segue — sem escolha, quem decide é o servidor
 * (`sessaoProntaParaEnvio`), como antes desta issue. Travar o atendimento por
 * causa de um seletor vazio seria trocar um defeito por outro.
 */
import { transportaMensagem } from "./capabilities";
import { canalDesativado } from "./desativado";
import { lerEstadoDoCanal } from "./estado";
import { ehNomeDeSessaoE2E } from "./sessoes-e2e";

/**
 * O recorte mínimo que estas funções leem de `channel_sessions`.
 *
 * Todos os campos exceto `id` são opcionais de propósito: quem chama pode
 * passar a linha crua da API (sem `provider` num banco novo) e a resposta é
 * "não oferece", que é o erro barato — o caro é oferecer um canal que não
 * manda mensagem.
 */
export interface CanalObservado {
  id: string;
  provider?: string | null;
  status?: string | null;
  waha_session_name?: string | null;
  metadata?: Record<string, unknown> | null;
  phone_number?: string | null;
  /** Coluna só existe após a migration 0106; ausente = não arquivado. */
  archived_at?: string | null;
}

/** Quem APARECE no seletor da conversa nova. Lista vazia é resposta válida. */
export function candidatosParaConversaNova<T extends CanalObservado>(
  canais: readonly T[] | undefined | null,
): T[] {
  if (!Array.isArray(canais)) return [];
  return canais.filter(
    (c) =>
      transportaMensagem(c.provider) &&
      !!c.phone_number &&
      !c.archived_at &&
      !canalDesativado(c.metadata ?? null) &&
      !ehNomeDeSessaoE2E(c.waha_session_name ?? null),
  );
}

/** Quem, entre os candidatos, pode SER ESCOLHIDO (estado utilizável). */
export function elegiveisParaConversaNova<T extends CanalObservado>(
  candidatos: readonly T[],
): T[] {
  return candidatos.filter((c) => lerEstadoDoCanal(c.status).utilizavel);
}

/**
 * Como o TIPO do canal se chama na tela — o "tipo/provedor" que a issue #2382
 * pede no seletor (Meta Cloud API, WAHA/QR Code, etc.).
 *
 * Sai como `string | null`: `null` para provider que este build não conhece (um
 * clone que atualizou o schema antes da imagem) — a opção continua aparecendo,
 * com nome e número, só sem o tipo. Inventar um tipo para o desconhecido seria
 * mentir na mesma tela que a issue quer tornar honesta.
 *
 * Os valores são nomes de marca, iguais em todo idioma: por isso esta função
 * NÃO recebe o `t()`. Traduzi-las adicionaria entrada de dicionário para texto
 * que não muda entre idiomas.
 */
const ROTULO_DO_TIPO: Record<string, string> = {
  waha: "WAHA (QR Code)",
  meta_cloud: "Meta Cloud API",
  zernio: "Zernio",
  datafy: "Datafy",
};

export function rotuloDoTipoDeCanal(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return ROTULO_DO_TIPO[provider] ?? null;
}
