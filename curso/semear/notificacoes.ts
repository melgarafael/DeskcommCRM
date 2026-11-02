/**
 * Semente do módulo "Notificações": a tela não precisa de dado novo, só de
 * partir do padrão. A lição dos lembretes de tarefa grava a escolha da Helena
 * no metadata dela (`lembretes_de_tarefa`, ver app/actions/settings/updateTaskReminderPrefs.ts),
 * que a base não toca — então esta semente apaga essa chave antes de cada lição.
 * O que os avisos mostram fora do app mora em organizations.settings, que a base
 * já devolve ao estado de fábrica.
 */
import { type Contexto } from "../semear-demonstracao";

export async function semear(c: Contexto) {
  // o GoTrue mescla user_metadata por chave; null apaga só esta chave
  const r = await c.db.auth.admin.updateUserById(c.pessoa.helena, { user_metadata: { lembretes_de_tarefa: null } });
  if (r.error) throw new Error(`lembretes da Helena: ${r.error.message}`);
}
