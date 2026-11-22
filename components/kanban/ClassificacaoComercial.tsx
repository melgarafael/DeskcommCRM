"use client";

/**
 * A CLASSIFICAÇÃO COMERCIAL NA FICHA DO NEGÓCIO (#4191, item 1 do mantenedor).
 *
 * ─── O buraco que este arquivo fecha ────────────────────────────────────────
 *
 * A rota `POST`/`DELETE /api/v1/leads/[id]/classificacao-comercial` existia e
 * NENHUMA tela a chamava. O fragmento em `.changes/` dizia que "a ficha do
 * negócio tem a classificação", e isso não era verdade: quem quisesse marcar um
 * golpe tinha de descobrir a rota. Aqui a ficha passa a chamar a rota.
 *
 * ─── O que veio do @leonciojunior, e o que mudou ────────────────────────────
 *
 * A forma (bloco na ficha, confirmação em dois passos, `trava` contra duplo
 * clique, erro visível e nunca em silêncio, invalidação das consultas que
 * dependem da classificação) vem da continuação dele em
 * `contrib/4191-negocio-nao-comercial-leoncio` (`d17ed124b8`), com o crédito no
 * commit. O que mudou para caber neste PR: (a) o motivo é TEXTO declarado pela
 * equipe — a régua da branch deste PR manda `motivo` livre e validado, não um
 * vocabulário fechado no banco; (b) não existe coluna de `revisao`: o
 * compare-and-set desta entrega é do servidor (`classificacao-comercial.ts`),
 * que exige o estado que ELE leu, então a tela não carrega nem envia carimbo; e
 * (c) a releitura otimista saiu — o `409` do servidor é o que manda recarregar.
 *
 * ─── Por que o motivo é texto e não uma lista ───────────────────────────────
 *
 * O banco não tem CHECK de vocabulário (a lista está em discussão na issue e um
 * CHECK travaria a correção de um caso novo). A régua (`recusaDoMotivo…`) exige
 * de 3 a 200 caracteres, e a MESMA função valida aqui e no serviço — a tela não
 * pode recusar com uma frase diferente da que o servidor usa.
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import {
  MAX_MOTIVO_NAO_COMERCIAL,
  ehNaoComercial,
  recusaDoMotivoDoNaoComercial,
} from "@/lib/leads/elegibilidade-comercial";
import type { Lead } from "@/lib/types/leads";

type Estado = Pick<
  Lead,
  "id" | "status" | "nao_comercial_em" | "nao_comercial_motivo"
> & { nao_comercial_por?: string | null };

interface Resposta {
  data: {
    lead: Estado;
    ja_estava?: boolean;
    classificacao?: "nao_comercial" | "comercial";
  };
}

export function ClassificacaoComercial({ lead, podeEditar }: { lead: Estado; podeEditar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [estado, setEstado] = useState<Estado>(lead);
  const [confirmando, setConfirmando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Trava de UM clique: `ocupado` só chega à tela no próximo render, e dois
  // cliques no mesmo tique disparariam dois POSTs. `useRef` é síncrono.
  const trava = useRef(false);
  // A resposta de uma ficha que já fechou não pode reabrir outra: o dossiê
  // desmonta este componente ao trocar de negócio.
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);
  // A troca de ficha é resolvida pelo `key` do chamador (`LeadDossier`): o
  // componente remonta por negócio e por classificação, então estado local
  // nunca sobrevive à linha que o servidor devolveu.

  const naoComercial = ehNaoComercial(estado);
  const anonimizado = estado.nao_comercial_motivo === "anonimizado";
  const caminho = `/api/v1/leads/${lead.id}/classificacao-comercial`;
  const recusa = recusaDoMotivoDoNaoComercial(motivo);
  // O motivo escrito pela equipe aparece COMO FOI ESCRITO. Só o carimbo da
  // anonimização (item 3) tem rótulo próprio, porque ali o texto não é mais da
  // equipe: foi a cascata de LGPD que o substituiu.
  const motivoVisivel = anonimizado
    ? t("Motivo apagado pela anonimização")
    : (estado.nao_comercial_motivo ?? "");

  async function enviar(metodo: "POST" | "DELETE") {
    if (trava.current) return;
    trava.current = true;
    setOcupado(true);
    setErro(null);
    try {
      const resposta =
        metodo === "DELETE"
          ? await apiClient.delete<Resposta>(caminho)
          : await apiClient.post<Resposta>(caminho, { motivo });
      if (vivo.current) {
        setEstado(resposta.data.lead);
        setConfirmando(false);
        setMotivo("");
      }
      // Tudo o que lê a classificação: quadro, linha do tempo, Radar, métricas
      // de funil, previsão e as taxas por etapa. Sem isto a tela mente até o
      // próximo carregamento — o defeito clássico de "salvei e nada mudou".
      void qc.invalidateQueries({ queryKey: ["board"] });
      void qc.invalidateQueries({ queryKey: ["timeline", lead.id] });
      void qc.invalidateQueries({ queryKey: ["leads-at-risk"] });
      void qc.invalidateQueries({ queryKey: ["metrics"] });
      void qc.invalidateQueries({ queryKey: ["previsao"] });
      void qc.invalidateQueries({ queryKey: ["stage-win-rates"] });
    } catch (e) {
      if (vivo.current) {
        setConfirmando(false);
        setMotivo("");
        // A mensagem do servidor já vem no idioma de quem pediu (`traduzir` na
        // rota) e diz o que fazer — inclusive o 409 de corrida. Só um corpo sem
        // envelope (proxy, HTML) não foi escrito para a tela.
        setErro(
          e instanceof ApiError && !e.semEnvelope
            ? e.message
            : t("Não foi possível confirmar o resultado. Recarregue antes de tentar novamente."),
        );
      }
    } finally {
      trava.current = false;
      if (vivo.current) setOcupado(false);
    }
  }

  return (
    <section
      aria-label={t("Classificação comercial")}
      data-testid="classificacao-comercial"
      className="space-y-2 rounded-md border p-3 text-sm"
    >
      <p className="font-medium">
        {naoComercial ? t("Não comercial") : t("Comercial")}
      </p>
      {naoComercial && (
        <>
          {motivoVisivel && <p data-testid="classificacao-motivo">{motivoVisivel}</p>}
          <p className="text-xs text-muted-foreground">
            {t(
              "Histórico preservado. Este negócio fica fora do Radar e das métricas comerciais, e os follow-ups dele não enviam.",
            )}
          </p>
        </>
      )}
      {anonimizado && (
        <p className="text-xs text-muted-foreground">
          {t("Este contato foi anonimizado. A classificação não pode ser restaurada.")}
        </p>
      )}
      {erro && (
        <p role="alert" data-testid="classificacao-erro">
          {erro}
        </p>
      )}
      {podeEditar && !anonimizado && (naoComercial || estado.status === "open") && (
        confirmando ? (
          <div className="space-y-2">
            {!naoComercial && (
              <label className="block space-y-1">
                <span>{t("Motivo da classificação")}</span>
                <textarea
                  className="block w-full rounded-md border bg-background p-2"
                  value={motivo}
                  disabled={ocupado}
                  maxLength={MAX_MOTIVO_NAO_COMERCIAL}
                  rows={2}
                  aria-describedby="classificacao-motivo-ajuda"
                  onChange={(e) => setMotivo(e.target.value)}
                />
                <span id="classificacao-motivo-ajuda" className="text-xs text-muted-foreground">
                  {t(
                    "Escreva o que decide o caso (golpe, spam, contato sem finalidade comercial…).",
                  )}
                </span>
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              {naoComercial
                ? t(
                    "Restaurar não retoma follow-ups antigos. Uma demanda nova precisa ser iniciada pela equipe.",
                  )
                : t(
                    "O negócio não será ganho, perdido nem apagado. A classificação pode ser desfeita.",
                  )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={ocupado || (!naoComercial && recusa !== null)}
                onClick={() => void enviar(naoComercial ? "DELETE" : "POST")}
              >
                {ocupado ? t("Salvando…") : t("Confirmar classificação")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={ocupado}
                onClick={() => {
                  setMotivo("");
                  setConfirmando(false);
                }}
              >
                {t("Cancelar")}
              </Button>
            </div>
            {/* A recusa aparece só quando há texto digitado: antes disso não é erro. */}
            {!naoComercial && motivo.trim() !== "" && recusa !== null && (
              <p className="text-xs text-muted-foreground" role="status">
                {recusa.mensagem}
              </p>
            )}
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={ocupado}
            onClick={() => {
              setMotivo("");
              setErro(null);
              setConfirmando(true);
            }}
          >
            {naoComercial ? t("Restaurar como comercial") : t("Classificar como não comercial")}
          </Button>
        )
      )}
    </section>
  );
}
