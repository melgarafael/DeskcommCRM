import Link from "next/link";
import { notFound } from "next/navigation";

import { Card } from "@/components/ui/card";
import { loadAuthUser } from "@/lib/auth/server";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { lerAtrasoDoModulo, type AtrasoPorVinculo } from "@/lib/extensions/eventos-do-modulo";
import { createAdminClient } from "@/lib/supabase/admin";

/** O manifesto do artefato diz o perfil; só `connected` tem quem busque eventos. */
function ehConectada(artefato: unknown): boolean {
  const a = Array.isArray(artefato) ? artefato[0] : artefato;
  const manifesto = (a as { manifest?: { profile?: unknown } } | null | undefined)?.manifest;
  return manifesto?.profile === "connected";
}

/**
 * O último cursor lido, quando, e o atraso de cada vínculo. A empresa NÃO é nomeada (decisão: o dono do
 * servidor vê o estado, não a lista de clientes). Selo só quando há atraso e faz mais de 24 h.
 */
function LeituraDosEventos({
  chave,
  vinculos,
  t,
  dataEHora,
}: {
  chave: string;
  vinculos: AtrasoPorVinculo[];
  t: (s: string) => string;
  dataEHora: (iso: string) => string;
}) {
  return (
    <div data-testid={`leitura-eventos-${chave}`} className="mt-2 space-y-1 text-xs">
      <p className="font-medium">{t("Leitura dos avisos pelo módulo")}</p>
      {vinculos.map((v, i) => (
        <div key={i} data-testid={`leitura-eventos-${chave}-${i}`} className="text-text-muted">
          <p>
            {t("Empresa {n}").replace("{n}", String(i + 1))} ·{" "}
            {v.lidoEm === null || v.ultimoCursor === null
              ? t("ainda não leu nenhum aviso")
              : `${t("último aviso lido")} #${v.ultimoCursor} · ${t("lido em")} ${dataEHora(v.lidoEm)}`}
            {" · "}
            {v.atraso === 0
              ? t("em dia")
              : t("{n} aviso(s) por ler").replace("{n}", String(v.atraso))}
            {v.atrasado ? (
              <span
                data-testid={`selo-atrasado-${chave}-${i}`}
                className="ml-2 rounded bg-warning-bg px-1.5 py-0.5 font-medium text-warning-fg"
              >
                {t("Atrasado")}
              </span>
            ) : null}
          </p>
          {v.contatosPendentes > 0 ? (
            <p data-testid={`leitura-eventos-lgpd-${chave}-${i}`}>
              {t("Este módulo ainda não apagou os dados de {n} contato(s) anonimizado(s).").replace(
                "{n}",
                String(v.contatosPendentes),
              )}
              {v.atrasado
                ? ` ${t("Faz mais de 24 horas que o módulo não busca os avisos, e a LGPD manda apagar esses dados.")}`
                : ""}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export const metadata = { title: "Extensões da instalação" };
export const dynamic = "force-dynamic";

/**
 * AS EXTENSÕES, VISTAS DE QUEM É DONO DO SERVIDOR.
 *
 * ── O que esta tela existe para responder ───────────────────────────────────
 *
 * "Que extensões este servidor conhece, de onde elas vieram, e quem as está
 * usando?" Hoje isso não tinha tela: as três perguntas se respondiam com SSH e
 * SQL, ou não se respondiam.
 *
 * A tela da EMPRESA (`/app/extensions`) mostra o que aquela organização
 * instalou e configura o que ela vê. Mas o CATÁLOGO — de onde as extensões vêm,
 * em que revisão, admitido por quem — é da INSTALAÇÃO inteira: a tabela
 * `extension_catalogs` não tem `organization_id`. Era a mesma divisão errada
 * que o DEC-009 achou no e-mail: um assunto da instalação morando no menu da
 * empresa, onde o dono do servidor precisa entrar numa organização qualquer
 * para enxergá-lo.
 *
 * ── Por que SÓ LEITURA, e isso é decisão ────────────────────────────────────
 *
 * Admitir catálogo e instalar extensão continuam onde estão, na tela da
 * empresa, com os recibos e o desfazer que aquele fluxo já tem. Duplicar o
 * gesto de escrita aqui criaria dois caminhos para a mesma operação — e o que
 * falta ao dono do servidor não é um segundo botão, é a VISÃO que ele nunca
 * teve. Quando o fluxo de admissão mudar de lugar, ele muda uma vez.
 *
 * ── Por que `createAdminClient()` sem filtro de organização ─────────────────
 *
 * As três tabelas lidas aqui ou não têm `organization_id` (`extension_catalogs`,
 * `extension_installations`) ou são lidas para CONTAR organizações
 * (`organization_extensions`) — que é justamente a pergunta da instalação. O
 * gate é o papel: `is_platform_admin`, e `notFound()` para o resto, como as
 * vizinhas deste diretório.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();
  const idioma = normalizarIdioma(usuario.locale);
  const t = (s: string) => traduzir(s, idioma);

  const db = createAdminClient();
  const [catalogos, instalacoes, vinculos] = await Promise.all([
    db.from("extension_catalogs").select("id,origin,revision,digest,admitted_at").order("admitted_at", { ascending: false }),
    // Remoção aqui é soft delete: a linha fica, com `removed_at` preenchido. Sem
    // este filtro a tela chamaria de "instalada" uma extensão que o operador já
    // removeu — e contaria os vínculos dela junto. A irmã de produção
    // (`lib/extensions/service.ts`) filtra no banco pelo mesmo motivo.
    db
      .from("extension_installations")
      .select(
        "id,publisher,name,version,installed_at,disabled_at,extension_artifacts!extension_installations_artifact_id_fkey(manifest)",
      )
      .is("removed_at", null)
      .order("installed_at", { ascending: false }),
    db.from("organization_extensions").select("installation_id,enabled"),
  ]);

  const porInstalacao = new Map<string, { ligadas: number; total: number }>();
  for (const v of vinculos.data ?? []) {
    const atual = porInstalacao.get(v.installation_id) ?? { ligadas: 0, total: 0 };
    atual.total += 1;
    if (v.enabled) atual.ligadas += 1;
    porInstalacao.set(v.installation_id, atual);
  }

  // O atraso do módulo conectado (spec 33, F5 T3): só para instalação `connected`, e só números e datas.
  // Sem módulo conectado nada é lido e a tela fica idêntica à de antes.
  const atrasoPorInstalacao = new Map<string, AtrasoPorVinculo[]>();
  await Promise.all(
    (instalacoes.data ?? [])
      .filter((i) => ehConectada(i.extension_artifacts))
      .map(async (i) => {
        const atraso = await lerAtrasoDoModulo(i.id);
        if (atraso && atraso.length > 0) atrasoPorInstalacao.set(i.id, atraso);
      }),
  );

  const dataEHora = (iso: string) =>
    new Date(iso).toLocaleString(tagDeIdioma(idioma), {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const dataLegivel = (iso: string) =>
    new Date(iso).toLocaleDateString(tagDeIdioma(idioma), {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });

  return (
    <div className="space-y-6" data-testid="tela-extensoes-da-instalacao">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Extensões da instalação")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">
          {t(
            "O que este servidor conhece, de onde veio e quem está usando. Instalar e configurar continua sendo feito dentro de cada empresa.",
          )}
        </p>
      </div>

      <Card className="p-5">
        <h2 className="text-base font-semibold">{t("De onde vêm as extensões")}</h2>
        <p className="text-sm text-text-muted">
          {t("O catálogo admitido neste servidor. É a origem que o instalador aceita.")}
        </p>
        <div className="mt-3 space-y-3">
          {(catalogos.data ?? []).length === 0 ? (
            <p data-testid="extensoes-sem-catalogo" className="text-sm text-text-muted">
              {t(
                "Nenhum catálogo admitido ainda — enquanto não houver, não há extensão para instalar.",
              )}
            </p>
          ) : (
            (catalogos.data ?? []).map((c) => (
              <div key={c.id} data-testid={`catalogo-${c.id}`} className="text-sm">
                <p className="font-medium break-all">{c.origin}</p>
                <p className="text-xs text-text-muted">
                  {t("Revisão")} {c.revision} · {t("admitido em")} {dataLegivel(c.admitted_at)} ·{" "}
                  {/* Os 12 primeiros do digest: identifica a revisão numa conversa de suporte
                      sem virar uma parede de 64 caracteres na tela. */}
                  {t("impressão digital")} {c.digest.slice(0, 12)}
                </p>
              </div>
            ))
          )}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold">{t("Instaladas neste servidor")}</h2>
        <p className="text-sm text-text-muted">
          {t("Cada extensão é instalada uma vez no servidor e ligada por empresa.")}
        </p>
        <div className="mt-3 space-y-3">
          {(instalacoes.data ?? []).length === 0 ? (
            <p data-testid="extensoes-sem-instalacao" className="text-sm text-text-muted">
              {t("Nenhuma extensão instalada ainda.")}
            </p>
          ) : (
            (instalacoes.data ?? []).map((e) => {
              const uso = porInstalacao.get(e.id) ?? { ligadas: 0, total: 0 };
              return (
                <div key={e.id} data-testid={`extensao-${e.publisher}-${e.name}`} className="text-sm">
                  <p className="font-medium">
                    {e.publisher}/{e.name}{" "}
                    <span className="font-normal text-text-muted">v{e.version}</span>
                  </p>
                  <p className="text-xs text-text-muted">
                    {/* A contagem separa LIGADA de apenas vinculada: uma extensão
                        presente em dez empresas e ligada em nenhuma é um dado
                        diferente de "ninguém instalou", e some se a tela contar só
                        vínculos. */}
                    {uso.total === 0
                      ? t("Nenhuma empresa usa esta extensão")
                      : `${uso.ligadas} ${t("de")} ${uso.total} ${t("empresa(s) com ela ligada")}`}
                    {" · "}
                    {t("instalada em")} {dataLegivel(e.installed_at)}
                  </p>
                  {/* O interruptor do módulo conectado (spec 33, D8): desligado continua instalado.
                      Só `connected` tem `disabled_at`; ligar e desligar se faz na tela da empresa. */}
                  {e.disabled_at ? (
                    <p data-testid={`extensao-desligada-${e.publisher}-${e.name}`} className="text-xs font-medium">
                      {t("Desligado nesta instalação")} · {dataLegivel(e.disabled_at)}
                    </p>
                  ) : null}
                  {atrasoPorInstalacao.has(e.id) ? (
                    <LeituraDosEventos
                      chave={`${e.publisher}-${e.name}`}
                      vinculos={atrasoPorInstalacao.get(e.id) ?? []}
                      t={t}
                      dataEHora={dataEHora}
                    />
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </Card>

      <p className="text-sm text-text-muted">
        {t("Para instalar ou configurar uma extensão, entre na empresa:")}{" "}
        <Link
          href="/app/extensions"
          data-testid="ponteiro-extensoes-da-empresa"
          className="font-medium text-text underline underline-offset-4"
        >
          {t("Extensões da empresa →")}
        </Link>
      </p>
    </div>
  );
}
