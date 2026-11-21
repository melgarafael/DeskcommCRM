"use client";

import Link from "next/link";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useSystemVersion } from "@/hooks/system/useSystemVersion";
import { blocosVisiveis, instalacaoAnteriorAoArtigo, rotuloDaVersao } from "@/lib/ajuda/hub";
import { destinosDaInterface } from "@/lib/navigation/interface";
import { BlocoDoPapel } from "./_papel";

/**
 * A versão da instalação vem de FORA deste componente (#3567, F4).
 *
 * `AjudaConteudo` continua sem rede: ele recebe a versão pronta e é testável
 * sem provider de requisição. Quem lê a versão é `AjudaComVersao`, pela MESMA
 * rota que o rodapé da sidebar e a tela de atualização leem
 * (`useSystemVersion`) — uma segunda fonte de "qual versão roda aqui" seria a
 * próxima a divergir da primeira.
 */
export function AjudaComVersao() {
  const { data } = useSystemVersion();
  // Rota que falhou, ainda não respondeu, ou instalação fora de release: a
  // versão chega nula, e nula NÃO marca artigo nenhum. Ausência de versão é
  // ausência de prova; marcar seria afirmar o que ninguém conferiu.
  return <AjudaConteudo versaoInstalada={data?.current_version ?? null} />;
}

export function AjudaConteudo({
  versaoInstalada = null,
}: {
  /** A versão que roda nesta instalação. Nula = desconhecida (sem aviso). */
  versaoInstalada?: string | null;
}) {
  const t = useT();
  const { user, activeOrg } = useAuth();
  // O mesmo contexto enriquecido pelo layout e a mesma régua do Sidebar.
  // Arrays vazios são intencionais: undefined desligaria esses filtros.
  const destinos = destinosDaInterface(
    activeOrg?.interface_settings,
    user.is_platform_admin && !user.support,
    activeOrg?.role ?? null,
    activeOrg?.modulos_ligados ?? [],
    activeOrg?.capacidades_ligadas ?? [],
  );
  // A leitura de Atualização aceita plataforma também em suporte; não é o
  // bypass de papel dos atalhos regulares (settings/atualizacao/page.tsx).
  const blocos = blocosVisiveis(user.is_platform_admin, destinos);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Ajuda")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("O caminho para cada tarefa, e onde ir quando algo não sai como esperado.")}
        </p>
      </header>

      {/* O alcance do papel vem ANTES do índice: "posso" antes de "onde". */}
      <BlocoDoPapel papel={activeOrg?.role ?? null} destinos={destinos} />

      <div className="grid gap-6 md:grid-cols-2">
        {blocos.map((bloco) => (
          <section key={bloco.titulo} className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
              {t(bloco.titulo)}
            </h2>
            <ul className="flex flex-col divide-y rounded-lg border">
              {bloco.itens.map((item) => {
                // A pergunta é a mesma da tela de atualização: esta instalação
                // já tem o que o artigo ensina? `false` quando qualquer uma das
                // duas versões é ilegível — nunca marca por suposição.
                const atrasada = instalacaoAnteriorAoArtigo(versaoInstalada, item.desde);
                const doArtigo = rotuloDaVersao(item.desde);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      data-testid={`ajuda-${item.href.replace(/\//g, "-")}`}
                      className="flex min-h-11 flex-col gap-0.5 p-3 hover:bg-muted/50"
                    >
                      <span className="text-sm font-medium">{t(item.texto)}</span>
                      <span className="text-xs text-muted-foreground">{t(item.detalhe)}</span>
                      {/* A marca aparece SEMPRE, com ou sem aviso: é ela que
                          responde "este artigo é da minha versão?" sem abrir a
                          tela de atualização. */}
                      <span className="text-[11px] text-muted-foreground">
                        {t("Vale a partir da versão {versao}").replace("{versao}", doArtigo)}
                      </span>
                      {atrasada && (
                        <span
                          role="status"
                          data-testid={`ajuda-aviso-de-versao-${item.href}`}
                          className="mt-1 text-xs text-warning-fg"
                        >
                          {t(
                            "Este caminho é da versão {versao}, e esta instalação está na {instalada}. Atualize antes de segui-lo.",
                          )
                            .replace("{versao}", doArtigo)
                            .replace("{instalada}", rotuloDaVersao(versaoInstalada ?? ""))}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
