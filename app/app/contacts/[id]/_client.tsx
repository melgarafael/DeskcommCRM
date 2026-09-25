"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";
import { useState } from "react";
import { format } from "date-fns";
import { ShieldCheck, PencilSimple, LockOpen } from "@/lib/ui/icons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
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
import { useHierarquiaDoAnuncio } from "@/hooks/contacts/useHierarquiaDoAnuncio";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useDefaultPipeline } from "@/hooks/pipelines/useDefaultPipeline";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { ROLE_RANK } from "@/lib/auth/types";
import { TimelineView } from "@/components/contacts/TimelineView";
import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import { AnonymizeDialog } from "@/components/contacts/AnonymizeDialog";
import { PropostasDeDado } from "@/components/contacts/PropostasDeDado";
import { RoteirosDoContato } from "@/components/contacts/RoteirosDoContato";
import { ConversaNoDossie } from "@/components/kanban/ConversaNoDossie";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { origemDoContato } from "@/lib/leads/origem-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { DialButton } from "@/components/voice/DialButton";

interface Props {
  contactId: string;
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

export function ContactDetailClient({ contactId }: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const q = useContact(contactId);
  const { user, activeOrg } = useAuth();
  const clientesLigado = activeOrg?.cliente_pela_agenda === true;
  // As DEFINIÇÕES continuam no funil (`crm_pipelines.settings.fields[]`) — só o
  // VALOR mora no contato. `camposDoFunil` é o mesmo leitor que o Kanban usa.
  const pipelineQuery = useDefaultPipeline(Boolean(activeOrg));
  const [editOpen, setEditOpen] = useState(false);
  const [anonOpen, setAnonOpen] = useState(false);
  // Desfazer o descadastro é o override da regra W-02 — só admin, e auditado.
  // O hook fica ANTES dos early returns: chamá-lo depois mudaria a ordem dos
  // hooks entre renderizações e o React reprova.
  const desbloquear = useUnblockContact(contactId);

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
  const isAdmin =
    (user.is_platform_admin && !user.support) || (activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin);

  // Uma decisão, um lugar (lib/contacts/rotulo-do-contato.ts). Esta tela era
  // uma das DUAS que ignoravam o telefone: contato com número e sem nome
  // aparecia como "Sem nome" aqui e com o número no inbox.
  const displayName = rotuloDoContato(contact, t);

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
            <DialButton contactId={contactId} hasPhone={!!contact.phone_number} />
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
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Email</dt>
                <dd className="mt-1">{contact.email ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t("Telefone")}</dt>
                <dd className="mt-1">
                  {contact.phone_number ? phoneForDisplay(contact.phone_number) : "—"}
                </dd>
              </div>
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
              {/*
                A origem sai do `source_metadata` quando ele tem algo melhor a
                dizer, e cai na coluna `source` quando não tem. Antes esta linha
                lia só a coluna, e a resposta era `site` para quem chegou pelo
                link do site, ou o nome da plataforma para quem clicou num
                anúncio — mesmo com o `utm_source` da campanha gravado ao lado.
              */}
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t("Origem")}</dt>
                <dd className="mt-1">{origem.origem}</dd>
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
          <div className="mt-4">
            <RoteirosDoContato contactId={contactId} />
          </div>
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
        customFieldDefs={camposDoFunil(pipelineQuery.data?.pipeline.settings ?? null)}
      />
      <AnonymizeDialog contactId={contactId} open={anonOpen} onOpenChange={setAnonOpen} />
    </div>
  );
}
