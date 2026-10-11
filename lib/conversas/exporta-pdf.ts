// lib/conversas/exporta-pdf.ts
//
// O PDF DA CONVERSA — o histórico de UMA conversa virando documento legível,
// datado e em ordem, para o operador/arquivamento baixar (issue #1982, F1).
//
// ─── O QUE ESTE ARQUIVO REUSA DA CASA ───────────────────────────────────────
// O MESMO padrão de PDF de `lib/propostas/pdf-da-proposta.ts` e
// `lib/propostas/documento/pdf-do-documento.tsx` (os testes lá são a régua):
//
//   - a MESMA biblioteca: `@react-pdf/renderer` com `renderToBuffer` → Buffer;
//   - o MESMO contrato de `montarPdfDaProposta`: `{ ok, buffer }` ou
//     `{ ok: false, motivo }` com o motivo JÁ traduzido — quem chama só escreve
//     a recusa, nunca monta frase;
//   - a marca da ORGANIZAÇÃO via `marcaDaOrganizacaoParaPdf` (nunca a camada de
//     instalação/revendedor — a mesma régua do PDF de LGPD);
//   - o rótulo do contato via `rotuloDoContato`: "como a pessoa se chama" é
//     decisão de UM lugar, e a proposta já passa por ele.
//
// O renderizador da proposta em si NÃO é chamado, e a razão é o conteúdo: a
// forma dele é de proposta — número/versão, tabela de itens e a linha de
// "Total". Conversa não tem número nem total, e "Total: R$ 0,00" impresso num
// histórico que serve de prova é mentira no documento. Daí o layout próprio,
// com o mesmo vocabulário de estilo e o mesmo cabeçalho/rodapé.
//
// ─── POR QUE ISTO NÃO É O EXPORT LGPD ───────────────────────────────────────
// O export de LGPD (`lib/lgpd/export-collector.ts` + `lib/lgpd/pdf-renderer.tsx`)
// é devido ao TITULAR: segue o pedido dele, redige/anonimiza, engloba outras
// tabelas e sai por e-mail. Este é iniciativa do OPERADOR sobre a conversa da
// SUA organização, lido pelo client da SESSÃO: RLS +
// `fn_can_view_conversation` decidem quem enxerga a linha, e o
// `organization_id` filtrado aqui fecha o resto. Os dois convivem sem tocar um
// no outro — o export LGPD não muda uma linha por causa deste.
//
// LGPD: o corpo da mensagem NUNCA entra em log (só id de conversa e contagem),
// a mesma regra do coletor. E este documento NÃO inclui nota interna
// (`conversation_notes`): nota é conversa de equipe, escopo do titular, não do
// operador.
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";
import React from "react";

import { rotuloDoContato, type ContatoNomeavel } from "@/lib/contacts/rotulo-do-contato";
import { logger } from "@/lib/logger";
import { lerRemetenteDeGrupo, rotuloDoRemetente } from "@/lib/messaging/remetente-de-grupo";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";
import { marcaDaOrganizacaoParaPdf, type MarcaDaOrganizacaoParaPdf } from "@/lib/propostas/marca-da-organizacao-para-pdf";

/**
 * Quantas mensagens cabem NUM ARQUIVO. PostgREST devolve 1000 linhas quando o
 * `limit` não vem escrito — truncar em silêncio e chamar isso de histórico seria
 * o defeito que este documento existe para evitar. Batido o limite, o PDF AVISA
 * no cabeçalho (`truncada`): prova incompleta declarada ainda serve para
 * orientar; prova incompleta achada não.
 *
 * O número sai da MEMÓRIA, não do tamanho da conversa: o render roda no mesmo
 * processo que serve o CRM (`mem_limit: 768m` do `app` no
 * `docker-compose.prod.yml`, pico próprio medido de 335 MiB). Medido na
 * vps-teste em 11/10/2026 (Node 22, `montarPdfDaConversa` real, mensagens de
 * 8 a 37 palavras), acréscimo de RSS durante o render:
 *   250 → 21 MB · 500 → 131 MB · 750 → 184 MB · 1000 → 411 MB · 2000 → 859 MB · 5000 → 1,8 GB
 * O custo não é linear (de 750 para 1000 mais que dobra) e o tempo também não
 * (500 → 1,9 s; 5000 → 177 s). 500 fica em ~17% do teto do contêiner e deixa
 * folga para mensagens mais longas e para duas exportações simultâneas.
 */
export const LIMITE_DE_MENSAGENS = 500;

/** O fuso quando a organização não declarou o dele. */
const FUSO_PADRAO = "America/Sao_Paulo";

/** O que a rota lê de `messages` — colunas que a autoria e o tempo precisam. */
export const COLUNAS_DA_MENSAGEM =
  "id, direction, type, body, sent_via, sent_by_user_id, sent_on_behalf_of_user_id, media_derived_text, sent_at, created_at, edited_at, revoked_at, metadata";

/** A conversa como o PDF a lê. */
export interface ConversaParaPdf {
  id: string;
  channel: string | null;
  status: string | null;
  created_at: string | null;
  /** A ficha do contato — mesma forma que `rotuloDoContato` aceita. */
  contato: ContatoNomeavel | null;
}

/**
 * Uma linha de `messages` com o que o documento pergunta. Não é o `Message`
 * inteiro (mídia binária, ack, status de entrega não entram aqui) e não é o
 * `MessageRow` do coletor LGPD — aquele não traz `sent_via`/`sent_by_user_id`,
 * e sem os dois não há como dizer QUEM falou.
 */
export interface MensagemParaPdf {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  body: string | null;
  sent_via: string;
  sent_by_user_id: string | null;
  sent_on_behalf_of_user_id?: string | null;
  /** Transcrição da mídia (áudio/OCR) — quando não há corpo escrito. */
  media_derived_text?: string | null;
  sent_at: string | null;
  created_at: string;
  edited_at?: string | null;
  revoked_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface OpcoesDoPdfDaConversa {
  /** Tradução das frases fixas — mesmo contrato de `montarPdfDaProposta`. */
  t: (texto: string) => string;
  /** Quem baixou: entra no cabeçalho como origem do documento. */
  exportadoPor?: string | null;
  /** Nome de quem enviou, por user id — a rota resolve (uma leitura por id único). */
  nomesDosUsuarios?: Map<string, string | null>;
  /** Fuso do documento. Default: o da organização; depois América/São Paulo. */
  fuso?: string;
  /** Momento da geração — injetável para o teste ser determinístico. */
  geradoEm?: string;
  /** Conversa maior que o limite: o cabeçalho declara o corte. */
  truncada?: boolean;
  /**
   * Idioma de quem está BAIXANDO — a data do documento segue quem lê, pela
   * mesma camada de `lib/i18n/datas.ts` (nada escrito `"pt-BR"` aqui fora,
   * que é o que a cerca `i18n-a-data-segue-o-idioma` guarda). Default pt-BR.
   */
  idioma?: Idioma;
}

/** Uma mensagem já resolvida para a página: autor, horário e texto, na ordem. */
export interface LinhaDoHistorico {
  id: string;
  direcao: "inbound" | "outbound";
  autor: string;
  /** `dd/mm/aaaa hh:mm` no fuso do documento. */
  horario: string;
  texto: string;
}

/** `ok: false` traz o motivo JÁ TRADUZIDO — quem chama só o escreve no erro. */
export type PdfDaConversa =
  | { ok: true; buffer: Buffer; nomeDoArquivo: string }
  | { ok: false; motivo: string };

interface DataQuebrada {
  ano: string;
  mes: string;
  dia: string;
  hora: string;
  minuto: string;
}

function quebrarData(instante: number, fuso: string, idioma: Idioma): DataQuebrada {
  const partes = new Intl.DateTimeFormat(tagDeIdioma(idioma), {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instante));
  const campo = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? "";
  return {
    ano: campo("year"),
    mes: campo("month"),
    dia: campo("day"),
    hora: campo("hour"),
    minuto: campo("minute"),
  };
}

/**
 * `timezone` é coluna de tela: um valor torto não pode derrubar a exportação
 * inteira. Fuso inválido cai no padrão; data ilegível vira `null` (o "—" do
 * cabeçalho) em vez de estourar `RangeError` no meio do render.
 */
function quebrar(
  iso: string | null | undefined,
  fuso: string,
  idioma: Idioma,
): DataQuebrada | null {
  if (!iso) return null;
  const instante = Date.parse(iso);
  if (!Number.isFinite(instante)) return null;
  try {
    return quebrarData(instante, fuso, idioma);
  } catch {
    return quebrarData(instante, FUSO_PADRAO, idioma);
  }
}

function formatarDataHora(iso: string | null | undefined, fuso: string, idioma: Idioma): string {
  const d = quebrar(iso, fuso, idioma);
  return d ? `${d.dia}/${d.mes}/${d.ano} ${d.hora}:${d.minuto}` : "—";
}

/**
 * O nome do arquivo. ASCII puro: `Content-Disposition` com acento depende de
 * RFC 5987 e de como o navegador decide decodificar — e um download que chega
 * com o nome corrompido é o primeiro defeito que a pessoa vê.
 */
function nomeDeArquivo(
  conversa: ConversaParaPdf,
  geradoEm: string,
  fuso: string,
  idioma: Idioma,
): string {
  const rotulo = rotuloDoContato(conversa.contato, (texto) => texto);
  const slug = rotulo
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const d = quebrar(geradoEm, fuso, idioma);
  const dia = d ? `${d.ano}-${d.mes}-${d.dia}` : "sem-data";
  return `historico-conversa-${slug || conversa.id.slice(0, 8)}-${dia}.pdf`;
}

/**
 * QUEM FALOU — a mesma leitura de `components/inbox/MessageBubble.tsx`, porque
 * o documento diz para o leitor o que a tela diz para quem lê na hora.
 *
 * Nada aqui faz join por nome: o nome de quem enviou vem em
 * `nomesDosUsuarios` (a rota resolve, uma leitura por id único). Sem nome
 * resolvido o rótulo cai para "Atendente", que continua dizendo o que
 * `sent_via` garante — humano, pelo CRM — sem afirmar identidade que o dado não
 * sustenta.
 */
function autorDaMensagem(
  m: MensagemParaPdf,
  conversa: ConversaParaPdf,
  opcoes: { t: (texto: string) => string; nomesDosUsuarios?: Map<string, string | null> },
): string {
  const { t } = opcoes;
  if (m.direction !== "outbound") {
    // Grupo: a linha traz o participante gravado nela (é assim que a tela faz).
    const remetente = lerRemetenteDeGrupo(m.metadata);
    if (remetente) return rotuloDoRemetente(remetente);
    return rotuloDoContato(conversa.contato, t);
  }
  // #1613: a autoria "em nome de" sobe a mesa — quem apertou foi o token, quem
  // decidiu foi uma pessoa no outro sistema. Os nomes vêm GRAVADOS na linha.
  const emNomeDe = m.sent_on_behalf_of_user_id
    ? ((m.metadata?.sent_on_behalf ?? undefined) as
        | { user_name?: string | null; token_name?: string | null }
        | undefined)
    : undefined;
  if (emNomeDe) {
    const nome = emNomeDe.user_name?.trim() || t("Atendente");
    return emNomeDe.token_name ? `${nome} · ${t("via")} ${emNomeDe.token_name}` : nome;
  }
  if (m.sent_via === "ai") return t("IA");
  if (m.sent_via === "automation") return t("Automação");
  if (m.sent_via === "system") return t("Sistema");
  if (m.sent_via === "external_device") return t("Celular");
  return (m.sent_by_user_id ? opcoes.nomesDosUsuarios?.get(m.sent_by_user_id) : null) || t("Atendente");
}

/**
 * O QUE ESTA LINHA DIZ. Apagada pelo autor o texto NÃO entra (a linha fica,
 * como na tela: sumir com ela deixaria a resposta seguinte respondendo ao nada,
 * e mostrá-la seria expor o que a pessoa pediu para tirar do ar).
 */
function textoDaMensagem(m: MensagemParaPdf, t: (texto: string) => string): string {
  if (m.revoked_at) return t("Mensagem apagada pelo autor.");
  const corpo = (m.body ?? "").trim() || (m.media_derived_text ?? "").trim();
  if (corpo === "") return `[${m.type}]`;
  return m.edited_at ? `${corpo} ${t("(editada)")}` : corpo;
}

function instanteDe(m: MensagemParaPdf): number {
  const bruto = m.sent_at ?? m.created_at;
  const instante = Date.parse(bruto ?? "");
  return Number.isFinite(instante) ? instante : 0;
}

/**
 * O HISTÓRICO EM ORDEM CRONOLÓGICA — a garantia do documento, e ela mora
 * AQUI, não na ordem em que o banco devolveu: a rota lê das mais recentes para
 * as mais antigas (é assim que o `limit` corta a conversa certa), e esta função
 * ordena pelo instante da mensagem. Em empate, o id desempata: a página não
 * pode trocar de ordem entre uma chamada e outra.
 */
export function linhasDoHistorico(
  conversa: ConversaParaPdf,
  mensagens: MensagemParaPdf[],
  opcoes: {
    t: (texto: string) => string;
    nomesDosUsuarios?: Map<string, string | null>;
    fuso?: string;
    idioma?: Idioma;
  },
): LinhaDoHistorico[] {
  const { t } = opcoes;
  const fuso = opcoes.fuso ?? FUSO_PADRAO;
  const idioma = opcoes.idioma ?? IDIOMA_PADRAO;
  const ordenadas = [...mensagens].sort(
    (a, b) => instanteDe(a) - instanteDe(b) || a.id.localeCompare(b.id),
  );
  return ordenadas.map((m) => ({
    id: m.id,
    direcao: m.direction,
    autor: autorDaMensagem(m, conversa, opcoes),
    horario: formatarDataHora(m.sent_at ?? m.created_at, fuso, idioma),
    texto: textoDaMensagem(m, t),
  }));
}

interface OrganizacaoDoPdf {
  legal_name: string | null;
  display_name: string | null;
  timezone: string | null;
}

/** O CONTROLADOR do rodapé (razão social) e o fuso do documento. */
async function lerOrganizacao(db: SupabaseClient, orgId: string): Promise<OrganizacaoDoPdf> {
  const { data } = await db
    .from("organizations")
    .select("legal_name, display_name, timezone")
    .eq("id", orgId)
    .maybeSingle();
  return (
    (data as Partial<OrganizacaoDoPdf> | null) ?? {
      legal_name: null,
      display_name: null,
      timezone: null,
    }
  ) as OrganizacaoDoPdf;
}

const styles = StyleSheet.create({
  page: { padding: 32, paddingBottom: 48, fontSize: 10 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 },
  cabecalhoTexto: { flex: 1, paddingRight: 12 },
  titulo: { fontSize: 16, fontWeight: 700 },
  subtitulo: { fontSize: 10, color: "#4b5563", marginTop: 2 },
  logo: { width: 96, height: 40, objectFit: "contain" },
  meta: { fontSize: 9, color: "#4b5563", marginTop: 1 },
  aviso: {
    fontSize: 9,
    color: "#92400e",
    border: "1pt solid #f59e0b",
    backgroundColor: "#fffbeb",
    padding: 4,
    marginTop: 8,
    marginBottom: 4,
  },
  secao: { fontSize: 11, fontWeight: 700, marginTop: 12, marginBottom: 6 },
  linha: { marginBottom: 8, paddingBottom: 4, borderBottomWidth: 0.5, borderBottomColor: "#e5e7eb" },
  linhaCabecalho: { fontSize: 9, fontWeight: 700 },
  linhaCorpo: { fontSize: 10, lineHeight: 1.4, marginTop: 2 },
  vazio: { fontSize: 10, color: "#6b7280", fontStyle: "italic" },
  footer: { position: "absolute", bottom: 24, left: 32, right: 32, fontSize: 8, color: "#666666" },
});

interface DadosDoPdf {
  titulo: string;
  subtitulo: string;
  metadados: string[];
  aviso: string | null;
  tituloDasMensagens: string;
  vazio: string;
  linhas: LinhaDoHistorico[];
  rotuloDeDirecao: (direcao: "inbound" | "outbound") => string;
  /** "página {atual} de {total}", já traduzido — o render só troca os números. */
  rotuloDePagina: string;
  controlador: string | null;
  marca: MarcaDaOrganizacaoParaPdf;
}

/**
 * O documento. `React.createElement` e não JSX porque o módulo é `.ts` — o
 * render do react-pdf não exige sintaxe de template, só a árvore.
 */
function montarDocumento(d: DadosDoPdf): React.ReactElement<React.ComponentProps<typeof Document>> {
  const accent = d.marca.accentHex ?? undefined;
  return React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "A4", style: styles.page },
      React.createElement(
        View,
        { style: styles.header },
        React.createElement(
          View,
          { style: styles.cabecalhoTexto },
          React.createElement(Text, { style: [styles.titulo, accent ? { color: accent } : {}] }, d.titulo),
          React.createElement(Text, { style: styles.subtitulo }, d.subtitulo),
        ),
        d.marca.logoUrl
          ? React.createElement(Image, { src: d.marca.logoUrl, style: styles.logo })
          : React.createElement(Text, { style: styles.subtitulo }, d.marca.appName ?? ""),
      ),
      ...d.metadados.map((m) => React.createElement(Text, { key: m, style: styles.meta }, m)),
      d.aviso ? React.createElement(Text, { style: styles.aviso }, d.aviso) : null,
      React.createElement(Text, { style: styles.secao }, d.tituloDasMensagens),
      d.linhas.length === 0
        ? React.createElement(Text, { style: styles.vazio }, d.vazio)
        : d.linhas.map((l) =>
            React.createElement(
              View,
              { key: l.id, style: styles.linha, wrap: true },
              React.createElement(
                Text,
                { style: styles.linhaCabecalho },
                `${l.autor} · ${l.horario} · ${d.rotuloDeDirecao(l.direcao)}`,
              ),
              React.createElement(Text, { style: styles.linhaCorpo }, l.texto),
            ),
          ),
      React.createElement(Text, {
        style: styles.footer,
        fixed: true,
        render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
          `${d.controlador ?? d.titulo} — ${d.rotuloDePagina
            .replace("{atual}", String(pageNumber))
            .replace("{total}", String(totalPages))}`,
      }),
    ),
  );
}

/**
 * Monta o PDF da conversa — o MESMO contrato de `montarPdfDaProposta`.
 *
 * Recusa aqui é o que o render não consegue desenhar (logo inalcançável, heap
 * estourado numa conversa gigante): o motivo vem traduzido e a rota só o
 * escreve. Consulta de autoria NÃO acontece aqui — quem resolve nome é quem
 * chama, para este módulo continuar puro de rede além do que a própria marca
 * já faz.
 */
export async function montarPdfDaConversa(
  db: SupabaseClient,
  orgId: string,
  conversa: ConversaParaPdf,
  mensagens: MensagemParaPdf[],
  opcoes: OpcoesDoPdfDaConversa,
): Promise<PdfDaConversa> {
  const t = opcoes.t;
  const [marca, org] = await Promise.all([
    marcaDaOrganizacaoParaPdf(db, orgId),
    lerOrganizacao(db, orgId),
  ]);
  const fuso = opcoes.fuso ?? org.timezone ?? FUSO_PADRAO;
  const idioma = opcoes.idioma ?? IDIOMA_PADRAO;
  const linhas = linhasDoHistorico(conversa, mensagens, {
    t,
    nomesDosUsuarios: opcoes.nomesDosUsuarios,
    fuso,
    idioma,
  });
  const geradoEm = opcoes.geradoEm ?? new Date().toISOString();
  const controlador = org.legal_name?.trim() || org.display_name?.trim() || marca.appName || null;

  const dados: DadosDoPdf = {
    titulo: t("Histórico da conversa"),
    subtitulo: `${rotuloDoContato(conversa.contato, t)} · ${conversa.channel ?? "—"}`,
    metadados: [
      `${t("Conversa")}: ${conversa.id}`,
      `${t("Status")}: ${conversa.status ?? "—"}`,
      `${t("Aberta em")}: ${formatarDataHora(conversa.created_at, fuso, idioma)}`,
      `${t("Mensagens")}: ${linhas.length}`,
      ...(opcoes.exportadoPor
        ? [
            `${t("Exportado por")}: ${t("{quem} em {quando}")
              .replace("{quem}", opcoes.exportadoPor)
              .replace("{quando}", formatarDataHora(geradoEm, fuso, idioma))}`,
          ]
        : []),
    ],
    aviso: opcoes.truncada
      ? t(
          "Atenção: esta conversa ultrapassa o limite de mensagens por arquivo — só as mais recentes entram neste histórico.",
        )
      : null,
    tituloDasMensagens: t("Mensagens"),
    vazio: t("Nenhuma mensagem nesta conversa."),
    linhas,
    rotuloDeDirecao: (direcao) => (direcao === "inbound" ? t("recebida") : t("enviada")),
    rotuloDePagina: t("página {atual} de {total}"),
    controlador,
    marca,
  };

  let buffer: Buffer;
  try {
    buffer = (await renderToBuffer(montarDocumento(dados))) as Buffer;
  } catch (erro) {
    // Ids e a CAUSA, nunca o corpo da mensagem (LGPD: PII fora de log).
    logger.warn("[exporta-pdf] falha ao renderizar", {
      organizationId: orgId,
      conversationId: conversa.id,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return { ok: false, motivo: t("Não foi possível gerar o PDF desta conversa.") };
  }

  return { ok: true, buffer, nomeDoArquivo: nomeDeArquivo(conversa, geradoEm, fuso, idioma) };
}
