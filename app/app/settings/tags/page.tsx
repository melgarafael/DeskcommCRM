/**
 * Configurações → Tags. Onde a organização arruma o vocabulário de etiquetas que
 * os agentes, o Inbox e o funil já escrevem (issue #852, fatia S4).
 *
 * ── Por que esta tela existe ─────────────────────────────────────────────────
 *
 * Até aqui a etiqueta só ENTRAva no vocabulário: cada agente escrevia em `add_tag`
 * o nome que o prompt dele mandasse, e ninguém tinha por onde corrigir. Medido
 * numa instalação real, a operação acumulou as três versões da mesma ideia —
 * "Cliente Novo", "cliente novo" e "novo-cliente" — com o filtro da lista de
 * conversas separando em três grupos a mesma carteira. Não era cosmético: o
 * agente continuava escrevendo a grafia velha porque a regra dele não sabia da
 * nova.
 *
 * ── Por que a tela mostra as regras de agente na MESMA lista ─────────────────
 *
 * É a informação que decide a ação. Uma etiqueta com zero conversas e três
 * regras `add_tag` vai reaparecer amanhã; uma com 200 conversas e zero regras é
 * só arrumação. Sem a coluna, o operador exclui a que "não usa ninguém" e
 * descobre o erro na próxima rodada do agente.
 *
 * ── Por que `manager`, e não `agent` ─────────────────────────────────────────
 *
 * Renomear aqui reescreve o vocabulário de todo mundo da organização, inclusive
 * as regras dos agentes. Mesmo gate do roteamento de filas — configuração, não
 * atendimento.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import type { LinhaDeVocabulario } from "@/lib/schemas/tags";
import { createClient } from "@/lib/supabase/server";

import { PainelDeTags } from "./_painel";

export const metadata = { title: "Tags" };
export const dynamic = "force-dynamic";

export default async function TagsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  // ⚠️ SEM ATALHO DE PLATFORM ADMIN, e de propósito. Quem grava é
  // `fn_vocabulario_de_tags_operar`, cujo portão é
  // `fn_role_at_least(p_org, 'manager')` — e `fn_role_at_least` resolve SÓ por
  // `fn_user_role_in_org`, sem ramo de platform admin. Com o atalho aqui, um
  // platform admin que não é manager+ nesta organização via a tela e os três
  // botões, e TODA ação dele voltava 403: controle decorativo, que é pior que
  // controle ausente, porque o 403 na cara lê como "o sistema falhou".
  //
  // A tela e o banco passam a dizer a MESMA coisa. Se um dia o platform admin
  // DEVER operar aqui, o lugar de mudar é o portão da função (e um invariante
  // que prove), nunca só esta linha.
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  // Client da SESSÃO: `fn_vocabulario_de_tags` é `security invoker`, então a
  // organização vem da RLS e do `p_org` da sessão. Ler com o admin client aqui
  // mostraria o vocabulário de qualquer tenant se alguém trocasse o id.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_vocabulario_de_tags", {
    p_org: activeOrg.orgId,
  });

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Tags")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "As etiquetas que os agentes, o Inbox e o funil usam nesta organização. Renomear ou juntar corrige também as regras de agente que escrevem a etiqueta, na mesma operação.",
          )}
        </p>
      </header>

      {error ? (
        // A falha NÃO vira lista vazia: "nenhuma etiqueta" e "não consegui ler"
        // levam o operador a decisões opostas (uma convida a criar tudo de novo).
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
          {t("Não foi possível carregar as etiquetas agora. Recarregue a página.")}
        </div>
      ) : (
        <PainelDeTags tags={(data ?? []) as LinhaDeVocabulario[]} idioma={idioma} />
      )}
    </div>
  );
}
