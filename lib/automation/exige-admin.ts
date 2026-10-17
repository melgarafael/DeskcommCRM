/**
 * O PORTÃO DO `notify_team` — QUEM PODE GUARDAR ESTA AÇÃO NA REGRA (#2642).
 *
 * ─── O defeito que este módulo fecha ───────────────────────────────────────
 *
 * A tela de regras de automação abre para `manager`. A ação `notify_team`
 * endereça uma PESSOA DA EQUIPE e dispara um WhatsApp pelo número que só o
 * administrador cadastra em Avisos. Se um manager pudesse guardá-la, o portão
 * da tela de Avisos seria contornável por duas telas: ele aponta o membro, a
 * regra dispara, e o envio sai pelo número que ele não pode ver.
 *
 * ─── Como o portão é FEITO ─────────────────────────────────────────────────
 *
 * Duas portas, mesma régua:
 *
 *  1. o EDITOR esconde a opção (`webhooks.notify_team: admin` em
 *     `AuthProvider.tsx`) — e só isso é conforto, não é garantia;
 *  2. a ROTA pergunta ao `requireRole` pelo nível que a lista pede. Ela NÃO
 *     compara `ROLE_RANK` na mão (anti-padrão: a matriz é advisory, e a rota
 *     errada a copia); ela CALCULA o mínimo e devolve para o gate canônico
 *     decidir. Quem burla o editor leva a recusa do `requireRole`, com a
 *     resposta 403 localizada que a rota já devolve.
 *
 * Este módulo é PURO de propósito: `raw` é corpo NÃO validado que a rota lê
 * antes do schema rodar, então a função tem de aguentar qualquer coisa —
 * string, array torto, objeto nulo — sem lançar. Lançar aqui seria um 500 no
 * corpo de um administrador comum, que é o único erro que não pode ser
 * explicado ao usuário.
 */
import type { Role } from "@/lib/auth/types";

/**
 * A lista de ações, como veio do corpo, sem confiar em forma nenhuma.
 *
 * Não é `z.array(actionSchema)`: o schema ainda não rodou. Isto é uma leitura
 * defensiva do JSON — por isso `unknown` de ponta a ponta.
 */
function listaDeAcoes(bruto: unknown): Array<{ type?: unknown }> {
  if (!Array.isArray(bruto)) return [];
  return bruto.filter((a): a is { type?: unknown } => typeof a === "object" && a !== null);
}

/** O tipo de ação que exige `admin`. Só existe um hoje (#2642). */
const TIPOS_QUE_EXIGEM_ADMIN = new Set(["notify_team"]);

/**
 * `true` quando a lista guarda, em QUALQUER posição, uma ação que só o
 * administrador pode configurar.
 *
 * Qualquer posição importa: o editor permite N ações por regra, e uma única
 * `notify_team` no fim da lista já faz o envio sair pelo número da empresa.
 */
export function listaExigeAdmin(bruto: unknown): boolean {
  return listaDeAcoes(bruto).some((a) => typeof a.type === "string" && TIPOS_QUE_EXIGEM_ADMIN.has(a.type));
}

/**
 * O nível mínimo que a rota tem de exigir para ESTA lista.
 *
 * Devolve o `Role` e não o booleano de propósito: a rota passa o valor direto
 * para `requireRole(min, …)`, e o gate canônico é quem conhece a matriz de
 * papéis. Duas fontes de verdade para "admin é suficiente?" é como a rota
 * acaba reimplementando o `requireRole`.
 */
export function papelMinimoDaLista(bruto: unknown): Role {
  return listaExigeAdmin(bruto) ? "admin" : "manager";
}
