"use client";

import { useState, useTransition } from "react";

import { updateMoldeDeIa } from "@/app/actions/settings/updateMoldeDeIa";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import type { EmpresaParaMolde, ResumoDoMolde } from "@/lib/ai/molde-de-ia";
import { rotuloDoProvedor } from "@/lib/ai/pontos/provedores";
import { MENSAGEM_DA_RECUSA_DE_ESCRITA, ehRecusaDeEscrita } from "@/lib/auth/recusa-de-escrita-de-admin";

/** O valor do Select para "nenhum molde" — o Radix não aceita string vazia como valor de item. */
const NENHUMA = "nenhuma";
/** O marcador das frases com número; fora do JSX porque não é prosa. */
const N = "{n}";

/**
 * A IA COM QUE AS EMPRESAS NOVAS NASCEM (migration 9096).
 *
 * Mesmo desenho dos cartões vizinhos: a escolha salva na hora, volta no erro, e
 * o registro de quem trocou fica na auditoria. O que muda é o RESUMO embaixo —
 * a tela diz o que a próxima empresa vai receber (quantas funções, quais
 * modelos, qual padrão e o que fica de fora), com a mesma regra que o gatilho do
 * banco aplica (`lib/ai/molde-de-ia.ts`). Sem ele, "Copiar a IA de <empresa>" seria
 * uma promessa que a pessoa só confere criando uma empresa de teste.
 */
export function FormularioDoMoldeDeIa({
  inicial,
  empresas,
  resumoInicial,
}: {
  inicial: string | null;
  /** `null` = a lista não pôde ser lida; o seletor fica travado em vez de mentir. */
  empresas: readonly EmpresaParaMolde[] | null;
  resumoInicial: ResumoDoMolde | null;
}) {
  const t = useT();
  const [molde, setMolde] = useState<string | null>(inicial);
  const [resumo, setResumo] = useState<ResumoDoMolde | null>(resumoInicial);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();

  function trocar(valor: string) {
    const proximo = valor === NENHUMA ? null : valor;
    const anterior = { molde, resumo };
    setErro(null);
    setMolde(proximo);
    startTransition(async () => {
      const r = await updateMoldeDeIa({ molde_de_ia_org_id: proximo });
      if (!r.ok) {
        setMolde(anterior.molde);
        setResumo(anterior.resumo);
        setErro(
          t(
            ehRecusaDeEscrita(r.error)
              ? MENSAGEM_DA_RECUSA_DE_ESCRITA[r.error]
              : r.error === "molde_invalido"
                ? "Só uma empresa ativa pode servir de molde. Recarregue a página e escolha outra."
                : "Não deu para salvar. Tente de novo em instantes.",
          ),
        );
        return;
      }
      setResumo(r.resumo);
    });
  }

  return (
    <Card id="molde-de-ia" data-testid="molde-de-ia">
      <CardHeader>
        <CardTitle>{t("IA das empresas novas")}</CardTitle>
        <CardDescription>
          {t(
            "Toda empresa criada daqui em diante nasce com a mesma escolha de modelo por função da empresa que você escolher aqui. As empresas que já existem não mudam.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border p-4">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor="molde-de-ia-empresa" className="text-base">
              {t("Copiar a IA de")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t(
                "Copia o modelo de cada função e o modelo padrão, sempre usando a chave de IA desta instalação. Chaves, Jev, agentes e base de conhecimento nunca são copiados.",
              )}
            </p>
          </div>
          <Select value={molde ?? NENHUMA} onValueChange={trocar} disabled={pendente || empresas === null}>
            <SelectTrigger
              id="molde-de-ia-empresa"
              className="w-full sm:w-[280px]"
              aria-label={t("IA das empresas novas")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NENHUMA}>{t("Nenhuma (cada empresa começa com o padrão do produto)")}</SelectItem>
              {(empresas ?? []).map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.ativa ? e.nome : `${e.nome} (${t("não está ativa")})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {empresas === null && (
          <p className="text-sm text-destructive" role="alert">
            {t("Não deu para ler a lista de empresas agora. Recarregue a página em instantes.")}
          </p>
        )}

        <div className="space-y-2 text-sm" data-testid="resumo-do-molde" aria-live="polite">
          {molde === null ? (
            <p className="text-muted-foreground">
              {t("Cada empresa nova começa com o modelo padrão do produto e sem escolha por função.")}
            </p>
          ) : pendente ? (
            <p className="text-muted-foreground">{t("Salvando…")}</p>
          ) : resumo === null ? (
            <p className="text-muted-foreground">
              {t("Escolha salva, mas não deu para ler agora o que esta empresa tem configurado.")}
            </p>
          ) : resumo.funcoes === 0 && resumo.padrao === null ? (
            <p className="text-warning-fg">
              {t(
                "Esta empresa não tem nada que se possa copiar: as empresas novas vão nascer com o padrão do produto.",
              )}
            </p>
          ) : (
            <>
              <p>
                {resumo.funcoes === 1
                  ? t("A próxima empresa vai nascer com 1 função de IA configurada:")
                  : t("A próxima empresa vai nascer com {n} funções de IA configuradas:").replace(
                      N,
                      String(resumo.funcoes),
                    )}
              </p>
              {resumo.modelos.length > 0 && (
                <ul className="space-y-1" data-testid="modelos-do-molde">
                  {resumo.modelos.map((m) => (
                    <li key={`${m.provider}|${m.model_id}`} className="flex flex-wrap gap-x-2">
                      <span className="font-mono">{m.model_id}</span>
                      <span className="text-muted-foreground">
                        {rotuloDoProvedor(m.provider) ?? m.provider} ·{" "}
                        {m.funcoes === 1 ? t("1 função") : t("{n} funções").replace(N, String(m.funcoes))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p data-testid="padrao-do-molde">
                {resumo.padrao ? (
                  <>
                    {t("Modelo padrão:")} <span className="font-mono">{resumo.padrao.default_model}</span>{" "}
                    <span className="text-muted-foreground">
                      · {rotuloDoProvedor(resumo.padrao.provider) ?? resumo.padrao.provider}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    {t(
                      "Modelo padrão: o do produto — o desta empresa usa um provedor que só funciona com a chave dela.",
                    )}
                  </span>
                )}
              </p>
              {resumo.deixadas > 0 && (
                <p className="text-muted-foreground" data-testid="deixadas-do-molde">
                  {(resumo.deixadas === 1
                    ? t(
                        "1 função desta empresa fica de fora: usa um endereço próprio ou um provedor que só funciona com a chave da própria empresa.",
                      )
                    : t(
                        "{n} funções desta empresa ficam de fora: usam um endereço próprio ou um provedor que só funciona com a chave da própria empresa.",
                      )
                  ).replace(N, String(resumo.deixadas))}
                </p>
              )}
            </>
          )}
        </div>

        {erro && (
          <p className="text-sm text-destructive" role="alert">
            {erro}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
