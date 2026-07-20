"use client";
/**
 * Tabs do detalhe de agent. Wave 12 (S-13.12) entrega Test, Runs e History.
 */
import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentForm, type ChannelSessionLite } from "./AgentForm";
import { TestPanel } from "./TestPanel";
import { RunsTable } from "./RunsTable";
import { VersionHistory } from "./VersionHistory";
import { ProposalsPanel } from "./ProposalsPanel";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";
import type { CredentialRow } from "@/hooks/ai/useCredentials";

interface Props {
  agent: AgentRow;
  draft: AgentVersionRow | null;
  published: AgentVersionRow | null;
  versions: AgentVersionRow[];
  credentials: CredentialRow[];
  channelSessions: ChannelSessionLite[];
  readOnly?: boolean;
}

export function AgentTabs(props: Props) {
  const [tab, setTab] = React.useState<
    "configuration" | "test" | "runs" | "history" | "proposals"
  >("configuration");
  const hasVersion = !!(props.draft || props.published);

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as typeof tab)}
      className="flex flex-col gap-4"
    >
      <TabsList>
        <TabsTrigger value="configuration">Configuração</TabsTrigger>
        <TabsTrigger value="test" disabled={!hasVersion}>
          Teste
        </TabsTrigger>
        <TabsTrigger value="runs">Execuções</TabsTrigger>
        <TabsTrigger value="history">Histórico</TabsTrigger>
        <TabsTrigger value="proposals">Propostas</TabsTrigger>
      </TabsList>

      <TabsContent value="configuration" className="m-0">
        <AgentForm
          mode="edit"
          agent={props.agent}
          draft={props.draft}
          published={props.published}
          credentials={props.credentials}
          channelSessions={props.channelSessions}
          readOnly={props.readOnly}
        />
      </TabsContent>

      <TabsContent value="test" className="m-0">
        <TestPanel
          agent={props.agent}
          draft={props.draft}
          published={props.published}
          readOnly={props.readOnly}
        />
      </TabsContent>

      <TabsContent value="runs" className="m-0">
        <RunsTable agentId={props.agent.id} active={tab === "runs"} />
      </TabsContent>

      <TabsContent value="proposals" className="m-0">
        <ProposalsPanel
          agentId={props.agent.id}
          active={tab === "proposals"}
          readOnly={props.readOnly}
        />
      </TabsContent>

      <TabsContent value="history" className="m-0">
        <VersionHistory
          agentId={props.agent.id}
          versions={props.versions}
          readOnly={props.readOnly}
        />
      </TabsContent>
    </Tabs>
  );
}
