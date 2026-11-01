/**
 * O que um aviso mostra com a tela do celular bloqueada, pela opção da empresa
 * (`organizations.settings.notificacoes.conteudo_na_tela_bloqueada`, schema em
 * `lib/schemas/settings.ts`).
 *
 * Puro e sem import de servidor: a mesma redação serve ao funil do push
 * (`./web_push.ts`) e à notificação local do app aberto
 * (`./deliver.ts`, por onde passa todo aviso local).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import { conteudoNaTelaBloqueada, type ConteudoNaTelaBloqueada } from "@/lib/schemas/settings";

import type { PushPayload } from "./push_payload";

export const TITULO_NEUTRO = "Novo aviso";

export type AvisoNaTela = { title: string; body: string; tag?: string; href?: string; icon?: string };

/**
 * Montado campo a campo, nunca por spread do payload: é isso que impede um
 * campo do produtor (o próprio `corpoSemPrevia`, ou um que alguém acrescente
 * amanhã) de chegar à tela. Qualquer modo fora dos dois que mostram algo cai
 * no oculto.
 */
export function redigirParaATelaBloqueada(
  p: PushPayload,
  modo: ConteudoNaTelaBloqueada,
  idioma: Idioma,
): AvisoNaTela {
  const saida: AvisoNaTela =
    modo === "nome_e_previa"
      ? { title: p.title, body: p.body, icon: p.icon }
      : modo === "nome"
        ? { title: p.title, body: p.corpoSemPrevia ?? "", icon: p.icon }
        : { title: traduzir(TITULO_NEUTRO, idioma), body: "" };
  if (saida.icon === undefined) delete saida.icon;
  if (p.tag !== undefined) saida.tag = p.tag;
  if (p.href !== undefined) saida.href = p.href;
  return saida;
}

/**
 * A opção e o idioma da organização numa leitura só. Falha de leitura ou
 * organização inexistente escondem o conteúdo (`oculto`) em vez de calar o
 * aviso: ele sai, só que sem dizer quem nem o quê.
 */
export async function lerTelaBloqueada(
  db: Pick<SupabaseClient, "from">,
  orgId: string,
): Promise<{ modo: ConteudoNaTelaBloqueada; idioma: Idioma }> {
  const { data, error } = await db.from("organizations").select("settings, locale").eq("id", orgId).maybeSingle();
  const linha = data as { settings?: unknown; locale?: string | null } | null;
  const idioma = normalizarIdioma(linha?.locale ?? null);
  if (error || !linha) return { modo: "oculto", idioma };
  return { modo: conteudoNaTelaBloqueada(linha.settings), idioma };
}
