import { format } from "date-fns";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { lerManifestacaoDaOuvidoria } from "@/app/actions/ouvidoria/ler-manifestacao";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { localeDeData } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { acessoDaOuvidoria } from "@/lib/ouvidoria/acesso";
import type { CanalDaOuvidoria, StatusDaOuvidoria } from "@/lib/ouvidoria/registro";
import { proximosStatus } from "@/lib/ouvidoria/transicao";

import { MudarStatus } from "./_status";

/**
 * O DETALHE DA MANIFESTAÇÃO (#3611, fatia 3) — onde o relato aparece.
 *
 * ─── Por que a leitura é a MESMA da fatia 1 ────────────────────────────────
 *
 * A página não monta o `select` do relato: chama
 * `lerManifestacaoDaOuvidoria`, a porta da fatia 1, que já carrega a barreira de
 * sessão e o predicado de organização. Uma segunda leitura escrita aqui seria a
 * chance de uma delas esquecer a organização — e a que esquece é a que ninguém
 * abre. A tela também NÃO é a autorização: quem chega aqui já passou pela
 * barreira, e a action cobra de novo.
 *
 * ─── O que "não encontrada" significa na tela ──────────────────────────────
 *
 * Existe, é de outra empresa e id malformado são a MESMA resposta
 * (`not_found`), de propósito: distinguir contaria ao vizinho que a linha
 * existe. A tela diz "não encontrada" para os três — e não "sem permissão para
 * esta manifestação", que já seria a informação que o sigilo não quer dar.
 *
 * ─── Por que as opções de status vêm do SERVIDOR ───────────────────────────
 *
 * `proximosStatus` mora em `lib/ouvidoria/transicao.ts`, que carrega o registro
 * (e o `node:crypto` dele). O formulário é cliente e não pode importar aquilo —
 * então o servidor calcula as opções e as passa como dado. O efeito colateral é
 * bom: a tela oferece exatamente o que a action aceita, sem cópia da régua.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ouvidoria" };

const CANAL_ROTULO: Record<CanalDaOuvidoria, string> = {
  whatsapp: "WhatsApp",
  web: "Site",
  email: "E-mail",
  telefone: "Telefone",
  presencial: "Presencial",
  outro: "Outro",
};

/**
 * O rótulo de cada status. A chave é o valor de wire; o VALOR é o texto que
 * passa por `t()` — traduzir `em_analise` daria "em_analise" em qualquer idioma.
 */
const STATUS_ROTULO: Record<StatusDaOuvidoria, string> = {
  recebida: "Recebida",
  em_analise: "Em análise",
  concluida: "Concluída",
};

function dataLegivel(iso: string, idioma: Idioma): string {
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return iso;
  return format(data, "dd/MM/yyyy HH:mm", { locale: localeDeData(idioma) });
}

export default async function ManifestacaoDaOuvidoriaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const acesso = await acessoDaOuvidoria();
  if (!acesso.ok) redirect(acesso.error === "unauthenticated" ? "/login" : "/app");

  const t = (texto: string) => traduzir(texto, acesso.user.idioma);
  const { id } = await params;
  const resultado = await lerManifestacaoDaOuvidoria(id);

  if (!resultado.ok) {
    return (
      <main className="flex h-full flex-col gap-4 md:p-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Ouvidoria")}</h1>
        <p className="text-sm text-muted-foreground">
          {resultado.error === "not_found"
            ? t("Manifestação não encontrada.")
            : t("Não foi possível carregar a manifestação.")}
        </p>
        <Button asChild variant="outline" size="sm" className="w-fit">
          <Link href="/app/ouvidoria">{t("Voltar para a lista")}</Link>
        </Button>
      </main>
    );
  }

  const m = resultado.manifestacao;
  const opcoes = proximosStatus(m.status);

  return (
    <main className="flex h-full flex-col gap-6 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{t("Protocolo")}</p>
          <h1 className="font-mono text-xl font-semibold tracking-tight">{m.protocolo}</h1>
        </div>
        <Button asChild variant="ghost" size="sm" className="text-xs">
          <Link href="/app/ouvidoria">{t("Voltar para a lista")}</Link>
        </Button>
      </header>

      <Card className="flex flex-col gap-4 p-4">
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">{t("Canal")}</dt>
            <dd>{t(CANAL_ROTULO[m.canal] ?? m.canal)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("Status")}</dt>
            <dd>
              <Badge variant="secondary" className="text-xs">
                {t(STATUS_ROTULO[m.status] ?? m.status)}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("Recebida em")}</dt>
            <dd className="whitespace-nowrap">{dataLegivel(m.createdAt, acesso.user.idioma)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("Última atualização")}</dt>
            <dd className="whitespace-nowrap">{dataLegivel(m.updatedAt, acesso.user.idioma)}</dd>
          </div>
        </dl>

        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <h2 className="text-sm font-medium">{t("Relato")}</h2>
          {/* O texto é o dado sigiloso: sai como foi registrado, sem resumo e
              sem reescrita. `whitespace-pre-wrap` porque a quebra de linha de
              quem escreveu é parte do relato. */}
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.texto}</p>
        </div>
      </Card>

      <MudarStatus id={m.id} de={m.status} opcoes={opcoes} />
    </main>
  );
}
