/**
 * Export PDF renderer — relatório de proteção de dados (PT).
 *
 * Instalação para Angola: cita a Lei n.º 22/11, de 17 de Junho (Lei da
 * Proteção de Dados Pessoais), não a LGPD brasileira. Direito de acesso aos
 * dados do titular. Renderizado para Buffer via @react-pdf/renderer e
 * entregue ao titular via Resend.
 *
 * ⚠️ A citação aqui é do NOME e NÚMERO da lei, deliberadamente sem apontar um
 * artigo específico — ao contrário do "Art. 18 II" que este arquivo citava da
 * LGPD. Não há confirmação jurídica do artigo equivalente na lei angolana
 * nesta sessão; um advogado habilitado em Angola deve revisar antes de este
 * documento sair para um titular de verdade.
 *
 * ── ESTE DOCUMENTO NÃO LEVA MARCA. É decisão, não esquecimento ──────────────
 *
 * O rodapé imprime o CONTROLADOR (`organizations.legal_name`) e o Encarregado
 * resolvido. Não imprime a marca do revendedor, não imprime a nossa, não leva
 * logo e não leva cor.
 *
 * O motivo: o relatório responde a um DIREITO LEGAL do titular.
 * Nomear ali o revendedor — que é OPERADOR, não controlador — inverteria os
 * papéis num documento jurídico. Trocar `DeskcommCRM` por `Vendas Turbo CRM`
 * no rodapé não é "completar o white-label": é piorar o defeito, porque hoje o
 * nome é obviamente o do software, e depois passaria a parecer a declaração de
 * quem responde pelos dados.
 *
 * Consequência boa e deliberada: a armadilha do @react-pdf não nos alcança.
 * `var(--x)` e `oklch()` renderizam PDF VÁLIDO e descartam a cor em silêncio
 * (medido: 1514 bytes contra 1538 do hex), então qualquer prova do tipo "gerei
 * o PDF e ele abriu" passaria com a marca perdida. Como o documento não recebe
 * cor de marca nenhuma, o `styles` de módulo abaixo pode continuar de módulo:
 * zero risco assumido. Não parametrize, não mova para dentro do componente.
 *
 * A tela que resolve o outro lado disto é `/app/settings/tenant` (campo "Razão
 * social"): `legal_name` nasce IGUAL a `display_name` no bootstrap
 * (`scripts/bootstrap-owner.ts`, os dois recebem `ORG_NAME`), então o caso ruim
 * aqui não é o campo vazio — é o nome fantasia impresso como razão social. Uma
 * guarda "se vazio, use X" nunca dispararia; o que resolve é preencher a tela.
 */

import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import React from "react";

import { env } from "@/lib/env";
import { MOEDA_PADRAO } from "@/lib/money";
import { FUSO_PADRAO } from "@/lib/tempo/fusos";

import type { ExportPayload } from "./export-collector";

const styles = StyleSheet.create({
  page: {
    padding: 36,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: "#1f2937",
  },
  header: {
    borderBottom: "1pt solid #d1d5db",
    paddingBottom: 8,
    marginBottom: 16,
  },
  title: { fontSize: 16, fontWeight: "bold", marginBottom: 4 },
  subtitle: { fontSize: 10, color: "#6b7280" },
  section: { marginTop: 14 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "bold",
    backgroundColor: "#f3f4f6",
    padding: 4,
    marginBottom: 6,
  },
  row: { flexDirection: "row", marginBottom: 2 },
  label: { width: 110, color: "#6b7280" },
  value: { flex: 1 },
  small: { fontSize: 8, color: "#9ca3af" },
  itemBlock: {
    marginBottom: 4,
    paddingBottom: 4,
    borderBottom: "0.5pt dashed #e5e7eb",
  },
  warningBanner: {
    marginTop: 14,
    padding: 6,
    border: "1pt solid #f59e0b",
    backgroundColor: "#fffbeb",
    fontSize: 9,
    color: "#92400e",
  },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 36,
    right: 36,
    fontSize: 8,
    color: "#9ca3af",
    borderTop: "0.5pt solid #e5e7eb",
    paddingTop: 4,
  },
});

interface Props {
  data: ExportPayload;
  /** When true, appends an unsigned-PADES warning banner. */
  unsignedWarning?: boolean;
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  try {
    // ExportPayload não carrega o fuso da organização — usa o padrão da
    // instalação. Plumbing do fuso real da org, se precisar, é mudança maior
    // (tocaria export-collector.ts e a assinatura deste componente).
    return new Date(s).toLocaleString("pt-BR", { timeZone: FUSO_PADRAO });
  } catch {
    return s;
  }
}

function fmtMoney(cents: number | null | undefined, currency: string | null | undefined): string {
  if (cents == null) return "—";
  const v = cents / 100;
  return `${currency ?? MOEDA_PADRAO} ${v.toFixed(2)}`;
}

/**
 * A MESMA cadeia que `lib/lgpd/sla-alarm.ts:93` já usa
 * (`organizationDpoEmail || env.LGPD_DPO_EMAIL`). Reusar a ordem, e não
 * inventar outra, é o que impede o documento e o alarme de apontarem para
 * encarregados diferentes na mesma organização.
 *
 * O texto anterior era `DPO: contato via canal oficial do controlador` — um
 * não-resposta num campo cuja função é dizer a quem o titular reclama.
 */
function encarregado(data: ExportPayload): string {
  return data.dpo_email || env.LGPD_DPO_EMAIL || "não informado pelo controlador";
}

export function LgpdExportPdf({ data, unsignedWarning }: Props): React.ReactElement {
  const shortId = data.request_id.slice(0, 8);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Relatório de Proteção de Dados — Solicitação de Acesso aos Dados</Text>
          <Text style={styles.subtitle}>
            Base legal: Lei n.º 22/11, de 17 de Junho (Lei da Proteção de Dados Pessoais de Angola) ·
            Solicitação #{shortId}
          </Text>
        </View>

        {/* Metadata */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Metadados da Solicitação</Text>
          <View style={styles.row}>
            <Text style={styles.label}>ID:</Text>
            <Text style={styles.value}>{data.request_id}</Text>
          </View>
          {/* A razão social vem primeiro e o uuid vira "ID interno": o campo
              existe para o TITULAR saber de quem são os dados, e um uuid cru
              não responde isso a ninguém. O id continua no documento porque é
              o que o suporte pede quando alguém liga citando o relatório. */}
          <View style={styles.row}>
            <Text style={styles.label}>Organização:</Text>
            <Text style={styles.value}>{data.organization_legal_name || "—"}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>ID interno:</Text>
            <Text style={styles.value}>{data.organization_id}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Gerado em:</Text>
            <Text style={styles.value}>{fmtDate(data.generated_at)}</Text>
          </View>
          {data.no_local_footprint ? (
            <View style={styles.row}>
              <Text style={styles.label}>Status:</Text>
              <Text style={styles.value}>
                Nenhum dado pessoal localizado nos sistemas internos.
              </Text>
            </View>
          ) : null}
        </View>

        {/* Contact */}
        {data.contact ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Dados Pessoais (Contato)</Text>
            <View style={styles.row}>
              <Text style={styles.label}>Nome:</Text>
              <Text style={styles.value}>{data.contact.name ?? "—"}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Email:</Text>
              <Text style={styles.value}>{data.contact.email ?? "—"}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Telefone:</Text>
              <Text style={styles.value}>{data.contact.phone_number ?? "—"}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>NIF:</Text>
              <Text style={styles.value}>
                {data.contact.cpf_present ? "Armazenado (criptografado)" : "—"}
              </Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Origem:</Text>
              <Text style={styles.value}>{data.contact.source ?? "—"}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Criado em:</Text>
              <Text style={styles.value}>{fmtDate(data.contact.created_at)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Anonimizado:</Text>
              <Text style={styles.value}>{data.contact.is_anonymized ? "Sim" : "Não"}</Text>
            </View>
          </View>
        ) : null}

        {/* Consents */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Consentimentos</Text>
          {data.consents.length === 0 ? (
            <Text style={styles.small}>Nenhum consentimento registrado.</Text>
          ) : (
            data.consents.map((c, i) => (
              <View key={i} style={styles.row}>
                <Text style={styles.label}>{c.scope}:</Text>
                <Text style={styles.value}>
                  {c.granted ? "concedido" : "negado"}
                  {c.granted_at ? ` em ${fmtDate(c.granted_at)}` : ""}
                </Text>
              </View>
            ))
          )}
        </View>

        {/* Conversations */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Histórico de Atendimento</Text>
          <Text style={styles.small}>
            Total de conversas: {data.conversations.length} · Total de mensagens:{" "}
            {data.messages_count_total} · Amostra incluída neste relatório:{" "}
            {data.messages_recent.length}
          </Text>
          {data.conversations.slice(0, 10).map((c) => (
            <View key={c.id} style={styles.itemBlock}>
              <Text>
                Conversa #{c.id.slice(0, 8)} · {c.channel} · {c.status}
              </Text>
              <Text style={styles.small}>
                Última mensagem: {fmtDate(c.last_message_at)} · Criada em{" "}
                {fmtDate(c.created_at)}
              </Text>
            </View>
          ))}
        </View>

        {/* Recent messages preview */}
        {data.messages_recent.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Mensagens Recentes (amostra)</Text>
            {data.messages_recent.slice(0, 25).map((m) => (
              <View key={m.id} style={styles.itemBlock}>
                <Text style={styles.small}>
                  {fmtDate(m.created_at)} · {m.direction} · {m.type} · {m.status}
                </Text>
                <Text>{m.body ? m.body.slice(0, 280) : m.has_media ? "[mídia]" : "—"}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Leads */}
        {data.leads.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Atividade Comercial — Leads</Text>
            {data.leads.map((l) => (
              <View key={l.id} style={styles.itemBlock}>
                <Text>
                  {l.title ?? "(sem título)"} · {l.status} ·{" "}
                  {fmtMoney(l.value_cents, l.currency)}
                </Text>
                <Text style={styles.small}>Criado em {fmtDate(l.created_at)}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Orders */}
        {data.orders.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Pedidos</Text>
            {data.orders.map((o) => (
              <View key={o.id} style={styles.itemBlock}>
                <Text>
                  {o.external_provider ?? "—"} #{o.external_id ?? o.id.slice(0, 8)} ·{" "}
                  {o.status} · {fmtMoney(o.total_cents, o.currency)}
                </Text>
                <Text style={styles.small}>Pedido em {fmtDate(o.ordered_at)}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Agenda — vai no PDF, e não só no JSON, porque é a substância legível
            do Art. 18 II: "houve consulta no dia tal, sobre isto". `activities`
            fica só no JSON de propósito (type/source_module é telemetria); um
            compromisso, não. */}
        {data.appointments.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Agenda — Compromissos</Text>
            {data.appointments.map((c) => (
              <View key={c.id} style={styles.itemBlock}>
                <Text>
                  {c.title ?? "(sem título)"} · {c.status}
                  {c.location_details ? ` · ${c.location_details}` : ""}
                </Text>
                <Text style={styles.small}>
                  {fmtDate(c.starts_at)} até {fmtDate(c.ends_at)} ({c.time_zone})
                </Text>
                {c.description ? <Text style={styles.small}>{c.description}</Text> : null}
                {c.notes ? <Text style={styles.small}>Anotação: {c.notes}</Text> : null}
                {c.cancellation_reason ? (
                  <Text style={styles.small}>Cancelado: {c.cancellation_reason}</Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {/* Captação — de onde a pessoa veio. Entra no PDF porque `remote_ip`,
            `user_agent` e `utm` são dados que a organização guarda A RESPEITO
            dela e que ela raramente imagina que existem. */}
        {data.webhook_captures.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Como seus dados chegaram até nós</Text>
            {data.webhook_captures.map((c) => (
              <View key={c.id} style={styles.itemBlock}>
                <Text>
                  {c.source_name ?? "(origem não identificada)"} · {c.outcome}
                </Text>
                <Text style={styles.small}>
                  Recebido em {fmtDate(c.received_at)}
                  {c.remote_ip ? ` · IP ${c.remote_ip}` : ""}
                </Text>
                {c.user_agent ? (
                  <Text style={styles.small}>Navegador: {c.user_agent.slice(0, 160)}</Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {/* Audit */}
        {data.audit_log_extract.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Atividades de Auditoria</Text>
            {data.audit_log_extract.slice(0, 50).map((a) => (
              <View key={a.id} style={styles.row}>
                <Text style={styles.label}>{fmtDate(a.created_at)}</Text>
                <Text style={styles.value}>
                  {a.action}
                  {a.resource_type ? ` · ${a.resource_type}` : ""}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Unsigned warning */}
        {unsignedWarning ? (
          <View style={styles.warningBanner}>
            <Text>
              ASSINATURA DIGITAL PAdES PENDENTE — chave LGPD_SIGNING_KEY não
              configurada. A integridade do documento é garantida por hash SHA-256
              registrado em log auditável.
            </Text>
          </View>
        ) : null}

        {/* Footer */}
        {/* CONTROLADOR, nunca marca — ver o cabeçalho deste arquivo. */}
        <View style={styles.footer} fixed>
          <Text>
            Controlador: {data.organization_legal_name || "—"} · Relatório de Proteção de Dados
            (Lei n.º 22/11, de 17 de Junho) · Encarregado (DPO): {encarregado(data)} · Validade do
            link de download conforme e-mail recebido
          </Text>
        </View>
      </Page>
    </Document>
  );
}

export async function renderLgpdPdf(
  data: ExportPayload,
  options: { unsignedWarning?: boolean } = {},
): Promise<Buffer> {
  const element = <LgpdExportPdf data={data} unsignedWarning={options.unsignedWarning} />;
  const buf = await renderToBuffer(element);
  return buf as Buffer;
}
