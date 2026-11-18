"use client";

import Link from "next/link";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useConversasDosNumeros } from "@/hooks/leads/useConversasDosNumeros";
import type {
  ConversaDoNumero,
  ItemDaLinhaDoTempo,
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
 * ─── Uma linha do tempo, não duas listas ────────────────────────────────────
 *
 * A primeira entrega desta fatia mostrou conversa e ligação em DUAS listas
 * separadas. O que a vendedora lê é a ordem dos fatos: "liguei, ele mandou o
 * pedido, retornei". Aqui os dois tipos entram no MESMO fio, por data, cada
 * linha com o nome e o telefone de quem falou — e o "carregar mais" pede a
 * página seguinte por cursor, para um cliente com histórico longo não ficar
 * preso nas 50 primeiras linhas.
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
  const { data, isLoading, isError, temMais, carregarMais, carregandoMais } =
    useConversasDosNumeros(leadId);

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

  const { numeros, linha_do_tempo, conversas, ligacoes } = data.data;
  const porId = new Map(numeros.map((n) => [n.contact_id, n]));
  // Resposta antiga (cache de uma aba aberta antes da linha do tempo) ainda tem
  // as duas listas: o fio é montado aqui, com o mesmo critério do servidor.
  const itens =
    linha_do_tempo && linha_do_tempo.length > 0
      ? linha_do_tempo
      : mesclarAsListas(conversas ?? [], ligacoes ?? [], porId);

  if (itens.length === 0) {
    return (
      <p className="text-xs text-text-muted" data-testid="numeros-sem-historico">
        {t("Nenhuma conversa ou ligação nos outros números ainda.")}
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="conversas-dos-numeros">
      <ul className="space-y-1">
        {itens.map((item) => (
          <ItemDaLinha key={item.id} item={item} pessoa={porId.get(item.contact_id)} tag={tag} />
        ))}
      </ul>

      {temMais && (
        <button
          type="button"
          onClick={carregarMais}
          disabled={carregandoMais}
          className="w-full rounded-md border border-border px-2 py-1 text-xs text-text-muted transition-colors hover:border-primary/40 hover:text-text disabled:opacity-60"
          data-testid="numeros-carregar-mais"
        >
          {t("Carregar mais")}
        </button>
      )}
    </div>
  );
}

function ItemDaLinha({
  item,
  pessoa,
  tag,
}: {
  item: ItemDaLinhaDoTempo;
  pessoa: NumeroDoNegocio | undefined;
  tag: string;
}) {
  if (item.tipo === "conversa" && item.conversa) {
    return (
      <li data-conversa={item.conversa.id}>
        <ConversaDaLinha
          conversa={item.conversa}
          pessoa={pessoa}
          quando={quando(item.em, tag)}
        />
      </li>
    );
  }
  if (item.tipo === "ligacao" && item.ligacao) {
    return <LigacaoDaLinha ligacao={item.ligacao} pessoa={pessoa} tag={tag} />;
  }
  return null;
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

function LigacaoDaLinha({
  ligacao,
  pessoa,
  tag,
}: {
  ligacao: LigacaoDoNumero;
  pessoa: NumeroDoNegocio | undefined;
  tag: string;
}) {
  const t = useT();
  return (
    <li
      data-ligacao={ligacao.id}
      className="flex flex-wrap items-baseline gap-x-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs"
    >
      <Phone size={13} weight="regular" className="shrink-0 text-text-muted" aria-hidden />
      <span className="min-w-0 truncate font-medium text-text">{pessoa?.nome ?? "—"}</span>
      {pessoa?.telefone && <span className="text-text-muted tabular-nums">{pessoa.telefone}</span>}
      <span className="text-text-muted">{ligacao.direcao === "inbound" ? t("Recebida") : t("Feita")}</span>
      <span className={ligacao.atendida ? "text-text-muted" : "text-destructive"}>
        {ligacao.em_andamento ? t("Em andamento") : ligacao.atendida ? t("Atendida") : t("Não atendida")}
      </span>
      {ligacao.duracao_ms !== null && ligacao.atendida && (
        <span className="text-text-muted tabular-nums">{duracao(ligacao.duracao_ms)}</span>
      )}
      <span className="ml-auto text-text-muted tabular-nums">{quando(ligacao.comecou_em, tag)}</span>
    </li>
  );
}

/**
 * O fio montado no cliente, para resposta SEM `linha_do_tempo` — a aba aberta
 * antes desta entrega, com a resposta velha em cache. Critério idêntico ao do
 * servidor: `em` desc, conversa antes de ligação no empate, id desc.
 */
function mesclarAsListas(
  conversas: ConversaDoNumero[],
  ligacoes: LigacaoDoNumero[],
  porId: Map<string, NumeroDoNegocio>,
): ItemDaLinhaDoTempo[] {
  const origem = (contactId: string) => {
    const pessoa = porId.get(contactId);
    return { contact_id: contactId, nome: pessoa?.nome ?? null };
  };
  const itens: ItemDaLinhaDoTempo[] = [
    ...conversas.map((conversa) => ({
      tipo: "conversa" as const,
      id: conversa.id,
      ...origem(conversa.contact_id),
      em: conversa.ultima_em,
      conversa,
    })),
    ...ligacoes.map((ligacao) => ({
      tipo: "ligacao" as const,
      id: ligacao.id,
      ...origem(ligacao.contact_id),
      em: ligacao.comecou_em,
      ligacao,
    })),
  ];
  return itens.sort((a, b) => {
    if (a.em !== b.em) {
      if (a.em === null) return 1;
      if (b.em === null) return -1;
      return a.em < b.em ? 1 : -1;
    }
    if (a.tipo !== b.tipo) return a.tipo === "conversa" ? -1 : 1;
    return a.id < b.id ? 1 : -1;
  });
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
