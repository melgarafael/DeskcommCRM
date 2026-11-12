"use server";

/**
 * GRAVAR A ESCOLHA DA CAMADA "DATAS DOS NEGÓCIOS" (#4436, item 1).
 *
 * A camada nasceu com a escolha só no estado do componente — ligada/desligada,
 * funil, campo e campo-fim voltavam ao padrão a cada visita. Aqui é a metade
 * que a faz sobreviver: a pessoa grava a DELA, no `raw_user_meta_data`, sem
 * tabela nova e sem permissão de administrador (`lembretes_de_tarefa` e o
 * perfil usam o mesmo sítio, pelo mesmo motivo).
 *
 * ─── Por que a pessoa grava a própria, e por que isso basta ────────────────
 *
 * O objeto é sempre o metadata de quem chama (`auth.updateUser`), então não há
 * caminho para escrever em outra pessoa — e quem é só leitura também não
 * escreve, pelo mesmo portão de suporte das outras actions.
 *
 * O metadata é DADO ALHEIO na leitura: quem lê é `lerEscolhaDaCamada`, que
 * devolve o padrão para funil arquivado e campo que sumiu. Isso é o que impede
 * uma escolha gravada ontem de abrir a Agenda quebrada hoje.
 *
 * `updateUser` faz merge por chave de TOPO: nome, idioma, avatar e as outras
 * preferências não são tocados.
 */
import { invalidarUsuario } from "@/lib/auth/cache-curto";
import { loadAuthUser } from "@/lib/auth/server";
import { CHAVE_DA_CAMADA, type EscolhaDaCamada } from "@/lib/agenda/preferencia-da-camada";
import { escolhaDaCamadaSchema } from "@/lib/schemas/agenda";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

/**
 * Códigos, e não frases: a tela traduz (pt-BR/es) — a mesma régua das outras
 * actions de configuração.
 */
export type ErroDaEscolhaDaCamada = "sessao" | "somente_leitura" | "validacao" | "falha";

export type RespostaDaEscolhaDaCamada =
  { ok: true; escolha: EscolhaDaCamada } | { ok: false; erro: ErroDaEscolhaDaCamada };

export async function definirCamadaDatasDosNegocios(
  entrada: EscolhaDaCamada,
): Promise<RespostaDaEscolhaDaCamada> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const parsed = escolhaDaCamadaSchema.safeParse(entrada);
  if (!parsed.success) return { ok: false, erro: "validacao" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "sessao" };
  if (supportWriteError(user.support)) return { ok: false, erro: "somente_leitura" };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({
    data: { [CHAVE_DA_CAMADA]: parsed.data },
  });
  // #3696: o `getUser` vai para o cache curto; outra aba (ou o próximo render do
  // RSC da Agenda) leria o metadata velho e a camada voltaria desligada.
  invalidarUsuario(user.id);
  if (error) {
    logger.error("[camada-datas] updateUser falhou", {
      user_id: user.id,
      error: error.message,
    });
    return { ok: false, erro: "falha" };
  }

  // Sem `revalidatePath`: a Agenda é `force-dynamic` e o próximo carregamento lê
  // o metadata invalidado acima. Não há página cacheada com esta escolha dentro.
  //
  // Sem `audit` também, de propósito: é preferência de TELA, sem efeito sobre
  // dado de ninguém, e mudar de campo gera um evento por clique — encheria o
  // histórico legível por quem administra a instalação com ruído que não audita
  // nada.
  return { ok: true, escolha: parsed.data };
}
