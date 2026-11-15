"use client";
import { useCallback, useState, useLayoutEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AmigoConfig } from "./_config";
import { AmigoMutationBoundary } from "./_mutation-boundary";
import { AmigoAgenda } from "./_agenda";
import { AmigoPatients } from "./_patients";
import { AmigoCatalogs } from "./_catalogs";
import { ContactPicker, type ContactChoice } from "./_contacts";
import { amigoRequest, AmigoUiError, pinAmigoConnection } from "./_api";
import { useLoad } from "./_hooks";
import { Notice, Panel } from "./_ui";
import type { AmigoSafeConfig, Tab } from "./_types";

export function AmigoClient({
  initialConfig,
  canConfigure,
  canManage = true,
  initialTab = "config",
  initialContactId,
}: {
  initialConfig: AmigoSafeConfig;
  canConfigure: boolean;
  canManage?: boolean;
  initialTab?: Tab;
  initialContactId?: string;
}) {
  const [config, setConfig] = useState(initialConfig);
  useLayoutEffect(() => pinAmigoConnection(config.connection_id), [config.connection_id]);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [visited, setVisited] = useState<Tab[]>([initialTab]);
  const [contact, setContact] = useState<ContactChoice | null>(null);
  const selectContact = useCallback((value: ContactChoice | null) => setContact(value), []);
  const tabs: [Tab, string][] = [
    ["config", "Configuração"],
    ["agenda", "Agenda"],
    ["pacientes", "Pacientes"],
    ["catalogos", "Catálogos"],
  ];
  return (
    <div className="w-full min-w-0 space-y-6 p-4 sm:p-6">
      <AmigoMutationBoundary key={config.connection_id}>
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Amigo API</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Pacientes, recursos da clínica e consultas na mesma operação.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-md border px-3 py-1 text-sm">
              {config.active
                ? "Agenda principal: Amigo"
                : config.configured
                  ? "Conexão configurada"
                  : "Aguardando configuração"}
            </span>
            <Button asChild variant="outline">
              <Link href="/app/agenda">Abrir agenda</Link>
            </Button>
          </div>
        </header>
        {config.configured && (
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
            <span>
              Última sincronização:{" "}
              {config.last_sync_at
                ? new Date(config.last_sync_at).toLocaleString("pt-BR", {
                    timeZone: config.timezone,
                  })
                : "Ainda não realizada"}
            </span>
            {config.last_error && (
              <p role="alert">
                Não foi possível sincronizar. Um administrador pode testar a conexão na aba
                Configuração.
              </p>
            )}
          </div>
        )}
        <Tabs
          value={tab}
          onValueChange={(value) => {
            const next = value as Tab;
            setTab(next);
            setVisited((current) => (current.includes(next) ? current : [...current, next]));
          }}
        >
          <TabsList className="grid h-auto w-full grid-cols-2 sm:inline-flex sm:w-auto sm:flex-wrap">
            {tabs.map(([value, label]) => (
              <TabsTrigger
                key={value}
                id={`amigo-tab-${value}`}
                aria-controls={`amigo-panel-${value}`}
                value={value}
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {visited.some((value) => value !== "config") && config.configured && (
          <div hidden={tab === "config"}>
            <Panel
              title="Contexto do atendimento"
              description="Escolha o contato que receberá a comunicação. A seleção do paciente e o vínculo são explícitos."
            >
              <ContactPicker
                selected={contact}
                onSelect={selectContact}
                initialContactId={initialContactId}
              />
              {contact && (
                <Link className="text-sm underline" href={`/app/contacts/${contact.id}`}>
                  Voltar à ficha do contato
                </Link>
              )}
            </Panel>
          </div>
        )}
        {tabs
          .filter(([value]) => visited.includes(value))
          .map(([value]) => (
            <section
              key={`${value}:${config.connection_id ?? "none"}:${value === "config" ? "" : (contact?.id ?? "global")}`}
              role="tabpanel"
              id={`amigo-panel-${value}`}
              aria-labelledby={`amigo-tab-${value}`}
              hidden={tab !== value}
              className="min-w-0 space-y-6"
            >
              {value === "config" ? (
                <AmigoConfig config={config} canConfigure={canConfigure} onChange={setConfig} />
              ) : !config.configured ? (
                <Panel title="Conexão necessária">
                  <p className="text-sm">
                    Um administrador precisa salvar e testar o token na aba Configuração para
                    acessar estes recursos.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setVisited((current) =>
                        current.includes("config") ? current : [...current, "config"],
                      );
                      setTab("config");
                    }}
                  >
                    Abrir configuração
                  </Button>
                </Panel>
              ) : value === "agenda" ? (
                <>
                  <AmigoAgenda
                    initialConfig={config}
                    canManage={canManage}
                    contactId={contact?.id}
                    onSync={async () => setConfig(await amigoRequest<AmigoSafeConfig>(""))}
                  />
                  {canManage && <PendingOperations />}
                </>
              ) : value === "pacientes" ? (
                <AmigoPatients config={config} contact={contact} canManage={canManage} />
              ) : (
                <AmigoCatalogs />
              )}
            </section>
          ))}
      </AmigoMutationBoundary>
    </div>
  );
}
function PendingOperations() {
  const loader = useCallback(async () => {
    const result = await amigoRequest<{
      operations: { id: string; operation: string; state: string; created_at: string }[];
    }>("/links");
    if (!result || !Array.isArray(result.operations)) throw new AmigoUiError("invalid_response");
    return result;
  }, []);
  const operations = useLoad(loader);
  const names: Record<string, string> = {
    attendance_create: "Marcação",
    attendance_cancel: "Cancelamento",
    attendance_status: "Atualização de presença",
    attendance_reschedule: "Remarcação",
    patient_create: "Cadastro de paciente",
    patient_update: "Atualização de paciente",
  };
  return (
    <Panel
      title="Operações pendentes"
      description="Confira a agenda ou o cadastro diretamente no Amigo antes de tomar outra ação. Uma pendência não confirma o resultado."
    >
      <Button
        variant="outline"
        disabled={operations.loading}
        onClick={() => void operations.refresh()}
      >
        Atualizar pendências
      </Button>
      <Notice error={operations.error} loading={operations.loading} />
      {operations.data?.operations.length === 0 && (
        <p className="text-sm">Nenhuma operação pendente.</p>
      )}
      {operations.data?.operations.map((item) => (
        <div key={item.id} className="rounded-md border p-3 text-sm">
          <p className="font-medium">
            {names[item.operation] ?? "Operação Amigo"} · resultado a conferir
          </p>
          <p className="text-xs break-all text-muted-foreground">Protocolo: {item.id}</p>
          <p>
            Confira o resultado com a equipe da clínica. Não repita a solicitação enquanto houver
            dúvida.
          </p>
        </div>
      ))}
    </Panel>
  );
}
