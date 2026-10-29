"use server";

/**
 * GRAVAR E LER A LATERAL DO INBOX DE CADA PESSOA (#3008) — as duas metades.
 *
 * A preferência mora no `raw_user_meta_data` do próprio usuário, e não numa
 * tabela: é a MESMA casa das outras escolhas que a pessoa faz sobre o próprio
 * produto (`lembretes_de_tarefa` do #2529, `locale` e `timezone` do perfil).
 * Cada uma grava a dela com a própria sessão (`updateUser`), ninguém lê a de
 * ninguém, e não há migration — nem RLS nova, nem GRANT novo.
 *
 * `updateUser` faz merge por chave de TOPO: o resto do metadata (nome, idioma,
 * avatar, lembretes) não é tocado. O que se regrava inteiro é o valor desta
 * chave — a lista completa, já normalizada por `normalizarModulos`, porque a
 * lista é a única fonte da ordem e um recorte parcial voltaria a esconder
 * módulos que a pessoa não desligou.
 */

import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser } from "@/lib/auth/server";
import { supportWriteError } from "@/lib/impersonate/support";
import {
  CHAVE_DOS_MODULOS,
  lerModulosDaLateral,
  modulosDaLateralSchema,
  normalizarModulos,
  type ModuloDaLateral,
} from "@/lib/inbox/modulos-da-lateral";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

/**
 * Códigos, e não frases: a tela traduz (pt-BR/es) — a mesma régua das outras
 * actions de configuração.
 */
export type ErroDosModulosDaLateral = "sessao" | "somente_leitura" | "validacao" | "falha";

export type RespostaDosModulosDaLateral =
  | { ok: true; modulos: ModuloDaLateral[] }
  | { ok: false; erro: ErroDosModulosDaLateral };

export async function salvarModulosDaLateral(
  input: ModuloDaLateral[],
): Promise<RespostaDosModulosDaLateral> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao
  // servidor, e o que se grava aqui é lido em toda carga do Inbox.
  const parsed = modulosDaLateralSchema.safeParse(input);
  if (!parsed.success) return { ok: false, erro: "validacao" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, erro: "sessao" };
  if (supportWriteError(authUser.support)) return { ok: false, erro: "somente_leitura" };

  // Normaliza ANTES de gravar: a mesma régua da leitura. Assim o metadata
  // guarda sempre a lista completa, com os ids que faltaram no fim — e um
  // cliente que mande só os visíveis não apaga a ordem dos escondidos.
  const modulos = normalizarModulos(parsed.data);

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({
    data: { [CHAVE_DOS_MODULOS]: modulos },
  });
  if (error) {
    logger.error("[inbox-modulos] updateUser falhou", {
      user_id: authUser.id,
      error: error.message,
    });
    return { ok: false, erro: "falha" };
  }

  await audit({
    action: "user.inbox_modules_updated",
    actorUserId: authUser.id,
    organizationId: null,
    resourceType: "user",
    resourceId: authUser.id,
    // A ORDEM e a VISIBILIDADE, não o metadata inteiro: são elas que respondem
    // "por que a tela desta pessoa parece diferente" sem arrastar nome, idioma
    // nem telefone para o histórico legível por quem administra a instalação.
    metadata: {
      visiveis: modulos.filter((m) => m.visivel).map((m) => m.id),
      escondidos: modulos.filter((m) => !m.visivel).map((m) => m.id),
      ordem: modulos.map((m) => m.id),
    },
  });

  revalidatePath("/app/inbox");
  // Devolve o que foi GRAVADO (normalizado), não o que chegou: a tela passa a
  // mostrar a mesma lista que a próxima carga vai trazer.
  return { ok: true, modulos };
}

/**
 * O que a lateral desenha ao abrir — a preferência gravada, já normalizada.
 *
 * Lê com a sessão da pessoa (`getUser`), e não com `service_role`: a
 * preferência é dela, e a RLS do próprio auth basta. Sem sessão devolve o
 * padrão, como `carregarTaskReminderPrefs` faz — a tela precisa desenhar
 * alguma coisa, e o padrão é a lateral de hoje.
 */
export async function carregarModulosDaLateral(): Promise<{
  ok: boolean;
  modulos: ModuloDaLateral[];
}> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, modulos: lerModulosDaLateral(undefined) };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    // Falha de leitura NÃO vira lista vazia nem lista torta: o padrão. A tela
    // continua sendo a de hoje, e o próximo clique em Salvar regrava.
    logger.warn("[inbox-modulos] getUser falhou ao ler a preferência — usando o padrão", {
      user_id: authUser.id,
      error: error.message,
    });
    return { ok: false, modulos: lerModulosDaLateral(undefined) };
  }
  return { ok: true, modulos: lerModulosDaLateral(data.user?.user_metadata ?? undefined) };
}
