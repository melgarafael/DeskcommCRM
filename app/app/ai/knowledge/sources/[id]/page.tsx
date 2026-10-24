import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { lerConteudoDoMaterial } from "@/lib/ai/knowledge/conteudo-do-material";
import { TIPO_DE_FONTE_POR_ID } from "@/lib/ai/rag/tipos-de-fonte";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * LER UM MATERIAL DO ACERVO.
 *
 * A lista do acervo mostrada em grade só oferecia "Ver o que ele aprendeu" — os
 * pedaços do índice. Não havia porta nenhuma para o conteúdo legível do
 * material, e a equipe mantinha um sistema externo só para consultar o que já
 * estava guardado aqui dentro.
 *
 * O que a tela mostra vem de `lerConteudoDoMaterial`, que é a MESMA função que
 * a rota de API usa: um segundo caminho de leitura divergiria do que o agente
 * aprendeu, e a tela passaria a mostrar um texto que ele nunca viu.
 *
 * O papel é o mesmo da tela do acervo (`page.tsx:39`): abaixo de manager, a
 * leitura seria uma porta lateral para o material da empresa — e por isso ela
 * redireciona antes de ler qualquer coisa.
 */
export default async function MaterialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: sourceId } = await params;

  const user = await requireAuth();
  // `t` local em vez do hook: esta página é componente de SERVIDOR, e lá o
  // idioma vem resolvido em `user.idioma`.
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const leitura = await lerConteudoDoMaterial(supabase, { orgId: activeOrg.orgId, sourceId });

  // Material de outra empresa e material inexistente são a MESMA resposta —
  // dizer "não encontrado" para o primeiro não confirmaria nada sobre ele.
  if (!leitura.ok && leitura.falha === "nao_encontrado") notFound();

  if (!leitura.ok) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
        <VoltarAoAcervo rotulo={t("Voltar ao acervo")} />
        <p className="text-sm text-error-fg" data-testid="material-erro">
          {t("Não consegui ler este material agora.")}
        </p>
      </div>
    );
  }

  const material = leitura.material;
  const meta = TIPO_DE_FONTE_POR_ID.get(material.tipo);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header className="space-y-2">
        <VoltarAoAcervo rotulo={t("Voltar ao acervo")} />
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="material-nome">
          {material.nome}
        </h1>
        <p className="text-sm text-text-muted">{meta ? t(meta.rotulo) : material.tipo}</p>
      </header>

      <div className="space-y-4" data-testid="material-conteudo">
        {material.itens ? (
          <ul className="space-y-4">
            {material.itens.map((item, i) => (
              <li
                key={`${i + 1}-${item.question}`}
                className="rounded-lg border border-border bg-surface p-4"
              >
                <p className="text-xs font-medium tracking-wide text-text-muted uppercase">
                  {t("Pergunta")}
                </p>
                <p className="mt-1 font-medium" data-testid={`material-pergunta-${i}`}>
                  {item.question}
                </p>
                <p className="mt-3 text-xs font-medium tracking-wide text-text-muted uppercase">
                  {t("Resposta")}
                </p>
                <p
                  className="mt-1 text-sm break-words whitespace-pre-wrap"
                  data-testid={`material-resposta-${i}`}
                >
                  {item.answer}
                </p>
              </li>
            ))}
          </ul>
        ) : material.conteudo ? (
          // Texto corrido (documento enviado, texto colado, trecho indexado):
          // as quebras de linha são do material, e reformatá-las mudaria o que
          // a pessoa guardou.
          <div
            className="rounded-lg border border-border bg-surface p-4 text-sm break-words whitespace-pre-wrap"
            data-testid="material-texto"
          >
            {material.conteudo}
          </div>
        ) : null}

        {/* Frase vinda do servidor (arquivo que não pôde ser lido, material sem
            nada guardado): dado, não texto de tela — por isso não passa por t(). */}
        {material.motivo ? (
          <p className="text-sm text-text-muted" data-testid="material-motivo">
            {material.motivo}
          </p>
        ) : null}

        {material.truncado ? (
          <p className="text-xs text-text-muted">
            {t("Mostrando os primeiros trechos de")} {material.total}.{" "}
            {t(
              "Uma tela não folheia mil pedaços — o restante está no acervo e o agente alcança todos.",
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Volta ao acervo: sem esta porta, a página do material é um beco sem saída. */
function VoltarAoAcervo({ rotulo }: { rotulo: string }) {
  return (
    <Link
      href="/app/ai/knowledge/sources"
      className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-foreground focus-visible:underline"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      {rotulo}
    </Link>
  );
}
