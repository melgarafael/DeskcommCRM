"use client";

/**
 * O cartão "Jev — decisões rápidas", no painel de provedores.
 *
 * O Jev não conversa com o cliente — só decide coisas pequenas, e hoje só uma:
 * se o cliente está irritado. Por isso ele não aparece no "Modelo padrão" nem
 * no seletor de cada ponto (escolhido ali, todo atendimento morreria), e ganha
 * este cartão, que leva quem nunca ouviu falar dele da chave até os números:
 * pegar a chave, colar, testar, concordar com o envio para fora do país, ligar,
 * comparar com a IA de sempre e, só então, deixá-lo decidir.
 *
 * Os dados vêm de `GET /api/v1/ai/jev`; o estado mostrado é derivado deles, e
 * nunca guardado aqui, para a tela não discordar da rota que o worker obedece.
 *
 * Ligado, ele lista as TAREFAS (`lib/ai/decisao/tarefas.ts`), cada uma com o
 * seu estado e o seu "Deixar o Jev decidir": deixar decidir o clima não é
 * deixar decidir a tarefa seguinte.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { AddCredentialDialog } from "@/app/app/ai/credentials/_components/AddCredentialDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { descreverErroDeValidacao } from "@/lib/ai/credenciais/erro-de-validacao";
import type { EstadoDaTarefa } from "@/lib/ai/decisao/config";
import { PROVEDOR_DO_JEV } from "@/lib/ai/decisao/credencial";
import { TAREFA_DO_CLIMA, TAREFAS_DO_JEV } from "@/lib/ai/decisao/tarefas";
import { O_QUE_FAZER_DO_JEV } from "@/lib/ai/decisao/textos";

/** O corpo de `GET /api/v1/ai/jev` (`app/api/v1/ai/jev/route.ts`). */
export interface DadosDoJev {
  provedor: { rotulo: string; quandoUsar: string; ondePegarAChave: string; prefixoDaChave: string };
  chave: {
    existe: boolean;
    validada: boolean;
    credencial_id: string | null;
    rotulo: string | null;
    erro_de_validacao: string | null;
  };
  config: {
    ligado: boolean;
    modo: "observacao" | "decide";
    aceite: { em: string; por: string } | null;
  };
  tarefas: Array<{ id: string; rotulo: string; oQueOJevFaz: string }>;
  /**
   * O estado de cada tarefa, como a rota o resolve. Ausente na resposta da
   * imagem anterior (a página aberta durante um rollback): nela a única tarefa
   * é o clima, e o estado dele é o `modo`.
   */
  por_tarefa?: TarefaNoCartao[];
  tem_ia_de_sempre: boolean;
  numeros: {
    dias: number;
    decisoes: number;
    /** `null` quando nenhuma medição tem preço conhecido. */
    custo_cents: number | null;
    /** Alguma medição veio de uma versão sem preço na tabela: a soma é parcial. */
    custo_incompleto: boolean;
    latencia_media_ms: number | null;
    reservas: number;
    /** Conversas em que a nota do Jev ficou abaixo do corte da passagem para humano. */
    irritados: number;
    observacao: {
      dias: number;
      comparadas: number;
      concordaram: number;
      /** Só a manipulação: em quantas das comparadas SÓ o Jev deu o alerta forte. */
      so_o_jev_alto?: number;
      /** Só o clima: a conta usou as N mensagens mais recentes, não o período inteiro. */
      teto_da_amostra?: number;
    };
  };
  /** `tarefa`: o rótulo da tarefa que falhou. Ausente na imagem anterior. */
  ultima_falha: { motivo: string | null; em: string; tarefa?: string | null } | null;
  pode_editar: boolean;
}

export interface TarefaNoCartao {
  id: string;
  ponto: string | null;
  rotulo: string;
  oQueFaz: string;
  estado: EstadoDaTarefa;
  /** O estado em que ela fica se o Jev for ligado agora. Ausente, o clima volta pelo `modo`. */
  ao_ligar?: EstadoDaTarefa;
  /** Começou sozinha e ninguém escolheu nada ainda. */
  novo: boolean;
  /**
   * A concordância dela com a IA de sempre nos últimos dias. Ausente na
   * resposta da imagem anterior: lá só o clima a tinha, em `numeros.observacao`.
   */
  observacao?: Concordancia | null;
  /**
   * A camada de segurança que ela acompanha está desligada para a empresa: o
   * turno não pergunta, e ela não roda em estado nenhum. Ausente na imagem anterior.
   */
  sem_camada?: boolean;
  /**
   * A do roteador numa empresa sem roteador de intenção ativo: o turno não
   * escolhe agente, e ela não tem o que comparar. Ausente na imagem anterior.
   */
  sem_roteador?: boolean;
}

/** Algo fora do Jev a impede de rodar em qualquer estado — a camada, ou o roteador. */
const parada = (t: TarefaNoCartao) => t.sem_camada === true || t.sem_roteador === true;

/** A tarefa pode rodar agora — não está desligada nem parada. */
const roda = (t: TarefaNoCartao) => t.estado !== "desligada" && !parada(t);

type Concordancia = DadosDoJev["numeros"]["observacao"];

/** A concordância da tarefa — a do clima ainda vem em `numeros` na imagem anterior. */
function concordanciaDa(tarefa: TarefaNoCartao, d: DadosDoJev): Concordancia | null {
  return tarefa.observacao ?? (tarefa.id === TAREFA_DO_CLIMA.id ? d.numeros.observacao : null);
}

/**
 * Como a tarefa volta ao ligar o Jev (`ao_ligar`, da rota). Na resposta da
 * imagem anterior só o clima existe, pelo `modo` — que sozinho mentia: o clima
 * desligado guarda o `modo` de antes, e o cartão prometia "volta decidindo".
 */
function estadoAoLigar(tarefa: TarefaNoCartao, d: DadosDoJev): EstadoDaTarefa {
  if (tarefa.ao_ligar) return tarefa.ao_ligar;
  if (tarefa.id === TAREFA_DO_CLIMA.id) return d.config.modo === "decide" ? "decidindo" : "observando";
  return "observando";
}

function tarefasDoCartao(d: DadosDoJev): TarefaNoCartao[] {
  if (d.por_tarefa) return d.por_tarefa;
  return [
    {
      id: TAREFA_DO_CLIMA.id,
      ponto: TAREFA_DO_CLIMA.ponto,
      rotulo: TAREFA_DO_CLIMA.rotulo,
      oQueFaz: TAREFA_DO_CLIMA.oQueFaz,
      estado: d.config.modo === "decide" ? "decidindo" : "observando",
      novo: false,
    },
  ];
}

/**
 * O corpo do PATCH que põe a tarefa num estado. O clima muda pelo `modo`, o
 * nome da onda 1: com a página aberta durante um rollback, a imagem anterior
 * entende o pedido — e `{ tarefa: "clima" }` chegaria ao mesmo lugar nesta.
 * Pausar não tem nome no `modo`, e vai sempre por `tarefa`.
 */
function corpoDaMudanca(tarefa: TarefaNoCartao, estado: EstadoDaTarefa) {
  if (tarefa.id === TAREFA_DO_CLIMA.id && estado !== "desligada") {
    return { modo: estado === "decidindo" ? "decide" : "observacao" };
  }
  return { tarefa: tarefa.id, estado };
}

type Estado =
  | "sem_chave"
  | "chave_nao_validada"
  | "pronto"
  | "observando"
  | "decidindo"
  | "sozinho"
  | "em_pausa"
  | "parado";

function estadoDoJev(d: DadosDoJev): Estado {
  if (d.config.ligado) {
    // Ligado sem chave que passou no teste, o Jev não mede nada (o worker só
    // usa chave validada). Um selo "Decidindo" aqui afirmaria o contrário.
    if (!d.chave.validada) return "parado";
    // Pelo estado de cada TAREFA, e não pelo `modo`: o clima desligado sozinho
    // guarda o `modo` de antes, e um "Observando" aqui afirmaria que ele mede.
    const tarefas = tarefasDoCartao(d);
    const clima = tarefas.find((t) => t.id === TAREFA_DO_CLIMA.id);
    // Sem a IA de sempre não há com quem comparar nem quem cubra: o worker
    // deixa o Jev decidir o clima qualquer que seja o estado — menos desligado.
    if (!d.tem_ia_de_sempre && clima && clima.estado !== "desligada") return "sozinho";
    // A tarefa parada pela camada não mede nada: não faz o cartão observar nem decidir.
    const rodando = tarefas.filter(roda);
    if (rodando.some((t) => t.estado === "decidindo")) return "decidindo";
    if (rodando.some((t) => t.estado === "observando")) return "observando";
    return "em_pausa";
  }
  if (!d.chave.existe) return "sem_chave";
  if (!d.chave.validada) return "chave_nao_validada";
  return "pronto";
}

/**
 * "Decidindo" com uma tarefa ainda só observando. O selo e a frase do cartão
 * inteiro não podem falar por todas: o clima observando com a manipulação
 * decidindo é o caminho natural depois do selo "Novo" e de um clique.
 */
function decideEmParte(d: DadosDoJev): boolean {
  return tarefasDoCartao(d).some((t) => roda(t) && t.estado === "observando");
}

/**
 * A tarefa no registro: é dela a frase do "Decide" (`aoDecidir`,
 * `aoDecidirNoPonto`) — o que decidir quer dizer muda de uma tarefa para outra.
 */
const doRegistro = (tarefaId: string) => TAREFAS_DO_JEV.find((x) => x.id === tarefaId);

/**
 * Como o Jev está no ponto `pontoId`, para a linha do cartão do ponto — pelo
 * estado da tarefa dele. Decidindo, a linha é a da tarefa (`aoDecidirNoPonto`):
 * "o modelo abaixo é a reserva" só é verdade no clima.
 */
export function jevNoPonto(
  d: DadosDoJev | null,
  pontoId: string,
): "observacao" | "sozinho" | { decide: string } | null {
  if (!d?.config.ligado || !d.chave.validada) return null;
  const tarefa = tarefasDoCartao(d).find((t) => t.ponto === pontoId);
  if (!tarefa || !roda(tarefa)) return null;
  // A IA de sempre é a do clima (`tem_ia_de_sempre`), e só o clima decide sem ela (DEC-012 #5).
  if (!d.tem_ia_de_sempre && tarefa.id === TAREFA_DO_CLIMA.id) return "sozinho";
  if (tarefa.estado !== "decidindo") return "observacao";
  const frase = doRegistro(tarefa.id)?.aoDecidirNoPonto;
  return frase === undefined ? null : { decide: frase };
}

type Resposta = { data?: DadosDoJev; error?: { message?: string } };

/**
 * Uma leitura da rota. A recusa dela já vem escrita para leigo; o que o
 * navegador diz numa falha de rede ("Failed to fetch") é inglês e não diz nada,
 * e um corpo sem mensagem (proxy) não tem o que mostrar além do fato.
 */
async function buscarDadosDoJev(
  t: (texto: string) => string,
): Promise<{ dados: DadosDoJev } | { erro: string }> {
  try {
    const res = await fetch("/api/v1/ai/jev");
    const json = (await res.json().catch(() => null)) as Resposta | null;
    if (res.ok && json?.data) return { dados: json.data };
    return { erro: json?.error?.message ? t(json.error.message) : t("Não consegui carregar o cartão agora.") };
  } catch {
    return { erro: t("Não consegui falar com o servidor. Confira a internet e tente de novo.") };
  }
}

/** Carrega o cartão. Mora no painel porque o cartão do ponto também o lê. */
export function useDadosDoJev() {
  const t = useT();
  const [dados, setDados] = useState<DadosDoJev | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const aplicar = useCallback((r: { dados: DadosDoJev } | { erro: string }) => {
    if ("erro" in r) {
      setErro(r.erro);
      return;
    }
    setErro(null);
    setDados(r.dados);
  }, []);

  const recarregar = useCallback(async () => aplicar(await buscarDadosDoJev(t)), [aplicar, t]);

  useEffect(() => {
    // A primeira leitura resolve DEPOIS do efeito (nada de setState no corpo
    // dele), e a resposta de um cartão já desmontado é descartada.
    let vivo = true;
    void buscarDadosDoJev(t).then((r) => {
      if (vivo) aplicar(r);
    });
    return () => {
      vivo = false;
    };
  }, [aplicar, t]);

  return { dados, erro, recarregar };
}

export function CartaoDoJev({
  dados,
  erro,
  recarregar,
}: {
  dados: DadosDoJev | null;
  erro: string | null;
  recarregar: () => Promise<void>;
}) {
  const t = useT();

  if (erro) {
    return (
      <Card className="mb-6 border-destructive/40 p-4" data-testid="cartao-do-jev">
        <h2 className="text-base font-semibold">{t("Não consegui carregar o cartão do Jev")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{erro}</p>
        <Button className="mt-3" size="sm" variant="outline" onClick={() => void recarregar()}>
          {t("Tentar de novo")}
        </Button>
      </Card>
    );
  }
  // Sem esqueleto: o cartão entra pronto, e o resto do painel não espera por ele.
  if (!dados) return null;

  const estado = estadoDoJev(dados);
  const ligado = dados.config.ligado;

  return (
    <Card className="mb-6 p-4" data-testid="cartao-do-jev" data-estado={estado}>
      {/* No celular o selo desce para baixo do título e a descrição ocupa a
          largura toda: lado a lado, o selo espremia o texto numa coluna
          estreita (medido a 375 px). Do `sm` para cima, selo à direita. */}
      <div className="grid gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto]">
        <h2 className="text-base font-semibold">{t("Jev — decisões rápidas")}</h2>
        <div className="sm:col-start-2 sm:row-start-1">
          <SeloDoEstado estado={estado} emParte={estado === "decidindo" && decideEmParte(dados)} />
        </div>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t(dados.provedor.quandoUsar)}</p>
      </div>

      {/* Depois de colar a chave nada confirmava que ela FUNCIONA: esta linha é
          o resultado do teste, dito em palavras (o ✓ é enfeite). */}
      {dados.chave.validada && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-success-fg" data-testid="jev-chave-conferida">
          <span aria-hidden>✓</span>
          {t("Chave conferida com a TypeSafe")}
        </p>
      )}

      {estado === "sem_chave" && <SemChave dados={dados} recarregar={recarregar} />}

      {/* Também com o Jev ligado: chave girada para uma que não passa, ou
          desativada, deixa-o mudo, e é aqui que a pessoa descobre por quê. */}
      {!dados.chave.validada && (dados.chave.existe || ligado) && (
        <ProblemaDaChave dados={dados} recarregar={recarregar} />
      )}

      {estado === "pronto" && <ProntoParaLigar dados={dados} recarregar={recarregar} />}

      {/* A falta da IA principal NÃO é avisada aqui: o topo da página já a
          avisa, e a linha de estado ("Decidindo sozinho — …") explica o efeito
          no Jev. Repetida dentro do cartão, com o Jev funcionando, lia-se como
          erro dele. */}

      {ligado && <Ligado dados={dados} estado={estado} recarregar={recarregar} />}

      {!dados.pode_editar && estado !== "sem_chave" && (
        <p className="mt-3 text-xs text-muted-foreground">{t("Só quem administra a empresa pode mudar o Jev.")}</p>
      )}
    </Card>
  );
}

function SeloDoEstado({ estado, emParte }: { estado: Estado; emParte: boolean }) {
  const t = useT();
  if (estado === "observando") return <Badge variant="info">{t("Observando")}</Badge>;
  if (estado === "decidindo") return <Badge variant="success">{emParte ? t("Decide em parte") : t("Decidindo")}</Badge>;
  if (estado === "sozinho") return <Badge variant="warning">{t("Decidindo sozinho")}</Badge>;
  if (estado === "parado") return <Badge variant="warning">{t("Parado")}</Badge>;
  if (estado === "em_pausa") return <Badge variant="neutral">{t("Em pausa")}</Badge>;
  return <Badge variant="neutral">{t("Desligado")}</Badge>;
}

function SemChave({ dados, recarregar }: { dados: DadosDoJev; recarregar: () => Promise<void> }) {
  const t = useT();
  const [colando, setColando] = useState(false);

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button asChild size="sm" variant="outline">
        <a href={dados.provedor.ondePegarAChave} target="_blank" rel="noreferrer">
          {t("Pegar a chave na TypeSafe")}
        </a>
      </Button>
      {dados.pode_editar ? (
        <>
          <Button size="sm" onClick={() => setColando(true)}>
            {t("Colar a chave")}
          </Button>
          <AddCredentialDialog
            open={colando}
            onOpenChange={setColando}
            providerInicial={PROVEDOR_DO_JEV}
            aoSalvar={() => {
              void recarregar();
              // O teste da chave roda depois da resposta (ver a rota de criar), com
              // teto de 5 s: as releituras pegam o resultado sem a pessoa
              // recarregar a tela, até no teste mais lento.
              setTimeout(() => void recarregar(), 3000);
              setTimeout(() => void recarregar(), 8000);
            }}
          />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("Só quem administra a empresa pode colar a chave e ligar o Jev.")}
        </p>
      )}
      {/* O Jev é pago à parte, numa conta da TypeSafe: sem esta frase a pessoa
          só descobria o crédito pela falha. */}
      <p className="w-full text-xs text-muted-foreground" data-testid="jev-como-pegar-a-chave">
        {t(
          "Para pegar a chave, você cria uma conta na TypeSafe AI e põe crédito: cada mensagem medida custa uma fração de centavo de dólar, cobrada lá. A chave começa com",
        )}{" "}
        <span className="font-mono">{dados.provedor.prefixoDaChave}</span>
      </p>
    </div>
  );
}

function ProblemaDaChave({ dados, recarregar }: { dados: DadosDoJev; recarregar: () => Promise<void> }) {
  const t = useT();
  const [testando, setTestando] = useState(false);
  const erro = descreverErroDeValidacao(dados.chave.erro_de_validacao, PROVEDOR_DO_JEV);
  const motivo = !dados.chave.existe
    ? t("O Jev está ligado, mas sem chave ativa: enquanto isso, ele não mede nada.")
    : !dados.chave.erro_de_validacao
      ? dados.pode_editar
        ? t("A chave está sendo testada. Se esta mensagem não sumir em alguns segundos, clique em “Testar de novo”.")
        : t("A chave está sendo testada. Se esta mensagem não sumir em alguns segundos, recarregue a página.")
      : erro.generico
        ? t("Não consegui testar a chave. Tente de novo em instantes.")
        : t(erro.frase);

  async function testar() {
    setTestando(true);
    try {
      const res = await fetch(`/api/v1/ai/credentials/${dados.chave.credencial_id}/revalidate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const json = (await res.json().catch(() => null)) as {
        data?: { validated_at: string | null };
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        toast.error(
          json?.error?.message
            ? t(json.error.message)
            : t("Não consegui testar a chave agora. Tente de novo em instantes."),
        );
      }
      else if (json?.data?.validated_at) toast.success(t("A chave passou no teste."));
      else toast.error(t("A chave não passou no teste."));
      await recarregar();
    } catch {
      toast.error(t("não consegui falar com o servidor"));
    } finally {
      setTestando(false);
    }
  }

  return (
    <div className="mt-4 rounded-md bg-warning-bg p-3 text-sm text-warning-fg" data-testid="jev-chave">
      {/* O código cru fica no `title`, para quem for investigar — nunca na frase. */}
      <p title={dados.chave.erro_de_validacao ?? undefined}>{motivo}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {dados.pode_editar && dados.chave.credencial_id && (
          <Button size="sm" variant="outline" disabled={testando} onClick={() => void testar()}>
            {testando ? t("Testando…") : t("Testar de novo")}
          </Button>
        )}
        {/* "Gere uma nova" precisa de caminho: a chave recusada leva à TypeSafe. */}
        {erro.chaveErrada && (
          <a
            className="text-xs underline underline-offset-4"
            href={dados.provedor.ondePegarAChave}
            target="_blank"
            rel="noreferrer"
          >
            {t("Pegar uma chave nova na TypeSafe")}
          </a>
        )}
        <Link className="text-xs underline underline-offset-4" href="/app/ai/credentials">
          {t("Trocar a chave em Credenciais")}
        </Link>
      </div>
    </div>
  );
}

/** Um PATCH na rota do Jev, com o aviso de volta e a releitura do cartão. */
function useMudarOJev(recarregar: () => Promise<void>) {
  const t = useT();
  const [enviando, setEnviando] = useState(false);

  async function mudar(corpo: Record<string, unknown>, sucesso: string) {
    setEnviando(true);
    try {
      const res = await fetch("/api/v1/ai/jev", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corpo),
      });
      const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        // A recusa da rota já vem escrita para leigo e no idioma de quem pediu.
        toast.error(json?.error?.message ? t(json.error.message) : t("não consegui salvar"));
        return;
      }
      toast.success(sucesso);
      await recarregar();
    } catch {
      toast.error(t("não consegui falar com o servidor"));
    } finally {
      setEnviando(false);
    }
  }

  return { mudar, enviando };
}

function ProntoParaLigar({ dados, recarregar }: { dados: DadosDoJev; recarregar: () => Promise<void> }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const { mudar, enviando } = useMudarOJev(recarregar);
  const [concordo, setConcordo] = useState(false);
  // O aceite é da empresa, e vale uma vez (D6): religar não pergunta de novo.
  const aceite = dados.config.aceite;
  const pedeAceite = aceite === null;
  // Cada tarefa diz como volta — a frase única de antes falava do clima como se
  // fosse o Jev inteiro, e errava quando as outras tarefas voltavam diferentes.
  const tarefas = tarefasDoCartao(dados).map((tarefa) => ({ tarefa, aoLigar: estadoAoLigar(tarefa, dados) }));
  const doClima = tarefas.find(({ tarefa }) => tarefa.id === TAREFA_DO_CLIMA.id);
  const climaSozinho = !dados.tem_ia_de_sempre && doClima !== undefined && doClima.aoLigar !== "desligada";
  const climaPausadoSemIa = !dados.tem_ia_de_sempre && doClima?.aoLigar === "desligada";
  const algumaDecide = tarefas.some(({ tarefa, aoLigar }) => aoLigar === "decidindo" && !parada(tarefa));
  const algumaPausada = tarefas.some(({ aoLigar }) => aoLigar === "desligada");

  return (
    <div className="mt-4 space-y-4">
      <div>
        <p className="text-sm font-medium">{t("O que o Jev vai fazer")}</p>
        <ul className="mt-1 space-y-1 text-sm">
          {tarefas.map(({ tarefa, aoLigar }) => (
            <li key={tarefa.id} data-testid={`jev-ao-ligar-${tarefa.id}`}>
              <span className="font-medium">{t(tarefa.rotulo)}</span>{" "}
              <span className="text-xs text-muted-foreground">
                (
                {aoLigar === "desligada"
                  ? t("Pausada")
                  : parada(tarefa)
                    ? t("Não roda")
                    : tarefa.id === TAREFA_DO_CLIMA.id && climaSozinho
                      ? t("Decide sozinho")
                      : aoLigar === "decidindo"
                        ? t("Decide")
                        : t("Só observa")}
                )
              </span>
              <span className="text-muted-foreground"> — {t(tarefa.oQueFaz)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="jev-ao-ligar">
          {climaSozinho
            ? t(
                "Sem uma IA principal que meça o clima, o Jev já começa decidindo sozinho nessa tarefa: não há com quem comparar nem quem cubra uma falha dele.",
              )
            : algumaDecide
              ? t(
                  "Onde ele decide, vale a escolha que você fez antes de desligá-lo; onde só observa, a sua IA de sempre continua decidindo, e você compara os dois antes de deixar o Jev decidir.",
                )
              : t(
                  "Onde ele só observa, a sua IA de sempre continua decidindo, e você compara os dois antes de deixar o Jev decidir.",
                )}{" "}
          {algumaPausada &&
            t("As tarefas pausadas continuam assim: depois de ligar o Jev, religue-as na lista que aparece aqui.")}{" "}
          {climaPausadoSemIa &&
            t("Sem uma IA principal, o clima religado volta decidindo sozinho: não há com quem comparar nem quem cubra uma falha do Jev.")}
        </p>
      </div>

      <div className="rounded-md border border-border p-3 text-sm">
        <p>
          {t(
            "Ao ligar, cada mensagem que o cliente manda vai para a TypeSafe AI, nos Estados Unidos, uma de cada vez e sem o resto da conversa, para o Jev avaliar. Antes de sair, o sistema apaga CPF, telefone e e-mail do texto. Com o Jev desligado, nada é enviado.",
          )}
        </p>
        {aceite === null ? (
          <div className="mt-3 flex items-start gap-2">
            <input
              id="jev-aceite"
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
              checked={concordo}
              onChange={(e) => setConcordo(e.target.checked)}
              disabled={!dados.pode_editar}
            />
            <label htmlFor="jev-aceite" className="text-sm">
              {t(
                "Concordo com o envio de cada mensagem dos clientes, uma de cada vez e sem o resto da conversa, para a TypeSafe AI, nos Estados Unidos.",
              )}
            </label>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("Envio aceito pela empresa em")}{" "}
            {new Date(aceite.em).toLocaleDateString(tagDoIdioma)}.
          </p>
        )}
      </div>

      {dados.pode_editar && (
        <Button
          size="sm"
          disabled={enviando || (pedeAceite && !concordo)}
          onClick={() =>
            void mudar(pedeAceite ? { ligado: true, aceite_lgpd: true } : { ligado: true }, t("O Jev foi ligado."))
          }
        >
          {enviando ? t("Ligando…") : t("Ligar o Jev")}
        </Button>
      )}
    </div>
  );
}

function Ligado({
  dados,
  estado,
  recarregar,
}: {
  dados: DadosDoJev;
  estado: Estado;
  recarregar: () => Promise<void>;
}) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const { mudar, enviando } = useMudarOJev(recarregar);
  // A tarefa cujo "Deixar o Jev decidir" espera confirmação. Só decidir pede:
  // pausar e voltar a observar só tiram o Jev do caminho do cliente. Fechado, o
  // diálogo guarda a tarefa: o texto não some durante a animação de saída.
  const [aConfirmar, setAConfirmar] = useState<{ tarefa: TarefaNoCartao; aberto: boolean } | null>(null);
  const n = dados.numeros;

  // `cost_cents` é centavo de DÓLAR, e o Jev custa fração de centavo por
  // mensagem: com 2 casas a semana inteira mostraria "US$ 0,00".
  const usd = new Intl.NumberFormat(tagDoIdioma, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
  const segundos = new Intl.NumberFormat(tagDoIdioma, { maximumFractionDigits: 1 });
  const inteiro = new Intl.NumberFormat(tagDoIdioma);
  // Só com o Jev medindo de verdade a linha de cada tarefa mostra o estado e o
  // botão — e em pausa também, que é de onde se religa a tarefa desligada. E
  // decidindo sozinho: o clima decide sem reserva, mas as outras tarefas rodam
  // como sempre, e sem a linha delas a única saída de uma tarefa nova era
  // desligar o Jev inteiro.
  const rodando = estado === "observando" || estado === "decidindo" || estado === "em_pausa" || estado === "sozinho";
  const todasPausadas = tarefasDoCartao(dados).every((t) => t.estado === "desligada");
  const falha = dados.ultima_falha;
  const frasesDeFalha: Readonly<Record<string, string>> = O_QUE_FAZER_DO_JEV;
  const oQueFazer = falha?.motivo ? frasesDeFalha[falha.motivo] : undefined;

  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm">
        {estado === "observando" &&
          t("Observando — a sua IA de sempre ainda decide. Compare os dois antes de deixar o Jev decidir.")}
        {estado === "decidindo" &&
          (decideEmParte(dados)
            ? t("Decidindo em parte — cada tarefa abaixo diz se o Jev decide ou só observa nela.")
            : t("Decidindo — cada tarefa abaixo diz o que o Jev decide nela."))}
        {estado === "sozinho" &&
          t(
            "Decidindo sozinho no clima — a empresa ainda não tem uma IA principal que meça o clima, então o Jev mede sem reserva. As outras tarefas dizem abaixo o que fazem.",
          )}
        {estado === "parado" &&
          t("Ligado, mas parado: o Jev só volta a medir quando a chave passar no teste.")}
        {estado === "em_pausa" &&
          (todasPausadas
            ? t("Ligado, mas com todas as tarefas pausadas: o Jev não mede nada até você religar uma abaixo.")
            : t(
                "Ligado, mas nenhuma tarefa está rodando agora: o Jev não mede nada. Veja abaixo o que falta nas que dizem “Não roda”, ou religue uma pausada.",
              ))}
      </p>

      {/* Uma linha por tarefa: o estado dela e o "Deixar o Jev decidir" dela.
          Com a chave parada, o selo do cartão já diz o estado de todas, e a
          linha não repete nem oferece o botão. Sem a IA de sempre, o clima
          decide sozinho e só se pausa; as outras seguem como sempre. */}
      <ul className="divide-y divide-border rounded-md border border-border" data-testid="jev-tarefas">
        {tarefasDoCartao(dados).map((tarefa) => {
          const aoDecidir = doRegistro(tarefa.id)?.aoDecidir;
          const climaSozinho = estado === "sozinho" && tarefa.id === TAREFA_DO_CLIMA.id;
          const climaSemIa = tarefa.id === TAREFA_DO_CLIMA.id && !dados.tem_ia_de_sempre;
          return (
          <li
            key={tarefa.id}
            className="space-y-2 p-3"
            data-testid={`jev-tarefa-${tarefa.id}`}
            data-estado={tarefa.estado}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{t(tarefa.rotulo)}</span>
              {rodando && (
                <Badge
                  variant={
                    climaSozinho ? "warning" : roda(tarefa) && tarefa.estado === "decidindo" ? "success" : "neutral"
                  }
                >
                  {/* "Pausada", o verbo do botão: "Desligada" ao lado de "Pausar
                      esta tarefa" e do "Desligar" do Jev inteiro confundia os dois. */}
                  {tarefa.estado === "desligada"
                    ? t("Pausada")
                    : parada(tarefa)
                      ? t("Não roda")
                      : climaSozinho
                        ? t("Decide sozinho")
                        : tarefa.estado === "observando"
                          ? t("Só observa")
                          : t("Decide")}
                </Badge>
              )}
              {/* "Nova": a tarefa é feminina. A chave "Novo" é a do agente novo. */}
              {tarefa.novo && <Badge variant="info">{t("Nova")}</Badge>}
            </div>

            {/* O selo sozinho não explicava nada e nunca sumia: diz o que ele
                quer dizer, e "Manter só observando" (abaixo) o tira. */}
            {rodando && tarefa.novo && tarefa.estado === "observando" && (
              <p className="text-sm text-muted-foreground" data-testid={`jev-nova-${tarefa.id}`}>
                {t("Começou sozinha, só observando: nada muda para o cliente até você deixar o Jev decidir.")}
              </p>
            )}

            {/* Sem esta linha, a tarefa ficava "Só observa" esperando uma
                comparação que nunca vem: o turno só pergunta ao Jev onde a IA
                de sempre também pergunta. Hoje só a manipulação acompanha camada.
                O nome é o que a tela do agente mostra — "Segurança" é só o nosso. */}
            {rodando && tarefa.estado !== "desligada" && tarefa.sem_camada && (
              <p className="text-sm text-muted-foreground" data-testid={`jev-sem-camada-${tarefa.id}`}>
                {t(
                  "Não roda agora: a verificação “Detectar tentativa de manipular o assistente” está desligada. Ela vale para a empresa toda: ligue-a abrindo qualquer agente, na aba “Confere antes de enviar”, em “Antes de o assistente ler”. O Jev só pergunta onde a sua IA de sempre também pergunta.",
                )}{" "}
                <Link className="underline underline-offset-4" href="/app/ai/agents">
                  {t("Abrir os agentes")}
                </Link>
              </p>
            )}
            {rodando && tarefa.estado !== "desligada" && tarefa.sem_roteador && (
              <p className="text-sm text-muted-foreground" data-testid={`jev-sem-roteador-${tarefa.id}`}>
                {t(
                  "Não roda agora: nenhum roteador de intenção ativo tem intenções para o Jev escolher. O Jev só escolhe o agente onde um roteador já escolhe — ative um, com as intenções dele, em Roteadores.",
                )}{" "}
                <Link className="underline underline-offset-4" href="/app/ai/routers">
                  {t("Abrir os roteadores")}
                </Link>
              </p>
            )}

            {rodando && roda(tarefa) && tarefa.estado === "decidindo" && aoDecidir !== undefined && (
              <p className="text-sm text-muted-foreground" data-testid={`jev-decide-${tarefa.id}`}>
                {t(aoDecidir)}
              </p>
            )}

            {/* A concordância de cada tarefa com a IA de sempre — o que se lê antes
                de deixar o Jev decidir. O clima conta "chamariam uma pessoa"; as
                outras, o mesmo rótulo (em `jev_observacoes`). */}
            {rodando && roda(tarefa) && tarefa.estado === "observando" && !climaSozinho && concordanciaDa(tarefa, dados) !== null && (
              <ConcordanciaDaTarefa
                tarefa={tarefa}
                o={concordanciaDa(tarefa, dados)!}
                formatar={(n) => inteiro.format(n)}
              />
            )}

            {dados.pode_editar && rodando && (
              <div className="flex flex-wrap items-center gap-3">
                {/* Parada pela camada ou sem roteador, não há o que comparar antes
                    de decidir; e o clima sem a IA de sempre já decide sozinho. */}
                {tarefa.estado === "observando" && !parada(tarefa) && !climaSozinho && (
                  <Button
                    size="sm"
                    disabled={enviando}
                    onClick={() => setAConfirmar({ tarefa, aberto: true })}
                  >
                    {t("Deixar o Jev decidir")}
                  </Button>
                )}
                {/* Sem este caminho, quem deixou o Jev decidir só voltaria a
                    comparar desligando — e religar mantém o estado gravado. */}
                {tarefa.estado === "decidindo" && !climaSozinho && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={enviando}
                    onClick={() =>
                      void mudar(corpoDaMudanca(tarefa, "observando"), t("O Jev voltou a só observar."))
                    }
                  >
                    {t("Voltar a só observar")}
                  </Button>
                )}
                {/* Grava o estado que já vale: o selo "Nova" sai, e nada muda. */}
                {tarefa.novo && tarefa.estado === "observando" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={enviando}
                    onClick={() =>
                      void mudar(
                        { tarefa: tarefa.id, estado: "observando" },
                        t("A tarefa segue só observando."),
                      )
                    }
                  >
                    {t("Manter só observando")}
                  </Button>
                )}
                {/* Uma tarefa só, sem desligar o Jev: a tarefa nova começa
                    observando sozinha (R7), e quem não a quer precisa de uma
                    saída que não leve as outras junto. */}
                {tarefa.estado !== "desligada" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={enviando}
                    onClick={() => void mudar(corpoDaMudanca(tarefa, "desligada"), t("A tarefa foi pausada."))}
                  >
                    {t("Pausar esta tarefa")}
                  </Button>
                )}
                {/* Pausada, a tarefa volta observando — nunca direto a decidir.
                    A exceção é o clima sem a IA de sempre: não há com quem
                    comparar, e o worker o deixa decidir sozinho (DEC-012 #5). O
                    aviso vem ANTES do clique. */}
                {tarefa.estado === "desligada" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={enviando}
                    onClick={() => void mudar(corpoDaMudanca(tarefa, "observando"), t("A tarefa foi religada."))}
                  >
                    {t("Religar")}
                  </Button>
                )}
              </div>
            )}
            {dados.pode_editar && rodando && tarefa.estado === "desligada" && climaSemIa && (
              <p className="text-xs text-muted-foreground" data-testid="jev-religar-clima-sozinho">
                {t(
                  "Sem uma IA principal, o clima religado volta decidindo sozinho: não há com quem comparar nem quem cubra uma falha do Jev.",
                )}
              </p>
            )}
          </li>
          );
        })}
      </ul>

      <div>
        <p className="text-xs text-muted-foreground">
          {t("Nos últimos")} {n.dias} {t("dias")}
        </p>
        {/* As colunas seguem a largura do CARTÃO, não a da tela: com a barra
            lateral aberta, um tablet de 800 px dava 3 colunas de 117 px e
            partia "US$ 0,000049" (130 px) em duas linhas. 9rem cabe o número
            mais largo; abaixo disso a coluna desce para a linha seguinte. */}
        <dl
          className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-6 gap-y-3 border-t border-border pt-3"
          data-testid="jev-numeros"
        >
          {/* Respostas, e não mensagens: com mais de uma tarefa, cada mensagem
              do cliente rende uma resposta por tarefa. */}
          <Numero rotulo={t("Respostas do Jev")} valor={inteiro.format(n.decisoes)} />
          <Numero rotulo={t("Clientes irritados percebidos")} valor={inteiro.format(n.irritados)} />
          <Numero
            rotulo={t("Custo")}
            valor={n.custo_cents === null ? "—" : usd.format(n.custo_cents / 100)}
          />
          <Numero
            rotulo={t("Tempo médio")}
            valor={n.latencia_media_ms === null ? "—" : `${segundos.format(n.latencia_media_ms / 1000)} s`}
          />
          {/* Sem IA de sempre para o clima não há quem o cubra: um zero que nunca
              muda só confunde. Mas o roteador tem a IA dele, e a cobertura dele
              conta aqui também. */}
          {(dados.tem_ia_de_sempre || n.reservas > 0) && (
            <Numero rotulo={t("Vezes que a IA de sempre cobriu o Jev")} valor={inteiro.format(n.reservas)} />
          )}
        </dl>
        {n.custo_incompleto && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="jev-custo-parcial">
            {t(
              "Parte das medições veio de uma versão do Jev sem preço conhecido: o custo mostrado soma só as outras.",
            )}
          </p>
        )}
      </div>

      {falha && (
        <p className="rounded-md bg-warning-bg p-2 text-xs text-warning-fg" data-testid="jev-ultima-falha">
          <span className="font-medium">
            {t("Última falha")}
            {falha.tarefa ? <> — {t(falha.tarefa)}</> : null} ({new Date(falha.em).toLocaleString(tagDoIdioma)}):
          </span>{" "}
          {oQueFazer ? t(oQueFazer) : t("O Jev não conseguiu medir.")}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {/* `py-1`: 28 px de alvo de toque (tinha 20), sem deixar de parecer link. */}
        <Link
          className="inline-block py-1 text-sm underline underline-offset-4"
          href={`/app/ai/runs?provider=${PROVEDOR_DO_JEV}`}
        >
          {t("Ver as decisões do Jev")}
        </Link>
        {dados.pode_editar && (
          <Button
            size="sm"
            variant="ghost"
            disabled={enviando}
            onClick={() => void mudar({ ligado: false }, t("O Jev foi desligado."))}
          >
            {t("Desligar")}
          </Button>
        )}
      </div>

      <ConfirmarDecidir
        pedido={aConfirmar}
        aoFechar={() => setAConfirmar((p) => p && { ...p, aberto: false })}
        aoConfirmar={(tarefa) => void mudar(corpoDaMudanca(tarefa, "decidindo"), t("Agora o Jev decide."))}
      />
    </div>
  );
}

/**
 * "Deixar o Jev decidir" muda o atendimento de toda mensagem seguinte: antes de
 * o clique valer, o efeito daquela tarefa (do registro, `aoConfirmarDecidir`) e
 * o caminho de volta.
 */
function ConfirmarDecidir({
  pedido,
  aoFechar,
  aoConfirmar,
}: {
  pedido: { tarefa: TarefaNoCartao; aberto: boolean } | null;
  aoFechar: () => void;
  aoConfirmar: (tarefa: TarefaNoCartao) => void;
}) {
  const t = useT();
  const tarefa = pedido?.tarefa ?? null;
  const efeito = tarefa ? doRegistro(tarefa.id)?.aoConfirmarDecidir : undefined;
  return (
    <AlertDialog open={pedido?.aberto === true} onOpenChange={(aberto) => !aberto && aoFechar()}>
      <AlertDialogContent data-testid="jev-confirmar-decidir" data-tarefa={tarefa?.id}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Deixar o Jev decidir?")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {tarefa && <p className="font-medium text-foreground">{t(tarefa.rotulo)}</p>}
              {efeito !== undefined && <p>{t(efeito)}</p>}
              <p>{t("Dá para voltar a só observar quando quiser.")}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => tarefa && aoConfirmar(tarefa)}>{t("Deixar o Jev decidir")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ConcordanciaDaTarefa({
  tarefa,
  o,
  formatar,
}: {
  tarefa: TarefaNoCartao;
  o: Concordancia;
  formatar: (n: number) => string;
}) {
  const t = useT();
  const doClima = tarefa.id === TAREFA_DO_CLIMA.id;
  // Cada tarefa diz EM QUE os dois concordaram — a régua dela, do registro.
  const frase = (doRegistro(tarefa.id) ?? TAREFA_DO_CLIMA).concordancia;
  // O testid do clima é o da onda 1: as specs o leem.
  return (
    <p className="text-sm" data-testid={doClima ? "jev-concordancia" : `jev-concordancia-${tarefa.id}`}>
      {o.comparadas === 0 ? (
        t("Ainda não há mensagens medidas pelos dois. A comparação aparece aqui assim que houver.")
      ) : (
        <>
          {t("Nos últimos")} {o.dias} {t(frase.antes)}{" "}
          {/* A fonte do texto, com algarismos de largura igual: a mono, no meio
              da frase, abria "5  de  7" com espaços largos. */}
          <span className="font-medium tabular-nums" data-testid={`jev-concordancia-numeros-${tarefa.id}`}>
            {formatar(o.concordaram)} {t("de")} {formatar(o.comparadas)}
          </span>{" "}
          {t(frase.depois)}
          {o.teto_da_amostra !== undefined && (
            <>
              {" "}
              {t("A conta usa só as")} {formatar(o.teto_da_amostra)} {t("mensagens mais recentes do período.")}
            </>
          )}
          {/* O que decidir muda na manipulação: o alerta forte que só ele daria. */}
          {o.so_o_jev_alto !== undefined && (
            <>
              {" "}
              {t("Só o Jev daria o alerta forte em")}{" "}
              <span className="font-medium tabular-nums">{formatar(o.so_o_jev_alto)}</span>{" "}
              {t("delas — é o que muda se você deixar o Jev decidir.")}
            </>
          )}
        </>
      )}
    </p>
  );
}

function Numero({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{rotulo}</dt>
      <dd className="mt-0.5 font-mono text-lg break-words">{valor}</dd>
    </div>
  );
}
