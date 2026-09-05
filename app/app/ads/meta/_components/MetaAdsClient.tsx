"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { useMetaAdAccounts, useMetaCampaigns } from "@/hooks/ads/useMetaAds";
import { ApiError } from "@/lib/api/types";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import type { Idioma } from "@/lib/i18n/idiomas";

import { TabelaDeCampanhas } from "./TabelaDeCampanhas";

/**
 * O corpo da tela: escolher conta, escolher período, atualizar, ler.
 *
 * ─── Por que a falha aparece com FRASE, e não como "erro ao carregar" ───────
 *
 * Invariante 6 da doutrina de restrição de canal: caminho de falha visível. As
 * quatro causas reais desta tela pedem ações OPOSTAS de quem lê — colar um
 * token novo, refazer o token com outro escopo, esperar a cota voltar, ou
 * avisar quem mantém o sistema. Um texto genérico faria quem esbarrou na cota
 * ir gerar credencial nova (que não conserta e ainda gasta o tempo dele), e
 * quem está com o token expirado ficar recarregando a página.
 *
 * O `code` vem do `ApiError` do apiClient; as classes são as de
 * `lib/plataformas-de-anuncio/types.ts` e a tradução para HTTP está em
 * `app/api/v1/ads/meta/_falha.ts`.
 */

const MENSAGEM_POR_CODIGO: Record<string, string> = {
  ads_token_invalido:
    "A plataforma recusou o token de acesso — ele expirou ou foi revogado. Gere um novo em Configurações › Meta Ads.",
  ads_permissao_insuficiente:
    "O token não tem permissão de leitura de anúncios (ads_read), ou não alcança esta conta. Refaça o token no Meta for Developers marcando essa permissão.",
  ads_limite_de_chamadas:
    "A plataforma limitou as chamadas por excesso de consultas. Espere alguns minutos antes de atualizar de novo.",
  ads_campo_invalido:
    "A plataforma recusou um campo desta consulta. Isso é um problema do sistema, não da sua conta — avise quem mantém a instalação.",
  ads_sem_conexao: "Nenhuma conta de anúncios conectada.",
  ads_cifra_indisponivel:
    "A chave de criptografia da instalação não está disponível, então o token guardado não pode ser lido. Isso é configuração do servidor.",
  upstream_unavailable: "Não consegui falar com a plataforma agora. Tente atualizar em instantes.",
  forbidden_role: "Seu papel não permite ver os dados de anúncios.",
};

/**
 * `account_status` da plataforma → português.
 *
 * Mostrado ao lado do nome no seletor porque uma conta com pendência devolve
 * tabela VAZIA, e sem esta etiqueta a tela pareceria quebrada. A conta "Astra
 * Mídia: Antigo" da instalação sondada está exatamente nesse estado.
 */
const STATUS_DA_CONTA: Record<number, string> = {
  1: "",
  2: "desativada",
  3: "pendência de cobrança",
  7: "em análise de risco",
  8: "aguardando pagamento",
  9: "em período de carência",
  100: "encerramento pendente",
  101: "encerrada",
};

function comoData(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Ontem — nunca hoje. O dia corrente está incompleto e a plataforma ainda o reprocessa. */
function ontem(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

function haDias(dias: number): { de: string; ate: string } {
  const fim = ontem();
  const inicio = new Date(fim.getTime() - (dias - 1) * 24 * 60 * 60 * 1000);
  return { de: comoData(inicio), ate: comoData(fim) };
}

const PERSONALIZADO = "personalizado";

interface Props {
  contaPadrao: string | null;
  idioma: Idioma;
}

export function MetaAdsClient({ contaPadrao }: Props) {
  const t = useT();
  // O carimbo "lido em" é uma DATA, e data segue o idioma de quem lê — fixar
  // "pt-BR" deixaria a tela em espanhol com a hora em português.
  const tagDoIdioma = useTagDeIdioma();

  const [conta, setConta] = useState<string | null>(contaPadrao);
  const [preset, setPreset] = useState<string>("7");
  const [intervalo, setIntervalo] = useState(() => haDias(7));

  const contas = useMetaAdAccounts(true);

  // O `?? []` precisa de `useMemo` próprio: sem ele, cada render cria um array
  // NOVO, a dependência do memo abaixo muda sempre e o memo deixa de memoizar —
  // o que o `react-hooks/exhaustive-deps` aponta e que aqui teria efeito real,
  // já que o cálculo abaixo varre a lista.
  const listaDeContas = useMemo(() => contas.data?.data.contas ?? [], [contas.data]);

  // A conta efetiva: a escolhida, a padrão gravada, ou a primeira ATIVA da
  // lista. Cair na primeira ativa e não na primeira da lista evita abrir a tela
  // numa conta com pendência de cobrança, que devolveria tabela vazia e passaria
  // a impressão de integração quebrada.
  const contaEfetiva = useMemo(() => {
    if (conta) return conta;
    if (contaPadrao) return contaPadrao;
    const ativa = listaDeContas.find((c) => c.status === 1);
    return ativa?.id ?? listaDeContas[0]?.id ?? null;
  }, [conta, contaPadrao, listaDeContas]);

  const moeda = listaDeContas.find((c) => c.id === contaEfetiva)?.moeda ?? "BRL";

  const campanhas = useMetaCampaigns({
    contaId: contaEfetiva,
    de: intervalo.de,
    ate: intervalo.ate,
  });

  function trocarPreset(valor: string) {
    setPreset(valor);
    if (valor !== PERSONALIZADO) setIntervalo(haDias(Number(valor)));
  }

  function mensagemDeErro(erro: unknown): string {
    if (erro instanceof ApiError) {
      return t(MENSAGEM_POR_CODIGO[erro.code] ?? "Não consegui carregar os dados agora.");
    }
    return t("Não consegui carregar os dados agora.");
  }

  const erro = contas.error ?? campanhas.error;
  const carregando = contas.isLoading || campanhas.isFetching;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="conta">{t("Conta de anúncios")}</Label>
          <Select
            value={contaEfetiva ?? ""}
            onValueChange={setConta}
            disabled={listaDeContas.length === 0}
          >
            <SelectTrigger id="conta" className="w-72">
              <SelectValue placeholder={t("Carregando…")} />
            </SelectTrigger>
            <SelectContent>
              {listaDeContas.map((c) => {
                const aviso = STATUS_DA_CONTA[c.status];
                return (
                  <SelectItem key={c.id} value={c.id}>
                    {c.nome}
                    {aviso ? ` — ${t(aviso)}` : ""}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="periodo">{t("Período")}</Label>
          <Select value={preset} onValueChange={trocarPreset}>
            <SelectTrigger id="periodo" className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">{t("Últimos 7 dias")}</SelectItem>
              <SelectItem value="14">{t("Últimos 14 dias")}</SelectItem>
              <SelectItem value="30">{t("Últimos 30 dias")}</SelectItem>
              <SelectItem value="90">{t("Últimos 90 dias")}</SelectItem>
              <SelectItem value={PERSONALIZADO}>{t("Personalizado")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {preset === PERSONALIZADO && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="de">{t("De")}</Label>
              <Input
                id="de"
                type="date"
                className="w-40"
                value={intervalo.de}
                max={intervalo.ate}
                onChange={(e) => setIntervalo((i) => ({ ...i, de: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ate">{t("Até")}</Label>
              <Input
                id="ate"
                type="date"
                className="w-40"
                value={intervalo.ate}
                min={intervalo.de}
                max={comoData(ontem())}
                onChange={(e) => setIntervalo((i) => ({ ...i, ate: e.target.value }))}
              />
            </div>
          </>
        )}

        {/*
          `disabled` enquanto busca não é polimento: cada clique gasta 2 chamadas
          na plataforma (campanhas + insights), e a conta sondada está em
          `development_access`, cuja cota é justa. Um botão clicável durante a
          busca convida ao clique repetido que provoca o próprio rate limit.
        */}
        <Button onClick={() => campanhas.refetch()} disabled={carregando || !contaEfetiva}>
          {carregando ? t("Atualizando…") : t("Atualizar")}
        </Button>
      </div>

      {erro && (
        <div
          role="alert"
          className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm"
        >
          <p className="font-medium">{mensagemDeErro(erro)}</p>
          {erro instanceof ApiError && (
            // O id da requisição vai junto: é o que liga esta tela ao log do
            // servidor quando alguém precisar investigar.
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Código")}: {erro.code} · {t("Requisição")}: {erro.requestId}
            </p>
          )}
        </div>
      )}

      {campanhas.data && !erro && (
        <>
          <TabelaDeCampanhas linhas={campanhas.data.data.campanhas} moeda={moeda} />
          {/*
            Sem carimbo, uma tabela que falhou ao atualizar é visualmente
            idêntica a uma recém-atualizada — e a promessa desta tela é
            justamente "número de agora".
          */}
          <p className="text-xs text-muted-foreground">
            {t("Período")}: {intervalo.de} {t("a")} {intervalo.ate} · {t("lido em")}{" "}
            {new Date(campanhas.data.data.lido_em).toLocaleString(tagDoIdioma)}
          </p>
        </>
      )}

      {campanhas.isLoading && !erro && (
        <p className="text-sm text-muted-foreground">{t("Carregando campanhas…")}</p>
      )}
    </div>
  );
}
