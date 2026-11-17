// lib/propostas/pdf-da-proposta.ts
//
// O PDF DA PROPOSTA — MONTADO NUM SÓ LUGAR, LIDO POR DUAS PORTAS.
//
// Duas telas pedem exatamente o mesmo arquivo: o envio (o que o cliente recebe
// no WhatsApp) e a prévia "Ver como o cliente recebe" do editor. Antes a
// montagem vivia inteira dentro de `app/api/v1/proposals/[id]/send/route.ts`, e
// a prévia não existia — abrir a segunda porta obrigaria a copiar o bloco, e
// uma diferença entre as duas cópias é defeito por construção: o gestor confere
// o arquivo A e o cliente recebe o arquivo B.
//
// Quem chama decide o `numero`/`ano` e o que fazer com o resultado. TODA
// consulta aqui filtra `organization_id`: o `admin` é o cliente de serviço,
// que NÃO passa pela RLS.
import type { SupabaseClient } from "@supabase/supabase-js";

import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import {
  montarDocumentoDaProposta,
  type PropostaParaDocumento,
} from "./documento/documento-da-proposta";
import { renderDocumentoPdf } from "./documento/pdf-do-documento";
import { marcaDaOrganizacaoParaPdf } from "./marca-da-organizacao-para-pdf";

/** A proposta como o PDF a lê — as colunas que `crm_proposals` precisa entregar. */
export interface PropostaParaPdf extends PropostaParaDocumento {
  id: string;
  contact_id: string | null;
  titulo: string;
  versao: number;
  condicoes: string | null;
}

export interface OpcoesDoPdfDaProposta {
  /** `null` em rascunho: é a prévia que mostra "sem número" no lugar dele. */
  numero: number | null;
  ano: number | null;
  t: (texto: string) => string;
  /** Prévia de tela — o número ainda não existe e o PDF diz isso no lugar dele. */
  previa?: boolean;
  /**
   * Quando true, a recusa por campo do documento sem preencher NÃO acontece:
   * o PDF é montado com o "[a definir]" que o renderizador já coloca no lugar
   * do campo faltando. A recusa por falta de modelo (documento null) continua
   * sempre — sem modelo não há seções para renderizar.
   */
  permitirPendencias?: boolean;
}

/** `ok: false` traz o motivo JÁ TRADUZIDO: quem chama só o escreve no 422. */
export type PdfDaProposta = { ok: true; buffer: Buffer } | { ok: false; motivo: string };

interface ItemDaPropostaParaPdf {
  descricao: string;
  quantidade: number;
  preco_unitario_cents: number | null;
  desconto_cents: number;
  product_id: string | null;
}

/**
 * Monta o PDF de uma proposta — o mesmo arquivo para o envio e para a prévia.
 *
 * A ordem das leituras é a que o envio já tinha, e a recusa por falta de
 * modelo não confirmado é a mesma (C1 da spec de 27/09). Já a recusa por campo
 * do documento sem preencher (§7 item 2 da spec de 26/09) só vale para o
 * envio: a prévia passa `permitirPendencias` e monta com "[a definir]" no
 * lugar do campo faltando. Recusa aqui é o que impede a prévia de virar uma
 * terceira versão do arquivo.
 */
export async function montarPdfDaProposta(
  admin: SupabaseClient,
  orgId: string,
  proposta: PropostaParaPdf,
  opcoes: OpcoesDoPdfDaProposta,
): Promise<PdfDaProposta> {
  const t = opcoes.t;

  const { data: itens } = await admin
    .from("crm_proposal_items")
    .select("*")
    .eq("organization_id", orgId)
    .eq("proposal_id", proposta.id)
    .order("position");
  const listaDeItens = (itens ?? []) as unknown as ItemDaPropostaParaPdf[];

  const { data: contatoParaDoc } = proposta.template_slug && proposta.contact_id
    ? await admin
        .from("contacts")
        .select("name, display_name")
        .eq("organization_id", orgId)
        .eq("id", proposta.contact_id)
        .maybeSingle()
    : { data: null };
  const documento = await montarDocumentoDaProposta(admin, orgId, proposta, contatoParaDoc ?? null);
  // Sem `template_slug` não há documento, e o que o cliente recebia nesse caso
  // era o PDF legado — sem as seções do modelo. É a diferença que o gestor não
  // consegue ver na tela, e a mesma recusa serve ao envio e à prévia (C1 da
  // spec de 27/09).
  if (!documento) {
    return { ok: false, motivo: t("Escolha e confirme o modelo da proposta antes de enviar.") };
  }
  if (!opcoes.permitirPendencias && documento.camposFaltando.length > 0) {
    return {
      ok: false,
      motivo: t("Faltam {n} campo(s) do documento antes de enviar: {lista}. Abra a proposta e preencha.")
        .replace("{n}", String(documento.camposFaltando.length))
        .replace("{lista}", documento.camposFaltando.map((c) => t(c.rotulo)).join(", ")),
    };
  }

  // A imagem do item de catálogo (primeira foto/capa) viaja para o PDF.
  // Só leitura, filtrada pela organização; item manual (sem product_id)
  // contribui com null e o layout fecha sem buraco.
  const idsDeProduto = listaDeItens.map((it) => it.product_id).filter((id): id is string => id !== null);
  const imagensPorProduto = new Map<string, string | null>();
  if (idsDeProduto.length > 0) {
    const { data: produtos } = await admin
      .from("catalog_products")
      .select("id, imagem_url")
      .eq("organization_id", orgId)
      .in("id", idsDeProduto);
    // Achado Importante da revisão C4: `imagem_url` é gravável por qualquer
    // manager+ da organização (rota de produto) e o schema só exige "é uma
    // URL", sem restringir protocolo/destino — `file://`, IP privado/
    // link-local e host inalcançável chegavam direto ao `<Image src>` do
    // react-pdf, que busca no SERVIDOR (leitura de arquivo local do
    // contêiner, SSRF para a rede interna, ou trava o envio até o timeout).
    // Mesmo guard textual que `call-webhook.ts` já usa para egress outbound;
    // falha = trata como "sem imagem" (null), nunca lança nem barra o envio.
    for (const p of (produtos ?? []) as Array<{ id: string; imagem_url: string | null }>) {
      if (p.imagem_url === null) {
        imagensPorProduto.set(p.id, null);
        continue;
      }
      try {
        assertSafeOutboundUrl(p.imagem_url);
        // O guard acima é TEXTUAL: ele lê o nome, não o IP. Um host público que resolve para
        // 10.x, para a rede do compose ou para o metadata da nuvem (169.254.169.254) passaria
        // por ele — e quem busca a imagem é o SERVIDOR, no react-pdf. `call-webhook.ts` já paga
        // essa resolução (`assertDestinoResolvidoSeguro`); aqui ela faltava, então a imagem de
        // catálogo era o caminho mais curto de "manager da organização" para a rede interna.
        await assertDestinoResolvidoSeguro(new URL(p.imagem_url).hostname);
        imagensPorProduto.set(p.id, p.imagem_url);
      } catch {
        // Inalcançável ou interno = item sem imagem. Nunca barra o envio da proposta.
        imagensPorProduto.set(p.id, null);
      }
    }
  }

  const { data: contato } = await admin
    .from("contacts")
    .select("name, display_name, email, phone_number")
    .eq("organization_id", orgId)
    .eq("id", proposta.contact_id)
    .maybeSingle();
  const marca = await marcaDaOrganizacaoParaPdf(admin, orgId);

  const itensDoPdf = listaDeItens.map((it) => ({
    descricao: it.descricao,
    quantidade: it.quantidade,
    // `?? 0` só fecha o tipo: no `@react-pdf` a conta é a mesma com `null`
    // (a trava de `pricing_status` já recusou o item sem preço antes daqui).
    precoUnitarioCents: it.preco_unitario_cents ?? 0,
    descontoCents: it.desconto_cents,
    imagemUrl: it.product_id ? (imagensPorProduto.get(it.product_id) ?? null) : null,
  }));

  const buffer = await renderDocumentoPdf({
    titulo: proposta.titulo,
    numero: opcoes.numero,
    ano: opcoes.ano,
    versao: proposta.versao,
    destinatario: { nome: rotuloDoContato(contato, t) },
    secoes: documento.secoes,
    itens: itensDoPdf,
    totalCents: proposta.total_cents,
    moeda: proposta.moeda,
    validUntil: proposta.valid_until,
    condicoes: proposta.condicoes,
    marca: { app_name: marca.appName, accent_hex: marca.accentHex, logoUrl: marca.logoUrl },
    ...(opcoes.previa ? { previa: true } : {}),
  });
  return { ok: true, buffer };
}
