"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useContact } from "@/hooks/contacts/useContact";
import { useContactList } from "@/hooks/contacts/useContactList";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useT } from "@/hooks/i18n/useT";
import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import { useContatosRelacionados } from "@/hooks/leads/useContatosRelacionados";
import {
  useAdicionarParticipante,
  useRemoverParticipante,
} from "@/hooks/leads/useParticipantesDoNegocio";
import type { ContatoRelacionado } from "@/app/api/v1/leads/[id]/contatos-relacionados/route";
import {
  aplicarLinks,
  EXEMPLO_DE_LINK,
  lerLinks,
  normalizarLink,
  TIPOS_DE_LINK,
  tiposInvalidos,
  type LinksDoContato,
  type TipoDeLink,
} from "@/lib/leads/links-de-contato";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { Contact } from "@/lib/types/contacts";

interface Props {
  contactId: string | null;
  pipelineId: string;
  /**
   * A âncora das pessoas relacionadas (#1506 F1). Opcional de propósito: quem
   * só tem o contato (card, testes do dossiê) não consulta rota nenhuma —
   * `useContatosRelacionados` segura a chamada sem `leadId`.
   */
  leadId?: string | null;
}

/**
 * Os dados do CLIENTE dentro do dossiê do negócio: telefone e e-mail numa aba,
 * links (Instagram, site, Google Meu Negócio…) na outra, e ABAIXO do principal
 * as outras pessoas do mesmo negócio (#1506 F1).
 *
 * Telefone e e-mail são LEITURA aqui, de propósito: o telefone exige E.164 e
 * passa por normalização e checagem de duplicidade no cadastro do contato, e
 * reimplementar isso num painel lateral seria uma segunda regra para divergir.
 * A ficha completa (`/app/contacts/[id]`) é um clique, e é onde essa regra mora.
 *
 * Os LINKS são editáveis aqui: não têm regra além de "ser um endereço http(s)",
 * e são o dado que o funil mais precisa preencher de passagem.
 *
 * As PESSOAS RELACIONADAS deixaram de ser só leitura na fatia 1 da #3083:
 * adicionar, remover e dar papel passam pela mesma rota (`POST`/`DELETE` em
 * `contatos-relacionados`). A aba OPCIONAL "Participantes" continua fora — ela
 * é opt-in por organização ou funil, e esse interruptor é decisão de produto.
 */
export function ContatoDoNegocio({ contactId, pipelineId, leadId }: Props) {
  const t = useT();
  return (
    <>
      {contactId ? (
        <ContatoVinculado contactId={contactId} pipelineId={pipelineId} />
      ) : (
        <p className="text-xs text-text-muted">{t("Este negócio não tem contato vinculado.")}</p>
      )}
      <PessoasRelacionadas leadId={leadId ?? null} />
    </>
  );
}

function ContatoVinculado({ contactId, pipelineId }: { contactId: string; pipelineId: string }) {
  const t = useT();
  const { data, isLoading, isError } = useContact(contactId);
  const contato = data?.data;

  if (isLoading) {
    return <p className="text-xs text-text-muted">{t("Carregando…")}</p>;
  }
  if (isError || !contato) {
    return <p className="text-xs text-text-muted">{t("Não consegui carregar o contato.")}</p>;
  }

  return (
    <Tabs defaultValue="dados" data-testid="contato-do-negocio">
      <TabsList>
        <TabsTrigger value="dados">{t("Dados")}</TabsTrigger>
        <TabsTrigger value="links">{t("Links")}</TabsTrigger>
      </TabsList>
      <TabsContent value="dados">
        <DadosDoContato contato={contato} />
      </TabsContent>
      <TabsContent value="links">
        {/* `key` = updated_at: quando o contato é relido depois de salvar (ou
            editado em outra tela), o formulário reinicia com o valor do
            servidor, sem um efeito de sincronização que pisaria no que a
            pessoa está digitando. */}
        <FormularioDeLinks key={contato.updated_at} contato={contato} pipelineId={pipelineId} />
      </TabsContent>
    </Tabs>
  );
}

/**
 * As outras pessoas do negócio: a lista que faltava embaixo do contato
 * principal (#1506 F1), e o ESCRITOR que faltava desde então (#3083 F1).
 *
 * ─── O DEFEITO QUE ESTE BLOCO FECHA ─────────────────────────────────────────
 *
 * Até aqui a lista só sabia LER. Não existia `INSERT` em `crm_lead_links` com
 * `target_kind='contact'` em lugar nenhum do produto — nem rota, nem tela —,
 * então não havia como adicionar, remover nem dar papel a um participante. O
 * único caminho era editar a descrição do negócio à mão.
 *
 * ─── POR QUE A LISTA VAZIA NÃO SOME MAIS ────────────────────────────────────
 *
 * A versão leitora devolvia `null` com a lista vazia, de propósito: negócio sem
 * relacionado não ganhava um título de seção pendurado no dossiê, e quem
 * carregava a tela não via um piscar de lista vazia antes da resposta. Com o
 * escritor isso deixou de servir: se a lista vazia some, ela leva junto o ÚNICO
 * controle que ADICIONA a primeira pessoa — o recurso novo ficaria inalcançável
 * justo nos negócios que mais precisam dele. Agora a seção aparece vazia,
 * dizendo que está vazia, com o controle ao lado.
 *
 * O carregamento continua mudo (`isLoading` devolve `null`): isso não é a lista
 * vazia, é a resposta que ainda não chegou — e um "nenhuma pessoa" que pisca
 * antes dos dados é uma afirmação falsa sobre o negócio. O erro NÃO some: ele é
 * a única coisa que a pessoa tem a ler quando a rota falha.
 *
 * Sem `leadId` não há âncora para escrever: o bloco inteiro não renderiza, e
 * quem monta o componente sem o negócio (card, testes do dossiê) não faz rede.
 *
 * O `papel` vem do `metadata` escrito pelo atendente (texto livre, teto de 40 —
 * a régua está na rota) e o nome vem do cadastro: dado de quem usou o produto,
 * não frase de interface, então os dois saem como vieram em qualquer idioma.
 */
function PessoasRelacionadas({ leadId }: { leadId: string | null }) {
  const t = useT();
  const { data, isLoading, isError } = useContatosRelacionados(leadId);
  if (!leadId) return null;
  if (isError) {
    return (
      <p className="mt-2 text-xs text-destructive">
        {t("Não consegui carregar as pessoas relacionadas.")}
      </p>
    );
  }
  if (isLoading) return null;
  const pessoas = data?.data ?? [];
  return (
    <div className="mt-3 space-y-1" data-testid="pessoas-relacionadas">
      <p className="text-[11px] font-medium tracking-wide text-text-muted uppercase">
        {t("Pessoas relacionadas")}
      </p>
      {pessoas.length === 0 ? (
        <p className="text-xs text-text-muted">{t("Nenhuma pessoa relacionada ainda.")}</p>
      ) : (
        <ul className="space-y-1">
          {pessoas.map((pessoa) => (
            <li key={pessoa.contact_id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="min-w-0 truncate">{pessoa.nome ?? "—"}</span>
              {pessoa.papel && <span className="text-text-muted">({pessoa.papel})</span>}
              {pessoa.anonimizado && <span className="text-text-muted">{t("Anonimizado")}</span>}
              <RemoverParticipante leadId={leadId} pessoa={pessoa} />
            </li>
          ))}
        </ul>
      )}
      <AdicionarParticipante leadId={leadId} />
    </div>
  );
}

/**
 * O "remover" de UMA pessoa.
 *
 * Componente próprio, e não um botão inline, porque o hook de mutação é por
 * LINHA: montado dentro do `<li>`, cada linha tem o seu estado de "removendo" e
 * só o botão clicado desabilita. Um hook de remoção só para a lista inteira
 * desabilitaria todos os botões ao remover qualquer um.
 */
function RemoverParticipante({ leadId, pessoa }: { leadId: string; pessoa: ContatoRelacionado }) {
  const t = useT();
  const remover = useRemoverParticipante(leadId);
  // O nome no rótulo acessível: numa lista de pessoas, "Remover" sozinho não diz
  // a quem o botão pertence.
  const alvo = pessoa.nome ?? "";
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="ml-auto h-6 px-2 text-[11px] text-text-muted hover:text-destructive"
      disabled={remover.isPending}
      aria-label={`${t("Remover")} ${alvo}`.trim()}
      onClick={() =>
        remover.mutate(pessoa.contact_id, {
          onSuccess: () => toast.success(t("Participante removido.")),
        })
      }
    >
      {t("Remover")}
    </Button>
  );
}

/**
 * O controle que ADICIONA a primeira pessoa — e todas as outras.
 *
 * Fechado por padrão: o dossiê é uma leitura na maior parte do tempo, e um
 * formulário de busca sempre aberto ocuparia o rodapé de todos os negócios.
 * Aberto, ele MONTA `FormularioDeParticipante` — e é a montagem que segura a
 * única chamada de rede (`useContactList` não tem `enabled`): fechado, não há
 * requisição nenhuma de contatos.
 */
function AdicionarParticipante({ leadId }: { leadId: string }) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  if (aberto) {
    return <FormularioDeParticipante leadId={leadId} onFechar={() => setAberto(false)} />;
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-7 px-2 text-xs text-text-muted hover:text-text"
      data-testid="adicionar-participante"
      onClick={() => setAberto(true)}
    >
      {t("Adicionar participante")}
    </Button>
  );
}

/**
 * A busca e o papel, e o POST.
 *
 * O papel é digitado ANTES de escolher a pessoa (texto livre, teto de 40 no
 * servidor) porque é ele que faz o vínculo ser útil: "quem paga" e "quem viaja"
 * são a informação que o negócio de grupo precisa, e escrevê-la depois exigiria
 * abrir a linha de novo. Em branco, o vínculo nasce sem papel — e um POST novo
 * do mesmo contato com papel preenchido é "dar papel", que é o mesmo caminho
 * (upsert no índice único, do lado do servidor).
 */
function FormularioDeParticipante({ leadId, onFechar }: { leadId: string; onFechar: () => void }) {
  const t = useT();
  const [busca, setBusca] = useState("");
  const [papel, setPapel] = useState("");
  const adicionar = useAdicionarParticipante(leadId);
  const termo = busca.trim();
  const { data, isLoading } = useContactList({ search: termo || undefined, limit: 5 });
  const contatos = data?.pages[0]?.data ?? [];

  async function incluir(contactId: string) {
    try {
      await adicionar.mutateAsync({ contact_id: contactId, papel: papel.trim() || null });
      toast.success(t("Participante adicionado."));
      onFechar();
    } catch {
      // `useAdicionarParticipante` já mostra o erro da API; aqui só não deixar a
      // rejeição escapar como erro não tratado.
    }
  }

  return (
    <div
      className="space-y-2 rounded-md border border-border p-2"
      data-testid="formulario-de-participante"
    >
      <div className="space-y-1">
        <Label htmlFor="papel-do-participante" className="text-xs">
          {t("Papel")}
        </Label>
        <Input
          id="papel-do-participante"
          value={papel}
          maxLength={40}
          placeholder={t("Pagante, passageiro…")}
          onChange={(e) => setPapel(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="busca-de-participante" className="text-xs">
          {t("Buscar contato")}
        </Label>
        <Input
          id="busca-de-participante"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
      </div>
      {isLoading && <p className="text-[11px] text-text-muted">{t("Carregando…")}</p>}
      {!isLoading && contatos.length === 0 && (
        <p className="text-[11px] text-text-muted">{t("Nenhum contato encontrado.")}</p>
      )}
      <ul className="space-y-1">
        {contatos.map((contato) => (
          <li key={contato.id} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 truncate">{nomeDoContato(contato) ?? "—"}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-[11px]"
              disabled={adicionar.isPending}
              onClick={() => incluir(contato.id)}
            >
              {t("Adicionar")}
            </Button>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-[11px] text-text-muted"
        onClick={onFechar}
      >
        {t("Cancelar")}
      </Button>
    </div>
  );
}

function DadosDoContato({ contato }: { contato: Contact }) {
  const t = useT();
  const nome = nomeDoContato(contato);
  const digitos = (contato.phone_number ?? "").replace(/\D/g, "");

  return (
    <div className="space-y-2 text-sm">
      <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-xs text-text-muted">{t("Nome")}</dt>
        <dd className="min-w-0 truncate">{nome ?? "—"}</dd>

        <dt className="text-xs text-text-muted">{t("Telefone")}</dt>
        <dd className="min-w-0 tabular-nums">
          {contato.phone_number ? (
            <span className="inline-flex flex-wrap items-center gap-x-2">
              {contato.phone_number}
              {digitos && (
                <a
                  href={`https://wa.me/${digitos}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent underline-offset-2 hover:underline"
                >
                  {t("Abrir no WhatsApp")}
                </a>
              )}
            </span>
          ) : (
            "—"
          )}
        </dd>

        <dt className="text-xs text-text-muted">{t("E-mail")}</dt>
        <dd className="min-w-0 truncate">
          {contato.email ? (
            <a href={`mailto:${contato.email}`} className="underline-offset-2 hover:underline">
              {contato.email}
            </a>
          ) : (
            "—"
          )}
        </dd>
      </dl>
      <Link
        href={`/app/contacts/${contato.id}`}
        className="inline-block text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
      >
        {t("Ver ficha completa do contato")}
      </Link>
    </div>
  );
}

function FormularioDeLinks({ contato, pipelineId }: { contato: Contact; pipelineId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const atualizar = useUpdateContact(contato.id);
  const [valores, setValores] = useState<LinksDoContato>(() => lerLinks(contato.custom_fields));
  // O erro só aparece DEPOIS da primeira tentativa de salvar: "exemplo" ainda
  // sem ".com" não é um erro de quem está no meio da digitação.
  const [tentouSalvar, setTentouSalvar] = useState(false);
  const invalidos = new Set<TipoDeLink>(tiposInvalidos(valores));

  function definir(tipo: TipoDeLink, valor: string) {
    setValores((atual) => ({ ...atual, [tipo]: valor }));
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setTentouSalvar(true);
    if (invalidos.size > 0) {
      toast.error(t("Confira os links marcados: só endereços http(s) valem."));
      return;
    }
    try {
      // O PATCH troca o `custom_fields` INTEIRO — `aplicarLinks` devolve o
      // objeto completo, com os campos que não são link preservados.
      await atualizar.mutateAsync({
        custom_fields: aplicarLinks(contato.custom_fields, valores),
      });
      // O card do funil lê estes links do quadro, não do contato: sem reler o
      // quadro, salvar aqui pareceria "não fez nada" no card.
      await qc.invalidateQueries({ queryKey: chaveDoQuadro(pipelineId) });
      toast.success(t("Links salvos."));
    } catch {
      // `useUpdateContact` já mostra o erro da API; aqui só não deixar a
      // rejeição escapar como erro não tratado.
    }
  }

  return (
    <form onSubmit={salvar} className="space-y-3" data-testid="formulario-de-links">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {TIPOS_DE_LINK.map(({ id, rotulo }) => {
          const href = normalizarLink(valores[id]);
          const erro = tentouSalvar && invalidos.has(id);
          return (
            <div key={id} className="space-y-1">
              <Label htmlFor={`link-${id}`} className="text-xs">
                {t(rotulo)}
              </Label>
              <div className="flex gap-1">
                <Input
                  id={`link-${id}`}
                  value={valores[id] ?? ""}
                  onChange={(e) => definir(id, e.target.value)}
                  maxLength={1000}
                  placeholder={EXEMPLO_DE_LINK}
                  aria-invalid={erro || undefined}
                  className={erro ? "border-destructive" : undefined}
                />
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${t("Abrir")} ${t(rotulo)}`}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-text"
                  >
                    ↗
                  </a>
                )}
              </div>
              {erro && <p className="text-[11px] text-destructive">{t("Endereço inválido.")}</p>}
            </div>
          );
        })}
      </div>
      <Button type="submit" size="sm" disabled={atualizar.isPending}>
        {atualizar.isPending ? t("Salvando…") : t("Salvar links")}
      </Button>
    </form>
  );
}
