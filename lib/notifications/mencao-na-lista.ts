/**
 * As conversas com menção PENDENTE na lista (#2372).
 *
 * ─── Por que esta marca existe ─────────────────────────────────────────────
 * O sino e o push já diziam "Você foi mencionado"; a lista de conversas, que é
 * onde a pessoa trabalha, não dizia ONDE. Quem recebia o aviso tinha de lembrar
 * em qual cliente foi citado — e o aviso do sino some quando a pessoa o dispensa.
 *
 * ─── Por que não há tabela atrás disto ─────────────────────────────────────
 * A pergunta que a lista responde é "chegou menção para mim nesta sessão?". Não
 * é um estado do banco, é o MESMO ciclo de vida do aviso do sino: o listener de
 * INSERT em `conversation_notes` (`hooks/notifications/useCrmAlerts.ts`) é quem
 * sabe, e o sino já é só de sessão. Gravar em coluna exigiria migration,
 * `read_at` por pessoa e um backfill para decidir o que é "não lido" — três
 * coisas novas para responder o que a sessão já sabe. O que fica gravado é a
 * NOTIFICAÇÃO (evento `user.mentioned`); a marca da lista é a leitura dela.
 *
 * Abrir a conversa desmarca; trocar de organização ou de pessoa limpa tudo
 * (a marca vale para o par org+pessoa que a produziu).
 *
 * Estado de módulo, e não contexto React, porque quem PRODUZ a marca é o
 * listener do AppShell e quem CONSOME é a lista, em ramos diferentes da árvore.
 * A leitura é `useSyncExternalStore` (`hooks/inbox/useConversasComMencao.ts`):
 * o snapshot só troca de identidade quando a marca muda, então a lista não
 * re-renderiza à toa.
 */
type Ouvinte = () => void;

const ouvintes = new Set<Ouvinte>();
let marcadas: ReadonlySet<string> = new Set();

/** O snapshot atual — identidade estável entre mudanças. */
export function conversasComMencao(): ReadonlySet<string> {
  return marcadas;
}

/** Quem quer saber de mudanças (a lista). Devolve o cancelamento. */
export function inscreverNaListaDeMencoes(ouvinte: Ouvinte): () => void {
  ouvintes.add(ouvinte);
  return () => {
    ouvintes.delete(ouvinte);
  };
}

function avisar(): void {
  // Cópia: um ouvinte que se cancela durante o aviso não pula o próximo.
  for (const ouvinte of [...ouvintes]) ouvinte();
}

/** A conversa da nota que citou esta pessoa entra na lista marcada. */
export function marcarConversaMencionada(conversationId: string): void {
  const id = conversationId.trim();
  if (!id || marcadas.has(id)) return;
  marcadas = new Set([...marcadas, id]);
  avisar();
}

/** Abrir a conversa consome a marca dela — e só a dela. */
export function desmarcarConversaMencionada(conversationId: string): void {
  const id = conversationId.trim();
  if (!marcadas.has(id)) return;
  const proximas = new Set(marcadas);
  proximas.delete(id);
  marcadas = proximas;
  avisar();
}

/** Troca de organização ou de pessoa: a marca de uma não vale para a outra. */
export function limparMencoesDaLista(): void {
  if (marcadas.size === 0) return;
  marcadas = new Set();
  avisar();
}
