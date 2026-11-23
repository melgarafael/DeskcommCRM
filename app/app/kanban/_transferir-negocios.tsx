"use client";
/**
 * O QUE FAZER COM OS NEGÓCIOS DE UM FUNIL QUE VAI SAIR DA LISTA (#4802, item 3).
 *
 * Arquivar sempre pôde ser feito com negócio dentro — o funil sai da lista, para de
 * receber card novo e o histórico continua apontando para ele. O que faltava era a
 * ESCOLHA: quem arquivava não sabia quantos negócios ficariam presos num funil que
 * não vê mais, e não tinha como levá-los de uma vez (só card a card, pelo quadro).
 *
 * ⚠️ A CONTAGEM É A DO SERVIDOR, não um chute da tela. Ela sai de
 * `GET /api/v1/pipelines/[id]/negocios`, que conta pela MESMA consulta que a rota
 * de arquivar usa para recusar — o número que o dono da operação lê aqui é o
 * número que o banco tem, e a diferença entre os dois seria uma decisão tomada
 * sobre um dado falso.
 *
 * ⚠️ AS TRÊS ESCOLHAS DA ISSUE, e a quarta é o "Cancelar" do painel que hospeda
 * este componente — ele não inventa um quarto caminho:
 *   (a) transferir os negócios EM ANDAMENTO para outro funil — a etapa é a
 *       primeira de ANDAMENTO do destino (escolhida pelo servidor, com a mesma
 *       régua do quadro). Ganhos e perdidos ficam no funil de origem, que abre em
 *       leitura depois de arquivado (doc de decisão 400, opção B);
 *   (b) transferir para uma etapa ESPECÍFICA do destino — a escolhida aqui, sem
 *       troca silenciosa pela primeira;
 *   (c) remover os negócios da estrutura, mantendo contatos e históricos.
 *
 * ⚠️ O QUE NÃO MORA AQUI: o arquivamento e a exclusão. Quem os executa é o painel
 * que hospeda o componente (`_client.tsx`), depois de `onConcluir` — e arquivar SEM
 * transferir continua sendo o botão de sempre, que este componente nunca desabilita.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import {
  useEtapasDoFunil,
  useMoverNegociosDoFunil,
  useNegociosDoFunil,
} from "@/hooks/pipelines/usePipelines";
import { ApiError } from "@/lib/api/types";

/** O funil que pode receber o lote — a lista viva da tela. */
export interface DestinoPossivel {
  id: string;
  name: string;
}

type Modo = "funil" | "etapa" | "remover";

export function TransferirNegocios({
  funilId,
  funilNome,
  destinos,
  onConcluir,
}: {
  funilId: string;
  funilNome: string;
  /** Os OUTROS funis vivos. O de origem fica de fora: não é transferência. */
  destinos: DestinoPossivel[];
  /**
   * Chamado DEPOIS da escrita bem-sucedida — é o painel que arquiva/exclui.
   * `restantes` são os que ficaram no funil (os encerrados, na transferência):
   * a exclusão só segue com zero.
   */
  onConcluir: (resultado: { movidos: number; restantes: number }) => void;
}) {
  const t = useT();
  // `rodada` refaz a contagem depois de uma transferência que deixou encerrados.
  const [rodada, setRodada] = useState(0);
  const { negocios, abertos, carregando, erro: erroDaContagem } = useNegociosDoFunil(funilId, true, rodada);
  const mover = useMoverNegociosDoFunil();
  const [aviso, setAviso] = useState<string | null>(null);

  const [modo, setModo] = useState<Modo>("funil");
  const [destinoId, setDestinoId] = useState<string>(destinos[0]?.id ?? "");
  const [etapaId, setEtapaId] = useState<string>("");
  const [erro, setErro] = useState<string | null>(null);

  const { etapas, carregando: carregandoEtapas } = useEtapasDoFunil(
    modo === "etapa" ? destinoId || null : null,
  );

  // A frase da confirmação só aparece quando o número chegou: "0 negócios" antes da
  // resposta seria uma afirmação que a tela não pode fazer.
  if (carregando || negocios === null) {
    return (
      <p className="text-sm leading-relaxed text-muted-foreground" data-testid={`negocios-carregando-${funilId}`}>
        {erroDaContagem
          ? t("Não consegui contar os negócios deste funil agora. Tente de novo em instantes.")
          : t("Conferindo quantos negócios estão vinculados…")}
      </p>
    );
  }

  if (negocios === 0) return null;

  const texto =
    negocios === 1
      ? t("«{nome}» tem 1 negócio vinculado. Escolha o que fazer com ele antes de continuar.")
      : t("«{nome}» tem {n} negócios vinculados. Escolha o que fazer com eles antes de continuar.");
  const frase = texto.replace("{nome}", funilNome).replace("{n}", String(negocios));
  // Doc 400 (B): só os em andamento mudam de funil; ganhos e perdidos ficam.
  const encerrados = Math.max(0, negocios - (abertos ?? 0));
  const fraseDosEncerrados =
    encerrados > 0
      ? t(
          "Transferir leva só os em andamento ({a}). Os ganhos e perdidos ({e}) ficam neste funil, que guarda o histórico em modo leitura. Para excluí-lo de vez, eles precisam ser removidos.",
        )
          .replace("{a}", String(abertos ?? 0))
          .replace("{e}", String(encerrados))
      : null;

  const podeAplicar =
    !mover.isPending &&
    (modo === "remover" || (destinoId !== "" && (modo === "funil" || etapaId !== "")));

  function aplicar() {
    setErro(null);
    setAviso(null);
    mover.mutate(
      {
        id: funilId,
        corpo:
          modo === "remover"
            ? { escolha: "remover" as const }
            : {
                escolha: "transferir" as const,
                funil_id: destinoId,
                etapa_id: modo === "etapa" ? etapaId : null,
              },
      },
      {
        onSuccess: (r) => {
          if (r.data.restantes > 0) {
            setAviso(
              t("{n} negócios ganhos ou perdidos continuam neste funil.").replace(
                "{n}",
                String(r.data.restantes),
              ),
            );
            setRodada((n) => n + 1);
          }
          onConcluir({ movidos: r.data.movidos, restantes: r.data.restantes });
        },
        onError: (e) => setErro(textoDoErro(e, t)),
      },
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid={`negocios-do-funil-${funilId}`}>
      <p className="text-sm leading-relaxed" data-testid={`contagem-de-negocios-${funilId}`}>
        {frase}
      </p>
      {fraseDosEncerrados && (
        <p className="text-sm leading-relaxed text-muted-foreground" data-testid={`encerrados-ficam-${funilId}`}>
          {fraseDosEncerrados}
        </p>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">
          {t("O que fazer com os negócios")}
        </legend>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`escolha-${funilId}`}
            checked={modo === "funil"}
            onChange={() => setModo("funil")}
            data-testid={`escolha-transferir-funil-${funilId}`}
          />
          {t("Transferir os em andamento para outro funil")}
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`escolha-${funilId}`}
            checked={modo === "etapa"}
            onChange={() => setModo("etapa")}
            data-testid={`escolha-transferir-etapa-${funilId}`}
          />
          {t("Transferir para uma etapa específica do funil de destino")}
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`escolha-${funilId}`}
            checked={modo === "remover"}
            onChange={() => setModo("remover")}
            data-testid={`escolha-remover-${funilId}`}
          />
          {t("Remover os negócios da estrutura dos funis, mantendo contatos e históricos")}
        </label>

        {/*
          #4852: a confirmação de "remover" NOMEIA o que vai junto e avisa que não
          tem volta. A opção acima promete o que fica (contatos, histórico), e a
          promessa é verdadeira — o que faltava era o outro lado da frase: a única
          parte desta tela que apaga de verdade. Medido nas FKs de `crm_leads`: em
          CASCATA vão anexos (e os arquivos no armazenamento), vínculos,
          reativações, escores de risco, propostas de campo e as conversões de
          anúncio; propostas, tarefas e o histórico ficam, apontando para nada.
        */}
        {modo === "remover" && (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs text-destructive"
            data-testid={`aviso-remover-${funilId}`}
          >
            {t(
              "Não tem volta: os negócios são apagados, e com eles os anexos (e os arquivos no armazenamento), os vínculos, as reativações, os escores de risco, as propostas de campo e as conversões de anúncio. Contatos, conversas e o histórico do contato continuam.",
            )}
          </p>
        )}
      </fieldset>

      {modo !== "remover" && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("Funil de destino")}
          <select
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-text"
            value={destinoId}
            onChange={(e) => {
              setDestinoId(e.target.value);
              setEtapaId("");
            }}
            data-testid={`destino-do-funil-${funilId}`}
          >
            {destinos.length === 0 && <option value="">{t("Nenhum outro funil disponível")}</option>}
            {destinos.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {modo === "etapa" && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("Etapa de destino")}
          <select
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-text"
            value={etapaId}
            onChange={(e) => setEtapaId(e.target.value)}
            data-testid={`destino-da-etapa-${funilId}`}
          >
            <option value="">{carregandoEtapas ? t("Carregando etapas…") : t("Escolha a etapa")}</option>
            {etapas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {aviso && (
        <p className="text-sm leading-relaxed text-muted-foreground" data-testid={`aviso-da-escolha-${funilId}`}>
          {aviso}
        </p>
      )}

      {erro && (
        <p className="text-sm leading-relaxed text-destructive" data-testid={`erro-da-escolha-${funilId}`}>
          {erro}
        </p>
      )}

      <Button
        size="sm"
        onClick={aplicar}
        disabled={!podeAplicar}
        data-testid={`aplicar-escolha-${funilId}`}
      >
        {mover.isPending
          ? t("Aplicando…")
          : modo === "remover"
            ? t("Remover os negócios e continuar")
            : t("Transferir e continuar")}
      </Button>
    </div>
  );
}

/**
 * A recusa do servidor, INTEIRA.
 *
 * As frases de `lib/pipelines/transferencia-de-negocios.ts` dizem o que fazer
 * ("o funil está arquivado", "a etapa é de fechamento") — trocá-las por "erro ao
 * transferir" transformaria uma instrução acionável num beco sem saída, que é a
 * mesma regra do painel de arquivamento ao lado.
 */
function textoDoErro(e: unknown, t: (texto: string) => string): string {
  if (e instanceof ApiError) return t(e.message);
  if (e instanceof Error && e.message) return e.message;
  return t("Não consegui mover os negócios. Tente de novo.");
}
