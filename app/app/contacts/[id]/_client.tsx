"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";
import { useState } from "react";
import { format } from "date-fns";
import { ShieldCheck, PencilSimple, LockOpen } from "@/lib/ui/icons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { FichasDoModulo } from "@/components/modulos/FichasDoModulo";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useContact } from "@/hooks/contacts/useContact";
import { useUnblockContact } from "@/hooks/contacts/useUnblockContact";
import {
  useMarkPersonalContact,
  useUnmarkPersonalContact,
} from "@/hooks/contacts/usePersonalContact";
import {
  useMarkAlwaysHumanContact,
  useUnmarkAlwaysHumanContact,
} from "@/hooks/contacts/useAlwaysHumanContact";
import { useHierarquiaDoAnuncio } from "@/hooks/contacts/useHierarquiaDoAnuncio";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useDefaultPipeline } from "@/hooks/pipelines/useDefaultPipeline";
import { camposDoFunil, camposPorEscopo } from "@/lib/leads/campos-do-funil";
import { canonicalTagsDoFunil } from "@/lib/contacts/etiquetas";
import { ROLE_RANK, roleAtLeast } from "@/lib/auth/types";
import { TimelineView } from "@/components/contacts/TimelineView";
import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import { JuntarComOutraFicha } from "@/components/contacts/JuntarComOutraFicha";
import { CartaoDaCarteira } from "@/components/contacts/CartaoDaCarteira";
import { AnonymizeDialog } from "@/components/contacts/AnonymizeDialog";
import { PropostasDeDado } from "@/components/contacts/PropostasDeDado";
import { RoteirosDoContato } from "@/components/contacts/RoteirosDoContato";
import { UltimasComprasDoContato } from "@/components/contacts/UltimasCompras";
import { ConversaNoDossie } from "@/components/kanban/ConversaNoDossie";
import { rotuloParaAEquipe } from "@/lib/contacts/rotulo-do-contato";
import { ORIGEM_AGENDA_DO_CELULAR, origemDoContato } from "@/lib/leads/origem-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { DialButton } from "@/components/voice/DialButton";
import type { Contact } from "@/lib/types/contacts";
import { ListaDeLinks } from "@/components/contacts/ListaDeLinks";
import { linksParaExibir } from "@/lib/leads/links-de-contato";

interface Props {
  contactId: string;
  /** Painéis de módulo de dados que declaram referência a contato. Resolvido no servidor. */
  paineisDeModulo?: { modulo: string; objeto: string }[];
}

/**
 * Um nível da origem, ou nada.
 *
 * Escondido quando não há valor, em vez de mostrar "—": quatro travessões
 * seguidos leem como cadastro quebrado, e não como "este contato não veio de
 * campanha". O rótulo chega já traduzido porque `t()` com argumento não literal
 * escapa do guardião de espanhol.
 */
function NivelDaOrigem({ rotulo, valor }: { rotulo: string; valor: string | null }) {
  if (!valor) return null;
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{rotulo}</dt>
      <dd className="mt-1 break-words">{valor}</dd>
    </div>
  );
}

/**
 * Rótulos do tipo e do WhatsApp de um telefone (Spec 31, B1). Cada ramo traz o
 * `t("...")` LITERAL: o guardião de espanhol só enxerga texto escrito na tela, e
 * `t(variavel)` escapa dele.
 */
function textoDoTipoDoTelefone(tipo: string | null | undefined, t: (texto: string) => string): string | null {
  if (tipo === "fixo") return t("Fixo");
  if (tipo === "celular") return t("Celular");
  if (tipo === "outro") return t("Outro");
  return null;
}

function textoDoWhatsappDoTelefone(
  whatsapp: string | null | undefined,
  t: (texto: string) => string,
): string | null {
  if (whatsapp === "sim") return t("Tem WhatsApp");
  if (whatsapp === "nao") return t("Sem WhatsApp");
  if (whatsapp === "nao_sei") return t("WhatsApp: não sabemos");
  return null;
}

/**
 * O bloco "Telefones" da ficha (Spec 31, B1), SÓ LEITURA: o principal e cada
 * extra, com tipo, WhatsApp, rótulo e, quando a fusão trouxe o número, a origem.
 * Editar é a próxima entrega (B2). Só aparece com extra; sem extra a ficha segue
 * como hoje, com o tipo ao lado do número.
 */
function BlocoDeTelefones({ contato, t }: { contato: Contact; t: (texto: string) => string }) {
  const extras = contato.additional_phones ?? [];
  return (
    <div className="md:col-span-2">
      <dt className="text-xs uppercase text-muted-foreground">{t("Telefones")}</dt>
      <dd className="mt-1">
        <ul className="flex flex-col gap-2">
          {contato.phone_number && (
            <li className="flex flex-wrap items-center gap-2">
              <span>{phoneForDisplay(contato.phone_number)}</span>
              <Badge variant="secondary">{t("Principal")}</Badge>
              {textoDoTipoDoTelefone(contato.phone_type, t) && (
                <span className="text-xs text-muted-foreground">
                  {textoDoTipoDoTelefone(contato.phone_type, t)}
                </span>
              )}
              {textoDoWhatsappDoTelefone(contato.phone_whatsapp, t) && (
                <span className="text-xs text-muted-foreground">
                  {textoDoWhatsappDoTelefone(contato.phone_whatsapp, t)}
                </span>
              )}
            </li>
          )}
          {extras.map((extra) => (
            <li key={extra.phone_number} className="flex flex-wrap items-center gap-2">
              <span>{phoneForDisplay(extra.phone_number)}</span>
              {textoDoTipoDoTelefone(extra.type, t) && (
                <span className="text-xs text-muted-foreground">
                  {textoDoTipoDoTelefone(extra.type, t)}
                </span>
              )}
              {textoDoWhatsappDoTelefone(extra.whatsapp, t) && (
                <span className="text-xs text-muted-foreground">
                  {textoDoWhatsappDoTelefone(extra.whatsapp, t)}
                </span>
              )}
              {extra.label && <span className="text-xs text-muted-foreground">{extra.label}</span>}
              {extra.origin === "fusao" && (
                <span className="text-xs text-muted-foreground">{t("Veio da junção de fichas")}</span>
              )}
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}

export function ContactDetailClient({ contactId, paineisDeModulo = [] }: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const q = useContact(contactId);
  const { user, activeOrg } = useAuth();
  const clientesLigado = activeOrg?.cliente_pela_agenda === true;
  // As DEFINIÇÕES continuam no funil (`crm_pipelines.settings.fields[]`) — só o
  // VALOR mora no contato. `camposDoFunil` é o mesmo leitor que o Kanban usa.
  const pipelineQuery = useDefaultPipeline(Boolean(activeOrg));
  // As duas fontes do autocompletar de etiquetas (issue #2732). Os dois hooks
  // ficam ANTES dos early returns pelo mesmo motivo do `desbloquear` abaixo:
  // chamá-los depois mudaria a ordem dos hooks entre renderizações.
  const vocabularioDeEtiquetas = useContactTagVocabulary(activeOrg?.orgId ?? null);
  const canonicalTags = canonicalTagsDoFunil(pipelineQuery.data?.pipeline.settings ?? null);
  const [editOpen, setEditOpen] = useState(false);
  const [anonOpen, setAnonOpen] = useState(false);
  // Juntar com outra ficha (spec 31, PR A): gestor, mesmo gate da fusão. Fica
  // antes dos early returns pelo mesmo motivo dos hooks acima.
  const podeJuntar = roleAtLeast(activeOrg?.role, "manager");
  const [juntarOpen, setJuntarOpen] = useState(false);
  // Desfazer o descadastro é o override da regra W-02 — só admin, e auditado.
  // O hook fica ANTES dos early returns: chamá-lo depois mudaria a ordem dos
  // hooks entre renderizações e o React reprova.
  const desbloquear = useUnblockContact(contactId);
  // Marcar/desmarcar pessoal (spec 21, etapa 15): os hooks ficam aqui pelo
  // mesmo motivo do `desbloquear` acima.
  const marcarPessoal = useMarkPersonalContact(contactId);
  const desmarcarPessoal = useUnmarkPersonalContact(contactId);
  // A marca PERMANENTE "sempre atendimento humano" (issue 2379). Os hooks
  // ficam aqui pelos MESMOS motivos dos de pessoal: ordem de hooks estável e
  // efeito que o Inbox enxerga.
  const marcarSempreHumano = useMarkAlwaysHumanContact(contactId);
  const desmarcarSempreHumano = useUnmarkAlwaysHumanContact(contactId);

  /*
    Pede o nome da campanha SÓ quando há um anúncio e ainda não há nome.

    Quem chegou pelo site já trouxe os nomes na URL, e quem já foi resolvido uma
    vez tem `campaign_name` no metadata — nos dois casos, perguntar à plataforma
    gastaria cota para receber o que já está na tela. Cota é o recurso escasso
    desta conta, não latência.

    Derivado de `q.data` e não de `contact` porque hook não pode ficar depois de
    um `return` condicional — e os dois `if` de carregamento vêm logo abaixo.
  */
  const metadataDoContato = (q.data?.data.source_metadata ?? {}) as Record<string, unknown>;
  const temAnuncio =
    typeof metadataDoContato.ad_id === "string" && metadataDoContato.ad_id.trim() !== "";
  const jaTemNome = typeof metadataDoContato.campaign_name === "string";
  const hierarquia = useHierarquiaDoAnuncio(contactId, temAnuncio && !jaTemNome);

  if (q.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (q.isError || !q.data) {
    return (
      <div className="p-6">
        <Card className="p-6 text-center text-sm text-error-fg">{t("Erro ao carregar contato.")}</Card>
      </div>
    );
  }

  const contact = q.data.data;
  const linksDoContato = linksParaExibir(contact.custom_fields);
  const isAdmin =
    (user.is_platform_admin && !user.support) || (activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin);
  // Gerente e dono marcam/desmarcam pessoal (spec 21, decisão 1, D3) — e este
  // gate fica LADO A LADO com o `isAdmin` do desbloquear, cada um com seu
  // motivo: desfazer descadastro reabre um canal que o cliente fechou (só
  // admin, LGPD); pessoal é decisão operacional (gerente pode).
  const podeMarcarPessoal =
    (user.is_platform_admin && !user.support) ||
    (activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager);

  // Uma decisão, um lugar (lib/contacts/rotulo-do-contato.ts). Esta tela era
  // uma das DUAS que ignoravam o telefone: contato com número e sem nome
  // aparecia como "Sem nome" aqui e com o número no inbox.
  const displayName = rotuloParaAEquipe(contact, t);

  // Os quatro níveis que quem opera tráfego lê. O jsonb já os recebia dos dois
  // caminhos de entrada — site e clique-para-WhatsApp — e nenhuma tela o abria.
  //
  // O que a plataforma respondeu entra COMO SE fosse metadata, e não como um
  // segundo caminho na tela: as três chaves resolvidas (`campaign_name`,
  // `adset_name`, `ad_name`) são exatamente as que `origemDoContato` já lê, no
  // degrau abaixo da UTM. Uma regra de precedência só, e ela já estava escrita.
  const origem = origemDoContato(
    hierarquia.data
      ? { ...(contact.source_metadata ?? {}), ...hierarquia.data }
      : contact.source_metadata,
    contact.source,
  );

  return (
    <div className="space-y-4 p-6">
      {contact.is_anonymized && (
        <div
          role="alert"
          className="border-error-fg/30 sticky top-0 z-20 flex items-center gap-3 rounded-md border bg-error-bg p-3 text-sm text-error-fg"
        >
          <ShieldCheck size={18} weight="duotone" aria-hidden />
          <span>
            {t("Contato anonimizado (LGPD)")}
            {contact.anonymized_at &&
              ` em ${format(new Date(contact.anonymized_at), "dd/MM/yyyy", { locale: localeDaData })}`}
            {t(" — edição bloqueada.")}
          </span>
        </div>
      )}

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          {/* Sem truncar: nome é dado que a tela existe pra mostrar, e cortar
              com reticências sem um jeito de ver o resto violaria o princípio
              de nunca esconder informação crítica. Deixa quebrar linha. */}
          <h1 className="break-words text-2xl font-semibold tracking-tight">{displayName}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {contact.email && <span>{contact.email}</span>}
            {contact.email && contact.phone_number && <span>•</span>}
            {contact.phone_number && <span>{phoneForDisplay(contact.phone_number)}</span>}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {contact.tags.map((t) => (
              <ChipDeEtiqueta key={t} tag={t} />
            ))}
            {contact.is_blocked && <Badge variant="warning">{t("Bloqueado")}</Badge>}
            {/* Selo lido da COLUNA, nunca da etiqueta (critério 5): editar
                etiquetas não apaga o selo — mesma regra do "Bloqueado" acima. */}
            {contact.is_personal && <Badge variant="secondary">{t("Pessoal")}</Badge>}
            {/* O TIPO DO CONTATO (issue 3005, fatia 1): selo lido da COLUNA
                (`contacts.contact_type`), mesma regra dos de cima — a etiqueta
                `fornecedor` é de trabalho e removível; o selo não. Só o
                fornecedor aparece: cliente é o padrão da coluna. */}
            {contact.contact_type === "fornecedor" && (
              <Badge variant="secondary">{t("Fornecedor")}</Badge>
            )}
            {/* A marca PERMANENTE (issue 2379): lida da COLUNA, mesma régua do
                "Bloqueado" e do "Pessoal" — a devolução não a apaga, então o selo
                continua a verdade mesmo quando a conversa já voltou ao automático. */}
            {contact.ai_opt_out && <Badge variant="secondary">{t("Sempre atendimento humano")}</Badge>}
            {contact.is_anonymized && <Badge variant="destructive">{t("Anonimizado")}</Badge>}
          </div>
        </div>
        {!contact.is_anonymized && user.support?.access_mode !== "support_readonly" && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {/* O CAMINHO DE VOLTA do descadastro. Sem ele, o contato que pediu
                para sair — ou que caiu num falso positivo — ficava preso para
                sempre: `before-send` recusa todo envio, o funil não cria lead,
                o follow-up não retoma. A regra W-02 previu o override
                ("Tenant admin pode desbloquear manualmente; ação auditada") e o
                produto não tinha porta nenhuma para exercê-lo.

                Só ADMIN, como a regra nomeia: desfazer um pedido de descadastro
                não é editar cadastro, é reabrir um canal que o cliente fechou —
                e quem clica responde pela decisão. */}
            {/* Confirmação antes do clique: nenhum caminho do produto bloqueia
                de novo à mão (o único escritor de is_blocked=true é o STOP do
                próprio cliente, em lib/channels/pos-entrada.ts), então um clique
                errado ao lado do "Editar" reabriria um canal que só o cliente
                consegue fechar outra vez. */}
            {contact.is_blocked && isAdmin && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" disabled={desbloquear.isPending} className="shrink-0">
                    <LockOpen size={16} weight="bold" aria-hidden />
                    <span>{t("Desbloquear")}</span>
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("Desbloquear este contato?")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("Este contato pediu para não receber mais mensagens. Desbloquear volta a permitir campanhas, follow-ups e respostas da IA para ele, e a ação fica registrada na auditoria em seu nome.")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => desbloquear.mutate()}>
                      {t("Desbloquear")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {/* PESSOAL (spec 21, etapa 15): gerente marca e desmarca; sem
                exceção de envio — quem é pessoal não recebe por nenhum caminho.
                Marcar confirma (esconde da operação); desmarcar é direto. */}
            {!contact.is_personal && podeMarcarPessoal && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    disabled={marcarPessoal.isPending}
                    className="shrink-0"
                    data-testid="marcar-pessoal"
                  >
                    <span>{t("Marcar como pessoal")}</span>
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("Marcar este contato como pessoal?")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("O contato sai da operação: conversas fecham, IA, follow-ups, campanha e envios param. O histórico continua no banco e volta à vista ao desmarcar; follow-ups e campanhas cancelados não voltam.")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => marcarPessoal.mutate()}>
                      {t("Marcar como pessoal")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {contact.is_personal && podeMarcarPessoal && (
              <Button
                variant="outline"
                disabled={desmarcarPessoal.isPending}
                className="shrink-0"
                data-testid="desmarcar-pessoal"
                onClick={() => desmarcarPessoal.mutate()}
              >
                <span>
                  {desmarcarPessoal.isPending ? t("Desmarcando...") : t("Desmarcar pessoal")}
                </span>
              </Button>
            )}
            {/* SEMPRE ATENDIMENTO HUMANO (issue 2379): a marca que a devolução
                NÃO desfaz — nem a manual, nem a automática do cron. Marcar
                confirma (a IA para de vez); remover é direto e NÃO devolve o
                atendimento, que continua sendo gesto do botão "Devolver ao
                automático". Mesmo gate de pessoal: decisão operacional. */}
            {!contact.ai_opt_out && podeMarcarPessoal && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    disabled={marcarSempreHumano.isPending}
                    className="shrink-0"
                    data-testid="marcar-sempre-humano"
                  >
                    <span>{t("Marcar como sempre humano")}</span>
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("Marcar este contato como sempre humano?")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("A IA deixa de responder este contato para sempre: a devolução automática e o botão de devolver ao automático passam a recusar, e a marca só sai por aqui. A conversa atual continua com a equipe.")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => marcarSempreHumano.mutate()}>
                      {t("Marcar como sempre humano")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {contact.ai_opt_out && podeMarcarPessoal && (
              <Button
                variant="outline"
                disabled={desmarcarSempreHumano.isPending}
                className="shrink-0"
                data-testid="desmarcar-sempre-humano"
                onClick={() => desmarcarSempreHumano.mutate()}
              >
                <span>
                  {desmarcarSempreHumano.isPending
                    ? t("Removendo...")
                    : t("Remover marca de humano")}
                </span>
              </Button>
            )}
            <DialButton contactId={contactId} hasPhone={!!contact.phone_number} />
            {podeJuntar && (
              <Button
                variant="outline"
                onClick={() => setJuntarOpen(true)}
                className="shrink-0"
                data-testid="juntar-com-outra-ficha"
              >
                <span>{t("Juntar com outra ficha")}</span>
              </Button>
            )}
            <Button variant="outline" onClick={() => setEditOpen(true)} className="shrink-0">
              <PencilSimple size={16} weight="bold" aria-hidden />
              <span>{t("Editar")}</span>
            </Button>
          </div>
        )}
      </header>

      <ConversaNoDossie conversa={contact.conversa} />

      {/* ANTES das abas, e não dentro de uma delas: é o único conteúdo desta
          tela que PEDE uma ação. Enterrado numa aba, viraria pendência que só
          quem já sabe que existe encontra — e a fila deixaria de ser fila.
          Some sozinho quando não há nada aguardando. */}
      {!contact.is_anonymized && user.support?.access_mode !== "support_readonly" && (
        <PropostasDeDado
          contactId={contactId}
          podeDecidir={Boolean(activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent)}
          aoDecidir={() => void q.refetch()}
        />
      )}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">{t("Visão geral")}</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          {isAdmin && <TabsTrigger value="lgpd">LGPD</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <Card className="p-4">
            <dl className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t("Nome")}</dt>
                <dd className="mt-1">{contact.name ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t("Nome")} · WhatsApp</dt>
                <dd className="mt-1">{contact.display_name ?? "—"}</dd>
              </div>
              {contact.address_book_name && (
                <div>
                  {/* Só a equipe vê: nenhuma mensagem usa este nome (PR #2439). */}
                  <dt className="text-xs uppercase text-muted-foreground">{t("Nome na agenda do celular")}</dt>
                  <dd className="mt-1">{contact.address_book_name}</dd>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t("Só a equipe vê. Para usar em mensagens, copie para o nome.")}
                  </p>
                </div>
              )}
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Email</dt>
                <dd className="mt-1">{contact.email ?? "—"}</dd>
              </div>
              {/*
                Com telefone extra, o bloco lista o principal e os extras (Spec 31,
                B1). Sem extra, a linha segue como hoje; o tipo do número vai ao lado.
              */}
              {contact.additional_phones && contact.additional_phones.length > 0 ? (
                <BlocoDeTelefones contato={contact} t={t} />
              ) : (
                <div>
                  <dt className="text-xs uppercase text-muted-foreground">{t("Telefone")}</dt>
                  <dd className="mt-1">
                    {contact.phone_number ? phoneForDisplay(contact.phone_number) : "—"}
                    {contact.phone_number && textoDoTipoDoTelefone(contact.phone_type, t) && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {textoDoTipoDoTelefone(contact.phone_type, t)}
                      </span>
                    )}
                  </dd>
                </div>
              )}
              {linksDoContato.length > 0 && (
                <div>
                  <dt className="text-xs uppercase text-muted-foreground">{t("Links")}</dt>
                  <dd className="mt-1">
                    <ListaDeLinks links={linksDoContato} />
                  </dd>
                </div>
              )}
              {/*
                A data gravada pelo "Editar contato" (e pela proposta aprovada),
                enxergada aqui — é ela que o cron `contact-birthdays` lê para
                emitir `contact.birthday`. A string vira `dd/MM/yyyy` PELOS
                PEDAÇOS: `new Date("1990-09-14")` nasce à meia-noite em UTC, e
                `format` no fuso da tela (UTC-3) devolveria 13/09 — o
                aniversário de ontem para quem olha.
              */}
              <div>
                <dt className="text-xs uppercase text-muted-foreground">
                  {t("Data de nascimento")}
                </dt>
                <dd className="mt-1">
                  {contact.birthdate ? contact.birthdate.split("-").reverse().join("/") : "—"}
                </dd>
              </div>
              {(contact.zip_code || contact.street || contact.city || contact.state) && (
                <div className="sm:col-span-2">
                  <dt className="text-xs uppercase text-muted-foreground">{t("Endereço")}</dt>
                  <dd className="mt-1">
                    {[contact.street, contact.number, contact.complement, contact.district, contact.city, contact.state, contact.zip_code]
                      .filter(Boolean)
                      .join(", ")}
                  </dd>
                </div>
              )}
              {/*
                A origem sai do `source_metadata` quando ele tem algo melhor a
                dizer, e cai na coluna `source` quando não tem. Antes esta linha
                lia só a coluna, e a resposta era `site` para quem chegou pelo
                link do site, ou o nome da plataforma para quem clicou num
                anúncio — mesmo com o `utm_source` da campanha gravado ao lado.
              */}
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t("Origem")}</dt>
                <dd className="mt-1">
                  {origem.origem === ORIGEM_AGENDA_DO_CELULAR ? t("Agenda do celular") : origem.origem}
                </dd>
              </div>
              <NivelDaOrigem rotulo={t("Campanha")} valor={origem.campanha} />
              <NivelDaOrigem rotulo={t("Conjunto")} valor={origem.conjunto} />
              <NivelDaOrigem rotulo={t("Anúncio")} valor={origem.anuncio} />
              <NivelDaOrigem rotulo={t("Posicionamento")} valor={origem.posicionamento} />
              {origem.semPosicionamentoDeAnuncio && (
                <div>
                  <dt className="text-xs uppercase text-muted-foreground">
                    {t("Posicionamento")}
                  </dt>
                  <dd className="mt-1 text-sm text-muted-foreground">
                    {t("A plataforma não informa o posicionamento de cada clique em anúncio.")}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t("Última atividade")}</dt>
                <dd className="mt-1">
                  {contact.last_activity_at
                    ? format(new Date(contact.last_activity_at), "dd/MM/yyyy HH:mm", {
                        locale: localeDaData,
                      })
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t("Criado em")}</dt>
                <dd className="mt-1">
                  {format(new Date(contact.created_at), "dd/MM/yyyy", { locale: localeDaData })}
                </dd>
              </div>
              {/*
                Escondido quando nulo, em vez de mostrar "—": aqui a ausência não
                é dado faltando, é "ainda não é cliente". Um travessão nesta
                linha leria como falha de cadastro. E escondido com a regra
                "Clientes pela agenda" desligada: a data está congelada.
              */}
              {clientesLigado && contact.first_service_at && (
                <div>
                  <dt className="text-xs uppercase text-muted-foreground">
                    {t("Cliente desde")}
                  </dt>
                  <dd className="mt-1">
                    {format(new Date(contact.first_service_at), "dd/MM/yyyy", {
                      locale: localeDaData,
                    })}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Tags</dt>
                <dd className="mt-1 flex flex-wrap gap-1">
                  {contact.tags.length === 0
                    ? "—"
                    : contact.tags.map((t) => (
                        <ChipDeEtiqueta key={t} tag={t} />
                      ))}
                </dd>
              </div>
            </dl>
          </Card>
          {/* CARTEIRA DO CLIENTE (#2591): de quem é este cliente. Fica na Visão
              geral, junto dos dados que dizem "quem é esta pessoa" — quem atende
              responde a pergunta antes de prometer o negócio, e o gerente muda o
              dono aqui (o seletor só aparece para `manager`+; o gate real é o da
              rota `PATCH /contacts/[id]/carteira`). Só de `agent` para cima: é
              o piso do GET da carteira, e o `viewer` receberia 403. */}
          {activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent && (
            <div className="mt-4">
              <CartaoDaCarteira contactId={contactId} papelDoUsuario={activeOrg.role} />
            </div>
          )}
          <div className="mt-4">
            <RoteirosDoContato contactId={contactId} />
          </div>
          {/* AS ÚLTIMAS COMPRAS (issue #3179): a MESMA seção do painel do Inbox,
              na ficha do contato — negócios ganhos em todos os funis, com data,
              título, valor, campos escolhidos pela organização e atalho. */}
          {!contact.is_anonymized && (
            <div className="mt-4">
              <UltimasComprasDoContato contactId={contactId} />
            </div>
          )}
          {/*
            O que os módulos de dados instalados guardam sobre esta pessoa. A lista vem do servidor e
            é vazia quando não há módulo com ficha de contato — então quem não instalou nada não vê
            nada a mais, que é o estado de primeira classe do não-negociável 1.
          */}
          {paineisDeModulo.map((painel) => (
            <div className="mt-4" key={`${painel.modulo}:${painel.objeto}`}>
              <FichasDoModulo
                modulo={painel.modulo}
                objeto={painel.objeto}
                contatoId={contactId}
              />
            </div>
          ))}
        </TabsContent>

        <TabsContent value="timeline" className="mt-4">
          <TimelineView contactId={contactId} />
        </TabsContent>

        {isAdmin && (
          <TabsContent value="lgpd" className="mt-4">
            <Card className="space-y-4 p-4">
              <div>
                <h2 className="text-lg font-semibold">{t("Direito ao esquecimento (LGPD)")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t(
                    "A anonimização é irreversível. Use somente após confirmação formal do titular ou ordem judicial.",
                  )}
                </p>
              </div>
              {contact.is_anonymized ? (
                <p className="text-sm text-muted-foreground">
                  {t("Este contato já foi anonimizado")}
                  {contact.anonymized_at &&
                    ` em ${format(new Date(contact.anonymized_at), "dd/MM/yyyy HH:mm", { locale: localeDaData })}`}
                  .
                </p>
              ) : (
                <Button variant="destructive" onClick={() => setAnonOpen(true)}>
                  {t("Anonimizar contato")}
                </Button>
              )}
            </Card>
          </TabsContent>
        )}
      </Tabs>

      <EditContactDialog
        contact={contact}
        open={editOpen}
        onOpenChange={setEditOpen}
        customFieldDefs={camposPorEscopo(
          camposDoFunil(pipelineQuery.data?.pipeline.settings ?? null),
          "contato",
        )}
        vocabulario={vocabularioDeEtiquetas.data}
        canonicalTags={canonicalTags}
      />
      <AnonymizeDialog contactId={contactId} open={anonOpen} onOpenChange={setAnonOpen} />
      {podeJuntar && (
        <JuntarComOutraFicha
          contatoAtual={contact}
          open={juntarOpen}
          onOpenChange={setJuntarOpen}
        />
      )}
    </div>
  );
}
