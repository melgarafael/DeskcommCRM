"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Warning, X } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";

/**
 * O LEITOR que faltava.
 *
 * As rotas de OAuth do Google terminam TODOS os desfechos — sucesso e as nove
 * falhas — voltando para `/app/agenda` com `?erro=<código>` ou `?ok=`. Doze
 * sítios de escrita, dez códigos distintos, e **zero leitores** no repositório
 * inteiro até este arquivo.
 *
 * O que isso produzia: a pessoa clica em conectar a agenda, alguma coisa falha,
 * o navegador volta para a Agenda — e a tela desenha a grade normal, sem aviso,
 * sem faixa, sem uma palavra. Ela vê a mesma tela de antes e conclui que o
 * clique não fez nada. Metade escrita de um contrato é pior que contrato
 * nenhum, porque quem escreveu acha que avisou.
 *
 * ## Por que FAIXA e não toast, ao contrário do precedente
 *
 * A mecânica é a do `StatusToast` da Nuvemshop (ler a query, agir uma vez,
 * limpar a URL para o reload não repetir). O formato é outro de propósito:
 * toast some sozinho em quatro segundos, e sete dos dez desfechos aqui exigem
 * que a pessoa FAÇA algo — reconectar, pedir ajuda a quem instalou, tentar de
 * novo. Aviso que exige ação não pode depender de a pessoa estar olhando na
 * hora. Sucesso e desistência, que não pedem nada, saem em toast.
 *
 * ## E o texto NÃO é o do precedente
 *
 * O da Nuvemshop diz "code ausente", "access token", "Verifique
 * NUVEMSHOP_OAUTH_ENCRYPTION_KEY". Quem lê isto aqui não programa: é dono de
 * clínica, de imobiliária, de loja. Código em inglês com ponto no meio na tela
 * é o pior que esta entrega pode mostrar.
 */

type Desfecho = {
  /** `aviso` desenha faixa que fica; `nota` sai em toast e some. */
  formato: "aviso" | "nota";
  titulo: string;
  corpo: string;
  /** Quem consegue resolver: a própria pessoa, ou quem cuidou da instalação. */
  acao?: "reconectar" | "falar_com_quem_instalou";
};

const DESFECHOS: Record<string, Desfecho> = {
  // ---- o único sucesso ----
  agenda_conectada: {
    formato: "nota",
    titulo: "Agenda do Google conectada.",
    corpo: "Os compromissos que já estão lá aparecem aqui, e o que você marcar vai para lá.",
  },

  // ---- NÃO É ERRO: a pessoa clicou "Cancelar" na tela do Google ----
  // Merece frase própria. Tratá-la como as outras nove diria "algo deu errado"
  // para quem apenas mudou de ideia — e ensinaria a pessoa a desconfiar de
  // avisos que, nas outras vezes, são verdadeiros.
  conexao_cancelada: {
    formato: "nota",
    titulo: "Você cancelou a conexão.",
    corpo: "Nada mudou. Quando quiser, é só conectar de novo.",
  },

  // ---- da INSTALAÇÃO, não da pessoa: ela não tem o que fazer sozinha ----
  google_nao_configurado: {
    formato: "aviso",
    titulo: "Esta instalação ainda não tem a conexão com o Google configurada",
    corpo:
      "Não é nada que você tenha feito. Quem instalou o sistema precisa cadastrar as credenciais do Google — até lá, a agenda funciona normalmente, só não sincroniza.",
    acao: "falar_com_quem_instalou",
  },
  cifra_indisponivel: {
    formato: "aviso",
    titulo: "Não consegui guardar a conexão com segurança",
    corpo:
      "Falta uma chave de segurança nesta instalação, e sem ela eu prefiro não guardar seus dados de acesso. Quem instalou o sistema resolve isso.",
    acao: "falar_com_quem_instalou",
  },

  // ---- transitórios: tentar de novo costuma resolver ----
  retorno_nao_verificavel: {
    formato: "aviso",
    titulo: "A conexão demorou demais e expirou",
    corpo: "Isso acontece quando a página fica aberta muito tempo. Conectar de novo resolve.",
    acao: "reconectar",
  },
  retorno_incompleto: {
    formato: "aviso",
    titulo: "O Google devolveu uma resposta incompleta",
    corpo: "Não deu para concluir a conexão. Tentar de novo costuma resolver.",
    acao: "reconectar",
  },
  troca_de_codigo_falhou: {
    formato: "aviso",
    titulo: "O Google não confirmou a conexão",
    corpo:
      "A autorização foi dada, mas o Google não devolveu o acesso. Tente de novo; se repetir, pode ser instabilidade do lado deles.",
    acao: "reconectar",
  },
  conta_indisponivel: {
    formato: "aviso",
    titulo: "Não consegui ler os dados da conta do Google",
    corpo: "A conexão foi autorizada, mas o Google não respondeu quem é a conta. Tente de novo.",
    acao: "reconectar",
  },
  /**
   * O 403 que NÃO passa com o tempo.
   *
   * Medido em produção em 2026-09-01: três tentativas seguidas de conectar, as
   * três com `HTTP 403` na leitura da agenda — e a tela mandando "Tente de
   * novo", porque o único desfecho disponível para esse caminho era
   * `conta_indisponivel`. A pessoa repetiria para sempre: a autorização está
   * certa, os escopos estão certos, e quem recusa é o projeto do Google Cloud.
   *
   * A ação é do DONO DA INSTALAÇÃO, no Console do Google, e não de quem clicou.
   * Por isso o texto não oferece "tentar de novo" como primeira saída — oferecer
   * o botão errado é o que fez três tentativas virarem zero diagnóstico.
   */
  google_recusou_o_acesso: {
    formato: "aviso",
    titulo: "O Google recusou o acesso à agenda",
    corpo:
      "A autorização funcionou, mas o Google negou a leitura do calendário. Quase sempre é a API do Google Agenda desligada no projeto do Google Cloud desta instalação — ligue em APIs e serviços › Biblioteca › Google Calendar API e conecte de novo. O motivo exato que o Google devolveu ficou registrado no Audit Log, na falha de conexão da agenda.",
    acao: "reconectar",
  },
  nao_consegui_guardar: {
    formato: "aviso",
    titulo: "A conexão funcionou, mas não consegui salvar",
    corpo:
      "O Google autorizou, e o problema foi ao gravar aqui. Tente de novo — se repetir, avise quem cuida do sistema.",
    acao: "reconectar",
  },

  // ---- a pessoa precisa refazer marcando as caixas ----
  permissao_incompleta: {
    formato: "aviso",
    titulo: "Faltou permissão para ler e escrever na sua agenda",
    corpo:
      "Na tela do Google, algumas permissões ficaram desmarcadas. Sem elas eu não consigo ver seus horários ocupados nem enviar os agendamentos. Conecte de novo e mantenha as caixas marcadas.",
    acao: "reconectar",
  },
};

/**
 * Fallback para código que esta tela ainda não conhece.
 *
 * NUNCA mostra o código cru — "Erro: retorno_nao_verificavel" na tela é o
 * defeito que este componente existe para consertar. Diz o que se sabe (não
 * conectou), o que fazer (tentar de novo) e o que NÃO mudou (o resto da agenda).
 */
const DESCONHECIDO: Desfecho = {
  formato: "aviso",
  titulo: "Não consegui conectar sua agenda do Google",
  corpo: "O resto da agenda continua funcionando normalmente. Tentar de novo costuma resolver.",
  acao: "reconectar",
};

function lerDesfecho(params: URLSearchParams | ReturnType<typeof useSearchParams>) {
  const ok = params.get("ok");
  const erro = params.get("erro");
  if (!ok && !erro) return null;
  const chave = ok ?? erro!;
  return { chave, desfecho: DESFECHOS[chave] ?? (ok ? DESFECHOS.agenda_conectada! : DESCONHECIDO) };
}

export function AvisoDaConexaoGoogle() {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const jaTratou = useRef(false);

  /**
   * Estado derivado na PRIMEIRA leitura, não dentro de um efeito.
   *
   * O efeito abaixo limpa a query (`router.replace`) para o reload não repetir o
   * aviso — e se a faixa dependesse de um `setState` DENTRO do efeito, ela
   * nasceria e morreria no mesmo ciclo: o replace apaga o parâmetro que a
   * alimenta. Ler uma vez no `useState` inicializador desacopla o que a tela
   * MOSTRA do que a URL ainda CARREGA.
   */
  const [faixa, setFaixa] = useState<Desfecho | null>(() => {
    const lido = lerDesfecho(params);
    return lido && lido.desfecho.formato === "aviso" ? lido.desfecho : null;
  });

  useEffect(() => {
    if (jaTratou.current) return;
    const lido = lerDesfecho(params);
    if (!lido) return;
    jaTratou.current = true;
    const { chave, desfecho } = lido;

    if (desfecho.formato === "aviso") {
      // a faixa já veio do estado inicial; aqui só se limpa a URL
    } else {
      // `import()` em vez de import de topo: o toast só é necessário em dois dos
      // dez desfechos, e carregá-lo sempre pesaria a tela que abre todo dia.
      void import("sonner").then(({ toast }) => {
        // `t()` aqui e não no catálogo: `DESFECHOS` é módulo, não componente,
        // e um Record de rótulos fechados se traduz no ponto de render — a
        // mesma fronteira dos outros vocabulários deste produto.
        if (chave === "agenda_conectada") toast.success(t(desfecho.titulo), { description: t(desfecho.corpo) });
        else toast(t(desfecho.titulo), { description: t(desfecho.corpo) });
      });
    }

    // Limpa a query para o reload não repetir o aviso — mesma razão do
    // precedente da casa.
    router.replace("/app/agenda");
  }, [params, router, t]);

  if (!faixa) return null;

  return (
    <div
      data-testid="aviso-conexao-google"
      data-acao={faixa.acao ?? "nenhuma"}
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3",
        "border-warning/40 bg-warning-bg",
      )}
    >
      <Warning size={18} weight="fill" className="mt-0.5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text">{t(faixa.titulo)}</p>
        <p className="mt-0.5 text-xs leading-4 text-text-muted">{t(faixa.corpo)}</p>
      </div>
      {faixa.acao === "reconectar" && (
        <Button variant="outline" size="sm" data-testid="reconectar" className="shrink-0">
          {t("Conectar de novo")}
        </Button>
      )}
      <button
        type="button"
        aria-label={t("Fechar aviso")}
        data-testid="fechar-aviso-google"
        onClick={() => setFaixa(null)}
        className="shrink-0 rounded-sm p-1 text-text-muted transition-colors hover:bg-surface hover:text-text"
      >
        <X size={14} weight="bold" aria-hidden />
      </button>
    </div>
  );
}

/** Os códigos que esta tela sabe ler — exportado para o teste cobrar cobertura. */
export const CODIGOS_CONHECIDOS = Object.keys(DESFECHOS);
