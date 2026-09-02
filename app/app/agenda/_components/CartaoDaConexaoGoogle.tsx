"use client";

import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import * as React from "react";
import { useRouter } from "next/navigation";

import { GoogleLogo } from "@/lib/ui/icons";

/**
 * O cartão da agenda conectada — e o caso que importa é o de quem NÃO tem.
 *
 * `GOOGLE_CALENDAR_CLIENT_ID` e `_SECRET` são opcionais (decisão 3.1), então
 * **100% das instalações novas** chegam aqui sem elas. Isso não é borda: é a
 * primeira tela que todo self-hoster vê.
 *
 * Nesse estado o botão NÃO aparece. E não é o mesmo que aparecer desabilitado:
 *
 *   indisponível  (falta o meio, vai ter)      -> existe, disabled, diz o motivo
 *   sem sentido   (não se aplica aqui)         -> não existe
 *   NÃO INSTALADO (a instalação não tem isso)  -> não existe, E a tela explica
 *
 * A terceira é esta, e ela é diferente das outras duas porque quem lê PODE
 * agir — falta uma chave, e há um lugar onde se põe. Botão desabilitado aqui
 * diria "você não pode", quando o certo é "esta instalação ainda não tem".
 */
export function CartaoDaConexaoGoogle({
  configurado,
  falta,
  contaConectada,
  enderecoDeRetorno,
  linkDeConfiguracao,
}: {
  configurado: boolean;
  /**
   * Para onde mandar quem PODE resolver — a tela do app OAuth no admin da
   * plataforma. Só vem preenchido para quem administra a INSTALAÇÃO: para o
   * resto, nomear a tela seria oferecer uma porta que dá em `notFound()`.
   */
  linkDeConfiguracao?: string;
  /** O que falta, PELO NOME — para a tela dizer em vez de só esconder o botão. */
  falta: string[];
  contaConectada?: string | null;
  /** O endereço EXATO que o Google exige registrado. Ver o bloco no JSX. */
  enderecoDeRetorno?: string;
}) {
  const t = useT();
  const router = useRouter();
  const [desconectando, setDesconectando] = React.useState(false);

  if (!configurado) {
    return (
      <div
        data-testid="google-nao-configurado"
        className="rounded-lg border border-border bg-surface-elevated/50 p-3"
      >
        <p className="text-sm font-medium text-text">{t("Sincronizar com o Google ainda não está disponível")}</p>
        {/*
          DUAS FRASES, porque são duas pessoas.
          
          Quem administra a instalação PODE resolver, e para essa pessoa nomear
          variáveis de ambiente é pior que inútil: elas não são mais o caminho —
          a credencial se cadastra pela tela desde a migration 0201. Para quem
          não administra, o texto continua o de antes: dizer o que falta sem
          oferecer uma porta que dá em `notFound()`.
        */}
        {linkDeConfiguracao ? (
          <p className="mt-1 text-xs leading-4 text-text-muted">
            {t("Falta cadastrar o aplicativo do Google desta instalação. Leva um minuto e você faz por aqui mesmo.")}
          </p>
        ) : (
          <p className="mt-1 text-xs leading-4 text-text-muted">
            {t("Esta instalação não tem as credenciais do Google cadastradas — não é nada que você tenha feito. Quem instalou o sistema precisa configurar")}
            {falta.length > 0 ? (
              <>
                {" "}
                <span data-testid="o-que-falta" className="font-mono text-[11px]">
                  {falta.join(` ${t("e")} `)}
                </span>
              </>
            ) : (
              ` ${t("as credenciais")}`
            )}
          </p>
        )}
        {linkDeConfiguracao ? (
          <a
            href={linkDeConfiguracao}
            data-testid="ir-configurar-google"
            className="mt-2 inline-block text-xs font-medium text-link underline underline-offset-2 hover:text-link-hover"
          >
            {t("Cadastrar as credenciais do Google")}
          </a>
        ) : null}
        {enderecoDeRetorno ? (
          <p className="mt-2 text-xs leading-4 text-text-muted">
            {/* ⚠️ ESTE BLOCO EXISTE PORQUE A AUSÊNCIA DELE JÁ CUSTOU UMA SESSÃO.
                O Google compara o endereço de retorno BYTE A BYTE, e recusa com
                `redirect_uri_mismatch` — um erro que aponta para o Google e não
                para a divergência. Quem cria a credencial no console registra o
                endereço do app (`http://.../`) e não o da ROTA, porque nada no
                produto dizia qual é. Agora diz, e dá para copiar. */}
            {t("E, no console do Google, registrar este endereço de retorno —")}{" "}
            <span className="font-medium">{t("exatamente assim")}</span>:{" "}
            <code
              data-testid="endereco-de-retorno"
              className="select-all break-all font-mono text-[11px] text-text"
            >
              {enderecoDeRetorno}
            </code>
          </p>
        ) : null}
        <p className="mt-2 text-xs leading-4 text-text-muted">
          {t("Até lá a agenda funciona normalmente, só não troca compromissos com o Google.")}
        </p>
      </div>
    );
  }

  if (contaConectada) {
    return (
      <div
        data-testid="google-conectado"
        className="flex items-center gap-2 rounded-lg border border-border bg-surface p-3"
      >
        <GoogleLogo size={16} weight="bold" className="shrink-0 text-text-muted" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-sm">
          <span className="text-text-muted">{t("Agenda conectada:")} </span>
          <span className="font-medium">{contaConectada}</span>
        </p>
        <Button
          variant="outline"
          size="sm"
          data-testid="desconectar-google"
          disabled={desconectando}
          onClick={() => {
            setDesconectando(true);
            void fetch("/api/v1/agenda/google/desconectar", { method: "DELETE" })
              .then(async (r) => {
                if (!r.ok) throw new Error(await r.text());
                // `refresh` e não estado local: quem sabe se a conexão saiu é o
                // servidor. Trocar o cartão no cliente repetiria o "Marcado ✓"
                // que esta mesma entrega acabou de pagar.
                router.refresh();
              })
              .catch(() => setDesconectando(false));
          }}
        >
          {desconectando ? t("Desconectando…") : t("Desconectar")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
      <p className="min-w-0 flex-1 text-sm text-text-muted">
        {t("Conecte sua agenda do Google para ver aqui o que já está marcado lá — e enviar para lá o que for marcado aqui.")}
      </p>
      <Button variant="outline" size="sm" data-testid="conectar-google" asChild>
        <a href="/api/v1/agenda/google/connect">
          <GoogleLogo size={16} weight="bold" aria-hidden />
          <span>{t("Conectar Google")}</span>
        </a>
      </Button>
    </div>
  );
}
