"use client";

import Link from "next/link";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useConversasDosNumeros } from "@/hooks/leads/useConversasDosNumeros";
import type {
  ConversaDoNumero,
  LigacaoDoNumero,
  NumeroDoNegocio,
} from "@/app/api/v1/leads/[id]/conversas-e-ligacoes/route";
import { ChatCircle, Phone } from "@/lib/ui/icons";

/**
 * AS CONVERSAS E AS LIGAÇÕES DE TODOS OS NÚMEROS DO CLIENTE (#3669, fatia 1).
 *
 * ─── O defeito que este bloco corrige ───────────────────────────────────────
 *
 * O dossiê mostrava UMA conversa (a mais recente do `crm_leads.contact_id`) e
 * nenhuma lista de ligações. Na venda B2B o cliente tem dono, comprador, gerente
 * e o fixo da loja — cada um num WhatsApp, cada um um contato —, e a vendedora
 * via só o número do card. A conversa do comprador existia, o histórico da
 * ligação para ele existia, e o negócio não os mostrava.
 *
 * ─── Por que aqui, e não dentro do bloco de conversa ────────────────────────
 *
 * O bloco de cima (`ConversaNoDossie`) é o ATALHO: um clique para o inbox, com a
 * prévia da última mensagem. Ele fica como está. Este bloco é a LISTA — o que
 * aconteceu em cada número —, e é seção própria porque responde outra pergunta:
 * "com quem deste cliente eu já falei, e por onde?".
 *
 * ─── Só aparece quando há outra pessoa ──────────────────────────────────────
 *
 * Negócio sem pessoa relacionada não ganha bloco nenhum: quem não usa a lista vê
 * exatamente o que via antes, sem uma seção a mais para dizer "nada aqui". É por
 * isso que a montagem é decidida pelo PAI (que já tem a lista de relacionados em
 * mãos, pelo mesmo hook de `ContatoDoNegocio`), e não por um `if` aqui dentro.
 *
 * ─── Ausência é estado normal ───────────────────────────────────────────────
 *
 * Pessoa relacionada sem conversa e sem ligação existe (o número foi cadastrado
 * ontem). A seção continua de pé com a frase de vazio, em vez de sumir e deixar
 * a vendedora achando que o vínculo não foi salvo.
 */
export function ConversasDosNumeros({ leadId }: { leadId: string | null }) {
  const t = useT();
  const tag = useTagDeIdioma();
  const { data, isLoading, isError } = useConversasDosNumeros(leadId);

  if (!leadId) return null;
  if (isError) {
    return (
      <p className="text-xs text-destructive" data-testid="numeros-com-erro">
        {t("Não consegui carregar as conversas e ligações.")}
      </p>
    );
  }
  // Sem resposta ainda não há o que dizer: um "carregando" aqui pisca a cada
  // abertura do dossiê e não informa nada.
  if (isLoading || !data) return null;

  const { numeros, conversas, ligacoes } = data.data;
  const porId = new Map(numeros.map((n) => [n.contact_id, n]));

  if (conversas.length === 0 && ligacoes.length === 0) {
    return (
      <p className="text-xs text-text-muted" data-testid="numeros-sem-historico">
        {t("Nenhuma conversa ou ligação nos outros números ainda.")}
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="conversas-dos-numeros">
      {conversas.length > 0 && (
        <section>
          <h4 className="mb-1 text-[11px] font-medium tracking-wide text-text-muted uppercase">
            {t("Conversas")} · {conversas.length}
          </h4>
          <ul className="space-y-1">
            {conversas.map((conversa) => (
              <li key={conversa.id} data-conversa={conversa.id}>
                <ConversaDaLinha conversa={conversa} pessoa={porId.get(conversa.contact_id)} quando={quando(conversa.ultima_em, tag)} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {ligacoes.length > 0 && (
        <section>
          <h4 className="mb-1 text-[11px] font-medium tracking-wide text-text-muted uppercase">
            {t("Ligações")} · {ligacoes.length}
          </h4>
          <ul className="space-y-1">
            {ligacoes.map((ligacao) => (
              <li
                key={ligacao.id}
                data-ligacao={ligacao.id}
                className="flex flex-wrap items-baseline gap-x-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs"
              >
                <Phone size={13} weight="regular" className="shrink-0 text-text-muted" aria-hidden />
                <span className="min-w-0 truncate font-medium text-text">{nomeDaPessoa(ligacao, porId)}</span>
                <span className="text-text-muted">{ligacao.direcao === "inbound" ? t("Recebida") : t("Feita")}</span>
                <span className={ligacao.atendida ? "text-text-muted" : "text-destructive"}>
                  {ligacao.em_andamento ? t("Em andamento") : ligacao.atendida ? t("Atendida") : t("Não atendida")}
                </span>
                {ligacao.duracao_ms !== null && ligacao.atendida && (
                  <span className="text-text-muted tabular-nums">{duracao(ligacao.duracao_ms)}</span>
                )}
                <span className="ml-auto text-text-muted tabular-nums">
                  {quando(ligacao.comecou_em, tag)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ConversaDaLinha({
  conversa,
  pessoa,
  quando: data,
}: {
  conversa: ConversaDoNumero;
  pessoa: NumeroDoNegocio | undefined;
  quando: string | null;
}) {
  const t = useT();
  const preview = conversa.previa?.trim();
  return (
    <Link
      href={`/app/inbox?id=${conversa.id}`}
      className="group flex flex-wrap items-baseline gap-x-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs transition-colors hover:border-primary/40 hover:bg-muted"
    >
      <ChatCircle size={13} weight="regular" className="shrink-0 text-text-muted" aria-hidden />
      <span className="min-w-0 truncate font-medium text-text">{pessoa?.nome ?? "—"}</span>
      {pessoa?.telefone && <span className="text-text-muted tabular-nums">{pessoa.telefone}</span>}
      {preview && <span className="min-w-0 flex-1 truncate text-text-muted">{preview}</span>}
      {conversa.nao_lidas > 0 && (
        <span
          className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground tabular-nums"
          aria-label={`${conversa.nao_lidas} ${t("sem ler")}`}
        >
          {conversa.nao_lidas}
        </span>
      )}
      {data && <span className="ml-auto shrink-0 text-text-muted tabular-nums">{data}</span>}
    </Link>
  );
}

function nomeDaPessoa(ligacao: LigacaoDoNumero, porId: Map<string, NumeroDoNegocio>): string {
  return porId.get(ligacao.contact_id)?.nome ?? "—";
}

/** `mm:ss` para ligações; `—` nunca, porque a linha só chama quando há duração. */
function duracao(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutos = Math.floor(total / 60);
  const segundos = total % 60;
  return `${minutos}:${String(segundos).padStart(2, "0")}`;
}

function quando(iso: string | null, tag: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(tag, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
