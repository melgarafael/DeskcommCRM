"use client";
/**
 * "Baixar lista" do cartão da campanha: as duas listas da mesma rota
 * (`GET /api/v1/prospecting/:id/exportar?quem=`).
 *
 * A contagem do menu vem do SERVIDOR (`?resumo=1`), da mesma leitura e da mesma
 * régua do arquivo (`resumoDaLista`, `lib/prospecting/exportar.ts`). A tela não
 * tem como contar sozinha: quem pediu para parar é achado também pelo telefone
 * da empresa, e esse vínculo não vem na lista de candidatos. Um número contado
 * aqui prometeria um arquivo que não sai.
 *
 * A contagem só é pedida quando o menu ABRE: o cartão aberto não paga uma
 * consulta por campanha, e cada abertura conta de novo (a campanha em andamento
 * muda a cada envio).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import type { QualLista, ResumoDaLista } from "@/lib/prospecting/exportar";

type Resumo = ResumoDaLista & { truncada?: boolean };

/** Os valores de `?quem=` (`LISTAS` em `lib/prospecting/exportar.ts`). */
const SO_AS_NAO_ABORDADAS: QualLista = "nao_abordadas";
const TODAS: QualLista = "todas";

function ehResumo(x: unknown): x is Resumo {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.nao_abordadas === "number" &&
    typeof r.todas === "number" &&
    !!r.fora_da_lista &&
    typeof r.fora_da_lista === "object"
  );
}

export function BaixarLista({ campaignId }: { campaignId: string }) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const resumo = useQuery({
    queryKey: ["prospecting-lista", campaignId],
    queryFn: async () => {
      const resposta = await apiClient.get<{ data: unknown }>(
        `/api/v1/prospecting/${campaignId}/exportar?resumo=1`,
      );
      if (!ehResumo(resposta.data)) throw new Error("resumo inválido");
      return resposta.data;
    },
    enabled: aberto,
    staleTime: 0,
    retry: false,
  });
  const contagem = resumo.data;
  const fora = contagem
    ? Object.values(contagem.fora_da_lista).reduce((soma, n) => soma + n, 0)
    : 0;

  function item(quem: QualLista, rotulo: string, quantas: number | undefined) {
    const texto = quantas === undefined ? rotulo : `${rotulo} (${quantas})`;
    // Lista vazia não vira link: o arquivo seria só o cabeçalho (a rota recusa).
    if (quantas === 0)
      return (
        <DropdownMenuItem disabled data-testid={`baixar-lista-${quem}`}>
          {texto}
        </DropdownMenuItem>
      );
    return (
      <DropdownMenuItem asChild>
        <a
          data-testid={`baixar-lista-${quem}`}
          download
          href={`/api/v1/prospecting/${campaignId}/exportar?quem=${quem}`}
        >
          {texto}
        </a>
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenu onOpenChange={setAberto}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" data-testid="baixar-lista">
          {t("Baixar lista")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
        {item(SO_AS_NAO_ABORDADAS, t("Só as não abordadas"), contagem?.nao_abordadas)}
        {item(TODAS, t("Todas"), contagem?.todas)}
        {resumo.isFetching && !contagem && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("Contando as empresas…")}</p>
        )}
        {resumo.isError && (
          <p role="alert" className="px-2 py-1.5 text-xs text-muted-foreground">
            {t("Não foi possível contar as empresas. Feche e abra o menu para tentar de novo.")}
          </p>
        )}
        {fora > 0 && (
          <p data-testid="baixar-lista-fora" className="px-2 py-1.5 text-xs text-muted-foreground">
            {fora === 1
              ? t(
                  "1 empresa fica fora do arquivo porque pediu para parar, é contato pessoal ou teve os dados apagados.",
                )
              : `${fora} ${t(
                  "empresas ficam fora do arquivo porque pediram para parar, são contatos pessoais ou tiveram os dados apagados.",
                )}`}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
