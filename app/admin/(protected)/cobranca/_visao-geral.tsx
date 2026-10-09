import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { leituraAtrasada, type DadosDaVisaoGeral, type PassoDoChecklist } from "@/lib/cobranca/visao-geral";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/**
 * No topo de /admin/cobranca, em TODAS as abas, enquanto a chave é de teste: o
 * leigo que terminou os passos em teste acha que acabou, e a Stripe recusa
 * cartão real em modo de teste — as empresas não pagariam e seriam suspensas.
 */
export function FaixaDoModoDeTeste({ modo, idioma }: { modo: string | null; idioma: Idioma }) {
  if (modo !== "teste") return null;
  return (
    <p role="alert" className="rounded-md border border-warning/40 bg-warning-bg p-3 text-sm text-warning-fg">
      {traduzir(
        "Modo de teste: suas empresas reais ainda não conseguem pagar. Quando a compra de teste der certo, troque para a chave de produção em Conexão.",
        idioma,
      )}
    </p>
  );
}

/**
 * A Visão geral (spec §7a, §9): o que falta até a primeira cobrança, se a
 * cobrança está viva, e o que é problema do dono. Sem hooks: desenhada pelo
 * servidor, no idioma de quem abriu.
 */
export function VisaoGeral({
  dados,
  checklist,
  idioma,
  agora,
}: {
  dados: DadosDaVisaoGeral;
  checklist: readonly PassoDoChecklist[];
  idioma: Idioma;
  agora: Date;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const quando = new Intl.DateTimeFormat(idioma, { dateStyle: "short", timeStyle: "short" });
  const proximo = checklist.find((p) => !p.feito);
  const atrasada = leituraAtrasada(dados.ultimaLeituraEm, agora, 7);
  const problemas = [
    [dados.problemas.credencialInvalida, (dados.problemas.credencialInvalida === 1 ? t("{n} cliente com leitura falhando: a chave não funciona mais. Conecte de novo na aba Conexão.") : t("{n} clientes com leitura falhando: a chave não funciona mais. Conecte de novo na aba Conexão."))],
    [dados.problemas.cobrancaDupla, (dados.problemas.cobrancaDupla === 1 ? t("{n} cliente com duas assinaturas ativas. Cancele uma no painel do provedor.") : t("{n} clientes com duas assinaturas ativas. Cancele uma de cada no painel do provedor."))],
    [dados.problemas.pagouCancelada, (dados.problemas.pagouCancelada === 1 ? t("{n} pagamento de assinatura já cancelada. Dê prazo à empresa ou estorne no provedor.") : t("{n} pagamentos de assinatura já cancelada. Dê prazo às empresas ou estorne no provedor."))],
    [dados.problemas.avisosComErro, (dados.problemas.avisosComErro === 1 ? t("{n} aviso do provedor sem empresa correspondente nos últimos 90 dias.") : t("{n} avisos do provedor sem empresa correspondente nos últimos 90 dias."))],
    [
      dados.problemas.avisosRecusados,
      (dados.problemas.avisosRecusados === 1 ? t("{n} aviso de pagamento recusado nas últimas 24 h: a assinatura não confere. Conecte a chave de novo na aba Conexão.") : t("{n} avisos de pagamento recusados nas últimas 24 h: a assinatura não confere. Conecte a chave de novo na aba Conexão.")),
    ],
  ] as const;

  return (
    <div className="space-y-6">
      <Card className="space-y-3 p-6">
        <h2 className="text-base font-semibold">{t("Primeira cobrança: o que falta")}</h2>
        <ol className="space-y-3">
          {checklist.map((p) => (
            <li key={p.id} data-passo={p.id} data-feito={String(p.feito)} className="flex gap-3">
              <span aria-hidden className={p.feito ? "text-success-fg" : "text-muted-foreground"}>
                {p.feito ? "✓" : "○"}
              </span>
              <div className="space-y-1">
                <p className={p.feito ? "text-sm text-muted-foreground line-through" : "text-sm font-medium"}>{t(p.titulo)}</p>
                {!p.feito && <p className="text-sm text-muted-foreground">{t(p.comoFazer)}</p>}
                {p === proximo && p.href && (
                  <Link href={p.href} className="text-sm font-medium underline">
                    {t("Fazer agora")}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card className="space-y-2 p-6">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">{t("Situação da cobrança")}</h2>
          {dados.modo && <Badge variant={dados.modo === "producao" ? "success" : "warning"}>{t(dados.modo === "producao" ? "PRODUÇÃO" : "MODO DE TESTE")}</Badge>}
        </div>
        <p className="text-sm">
          {t("Último aviso do provedor:")}{" "}
          {dados.ultimoAvisoEm ? quando.format(new Date(dados.ultimoAvisoEm)) : t("nenhum nos últimos 90 dias")}
        </p>
        <p className={atrasada ? "text-sm text-error-fg" : "text-sm"}>
          {t("Última leitura bem-sucedida:")}{" "}
          {dados.ultimaLeituraEm ? quando.format(new Date(dados.ultimaLeituraEm)) : t("nenhuma ainda")}
          {atrasada && ` — ${t("mais de 7 horas: confira se o agendador está rodando.")}`}
        </p>
      </Card>

      {problemas.some(([n]) => n > 0) && (
        <Card className="space-y-2 p-6" role="region" aria-label={t("Problemas para resolver")}>
          <h2 className="text-base font-semibold">{t("Problemas para resolver")}</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {problemas
              .filter(([n]) => n > 0)
              .map(([n, frase]) => (
                <li key={frase}>{frase.replace("{n}", String(n))}</li>
              ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
