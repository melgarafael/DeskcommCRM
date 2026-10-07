/**
 * QUAIS PROVEDORES ESTA INSTALAÇÃO OFERECE — `PROVEDORES` menos o que está atrás
 * de módulo desligado.
 *
 * O login por assinatura (#1639) é o módulo `login_codex`, desligado por padrão
 * (doc 73: desligado, nada aparece para as empresas). A tela de Credenciais e o
 * leitor do login já respeitavam a chave; o painel de Provedores não: o GET
 * listava "OpenAI pela assinatura (ChatGPT)" para toda empresa, e o PUT/PATCH
 * gravavam a assinatura num ponto ou no padrão com o módulo fora.
 *
 * Mora fora de `./provedores` porque aquele arquivo é vocabulário puro, importado
 * por componentes de cliente; este lê o banco.
 *
 * Devolve um PREDICADO, e não a lista: quem lê (a lista da tela, as credenciais
 * que ela mostra) e quem escreve (o PUT do ponto, o PATCH do padrão) perguntam a
 * mesma coisa sobre um id, e a resposta vem de uma leitura só. Banco que não
 * respondeu = módulo desligado (falha fechada, como `modulosLigados`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { moduloLigado } from "@/lib/instalacao/modulos";

import { ehProvedorSuportado, IDS_DE_PROVEDOR, PROVEDOR_POR_ASSINATURA } from "./provedores";

/** A recusa de toda escrita que tenta gravar um provedor desligado (422 `provedor_desligado`). */
export const MENSAGEM_PROVEDOR_DESLIGADO =
  "a assinatura do ChatGPT está desligada nesta instalação — quem administra o servidor liga em Recursos opcionais";

export async function provedorOferecido(db: SupabaseClient): Promise<(id: string) => boolean> {
  const assinaturaLigada = await moduloLigado(db, "login_codex");
  return (id) =>
    ehProvedorSuportado(id) && (id !== PROVEDOR_POR_ASSINATURA || assinaturaLigada);
}

/** Os ids que a tela oferece — o servidor filtra, o componente de cliente só desenha. */
export async function idsDosProvedoresOferecidos(db: SupabaseClient): Promise<string[]> {
  const oferece = await provedorOferecido(db);
  return IDS_DE_PROVEDOR.filter(oferece);
}

/**
 * Para quem ESCREVE: o provedor está desligado nesta instalação? Só consulta o
 * banco quando o id é o da assinatura — as outras escritas não pagam a leitura.
 * O `db` precisa ser o cliente de serviço (`platform_config` não tem policy);
 * com outro, a leitura falha e a resposta é "desligado".
 */
export async function provedorDesligadoNaInstalacao(
  db: SupabaseClient,
  id: string | undefined,
): Promise<boolean> {
  if (id !== PROVEDOR_POR_ASSINATURA) return false;
  return !(await moduloLigado(db, "login_codex"));
}
