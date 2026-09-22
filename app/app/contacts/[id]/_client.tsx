"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";
import { useState } from "react";
import { format } from "date-fns";
import { ShieldCheck } from "@/lib/ui/icons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useContact } from "@/hooks/contacts/useContact";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { TimelineView } from "@/components/contacts/TimelineView";
import { ComprasDoContato } from "./_compras";
import { FinanceiroDoContato, ContasDoCliente } from "./_financeiro";
import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import { AnonymizeDialog } from "@/components/contacts/AnonymizeDialog";
import { PropostasDeDado } from "@/components/contacts/PropostasDeDado";
import { ConversaNoDossie } from "@/components/kanban/ConversaNoDossie";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { enderecoEmLinha } from "@/components/contacts/EnderecoFields";
import { formatarCnpj } from "@/lib/brasil/cnpj";
import { Cabecalho360 } from "./_cabecalho360";
import { ProdutosDoContato } from "./_produtos";
import { OportunidadesDoContato } from "./_oportunidades";
import { WhatsappDoContato } from "./_whatsapp360";
import { InteligenciaDoContato } from "./_inteligencia360";
import { ProximasAcoes } from "./_acoes";

interface Props {
  contactId: string;
}

export function ContactDetailClient({ contactId }: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const q = useContact(contactId);
  const { user, activeOrg } = useAuth();
  const [editOpen, setEditOpen] = useState(false);
  const [anonOpen, setAnonOpen] = useState(false);

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
        <Card className="p-6 text-center text-sm text-error-fg">Erro ao carregar contato.</Card>
      </div>
    );
  }

  const contact = q.data.data;
  const isAdmin =
    user.is_platform_admin || (activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin);

  return (
    <div className="space-y-4 p-6">
      {contact.is_anonymized && (
        <div
          role="alert"
          className="sticky top-0 z-20 flex items-center gap-3 rounded-lg border border-error-fg/30 bg-error-bg p-3 text-sm text-error-fg"
        >
          <ShieldCheck size={18} weight="duotone" aria-hidden />
          <span>
            Cliente anonimizado (LGPD)
            {contact.anonymized_at &&
              ` em ${format(new Date(contact.anonymized_at), "dd/MM/yyyy", { locale: localeDaData })}`}
            {t(" — edição bloqueada.")}
          </span>
        </div>
      )}

      <Cabecalho360 contact={contact} contactId={contactId} onEdit={() => setEditOpen(true)} />

      <ConversaNoDossie conversa={contact.conversa} />

      {/* ANTES das abas, e não dentro de uma delas: é o único conteúdo desta
          tela que PEDE uma ação. Enterrado numa aba, viraria pendência que só
          quem já sabe que existe encontra — e a fila deixaria de ser fila.
          Some sozinho quando não há nada aguardando. */}
      {!contact.is_anonymized && (
        <PropostasDeDado
          contactId={contactId}
          podeDecidir={Boolean(activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent)}
          aoDecidir={() => void q.refetch()}
        />
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[1fr_280px]">
        <Tabs defaultValue="overview" className="min-w-0">
          <div className="overflow-x-auto">
            <TabsList>
              <TabsTrigger value="overview">{t("Visão geral")}</TabsTrigger>
              <TabsTrigger value="compras" data-tab="compras">
                {t("Pedidos")}
              </TabsTrigger>
              <TabsTrigger value="produtos" data-tab="produtos">
                {t("Produtos")}
              </TabsTrigger>
              <TabsTrigger value="financeiro">{t("Financeiro")}</TabsTrigger>
              <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
              <TabsTrigger value="timeline">{t("Histórico")}</TabsTrigger>
              <TabsTrigger value="oportunidades" data-tab="oportunidades">
                {t("Oportunidades")}
              </TabsTrigger>
              <TabsTrigger value="inteligencia">{t("Inteligência")}</TabsTrigger>
              {isAdmin && <TabsTrigger value="lgpd">LGPD</TabsTrigger>}
            </TabsList>
          </div>

          <TabsContent value="overview" className="mt-4">
            <Card className="p-4">
              <dl className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground uppercase">Nome</dt>
                  <dd className="mt-1">{contact.name ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground uppercase">Display name</dt>
                  <dd className="mt-1">{contact.display_name ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground uppercase">Email</dt>
                  <dd className="mt-1">{contact.email ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground uppercase">{t("Telefone")}</dt>
                  <dd className="mt-1">
                    {contact.phone_number ? phoneForDisplay(contact.phone_number) : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground uppercase">{t("Documento")}</dt>
                  <dd className="mt-1">
                    {contact.cnpj
                      ? `CNPJ ${formatarCnpj(contact.cnpj)}`
                      : contact.cpf_hash
                        ? "CPF ●●● (LGPD)"
                        : "—"}
                  </dd>
                </div>
                {contact.fantasia && (
                  <div>
                    <dt className="text-xs text-muted-foreground uppercase">
                      {t("Nome fantasia")}
                    </dt>
                    <dd className="mt-1">{contact.fantasia}</dd>
                  </div>
                )}
                {contact.ie && (
                  <div>
                    <dt className="text-xs text-muted-foreground uppercase">
                      {t("Inscrição estadual")}
                    </dt>
                    <dd className="mt-1">{contact.ie}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs text-muted-foreground uppercase">Origem</dt>
                  <dd className="mt-1">{contact.source}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground uppercase">
                    {t("Última atividade")}
                  </dt>
                  <dd className="mt-1">
                    {contact.last_activity_at
                      ? format(new Date(contact.last_activity_at), "dd/MM/yyyy HH:mm", {
                          locale: localeDaData,
                        })
                      : "—"}
                  </dd>
                </div>
                <div className="md:col-span-2">
                  <dt className="text-xs text-muted-foreground uppercase">{t("Endereço")}</dt>
                  <dd className="mt-1">{enderecoEmLinha(contact) ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground uppercase">Criado em</dt>
                  <dd className="mt-1">
                    {format(new Date(contact.created_at), "dd/MM/yyyy", { locale: localeDaData })}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground uppercase">Tags</dt>
                  <dd className="mt-1 flex flex-wrap gap-1">
                    {contact.tags.length === 0
                      ? "—"
                      : contact.tags.map((t) => (
                          <Badge key={t} variant="neutral">
                            {t}
                          </Badge>
                        ))}
                  </dd>
                </div>
              </dl>
            </Card>
          </TabsContent>

          <TabsContent value="whatsapp" className="mt-4">
            <WhatsappDoContato conversa={contact.conversa} />
          </TabsContent>

          <TabsContent value="timeline" className="mt-4">
            <TimelineView contactId={contactId} />
          </TabsContent>

          <TabsContent value="oportunidades" className="mt-4">
            <OportunidadesDoContato contactId={contactId} />
          </TabsContent>

          <TabsContent value="inteligencia" className="mt-4">
            <InteligenciaDoContato contactId={contactId} />
          </TabsContent>

          <TabsContent value="compras" className="mt-4">
            <ComprasDoContato contactId={contactId} />
          </TabsContent>

          <TabsContent value="produtos" className="mt-4">
            <ProdutosDoContato contactId={contactId} />
          </TabsContent>

          <TabsContent value="financeiro" className="mt-4 space-y-3">
            <ContasDoCliente contactId={contactId} />
            <FinanceiroDoContato
              contato={contact}
              podeEditar={Boolean(
                user.is_platform_admin ||
                (activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager),
              )}
              aoSalvar={() => void q.refetch()}
            />
          </TabsContent>

          {isAdmin && (
            <TabsContent value="lgpd" className="mt-4">
              <Card className="space-y-4 p-4">
                <div>
                  <h2 className="text-lg font-medium text-text">Direito ao esquecimento (LGPD)</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t(
                      "A anonimização é irreversível. Use somente após confirmação formal do titular ou ordem judicial.",
                    )}
                  </p>
                </div>
                {contact.is_anonymized ? (
                  <p className="text-sm text-muted-foreground">
                    {t("Este cliente já foi anonimizado")}
                    {contact.anonymized_at &&
                      ` em ${format(new Date(contact.anonymized_at), "dd/MM/yyyy HH:mm", { locale: localeDaData })}`}
                    .
                  </p>
                ) : (
                  <Button variant="destructive" onClick={() => setAnonOpen(true)}>
                    Anonimizar cliente
                  </Button>
                )}
              </Card>
            </TabsContent>
          )}
        </Tabs>

        <ProximasAcoes
          contactId={contactId}
          nome={contact.display_name ?? contact.name ?? "cliente"}
          conversaId={contact.conversa?.id ?? null}
          anonimo={contact.is_anonymized}
        />
      </div>

      <EditContactDialog contact={contact} open={editOpen} onOpenChange={setEditOpen} />
      <AnonymizeDialog contactId={contactId} open={anonOpen} onOpenChange={setAnonOpen} />
    </div>
  );
}
