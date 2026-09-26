"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAgentMapping,
  type EtapaDoFunil,
  type MapaDoAgente,
} from "@/hooks/pipelines/useAgentMapping";
import {
  useArquivarEtapa,
  useCriarEtapa,
  useEditarEtapa,
  type PatchDeEtapa,
} from "@/hooks/pipelines/useStages";
import { LEAD_STAGES, type LeadStage } from "@/lib/agent-engine/agent/lead-state";
import { ApiError } from "@/lib/api/types";
import { ROTULO_DO_PASSO } from "@/lib/leads/agent-mapping";
import { Archive, CaretDown, CaretUp, Plus, Warning } from "@/lib/ui/icons";
import { SeloDeAutoria } from "@/components/operacao/SeloDeAutoria";
import { useT } from "@/hooks/i18n/useT";

import { mensagemDeErro } from "./_mapping";

/**
 * Onde o dono do negócio transforma o funil que veio de fábrica no funil dele.
 *
 * ⚠️ ESTA TELA EXISTE PORQUE O SISTEMA JÁ DECIDE POR QUEM INSTALA. O gatilho
 * `trg_seed_default_pipeline_for_org` semeia um funil de e-commerce em TODA
 * organização criada — uma clínica abre o produto e vê "Carrinho abandonado",
 * "Aguardando pagamento", "Em separacao". Até aqui não havia tela, rota nem
 * action que renomeasse, criasse ou tirasse uma etapa do quadro.
 *
 * ⚠️ AS REGRAS SÃO DA API; AQUI SÓ HÁ REFLEXO. Nada nesta tela recalcula o que
 * `lib/leads/stage-editing.ts` já decide — quando a operação é impossível, quem
 * diz é o servidor, e a frase dele (escrita para leigo, citando o nome da etapa)
 * vai inteira para a tela. O que a tela faz por conta própria é só o que ela
 * pode saber antes de perguntar: não OFERECER um destino que a API recusaria
 * (etapa de fechamento ou de perda receberia negócios e os daria por encerrados)
 * e avisar ANTES que marcar o fechamento aqui o tira de lá.
 *
 * ⚠️ ARQUIVAR É O ÚNICO "REMOVER" QUE EXISTE, e não é eufemismo:
 * `crm_leads_stage_id_fkey` é `ON DELETE RESTRICT` — o histórico dos negócios
 * aponta para a etapa e apagá-la levaria o histórico junto.
 */

/** A âncora desta seção. O mapeamento linka para cá quando aponta uma lacuna do funil. */
export const ancoraDasEtapas = (pipelineId: string) => `etapas-${pipelineId}`;

/** O papel de uma etapa no desfecho do negócio. `nenhum` é a maioria das colunas. */
export type Papel = "nenhum" | "won" | "lost";

/**
 * ⚠️ OS RÓTULOS SÓ FAZEM SENTIDO SOB O CABEÇALHO DA COLUNA («O que acontece
 * nesta coluna»), e é assim que foram escritos. A primeira versão dizia
 * «Nenhuma das duas» — correto em relação ao parágrafo do topo, e ilegível na
 * linha: um seletor solto dizendo "nenhuma das duas" faz o dono da clínica
 * perguntar "das duas o quê?". Se o cabeçalho sair, estes textos saem junto.
 */
const ROTULO_DO_PAPEL: Readonly<Record<Papel, string>> = {
  nenhum: "Nada especial",
  won: "Aqui o cliente fecha",
  lost: "Aqui o cliente desiste",
};

export function papelDaEtapa(etapa: EtapaDoFunil): Papel {
  if (etapa.is_won) return "won";
  if (etapa.is_lost) return "lost";
  return "nenhum";
}

/**
 * O papel escolhido traduzido no corpo do PATCH.
 *
 * ⚠️ SÓ O QUE MUDA VIAJA. Mandar `is_lost: false` numa etapa que já não é de
 * perda faria a API validar uma desmarcação que ninguém pediu — e ela recusa
 * desmarcação (o funil precisa de uma etapa de perda). O campo do papel que a
 * etapa ABANDONA entra de propósito: sem ele, virar a etapa de perda em etapa de
 * fechamento pediria "ganho e perda ao mesmo tempo".
 */
export function patchDePapel(etapa: EtapaDoFunil, papel: Papel): PatchDeEtapa {
  const patch: PatchDeEtapa = {};
  const querWon = papel === "won";
  const querLost = papel === "lost";
  if (etapa.is_won !== querWon) patch.is_won = querWon;
  if (etapa.is_lost !== querLost) patch.is_lost = querLost;
  return patch;
}

/**
 * As etapas que podem receber os negócios de uma que está sendo arquivada.
 *
 * ⚠️ FECHAMENTO E PERDA FICAM DE FORA, e o motivo é grave o bastante para não
 * ser detalhe de lista: `fn_crm_lead_close_on_stage` fecha o negócio pelo
 * estágio. Mandar N negócios para a etapa de fechamento os marcaria como
 * vendidos, com data de fechamento — receita mexida por alguém arrumando o
 * quadro. A API recusa; a tela nem oferece, porque oferecer é convidar ao erro.
 */
export function destinosPossiveis(etapas: EtapaDoFunil[], etapaId: string): EtapaDoFunil[] {
  return etapas.filter((e) => e.id !== etapaId && !e.is_won && !e.is_lost);
}

/**
 * O vizinho da ESQUERDA depois de mover a etapa uma casa (`null` = primeira coluna).
 *
 * É o que o PATCH espera: quem clica na seta sabe onde a coluna vai parar, não
 * qual fração de `position` isso vira. Subir uma casa é "passar a ficar depois
 * de quem estava DUAS casas atrás" — daí o `i - 2`.
 */
export function vizinhoAoMover(
  etapas: EtapaDoFunil[],
  i: number,
  direcao: "subir" | "descer",
): string | null {
  if (direcao === "subir") return etapas[i - 2]?.id ?? null;
  return etapas[i + 1]?.id ?? null;
}

/** Passo do assistente que cada etapa representa — `mapeamento` do avesso. */
function passoPorEtapa(mapa: MapaDoAgente): Map<string, LeadStage> {
  const m = new Map<string, LeadStage>();
  for (const passo of LEAD_STAGES) {
    const id = mapa[passo];
    if (id) m.set(id, passo);
  }
  return m;
}

/** "1 negócio", "4 negócios" — a tela recompõe a frase, então pluraliza como o servidor. */
export function contagemDeNegocios(
  n: number,
  t: (texto: string) => string = (texto) => texto,
): string {
  return `${n} ${n === 1 ? t("negócio") : t("negócios")}`;
}

/**
 * O que o 422 do arquivamento diz sobre o caso — contagem e QUAL regra recusou.
 *
 * ⚠️ `precisaDestino` VEM DO SERVIDOR, não é re-derivado aqui. A tela troca essa
 * recusa específica por uma pergunta; decidir isso por conta própria ("tem
 * negócio e não é de ganho/perda") faria qualquer recusa NOVA sobre uma etapa
 * comum com negócios sumir atrás da pergunta.
 */
function casoDoErro(e: unknown): { negocios: number | null; precisaDestino: boolean } {
  const d = e instanceof ApiError ? (e.details as Record<string, unknown> | undefined) : undefined;
  return {
    negocios: typeof d?.negocios === "number" ? d.negocios : null,
    precisaDestino: d?.precisa_destino === true,
  };
}

/** O que o painel de arquivamento está esperando do usuário. */
type Arquivamento = {
  etapaId: string;
  /** `null` enquanto a tela ainda não perguntou ao servidor quantos negócios há. */
  negocios: number | null;
  destino: string | null;
  erro: string | null;
};

/**
 * As larguras das colunas, em UM lugar só.
 *
 * O cabeçalho e a linha precisam medir igual — divergência faz cada rótulo
 * nomear a coluna errada, e nenhum teste pega isso (a prova mede o alinhamento
 * no navegador, mas só depois de alguém rodá-la). Constante compartilhada torna
 * a divergência impossível em vez de indetectável.
 */
// ⚠️ AS CLASSES SÃO LITERAIS INTEIRAS, com o prefixo `sm:` incluído: o Tailwind
// varre o texto-fonte, então `sm:${...}` montado por interpolação NÃO gera CSS.
// E o prefixo é o certo de qualquer jeito — no celular a linha empilha e largura
// fixa espremeria os controles.
const LARGURA = {
  chance: "sm:w-[124px]",
  ordem: "sm:w-[76px]",
  papel: "sm:w-56",
  arquivar: "sm:w-[104px]",
} as const;

/**
 * O texto de cada rótulo, em UM lugar só — porque ele aparece em DOIS.
 *
 * No desktop, como cabeçalho de coluna; no celular, em cima de cada controle da
 * linha empilhada. Duas cópias divergiriam e o celular ficaria com o texto
 * antigo, que é exatamente o defeito que estes rótulos existem para consertar.
 */
export const ROTULO = {
  nome: "Nome da coluna (clique para renomear)",
  chance: "Chance de fechamento (0 a 100)",
  ordem: "Ordem",
  papel: "O que acontece nesta coluna",
} as const;

export function StagesSection({
  pipelineId,
  ancoraMapeamento,
}: {
  pipelineId: string;
  /** Para onde mandar quem precisa desfazer o vínculo de uma etapa com o assistente. */
  ancoraMapeamento: string;
}) {
  const t = useT();
  const consulta = useAgentMapping(pipelineId);
  const criar = useCriarEtapa(pipelineId);
  const editar = useEditarEtapa(pipelineId);
  const arquivar = useArquivarEtapa(pipelineId);

  const [erro, setErro] = useState<
    { etapaId: string | null; texto: string; sobrePapel?: boolean } | null
  >(null);
  const [confirmacao, setConfirmacao] = useState<{ etapaId: string; papel: Papel; texto: string } | null>(null);
  const [arquivamento, setArquivamento] = useState<Arquivamento | null>(null);
  const [nova, setNova] = useState<string | null>(null);

  if (consulta.isError) {
    return (
      <p className="text-sm text-text-muted" data-testid="etapas-erro-leitura">
        {t("Não foi possível carregar as etapas deste funil agora. Recarregue a página.")}
      </p>
    );
  }
  if (!consulta.data) {
    return (
      <p className="text-sm text-text-muted" data-testid="etapas-carregando">
        {t("Carregando as etapas deste funil…")}
      </p>
    );
  }

  const etapas = consulta.data.etapas;
  const passos = passoPorEtapa(consulta.data.mapeamento);
  const ocupado = criar.isPending || editar.isPending || arquivar.isPending || consulta.isFetching;

  function aplicar(etapaId: string, patch: PatchDeEtapa) {
    if (Object.keys(patch).length === 0) return;
    setErro(null);
    setConfirmacao(null);
    // ⚠️ SÓ RECUSA DE PAPEL GANHA O LINK PARA O MAPEAMENTO. O vínculo com o
    // assistente é o que trava trocar ganho/perda; ele não tem nada a ver com
    // nome duplicado nem com ordem. Condicionar o link a "esta linha tem passo"
    // produzia o non sequitur "Já existe uma etapa chamada «Cancelado». Ir para
    // o mapeamento do assistente."
    const sobrePapel = patch.is_won !== undefined || patch.is_lost !== undefined;
    editar.mutate(
      { stageId: etapaId, patch },
      {
        onSuccess: () => toast.success(t("Etapa atualizada.")),
        onError: (e) => setErro({ etapaId, texto: mensagemDeErro(e, t), sobrePapel }),
      },
    );
  }

  function escolherPapel(etapa: EtapaDoFunil, papel: Papel) {
    const patch = patchDePapel(etapa, papel);
    if (Object.keys(patch).length === 0) return;

    // ⚠️ O AVISO CITA A ETAPA QUE PERDE A MARCAÇÃO, e é a única informação que
    // importa aqui: "só uma pode" é regra abstrata; «Pago» é a coluna que vai
    // deixar de fechar negócio quando ele confirmar.
    const atual = etapas.find((e) => e.id !== etapa.id && (papel === "won" ? e.is_won : e.is_lost));
    if ((papel === "won" || papel === "lost") && atual) {
      setErro(null);
      setConfirmacao({
        etapaId: etapa.id,
        papel,
        texto:
          papel === "won"
            ? `${t("Só uma etapa pode ser a de fechamento. Marcar esta desmarca")} «${atual.name}».`
            : `${t("Só uma etapa pode ser a de perda. Marcar esta desmarca")} «${atual.name}».`,
      });
      return;
    }
    aplicar(etapa.id, patch);
  }

  function pedirArquivamento(etapa: EtapaDoFunil, destino: string | null) {
    setErro(null);
    arquivar.mutate(
      { stageId: etapa.id, destinoId: destino },
      {
        onSuccess: () => {
          setArquivamento(null);
          toast.success(`«${etapa.name}» ${t("saiu do quadro.")}`);
        },
        onError: (e) => {
          // Negócios parados na etapa não é recusa final: é a pergunta "para
          // onde eles vão?" — e QUEM DIZ que é esse o caso é o servidor
          // (`precisa_destino`), não uma re-derivação daqui.
          const caso = casoDoErro(e);
          setArquivamento({
            etapaId: etapa.id,
            negocios: caso.negocios,
            destino: null,
            erro: caso.precisaDestino ? null : mensagemDeErro(e, t),
          });
        },
      },
    );
  }

  function criarEtapa() {
    const nome = (nova ?? "").trim();
    if (!nome) return;
    setErro(null);
    criar.mutate(nome, {
      onSuccess: () => {
        setNova(null);
        toast.success(`«${nome}» ${t("entrou no fim do funil.")}`);
      },
      onError: (e) => setErro({ etapaId: null, texto: mensagemDeErro(e, t) }),
    });
  }

  return (
    <div className="space-y-4" id={ancoraDasEtapas(pipelineId)} data-testid={`etapas-${pipelineId}`}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("Etapas deste funil")}</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-text-muted">
          {t(
            "Estas são as colunas do seu quadro, na ordem em que o cliente avança. Você pode renomear, criar, reordenar e arquivar.",
          )}
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-text-muted">
          {t("Duas colunas têm papel especial: a")} <strong>{t("de fechamento")}</strong>{" "}
          {t("é onde o negócio vira venda, e a")} <strong>{t("de perda")}</strong>{" "}
          {t(
            "é onde ele se perde. Cada funil precisa de uma de cada — por isso a marcação se muda de lugar, não se apaga.",
          )}
        </p>
      </div>

      {/* ⚠️ O CABEÇALHO NÃO É ENFEITE. Sem ele a linha tem um campo de texto sem
          rótulo, duas setas sem legenda e um seletor dizendo "Nada especial"
          sobre coisa nenhuma — a dona da clínica precisa adivinhar o que cada
          controle faz. No celular a linha EMPILHA e um cabeçalho de colunas não
          alinha com nada: lá o mesmo texto vai em cima de cada controle
          (`sm:hidden`, mesmas constantes). `aria-label` não substitui nenhum dos
          dois — é invisível para quem enxerga. */}
      {/* `border border-transparent`: a lista abaixo tem borda de 1px, que empurra
          o conteúdo dela 1px para dentro. Sem a mesma borda aqui, cada rótulo
          fica 1px à direita do controle que nomeia — medido, não estimado. */}
      <div
        className="hidden gap-3 border border-transparent px-4 text-xs font-medium text-text-muted sm:flex"
        data-testid="etapas-cabecalho"
      >
        <span className="w-6 shrink-0" />
        <span className="min-w-0 flex-1">{t(ROTULO.nome)}</span>
        <span className={`${LARGURA.chance} shrink-0`}>{t(ROTULO.chance)}</span>
        <span className={`${LARGURA.ordem} shrink-0 text-center`}>{t(ROTULO.ordem)}</span>
        <span className={`${LARGURA.papel} shrink-0`}>{t(ROTULO.papel)}</span>
        <span className={`${LARGURA.arquivar} shrink-0`} />
      </div>

      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {etapas.map((etapa, i) => {
          const passo = passos.get(etapa.id) ?? null;
          const erroDaLinha = erro?.etapaId === etapa.id ? erro.texto : null;
          const confirmandoAqui = confirmacao?.etapaId === etapa.id ? confirmacao : null;
          const arquivandoAqui = arquivamento?.etapaId === etapa.id ? arquivamento : null;
          const destinos = destinosPossiveis(etapas, etapa.id);

          return (
            <li
              key={`${etapa.id}:${etapa.name}`}
              className="flex flex-col gap-3 p-4"
              data-testid={`etapa-${etapa.id}`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <span className="w-6 shrink-0 text-xs tabular-nums text-text-muted">
                  {i + 1}.
                </span>

                {/* No empilhado, cada controle carrega o rótulo que no desktop
                    vive no cabeçalho — mesmas constantes, `sm:hidden`. */}
                <div className="min-w-0 flex-1 space-y-1">
                  <span className="block text-xs font-medium text-text-muted sm:hidden">
                    {t(ROTULO.nome)}
                  </span>
                  <NomeDaEtapa
                    etapa={etapa}
                    desabilitado={ocupado}
                    aoConfirmar={(nome) => aplicar(etapa.id, { name: nome })}
                  />
                </div>

                {/* A calibração da previsão (issue #1535). Ganho e perda valem
                    100 e 0 NA REGRA, então o campo fica desabilitado ali —
                    digitar um número seria uma promessa que a regra ignora. */}
                <div className={`${LARGURA.chance} shrink-0 space-y-1`}>
                  <span className="block text-xs font-medium text-text-muted sm:hidden">
                    {t(ROTULO.chance)}
                  </span>
                  <ProbabilidadeDaEtapa
                    key={`prob-${etapa.id}-${etapa.win_probability ?? "sem"}`}
                    etapa={etapa}
                    desabilitado={ocupado}
                    aoConfirmar={(valor) => aplicar(etapa.id, { win_probability: valor })}
                  />
                </div>

                {/* No empilhado o rótulo vai EM CIMA, como os outros dois: ao
                    lado, ele desalinhava com as setas (medido no celular:
                    rótulo em y=4893, setas em y=4883) e a linha ficava com três
                    rótulos em duas convenções diferentes. */}
                <div
                  className={`flex flex-col gap-1 ${LARGURA.ordem} shrink-0 sm:flex-row sm:items-center sm:justify-center sm:gap-1`}
                >
                  <span className="text-xs font-medium text-text-muted sm:hidden">
                    {t(ROTULO.ordem)}
                  </span>
                  <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${t("Mover")} «${etapa.name}» ${t("uma coluna para trás")}`}
                    data-testid={`subir-${etapa.id}`}
                    disabled={i === 0 || ocupado}
                    onClick={() =>
                      aplicar(etapa.id, { depois_de: vizinhoAoMover(etapas, i, "subir") })
                    }
                  >
                    <CaretUp size={16} aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${t("Mover")} «${etapa.name}» ${t("uma coluna para frente")}`}
                    data-testid={`descer-${etapa.id}`}
                    disabled={i === etapas.length - 1 || ocupado}
                    onClick={() =>
                      aplicar(etapa.id, { depois_de: vizinhoAoMover(etapas, i, "descer") })
                    }
                  >
                    <CaretDown size={16} aria-hidden />
                  </Button>
                  </div>
                </div>

                <div className={`w-full shrink-0 space-y-1 ${LARGURA.papel} sm:space-y-0`}>
                  <span className="block text-xs font-medium text-text-muted sm:hidden">
                    {t(ROTULO.papel)}
                  </span>
                  <Select
                    value={papelDaEtapa(etapa)}
                    onValueChange={(v) => escolherPapel(etapa, v as Papel)}
                    disabled={ocupado}
                  >
                    <SelectTrigger
                      aria-label={`${t("Papel de")} «${etapa.name}» ${t("no funil")}`}
                      data-testid={`papel-${etapa.id}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(["nenhum", "won", "lost"] as const).map((p) => (
                        <SelectItem key={p} value={p}>
                          {t(ROTULO_DO_PAPEL[p])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  className={`${LARGURA.arquivar} shrink-0`}
                  data-testid={`arquivar-${etapa.id}`}
                  disabled={ocupado}
                  onClick={() => {
                    setErro(null);
                    setArquivamento({ etapaId: etapa.id, negocios: null, destino: null, erro: null });
                  }}
                >
                  <Archive size={16} className="mr-1" aria-hidden />
                  {t("Arquivar")}
                </Button>
              </div>

              {/* Uma coluna que apareceu no quadro sem o dono ter criado precisa
                  dizer de onde veio — senão o assistente muda o funil e a única
                  pista fica no log que nenhuma tela lê. */}
              <SeloDeAutoria
                kind={etapa.last_change_actor_kind ?? null}
                em={etapa.last_change_at ?? null}
                className={`etapa-autoria-${etapa.id}`}
              />

              {passo && (
                <p className="text-xs text-text-muted" data-testid={`passo-de-${etapa.id}`}>
                  {t("O assistente usa esta etapa para")} «{t(ROTULO_DO_PASSO[passo])}».{" "}
                  <a className="underline underline-offset-2" href={`#${ancoraMapeamento}`}>
                    {t("Mudar isso")}
                  </a>
                </p>
              )}

              {confirmandoAqui && (
                <Card
                  className="flex flex-col gap-3 border-warning bg-warning-bg p-4"
                  data-testid={`confirmar-papel-${etapa.id}`}
                >
                  <p className="text-sm leading-relaxed">{confirmandoAqui.texto}</p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      data-testid={`confirmar-papel-sim-${etapa.id}`}
                      onClick={() => aplicar(etapa.id, patchDePapel(etapa, confirmandoAqui.papel))}
                    >
                      {t("Marcar mesmo assim")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmacao(null)}>
                      {t("Cancelar")}
                    </Button>
                  </div>
                </Card>
              )}

              {arquivandoAqui && (
                <Card
                  className="flex flex-col gap-3 border-border p-4"
                  data-testid={`arquivar-painel-${etapa.id}`}
                >
                  {arquivandoAqui.erro ? (
                    <p className="text-sm leading-relaxed" data-testid={`arquivar-erro-${etapa.id}`}>
                      {arquivandoAqui.erro}
                    </p>
                  ) : arquivandoAqui.negocios === null ? (
                    <p className="text-sm leading-relaxed">
                      {t("Arquivar")} «{etapa.name}»?{" "}
                      {t(
                        "A coluna sai do quadro e para de receber negócios novos. Nada é apagado — o histórico de quem passou por ela continua guardado —, mas",
                      )}{" "}
                      <strong>{t("não dá para trazer a coluna de volta por aqui")}</strong>.
                    </p>
                  ) : destinos.length === 0 ? (
                    // Sem destino possível não há pergunta a fazer — e mandar
                    // escolher entre nada seria um beco sem saída.
                    <p className="text-sm leading-relaxed" data-testid={`arquivar-sem-destino-${etapa.id}`}>
                      {contagemDeNegocios(arquivandoAqui.negocios, t)}{" "}
                      {arquivandoAqui.negocios === 1
                        ? t("está nesta etapa e não há outra coluna em aberto para recebê-lo.")
                        : t(
                            "estão nesta etapa e não há outra coluna em aberto para recebê-los.",
                          )}{" "}
                      {t("Crie uma etapa antes de arquivar")} «{etapa.name}».
                    </p>
                  ) : (
                    <>
                      <p className="text-sm leading-relaxed" data-testid={`arquivar-pergunta-${etapa.id}`}>
                        {contagemDeNegocios(arquivandoAqui.negocios, t)}{" "}
                        {arquivandoAqui.negocios === 1
                          ? t("está nesta etapa. Para onde ele vai?")
                          : t("estão nesta etapa. Para onde eles vão?")}
                      </p>
                      <div className="sm:w-72">
                        <Select
                          value={arquivandoAqui.destino ?? ""}
                          onValueChange={(v) =>
                            setArquivamento({ ...arquivandoAqui, destino: v })
                          }
                        >
                          <SelectTrigger
                            aria-label={`${t("Para onde vão os negócios de")} «${etapa.name}»`}
                            data-testid={`destino-${etapa.id}`}
                          >
                            <SelectValue placeholder={t("Escolha a etapa")} />
                          </SelectTrigger>
                          <SelectContent>
                            {destinos.map((d) => (
                              <SelectItem key={d.id} value={d.id}>
                                {d.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  )}

                  {/* ⚠️ A SEGUNDA IRREVERSIBILIDADE, e ela era silenciosa.
                      `validarArquivamento` recusa arquivar a etapa de ganho/perda,
                      mas NÃO olha `agent_stage_hint`, e o DELETE não limpa o hint —
                      `resolveDestinoDoAgente` procura o alvo com `!is_archived`,
                      então arquivar simplesmente desliga esse passo do assistente.
                      O mapeamento volta sozinho para «não mover o card», ninguém é
                      avisado, e como a coluna não volta o vínculo só se refaz
                      escolhendo OUTRA etapa. Avisar da coluna e calar sobre isto era
                      contar metade. */}
                  {passo && !arquivandoAqui.erro && (
                    <p
                      className="text-sm leading-relaxed text-warning-fg"
                      data-testid={`arquivar-perde-passo-${etapa.id}`}
                    >
                      {t("Esta etapa é a que o assistente usa para")} «{t(ROTULO_DO_PASSO[passo])}».{" "}
                      {t(
                        "Arquivando, ele para de mover o card nesse passo até você escolher outra etapa em",
                      )}{" "}
                      <a className="underline underline-offset-2" href={`#${ancoraMapeamento}`}>
                        «{t("Para onde o card vai em cada passo")}»
                      </a>
                      .
                    </p>
                  )}

                  <div className="flex gap-2">
                    {!arquivandoAqui.erro && !(arquivandoAqui.negocios !== null && destinos.length === 0) && (
                      <Button
                        size="sm"
                        data-testid={`arquivar-confirmar-${etapa.id}`}
                        // Com negócios na etapa, arquivar sem destino não é
                        // oferecido: perder o rastro deles não pode ser um
                        // clique de distância.
                        disabled={
                          ocupado ||
                          (arquivandoAqui.negocios !== null && !arquivandoAqui.destino)
                        }
                        onClick={() => pedirArquivamento(etapa, arquivandoAqui.destino)}
                      >
                        {arquivandoAqui.negocios === null
                          ? t("Arquivar")
                          : t("Mover os negócios e arquivar")}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setArquivamento(null)}>
                      {arquivandoAqui.erro ? t("Fechar") : t("Cancelar")}
                    </Button>
                  </div>
                </Card>
              )}

              {erroDaLinha && (
                <Card
                  className="flex items-start gap-3 border-warning bg-warning-bg p-4"
                  data-testid={`etapa-erro-${etapa.id}`}
                >
                  <Warning size={18} className="mt-0.5 shrink-0 text-warning-fg" aria-hidden />
                  <p className="text-sm leading-relaxed">
                    {erroDaLinha}
                    {passo && erro?.sobrePapel && (
                      <>
                        {" "}
                        <a className="underline underline-offset-2" href={`#${ancoraMapeamento}`}>
                          {t("Ir para o mapeamento do assistente")}
                        </a>
                        .
                      </>
                    )}
                  </p>
                </Card>
              )}
            </li>
          );
        })}
      </ul>

      {nova === null ? (
        <Button variant="ghost" size="sm" data-testid="nova-etapa" onClick={() => setNova("")}>
          <Plus size={16} className="mr-1" aria-hidden />
          {t("Acrescentar etapa ao fim")}
        </Button>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            autoFocus
            value={nova}
            maxLength={80}
            placeholder={t("Nome da nova coluna")}
            aria-label={t("Nome da nova etapa")}
            data-testid="nova-etapa-nome"
            onChange={(e) => setNova(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") criarEtapa();
              if (e.key === "Escape") setNova(null);
            }}
            className="sm:w-72"
          />
          <Button
            size="sm"
            data-testid="nova-etapa-criar"
            disabled={ocupado || nova.trim().length === 0}
            onClick={criarEtapa}
          >
            {t("Criar")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNova(null)}>
            {t("Cancelar")}
          </Button>
        </div>
      )}

      {erro?.etapaId === null && (
        <Card
          className="flex items-start gap-3 border-warning bg-warning-bg p-4"
          data-testid="etapas-erro"
        >
          <Warning size={18} className="mt-0.5 shrink-0 text-warning-fg" aria-hidden />
          <p className="text-sm leading-relaxed">{erro.texto}</p>
        </Card>
      )}
    </div>
  );
}

/**
 * O nome da etapa, editado no lugar.
 *
 * ⚠️ SALVA AO CONFIRMAR (Enter ou sair do campo), NUNCA A CADA TECLA: um PATCH
 * por caractere gravaria "P", "Pr", "Pro"… no banco e faria a validação de nome
 * duplicado disparar no meio da digitação. O rascunho é local; a fonte da verdade
 * continua sendo o servidor — a linha inteira é remontada quando o nome gravado
 * muda (`key` da `li`), então uma edição feita em outra aba não fica escondida
 * atrás de um rascunho velho.
 */
/**
 * A probabilidade de ganho da etapa, editada no lugar (0–100).
 *
 * Mesmo contrato do nome: salva ao CONFIRMAR (Enter ou sair do campo), nunca a
 * cada tecla. Vazio = sem calibração — e limpar é um valor legítimo, não um
 * apagão acidental: a previsão passa a reportar a etapa no balde "sem
 * probabilidade" em vez de somar zero.
 *
 * `key` na linha de cima remonta o campo quando o valor GRAVADO muda, então uma
 * edição de outra aba não fica escondida atrás de um rascunho velho.
 */
function ProbabilidadeDaEtapa({
  etapa,
  desabilitado,
  aoConfirmar,
}: {
  etapa: EtapaDoFunil;
  desabilitado: boolean;
  aoConfirmar: (valor: number | null) => void;
}) {
  const t = useT();
  const [rascunho, setRascunho] = useState(
    etapa.win_probability == null ? "" : String(etapa.win_probability),
  );
  // Ganho e perda valem 100 e 0 na regra (`lib/leads/previsao.ts`): o número
  // gravado ali seria lido por ninguém e entenderia mal quem lê a tela.
  const fixa = etapa.is_won || etapa.is_lost;

  function confirmar() {
    const bruto = rascunho.trim().replace(/%$/, "");
    if (bruto === "") {
      if (etapa.win_probability != null) aoConfirmar(null);
      else setRascunho("");
      return;
    }
    const numero = Number(bruto);
    if (!Number.isInteger(numero) || numero < 0 || numero > 100) {
      setRascunho(etapa.win_probability == null ? "" : String(etapa.win_probability));
      toast.error(t("A chance de fechamento vai de 0 a 100."));
      return;
    }
    if (numero === etapa.win_probability) return;
    aoConfirmar(numero);
  }

  return (
    <Input
      type="number"
      min={0}
      max={100}
      step={1}
      inputMode="numeric"
      value={rascunho}
      disabled={desabilitado || fixa}
      placeholder={fixa ? (etapa.is_won ? "100" : "0") : "—"}
      title={
        fixa
          ? t("Etapa de fechamento ou de perda: a chance vale 100 e 0 na regra, sem calibração.")
          : t(ROTULO.chance)
      }
      aria-label={`${t(ROTULO.chance)} «${etapa.name}»`}
      data-testid={`probabilidade-${etapa.id}`}
      onChange={(e) => setRascunho(e.target.value)}
      onBlur={confirmar}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setRascunho(etapa.win_probability == null ? "" : String(etapa.win_probability));
          e.currentTarget.blur();
        }
      }}
      className="w-full"
    />
  );
}

function NomeDaEtapa({
  etapa,
  desabilitado,
  aoConfirmar,
}: {
  etapa: EtapaDoFunil;
  desabilitado: boolean;
  aoConfirmar: (nome: string) => void;
}) {
  const t = useT();
  const [rascunho, setRascunho] = useState(etapa.name);

  function confirmar() {
    const nome = rascunho.trim();
    if (!nome || nome === etapa.name) {
      setRascunho(etapa.name);
      return;
    }
    aoConfirmar(nome);
  }

  return (
    <Input
      value={rascunho}
      maxLength={80}
      disabled={desabilitado}
      aria-label={`${t("Nome da etapa")} «${etapa.name}»`}
      data-testid={`nome-${etapa.id}`}
      onChange={(e) => setRascunho(e.target.value)}
      onBlur={confirmar}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setRascunho(etapa.name);
          e.currentTarget.blur();
        }
      }}
      className="min-w-0 flex-1"
    />
  );
}
