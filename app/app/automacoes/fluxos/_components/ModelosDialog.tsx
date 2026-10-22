"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { useEtapasDeGatilho } from "@/hooks/followup/useEtapasDeGatilho";
import { useInstalarModelo } from "@/hooks/followup/useInstalarModelo";
import {
  MODELOS_DE_FOLLOWUP,
  horizonteDoModeloMs,
  toquesDoModelo,
  type ModeloDeFollowup,
} from "@/lib/followup/modelos";
import { Clock, PaperPlaneTilt } from "@/lib/ui/icons";

/**
 * A GALERIA DE MODELOS — a porta pela qual uma clínica sai do zero.
 *
 * ⚠️ O CATÁLOGO É IMPORTADO, NÃO BUSCADO. Ele é dado estático do produto (os
 * mesmos textos para toda instalação) e cabe no bundle; uma rota `GET /modelos`
 * seria um segundo contrato sobre o mesmo dado, que divergiria do primeiro no
 * dia em que alguém mudasse um prazo. Quem grava continua sendo a rota — a tela
 * manda o `model_id`, nunca o grafo.
 *
 * ⚠️ O QUE ACONTECE DEPOIS DE INSTALAR ESTÁ ESCRITO NA TELA, e não é enfeite: o
 * fluxo nasce RASCUNHO e um gatilho automático só dispara se um agente
 * PUBLICADO arma o ponteiro (`agent-followup-gate.ts`). Sem essa linha, a
 * pessoa instala, vê o fluxo na lista e espera mensagens que nunca saem — fluxo
 * com cara de vivo, que é o desfecho que este produto persegue em toda parte.
 */
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Nomes dos fluxos que a organização já tem — marca o modelo já instalado. */
  nomesExistentes: string[];
}

const DIA_MS = 86_400_000;

/** "10 dias", "2 meses" — o horizonte na régua de quem opera, não em ms. */
function horizonteLegivel(ms: number): string {
  const dias = Math.round(ms / DIA_MS);
  if (dias < 31) return dias <= 1 ? "1 dia" : `${dias} dias`;
  const meses = Math.round(dias / 30);
  return meses <= 1 ? "1 mês" : `${meses} meses`;
}

export function ModelosDialog({ open, onOpenChange, nomesExistentes }: Props) {
  const t = useT();
  const router = useRouter();
  const instalar = useInstalarModelo();
  const [etapaPorModelo, setEtapaPorModelo] = useState<Record<string, string>>({});
  const [erro, setErro] = useState<{ modelo: string; mensagem: string } | null>(null);

  // Só busca as etapas quando o diálogo abre — o catálogo é lido muito mais
  // vezes do que instalado, e dois terços dos modelos nem pedem etapa.
  const { etapas, carregando } = useEtapasDeGatilho(open);

  const porFunil = etapas.reduce<Array<{ id: string; nome: string; etapas: typeof etapas }>>(
    (grupos, etapa) => {
      const grupo = grupos.find((g) => g.id === etapa.pipelineId);
      if (grupo) grupo.etapas.push(etapa);
      else grupos.push({ id: etapa.pipelineId, nome: etapa.pipelineName, etapas: [etapa] });
      return grupos;
    },
    [],
  );

  const aoInstalar = (modelo: ModeloDeFollowup) => {
    setErro(null);
    instalar.mutate(
      {
        model_id: modelo.id,
        ...(modelo.pedeEtapa ? { stage_id: etapaPorModelo[modelo.id] } : {}),
      },
      {
        // Leva direto ao construtor: instalar não é o fim, é o começo — ali a
        // pessoa lê os textos, ajusta a voz da clínica e publica.
        onSuccess: (criado) => {
          onOpenChange(false);
          router.push(`/app/automacoes/fluxos/${criado.id}`);
        },
        onError: (err: unknown) => {
          setErro({
            modelo: modelo.id,
            mensagem:
              err instanceof Error && err.message
                ? t(err.message)
                : t("Não consegui instalar o modelo. Tente de novo."),
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Modelos prontos")}</DialogTitle>
          <DialogDescription>
            {t(
              "Fluxos com os textos já escritos, para as quatro vezes em que um paciente some no meio do caminho. Instalar não manda mensagem para ninguém: o fluxo nasce como rascunho para você revisar.",
            )}
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-3">
          {MODELOS_DE_FOLLOWUP.map((modelo) => {
            const jaInstalado = nomesExistentes.includes(modelo.nome);
            const etapaEscolhida = etapaPorModelo[modelo.id];
            const faltaEtapa = modelo.pedeEtapa && !etapaEscolhida;
            const instalando = instalar.isPending && instalar.variables?.model_id === modelo.id;

            return (
              <li
                key={modelo.id}
                data-testid={`modelo-${modelo.id}`}
                className="flex flex-col gap-3 rounded-lg border border-border p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="neutral">{modelo.jornada}</Badge>
                      <h3 className="font-medium">{modelo.nome}</h3>
                    </div>
                    <p className="mt-1 text-sm text-text-muted">{t(modelo.resumo)}</p>
                  </div>
                  {jaInstalado && <Badge variant="success">{t("Já instalado")}</Badge>}
                </div>

                <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-muted">
                  <div className="flex items-center gap-1.5">
                    <PaperPlaneTilt size={13} aria-hidden />
                    <dt className="sr-only">{t("Mensagens")}</dt>
                    <dd>
                      {toquesDoModelo(modelo.grafo)} {t("mensagens, se ninguém responder")}
                    </dd>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Clock size={13} aria-hidden />
                    <dt className="sr-only">{t("Duração")}</dt>
                    <dd>
                      {t("acompanha por")} {horizonteLegivel(horizonteDoModeloMs(modelo.grafo))}
                    </dd>
                  </div>
                </dl>

                <p className="text-xs text-text-muted">
                  <span className="font-medium text-text">{t("Dispara quando")}:</span>{" "}
                  {t(modelo.oQueDispara)}
                </p>

                {modelo.pedeEtapa && (
                  <div className="space-y-1.5">
                    <Label htmlFor={`etapa-${modelo.id}`} className="text-xs">
                      {t("Etapa do funil que dispara")}
                    </Label>
                    <Select
                      value={etapaEscolhida ?? ""}
                      onValueChange={(v) =>
                        setEtapaPorModelo((antes) => ({ ...antes, [modelo.id]: v }))
                      }
                    >
                      <SelectTrigger id={`etapa-${modelo.id}`}>
                        <SelectValue
                          placeholder={
                            carregando ? t("Carregando etapas…") : t("Escolha a etapa")
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {porFunil.map((funil) => (
                          <SelectGroup key={funil.id}>
                            <SelectLabel>{funil.nome}</SelectLabel>
                            {funil.etapas.map((etapa) => (
                              // O nome da etapa sozinho não identifica a etapa:
                              // dois funis já bastam para nomes repetidos.
                              <SelectItem key={etapa.stageId} value={etapa.stageId}>
                                {etapa.stageName} · {etapa.pipelineName}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {erro?.modelo === modelo.id && (
                  <p role="alert" data-testid="erro-do-modelo" className="text-sm text-error-fg">
                    {erro.mensagem}
                  </p>
                )}

                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => aoInstalar(modelo)}
                    disabled={instalando || faltaEtapa}
                  >
                    {instalando ? t("Instalando…") : t("Instalar")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>

        <p className="rounded-md bg-surface-elevated p-3 text-xs text-text-muted">
          {t(
            "Depois de instalar: revise os textos no construtor, clique em Publicar e ligue o fluxo no seu agente (Agentes › Follow-up). Sem um agente publicado armando o fluxo, o gatilho automático não dispara.",
          )}
        </p>
      </DialogContent>
    </Dialog>
  );
}
