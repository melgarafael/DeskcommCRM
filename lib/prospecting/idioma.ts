/**
 * O IDIOMA DA ORGANIZAÇÃO, para o que a prospecção manda para FORA.
 *
 * Duas coisas da prospecção saíam fixas em português do Brasil, qualquer que
 * fosse a organização:
 *
 *   1. o prompt do agente criado pela campanha ("Converse em português do
 *      Brasil", `agent-setup.ts`) — numa organização em espanhol, o agente
 *      nascia instruído a escrever em português para empresas que falam espanhol;
 *   2. a busca de mapas (`language: "pt-BR"`, `countryCode: "br"`, `provider.ts`)
 *      — o rubro das empresas chegava em português ("Concessionária") e virava
 *      palavra da abordagem.
 *
 * Medido numa instalação real em espanhol em 02/11/2026. A régua é
 * `organizations.locale`, a MESMA do rodapé de saída (`rodape-de-saida.ts`) e da
 * tela; uma variante regional (`es-MX`) casa o idioma servido (`idiomaDoTexto`),
 * e locale vazio ou desconhecido continua português — quem não escolheu nada
 * fica exatamente como antes.
 */
import type pg from "pg";

import { idiomaDoTexto, type Idioma } from "@/lib/i18n/idiomas";

export async function idiomaDaOrganizacao(
  db: Pick<pg.PoolClient, "query">,
  org: string,
): Promise<Idioma> {
  const { rows } = await db.query<{ locale: string | null }>(
    "select locale from organizations where id=$1",
    [org],
  );
  return idiomaDoTexto(rows[0]?.locale ?? null);
}

/**
 * O idioma da conversa, dito AO MODELO. O prompt do agente da campanha é escrito
 * em português (é o texto do produto); o que muda é a língua em que ele conversa.
 * `Record<Idioma, …>`: idioma novo no registro sem entrada aqui não compila.
 */
export const IDIOMA_DA_CONVERSA: Record<Idioma, string> = {
  "pt-BR": "português do Brasil",
  es: "espanhol",
};
