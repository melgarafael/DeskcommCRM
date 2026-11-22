"use server";

/**
 * GRAVAR O ÚLTIMO FILTRO DE RESPONSÁVEL ESCOLHIDO NA TELA DE TAREFAS (#4737,
 * parte 1).
 *
 * A tela nasceu com `?assigned_to=me` no endereço e o seletor apenas no estado
 * do componente: entrar pelo menu, recarregar ou abrir noutro aparelho voltava
 * para "Todos". Aqui é a metade que faz a escolha sobreviver — no
 * `raw_user_meta_data` de quem escolheu, exatamente como a camada de datas da
 * Agenda (`definirCamadaDatasDosNegocios`) e os lembretes de tarefa.
 *
 * ─── Por que a pessoa grava a própria, e por que isso basta ────────────────
 *
 * O objeto é sempre o metadata de quem chama (`auth.updateUser`), então não há
 * caminho para escrever em outra pessoa — e quem é só leitura também não
 * escreve, pelo mesmo portão de suporte das outras actions.
 *
 * `updateUser` faz merge por chave de TOPO: nome, idioma, avatar, a camada da
 * Agenda e as outras preferências não são tocados.
 *
 * Sem `audit`: é preferência de TELA, sem efeito sobre dado de ninguém, e cada
 * troca de filtro geraria um evento — encheria o histórico de ruído que não
 * audita nada. A MESMA decisão da action da camada de datas.
 */
import { z } from "zod";

import { invalidarUsuario } from "@/lib/auth/cache-curto";
import { loadAuthUser } from "@/lib/auth/server";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { CHAVE_DO_FILTRO_DAS_TAREFAS } from "@/lib/tarefas/preferencia-do-filtro";

/**
 * O que a tela pode gravar: as três escolhas fixas e o id de um membro. A
 * action não decide o que a pessoa vê (isso é da RLS de `crm_tasks`); ela
 * recusa lixo, e a leitura saneia o resto (`lerFiltroDoResponsavel`).
 */
const filtroSchema = z.union([
  z.literal("todos"),
  z.literal("eu"),
  z.literal("ninguem"),
  z.string().uuid(),
]);

/** Códigos, e não frases: a tela traduz (pt-BR/es). */
export type ErroDoFiltroDasTarefas = "sessao" | "somente_leitura" | "validacao" | "falha";

export type RespostaDoFiltroDasTarefas =
  | { ok: true; filtro: string }
  | { ok: false; erro: ErroDoFiltroDasTarefas };

export async function definirFiltroDasTarefas(
  entrada: string,
): Promise<RespostaDoFiltroDasTarefas> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const parsed = filtroSchema.safeParse(entrada);
  if (!parsed.success) return { ok: false, erro: "validacao" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "sessao" };
  if (supportWriteError(user.support)) return { ok: false, erro: "somente_leitura" };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({
    data: { [CHAVE_DO_FILTRO_DAS_TAREFAS]: parsed.data },
  });
  // O `getUser` vai para o cache curto: sem invalidar, o próximo render do RSC
  // leria o metadata velho e a tela voltaria ao filtro anterior.
  invalidarUsuario(user.id);
  if (error) {
    logger.error("[filtro-das-tarefas] updateUser falhou", {
      user_id: user.id,
      error: error.message,
    });
    return { ok: false, erro: "falha" };
  }

  // Sem `revalidatePath`: a página de Tarefas é `force-dynamic` e o próximo
  // carregamento lê o metadata invalidado acima.
  return { ok: true, filtro: parsed.data };
}
