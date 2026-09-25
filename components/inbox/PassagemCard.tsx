"use client";

import Link from "next/link";
import { useId } from "react";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import type { CartaoDaPassagem } from "@/lib/escalacao/cartao-da-passagem";
import { Robot, Warning } from "@/lib/ui/icons";

interface Props {
  cartao: CartaoDaPassagem;
  /** Para o gesto de opt-out: a ficha do contato é onde mora o bloqueio. */
  contatoId: string | null;
  /** Assumir a conversa. É o MESMO gesto do cabeçalho — uma rota, um efeito. */
  onAssumir: () => void;
  assumindo: boolean;
}

/**
 * O CARTÃO "POR QUE A IA PASSOU PARA VOCÊ", dentro do fio da conversa.
 *
 * ═══ Por que ele mora aqui, e não no cabeçalho nem no painel lateral ═══
 *
 * O cabeçalho já travou a largura da tela inteira uma vez (707px de
 * `min-content`, empurrando o painel de CRM 311px para fora da viewport em
 * 1280px) — o comentário no topo de `ConversationHeader.tsx` conta a história.
 * Ele é uma barra de selos de 10px; um cartão de seis linhas ali reintroduz o
 * defeito que o `flex-wrap` acabou de consertar.
 *
 * O painel lateral é coluna de CONSULTA: a pessoa olha para lá depois, e ele
 * some em largura apertada.
 *
 * O fio é o eixo de leitura que termina no composer. Ele já intercala mensagens
 * e notas por timestamp, já tem `NoteCard` como cartão não-mensagem, e o
 * auto-scroll traz o fim para a viewport. Como a passagem CALA a IA, ela é quase
 * sempre o último evento quando a pessoa chega — o cartão aparece exatamente
 * onde o olho está antes de o dedo digitar.
 *
 * ═══ O que NÃO pode virar link ═══
 *
 * `falaDoCliente` e `textoDeQuemPassou` são texto de FORA (o cliente, o modelo,
 * um agente MCP). Eles já passaram por `sanitizarTextoDoLead` na escrita, mas a
 * regra na tela é mais simples e mais segura: **nada aqui vira `<a>`**. Um link
 * renderizado a partir do que o cliente digitou é phishing dentro do CRM, de
 * graça e com a autoridade da nossa interface.
 *
 * ═══ Acessibilidade ═══
 *
 * `<article aria-labelledby>` com `<h3>` — o cartão é um marco, não um parágrafo
 * solto no fio. O ⚠ tem `aria-hidden` e a severidade viaja no TEXTO ("O cliente
 * NÃO foi avisado"), nunca só na cor: cor não sobrevive ao daltonismo nem ao
 * teste do metro. As tentativas são `<ol>` de verdade, e as passagens antigas
 * usam `<details>` nativo — teclado e leitor de tela de graça.
 *
 * ⚠️ **GUARDA DE LOCALIZADOR.** O convite se chama "Assumir e responder", e o
 * cabeçalho tem um botão "Assumir". As duas specs que clicam o do cabeçalho usam
 * localizador ANCORADO (`{ name: "Assumir", exact: true }` em
 * `encerramento-atendimento.spec.ts` e `/^Assumir$/i` em
 * `inbox-quem-manda.spec.ts`), então elas passam — **mas a margem é de uma
 * palavra**. Encurtar este rótulo para "Assumir" faz as duas virarem *strict
 * mode violation*, e o vermelho aparece longe daqui.
 */
export function PassagemCard({ cartao, contatoId, onAssumir, assumindo }: Props) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const tituloId = useId();
  const hora = format(new Date(cartao.criadoEm), "dd/MM HH:mm", { locale: localeDaData });

  if (cartao.recolhido) {
    return (
      <div className="flex w-full justify-center px-4 py-1">
        <details
          className="w-full max-w-[85%] rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm"
          data-testid="cartao-passagem"
          data-passagem-recolhido="true"
        >
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {t(cartao.motivo)}
            {cartao.percebidoPeloJev && <> {t("(percebido pelo Jev)")}</>} · {hora}
          </summary>
          <div className="mt-2">
            <Corpo cartao={cartao} tituloId={tituloId} />
          </div>
        </details>
      </div>
    );
  }

  const emAberto = cartao.estado === "aberta";

  return (
    <div className="flex w-full justify-center px-4 py-2">
      <article
        aria-labelledby={tituloId}
        data-testid="cartao-passagem"
        data-passagem-estado={cartao.estado}
        className={
          emAberto
            ? "w-full max-w-[85%] rounded-xl border border-warning/50 bg-warning-bg px-3 py-2.5 text-sm shadow-sm"
            : "w-full max-w-[85%] rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-sm shadow-sm"
        }
      >
        <div className="flex items-start justify-between gap-2">
          <h3 id={tituloId} className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Robot size={14} weight="fill" aria-hidden />
            {t(cartao.titulo)}
          </h3>
          <span className="shrink-0 text-[11px] text-muted-foreground">{hora}</span>
        </div>

        <Corpo cartao={cartao} tituloId={tituloId} />

        <Rodape
          cartao={cartao}
          contatoId={contatoId}
          onAssumir={onAssumir}
          assumindo={assumindo}
        />
      </article>
    </div>
  );
}

/** As seções. Separado do invólucro porque o estado recolhido reusa exatamente isto. */
function Corpo({ cartao, tituloId }: { cartao: CartaoDaPassagem; tituloId: string }) {
  const t = useT();

  if (cartao.anonimizada) {
    return (
      <p className="mt-1.5 text-xs text-muted-foreground">
        {t("Este contato foi anonimizado a pedido dele. O contexto desta passagem foi apagado.")}
      </p>
    );
  }

  return (
    <>
      <p className="mt-1.5 font-medium" data-testid="passagem-motivo">
        {t(cartao.motivo)}
        {cartao.percebidoPeloJev && <> {t("(percebido pelo Jev)")}</>}
      </p>

      {cartao.clienteQuer !== null && (
        <Secao rotulo={t("O cliente quer")}>
          <p className="whitespace-pre-wrap break-words">{cartao.clienteQuer}</p>
        </Secao>
      )}

      {cartao.tentativas.length > 0 && (
        <Secao rotulo={t("A IA já tentou")}>
          <ol className="list-decimal space-y-0.5 pl-4" data-testid="passagem-tentativas">
            {cartao.tentativas.map((tentativa, i) => (
              <li key={`${tituloId}-t${i}`} className="whitespace-pre-wrap break-words">
                {tentativa.o_que}
                {tentativa.desfecho !== undefined && ` → ${tentativa.desfecho}`}
              </li>
            ))}
          </ol>
        </Secao>
      )}

      {/* Aspas e itálico separam a PALAVRA DO CLIENTE da conclusão da IA. Quem lê
          precisa saber o que foi dito de quem interpretou — é a mitigação de
          injeção pelo histórico levada para a tela, não só para o prompt. */}
      {cartao.falaDoCliente !== null && (
        <Secao rotulo={t("Últimas palavras do cliente")}>
          <blockquote className="whitespace-pre-wrap break-words border-l-2 border-border pl-2 italic">
            {`“${cartao.falaDoCliente}”`}
          </blockquote>
        </Secao>
      )}

      {/* "(confira)" no rótulo, e não numa nota de rodapé: é a IA resumindo, e
          quem vai responder assume o que disser. Esconder a seção quando ela é o
          piso evita o cabeçalho órfão — três linhas para dizer nada. */}
      {cartao.resumo !== null && (
        <Secao rotulo={t("Resumo da IA (confira)")}>
          <p className="whitespace-pre-wrap break-words" data-testid="passagem-resumo">
            {cartao.resumo}
          </p>
        </Secao>
      )}

      {cartao.textoDeQuemPassou !== null && (
        <Secao rotulo={t("Escrito por quem passou")}>
          <p className="whitespace-pre-wrap break-words">{cartao.textoDeQuemPassou}</p>
        </Secao>
      )}

      {cartao.semContexto && !cartao.anonimizada && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t("Sem resumo acumulado ainda — a conversa é recente. Role para cima para ver tudo o que foi dito.")}
        </p>
      )}

      {cartao.aviso !== null && (
        <p
          className="mt-2 flex items-start gap-1.5 text-xs"
          data-testid="passagem-aviso-ao-cliente"
        >
          {cartao.aviso.avisado ? (
            <span>{t("O cliente já foi avisado de que uma pessoa vai assumir.")}</span>
          ) : (
            <>
              <Warning size={13} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
              <span>
                {t("O cliente NÃO foi avisado — ele está esperando sem saber.")}
                {cartao.aviso.frase !== null && ` (${t(cartao.aviso.frase)})`}
              </span>
            </>
          )}
        </p>
      )}
    </>
  );
}

function Secao({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="mt-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {rotulo}
      </p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

/**
 * O gesto. QUAL gesto é decisão de `montarCartoesDaPassagem` — aqui só se
 * desenha, porque o vocabulário do banco que distingue os casos é proibido em
 * `components/` (`tests/unit/passagem-motivo-em-portugues.test.ts`).
 */
function Rodape({
  cartao,
  contatoId,
  onAssumir,
  assumindo,
}: {
  cartao: CartaoDaPassagem;
  contatoId: string | null;
  onAssumir: () => void;
  assumindo: boolean;
}) {
  const t = useT();

  if (cartao.estado === "reconhecida") {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground">
        {cartao.assumidaPor === null
          ? t("Alguém da equipe já assumiu este atendimento.")
          : `${t("Assumida por")} ${cartao.assumidaPor}`}
      </p>
    );
  }

  if (cartao.estado === "devolvida") {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground">
        {t("Atendimento devolvido ao automático — ninguém assumiu.")}
      </p>
    );
  }

  switch (cartao.acao.tipo) {
    case "assumir_e_responder":
      return (
        <div className="mt-2.5 flex justify-end">
          <Button size="sm" onClick={onAssumir} disabled={assumindo} data-testid="passagem-assumir">
            {assumindo ? t("Assumindo...") : t("Assumir e responder")}
          </Button>
        </div>
      );
    case "abrir_contato":
      // Sem convite de responder, de propósito: um botão que diz "assumir e
      // responder" empurra alguém a escrever para quem acabou de pedir para
      // parar de receber mensagens.
      return (
        <div className="mt-2.5 flex justify-end">
          {contatoId !== null ? (
            <Button size="sm" variant="outline" asChild data-testid="passagem-abrir-contato">
              <Link href={`/app/contacts/${contatoId}`}>
                {t("Abrir o contato para confirmar o bloqueio")}
              </Link>
            </Button>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {t("Confirme na ficha do contato se ele pediu para não receber mais mensagens.")}
            </p>
          )}
        </div>
      );
    case "avisa_quem_atende":
      // O gesto que existe é transferir, e ele mora no cabeçalho. Duplicá-lo
      // aqui seria dois botões para um ato; ficar mudo deixaria o cartão mais
      // caro da entrega sem nada a dizer para metade dos leitores.
      return (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {cartao.acao.donoNome === null
            ? t("Outra pessoa está atendendo. Se precisar assumir, use Transferir no topo da conversa.")
            : `${cartao.acao.donoNome} ${t("está atendendo. Se precisar assumir, use Transferir no topo da conversa.")}`}
        </p>
      );
    case "nenhuma":
      return null;
  }
}
