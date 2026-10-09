"use client";
/**
 * OS AVISOS DA TELA — o invariante 6 do Sistema Vivo virando frase.
 *
 * *"A configuração mostra o estado EFETIVO, não só o que foi digitado."* Cada
 * bloco aqui existe porque, sem ele, uma instalação aceita a configuração, fica
 * verde e nunca entrega nada — e a pessoa não tem como descobrir por quê de
 * dentro desta tela.
 *
 * ## Por que as frases moram em TABELAS de módulo
 *
 * `tests/unit/i18n-espanhol-cobre-a-tela.test.ts` resolve `t(TABELA[chave])`
 * quando a tabela é um literal de objeto no topo do arquivo — e é assim que
 * cada uma das onze frases passa a ter espanhol COBRADO. Uma frase montada
 * dentro do componente escaparia da conta, e o espanhol dela ficaria faltando
 * em silêncio. As tabelas são RASAS (`Record<codigo, string>`) de propósito: o
 * resolvedor do guarda não desce em objeto aninhado.
 *
 * ## Por que os números ficam FORA da frase
 *
 * "7 de 20 avisos hoje" não pode ser uma chave de dicionário — ela teria uma
 * entrada por par de números. Os números são renderizados ao lado do texto
 * traduzido, e a frase traduzida nunca os contém.
 */
import Link from "next/link";
import { format } from "date-fns";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import type { AvisoDaTela, CodigoDoEstadoDoAviso } from "@/lib/escalacao/estado-do-aviso";
import { ArrowSquareOut, Info, Warning, WarningOctagon } from "@/lib/ui/icons";

const TITULO_DO_ESTADO = {
  sem_conexao: "Você ainda não conectou nenhum número",
  so_canal_oficial: "Seus números atuais não servem para avisar a equipe",
  sem_endereco_publico: "Este sistema ainda não tem um endereço na internet",
  conexao_removida: "A conexão que enviava os avisos foi removida",
  conexao_fora_do_ar: "A conexão escolhida está fora do ar",
  conexao_atende_clientes: "Este é o mesmo número que fala com seus clientes",
  casos_desligados: "Nenhum assistente está autorizado a abrir casos",
  agente_assistido: "Seus assistentes só sugerem respostas",
  atendimento_externo: "O atendimento desta conta é conduzido por outro sistema",
  aquecimento: "Este número ainda está em aquecimento",
  descarte_acontecendo: "As respostas para este número são ignoradas de propósito",
} as const satisfies Record<CodigoDoEstadoDoAviso, string>;

const CORPO_DO_ESTADO = {
  sem_conexao:
    "Conecte um WhatsApp lendo o QR code na tela de Conexões. É por ele que os avisos vão sair.",
  so_canal_oficial:
    "Seus números atuais só enviam mensagem para quem falou com você nas últimas 24 horas — isso não serve para um aviso interno. Conecte um número pelo QR code para usar este recurso.",
  sem_endereco_publico:
    "O endereço público ainda não foi configurado. Para trabalhar localmente, escolha “Sem link — resolver neste computador”. Para usar links, configure o endereço do domínio.",
  conexao_removida:
    "Como a conexão não existe mais, o aviso foi desligado sozinho. Escolha outra conexão abaixo e ligue de novo.",
  conexao_fora_do_ar:
    "Os avisos ficam esperando até 24 horas e, se a conexão não voltar, viram alerta na Central.",
  conexao_atende_clientes:
    "Os avisos vão contar no mesmo limite diário desse número. Funciona — mas um número só para avisos é mais seguro.",
  casos_desligados:
    "Enquanto ninguém puder abrir um caso, nenhum aviso vai sair. Ligue a opção de abrir casos na configuração do assistente.",
  agente_assistido:
    "Um assistente em modo assistido não abre caso sozinho: ele escreve a sugestão e espera alguém. Nenhum aviso vai sair por ele.",
  atendimento_externo:
    "Quem conduz as conversas desta conta é um sistema de fora, e ele não abre casos aqui.",
  aquecimento:
    "Um número novo começa com poucas mensagens por dia e vai crescendo por cerca de um mês. É o que protege o número de ser bloqueado pelo WhatsApp.",
  descarte_acontecendo:
    "Quem responder a esse número não vira atendimento, não vira contato e não chega ao CRM. É assim que o recurso funciona.",
} as const satisfies Record<CodigoDoEstadoDoAviso, string>;

/** Para onde o leigo vai resolver cada estado. Ausente = resolve nesta tela. */
const LINK_DO_ESTADO: Partial<Record<CodigoDoEstadoDoAviso, string>> = {
  sem_conexao: "/app/connections",
  so_canal_oficial: "/app/connections",
  conexao_fora_do_ar: "/app/connections",
  casos_desligados: "/app/ai/agents",
  agente_assistido: "/app/ai/agents",
};

const ROTULO_DO_LINK: Partial<Record<CodigoDoEstadoDoAviso, string>> = {
  sem_conexao: "Ir para Conexões",
  so_canal_oficial: "Ir para Conexões",
  conexao_fora_do_ar: "Ir para Conexões",
  casos_desligados: "Ir para os assistentes",
  agente_assistido: "Ir para os assistentes",
};

function numero(valor: unknown): number | null {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}

export function AlertasDoAviso({ avisos }: { avisos: AvisoDaTela[] }) {
  const t = useT();
  const locale = useLocaleDeData();

  if (avisos.length === 0) return null;

  return (
    <div className="flex flex-col gap-3" data-testid="alertas-do-aviso">
      {avisos.map((aviso) => {
        const href = LINK_DO_ESTADO[aviso.codigo];
        const rotulo = ROTULO_DO_LINK[aviso.codigo];
        const Icone = aviso.bloqueia
          ? WarningOctagon
          : aviso.codigo === "aquecimento" || aviso.codigo === "descarte_acontecendo"
            ? Info
            : Warning;
        return (
          <div
            key={aviso.codigo}
            data-testid={`alerta-${aviso.codigo}`}
            data-bloqueia={aviso.bloqueia ? "sim" : "nao"}
            className={`flex items-start gap-3 rounded-lg border p-3 ${
              aviso.bloqueia
                ? "border-destructive/40 bg-destructive/5"
                : "border-border bg-muted/40"
            }`}
          >
            <Icone className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" weight="duotone" />
            <div className="space-y-1">
              <p className="text-sm font-medium">{t(TITULO_DO_ESTADO[aviso.codigo])}</p>
              <p className="text-xs text-muted-foreground">{t(CORPO_DO_ESTADO[aviso.codigo])}</p>

              {aviso.codigo === "aquecimento" ? (
                <p className="text-xs font-medium" data-testid="aquecimento-de-hoje">
                  {t("Hoje")}: {numero(aviso.dados?.enviadosHoje) ?? 0} /{" "}
                  {numero(aviso.dados?.teto) ?? 0} {t("mensagens neste número")}
                  {typeof aviso.dados?.fimEm === "string" ? (
                    <>
                      {" · "}
                      {t("em aquecimento até")}{" "}
                      {format(new Date(aviso.dados.fimEm), "dd/MM", { locale })}
                    </>
                  ) : null}
                </p>
              ) : null}

              {aviso.codigo === "descarte_acontecendo" ? (
                <p className="text-xs font-medium" data-testid="descarte-de-hoje">
                  {numero(aviso.dados?.ignoradas) ?? 0} {t("mensagens já foram ignoradas")}
                  {typeof aviso.dados?.ultimaEm === "string" ? (
                    <>
                      {" · "}
                      {t("a última em")}{" "}
                      {format(new Date(aviso.dados.ultimaEm), "dd/MM 'às' HH:mm", { locale })}
                    </>
                  ) : null}
                </p>
              ) : null}

              {href && rotulo ? (
                <Link
                  href={href}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  {t(rotulo)}
                  <ArrowSquareOut className="h-3 w-3" />
                </Link>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
