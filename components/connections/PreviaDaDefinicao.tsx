"use client";
import Image from "next/image";

import { contarVariaveis, type BotaoDaDefinicao } from "@/lib/channels/template-conteudo";
import { useT } from "@/hooks/i18n/useT";

/**
 * Como a mensagem vai chegar ao cliente.
 *
 * ─── Por que uma prévia, e não só os campos ────────────────────────────────
 *
 * O formulário mostra pedaços — cabeçalho aqui, corpo ali, botões embaixo — e a
 * mensagem chega inteira. Erros que só aparecem no conjunto (rodapé repetindo o
 * que o corpo já disse, `{{2}}` sem `{{1}}`, botão com texto que não cabe) não
 * se enxergam campo a campo.
 *
 * E há um custo real em errar: cada definição vai para revisão da plataforma e
 * volta horas depois. Ver antes é o que evita o ciclo.
 *
 * ─── As variáveis aparecem COMO VARIÁVEIS ──────────────────────────────────
 *
 * `{{1}}` fica visível, não substituído pelo exemplo. Substituir mostraria uma
 * mensagem que nunca vai existir — o valor real muda a cada envio, e o que o
 * operador precisa conferir aqui é ONDE o buraco está, não como fica preenchido.
 */
export function PreviaDaDefinicao({
  cabecalho,
  midiaUrl,
  corpo,
  rodape,
  botoes,
}: {
  cabecalho: string;
  midiaUrl: string;
  corpo: string;
  rodape: string;
  botoes: BotaoDaDefinicao[];
}) {
  const t = useT();
  const vazia = !cabecalho && !midiaUrl && !corpo && !rodape && botoes.length === 0;
  const buracos = corpo ? contarVariaveis(corpo) : 0;
  // `{{3}}` sem `{{1}}` é recusado — a numeração é posicional e a lista de
  // valores não pode ter buraco. Avisar aqui poupa o ciclo de revisão.
  const faltando = Array.from({ length: buracos }, (_, i) => i + 1).filter(
    (n) => !new RegExp(`\\{\\{\\s*${n}\\s*\\}\\}`).test(corpo),
  );

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">{t("Como o cliente vai ver")}</p>

      <div className="rounded-lg bg-muted/60 p-3">
        {vazia ? (
          <p className="text-xs italic text-muted-foreground">
            {t("Preencha o texto para ver a prévia.")}
          </p>
        ) : (
          <div className="max-w-[22rem] rounded-lg rounded-tl-sm bg-background p-2.5 shadow-sm">
            {midiaUrl && (
              // `unoptimized`: a URL é assinada e temporária, e o otimizador do
              // Next a buscaria de novo depois de ela expirar.
              <Image
                src={midiaUrl}
                alt={t("Cabeçalho")}
                width={320}
                height={180}
                unoptimized
                className="mb-2 h-auto w-full rounded-md"
              />
            )}
            {cabecalho && <p className="mb-1 text-sm font-semibold">{cabecalho}</p>}
            {corpo && <p className="whitespace-pre-wrap text-sm leading-snug">{corpo}</p>}
            {rodape && <p className="mt-1 text-[11px] text-muted-foreground">{rodape}</p>}

            {botoes.filter((b) => b.texto.trim()).length > 0 && (
              <div className="mt-2 flex flex-col gap-1 border-t border-border pt-1.5">
                {botoes
                  .filter((b) => b.texto.trim())
                  .map((b, i) => (
                    <span key={i} className="text-center text-xs font-medium text-primary">
                      {b.texto}
                    </span>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>

      {faltando.length > 0 && (
        <p className="text-[11px] text-destructive">
          {t("Falta")} {faltando.map((n) => `{{${n}}}`).join(", ")} {t("no texto.")}{" "}
          {t("A numeração é sequencial e a plataforma recusa quando há buraco.")}
        </p>
      )}
    </div>
  );
}
