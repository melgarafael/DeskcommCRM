import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  COLUNAS_DA_NOTA,
  type CfopEquivalenteSalvo,
  type InutilizacaoSalva,
  type NotaFiscal,
} from "@/lib/schemas/fiscal";
import {
  COLUNAS_DA_ENTRADA,
  COLUNAS_DO_PAGAVEL,
  type EntradaFiscal,
  type Pagavel,
} from "@/lib/schemas/fiscal-entrada";
import { COLUNAS_DO_PEDIDO, type PedidoComercial } from "@/lib/schemas/pedidos";
import { createClient } from "@/lib/supabase/server";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NexusPageHeader } from "@/components/nexus-ui/layout/NexusPageHeader";

import { GradeNotas } from "./_components/GradeNotas";
import { EntradasFiscais } from "./_components/EntradasFiscais";
import { EmitirNota } from "./_components/EmitirNota";
import { AcoesFiscais } from "./_components/AcoesFiscais";
import { SpedFiscal } from "./_components/SpedFiscal";
import { ConfigFiscal } from "./_components/ConfigFiscal";

export const dynamic = "force-dynamic";

/**
 * AS NOTAS FISCAIS (ATT.txt Fase 3, Grupo 6) — uma área, cinco telas.
 *
 * Como os ERPs (Odivix, Bling, Tiny): a grade (Cadastro de NFes) é a home,
 * e cada fluxo tem a sua tela — emitir, ações fiscais (inutilização, IBPT),
 * SPED (CFOP, arquivo, fila) e configuração. `?aba=` endereça cada uma
 * (molde de `app/app/team/page.tsx`): link quebrado cai na grade, nunca numa
 * tela vazia. Sem entrada na sidebar de propósito: fiscal se alcança pelo
 * pedido ("Gerar NF-e") e pelo ⌘K.
 */
const ABAS = ["notas", "entradas", "emitir", "acoes", "sped", "config"] as const;

export default async function NotasPage({
  searchParams,
}: {
  searchParams: Promise<{ aba?: string }>;
}) {
  const { aba } = await searchParams;
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const podeEmitir = user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  const podeConfigurar = user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  const abasVisiveis = ABAS.filter((a) => {
    if (a === "emitir" || a === "acoes") return podeEmitir;
    if (a === "config") return podeConfigurar;
    if (a === "sped") return podeEmitir || podeConfigurar;
    return true;
  });
  const abaInicial = abasVisiveis.includes((aba ?? "") as (typeof ABAS)[number])
    ? (aba as string)
    : "notas";

  const supabase = await createClient();
  const [
    { data: notas },
    { data: entradas },
    { data: pagaveis },
    { data: faturados },
    { data: config },
    { data: inutilizacoes },
    { data: equivalentes },
  ] = await Promise.all([
    supabase
      .from("invoices")
      .select(COLUNAS_DA_NOTA)
      .eq("organization_id", activeOrg.orgId)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("fiscal_entradas")
      .select(COLUNAS_DA_ENTRADA)
      .eq("organization_id", activeOrg.orgId)
      .order("dh_emi", { ascending: false, nullsFirst: false })
      .limit(200),
    supabase
      .from("financial_pagaveis")
      .select(COLUNAS_DO_PAGAVEL)
      .eq("organization_id", activeOrg.orgId)
      .order("vencimento", { ascending: true })
      .limit(500),
    supabase
      .from("commercial_orders")
      .select(COLUNAS_DO_PEDIDO)
      .eq("organization_id", activeOrg.orgId)
      .eq("status", "faturado")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("fiscal_settings")
      .select(
        "serie, natureza_operacao, cfop_padrao, emitente_documento, ie, crt, logradouro, " +
          "numero_end, bairro, municipio, codigo_municipio, uf, cep, ambiente, provedor, certificado_path",
      )
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle(),
    supabase
      .from("fiscal_inutilizacoes")
      .select(
        "id, serie, numero_inicial, numero_final, motivo, ambiente, status, sefaz_protocolo, sefaz_xmotivo, created_at",
      )
      .eq("organization_id", activeOrg.orgId)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("fiscal_cfop_equivalentes")
      .select("id, cfop_origem, cfop_destino, created_at")
      .eq("organization_id", activeOrg.orgId)
      .order("cfop_origem")
      .limit(500),
  ]);

  // Pessoa da grade (Odivix): nome do cliente via pedido de origem. Pedidos
  // que saíram de "faturado" depois da emissão entram no mapa extra.
  const idsPedidos = [
    ...new Set(
      ((notas ?? []) as unknown as { order_id: string | null }[])
        .map((n) => n.order_id)
        .filter((v): v is string => !!v),
    ),
  ];
  const pessoas: Record<string, string> = {};
  for (const f of (faturados ?? []) as unknown as { id: string; cliente_nome: string }[]) {
    pessoas[f.id] = f.cliente_nome;
  }
  const faltantes = idsPedidos.filter((id) => !pessoas[id]);
  if (faltantes.length > 0) {
    const { data: extras } = await supabase
      .from("commercial_orders")
      .select("id, cliente_nome")
      .eq("organization_id", activeOrg.orgId)
      .in("id", faltantes);
    for (const e of (extras ?? []) as unknown as { id: string; cliente_nome: string }[]) {
      pessoas[e.id] = e.cliente_nome;
    }
  }

  const textos = {
    titulo: t("Notas fiscais"),
    subtitulo: t("Emita a partir do pedido faturado e acompanhe o status."),
    abas: t("Abas das notas fiscais"),
    emitir: t("Emitir nota"),
    subtituloEmitir: t("Gerar a NF-e a partir do pedido já faturado."),
    escolherPedido: t("Pedido faturado"),
    selecione: t("Selecione…"),
    notas: t("Notas"),
    vazias: t("Nenhuma nota ainda"),
    semFaturados: t("Nenhum pedido faturado aguardando nota."),
    semConfig: t("Configure os dados fiscais abaixo antes de emitir."),
    config: t("Configuração fiscal"),
    serie: t("Série"),
    natureza: t("Natureza da operação"),
    cfop: t("CFOP padrão"),
    documento: t("CNPJ do emitente"),
    salvarConfig: t("Salvar configuração"),
    cancelar: t("Cancelar nota"),
    motivo: t("Motivo (obrigatório para autorizada)"),
    reemitir: t("Tentar de novo"),
    timeline: t("Histórico fiscal"),
    baixarXml: t("Baixar XML"),
    verDanfe: t("Ver DANFE"),
    verPedido: t("Ver pedido"),
    enfileirada: t("Nota enfileirada para emissão"),
    detalhe: t("Detalhe"),
    pendencias: t("pendência(s) encontrada(s) — corrija antes de emitir"),
    fila: t("Fila"),
    tentativa: t("tentativa"),
    semNumero: t("Sem número"),
    logradouro: t("Logradouro"),
    numeroEnd: t("Número"),
    bairro: t("Bairro"),
    municipio: t("Município"),
    codMun: t("IBGE do município"),
    ambiente: t("Ambiente"),
    homologacao: t("Homologação (testes)"),
    producao: t("Produção (vale de verdade)"),
    provedorFiscal: t("Emissor"),
    provedorStub: t("Rascunho (sem emissor)"),
    provedorSped: t("sped-nfe (sidecar)"),
    certPath: t("Certificado (.pfx no sidecar)"),
    certSenha: t("Senha do certificado"),
    certSenhaVazia: t("Vazio = mantém a atual"),
    total: t("Total"),
    valor: t("Valor"),
    autorizadas: t("Autorizadas"),
    pendentes: t("Pendentes"),
    comErro: t("Com erro"),
    pendente: t("Pendente"),
    emitindo: t("Emitindo"),
    autorizada: t("Autorizada"),
    denegada: t("Denegada"),
    cancelada: t("Cancelada"),
    erro: t("Erro"),
    todos: t("Todos"),
    data: t("Data"),
    colunaDoc: t("Documento"),
    chaveAcesso: t("Chave de acesso"),
    status: t("Status"),
    acoes: t("Ações"),
    protocolo: t("Protocolo"),
    provedor: t("Provedor"),
    retornoSefaz: t("Retorno da SEFAZ"),
    buscarNota: t("Buscar nota…"),
    nenhumaNotaEncontrada: t("Nenhuma nota encontrada"),
    limparFiltros: t("Limpar filtros"),
    emitente: t("Emitente"),
    enderecoEmitente: t("Endereço do emitente"),
    emissaoSefaz: t("Emissão e SEFAZ"),
    certificado: t("Certificado"),
    avisoHomologacao: t("As notas deste ambiente são de teste e não têm validade fiscal."),
    operacao: t("Operação"),
    pessoa: t("Pessoa"),
    numNota: t("Nº Nota"),
    valorTotal: t("Valor total"),
    esteAno: t("Este ano"),
    esteMes: t("Este mês"),
    ultimos30: t("Últimos 30 dias"),
    tudo: t("Todo o período"),
    filtrandoPor: t("Filtrando por"),
    exportarCsv: t("Exportar CSV"),
    exportaXmls: t("Exporta XMLs"),
    cartaCorrecao: t("Carta de Correção"),
    correcao: t("Correção"),
    dicaCorrecao: t("Entre 15 e 1000 caracteres"),
    registrarCarta: t("Registrar carta"),
    registradaLocal: t("Registrada localmente"),
    inutilizarNum: t("Inutilizar numeração"),
    inutilizarFaixa: t("Inutilizar faixa"),
    notasInutilizadas: t("Notas inutilizadas"),
    nenhumaInutilizacao: t("Nenhuma inutilização ainda"),
    faixa: t("Faixa"),
    numInicial: t("Número inicial"),
    numFinal: t("Número final"),
    motivoSimples: t("Motivo"),
    dicaMotivo: t("Entre 15 e 255 caracteres"),
    ibpt: t("IBPT (imposto aproximado)"),
    semIbpt: t(
      "A tabela IBPT ainda não foi importada — o imposto aproximado aparece aqui quando houver.",
    ),
    sped: t("SPED Fiscal"),
    cfopsEq: t("CFOPs equivalentes"),
    nenhumaEquiv: t("Nenhuma equivalência ainda"),
    novaEquiv: t("Nova equivalência"),
    origem: t("Origem"),
    destino: t("Destino"),
    apagar: t("Apagar"),
    editar: t("Editar"),
    salvar: t("Salvar"),
    cancelarBtn: t("Cancelar"),
    ano: t("Ano"),
    mes: t("Mês"),
    gerarArquivo: t("Gerar arquivo"),
    rascunhoPva: t("Rascunho para conferência no PVA"),
    baixarArquivo: t("Baixar arquivo"),
    oQueFalta: t("O que falta"),
    itensLabel: t("Itens"),
    linhasLabel: t("Linhas"),
    manutencao: t("Manutenção da fila"),
    filaVazia: t("Fila vazia"),
    proxTentativa: t("Próxima tentativa"),
    entradas: t("Entradas"),
    buscarSefaz: t("Buscar na SEFAZ"),
    nenhumaEntrada: t("Nenhuma entrada ainda"),
    manifestar: t("Manifestar"),
    manifestadaOk: t("Manifestação registrada"),
    importarEntrada: t("Importar (estoque + pagar)"),
    importadaOk: t("Entrada importada"),
    ignorarEntrada: t("Ignorar"),
    ignoradaOk: t("Entrada ignorada"),
    fornecedor: t("Fornecedor"),
    duplicatas: t("Duplicatas da nota"),
    contasPagar: t("Contas a pagar geradas"),
    aguardarSefaz: t(
      "SEFAZ pediu pausa de 1h (nada novo ou consumo alto). Tente de novo mais tarde.",
    ),
    semXmlEntrada: t("Sem XML ainda — manifeste a nota e busque de novo para liberar os itens."),
    acoesFiscais: t("Ações fiscais"),
    transmitida: t("Transmitida"),
    registrada: t("Registrada"),
    processando: t("Processando"),
    concluido: t("Concluído"),
    cliente: t("Cliente"),
  };

  const rotuloAba: Record<string, string> = {
    notas: textos.notas,
    entradas: textos.entradas,
    emitir: textos.emitir,
    acoes: textos.acoesFiscais,
    sped: textos.sped,
    config: textos.config,
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <NexusPageHeader title={textos.titulo} subtitle={textos.subtitulo} />

      <Tabs defaultValue={abaInicial} className="flex flex-1 flex-col">
        <TabsList aria-label={textos.abas}>
          {abasVisiveis.map((a) => (
            <TabsTrigger key={a} value={a}>
              {rotuloAba[a]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="notas" className="mt-4">
          <GradeNotas
            inicial={(notas ?? []) as unknown as NotaFiscal[]}
            pessoas={pessoas}
            operacaoPadrao={
              (config as unknown as { natureza_operacao?: string } | null)?.natureza_operacao ?? ""
            }
            ambientePadrao={
              (config as unknown as { ambiente?: string } | null)?.ambiente ?? "homologacao"
            }
            podeEmitir={podeEmitir}
            textos={textos}
          />
        </TabsContent>

        <TabsContent value="entradas" className="mt-4">
          <EntradasFiscais
            inicial={(entradas ?? []) as unknown as EntradaFiscal[]}
            pagaveisIniciais={(pagaveis ?? []) as unknown as Pagavel[]}
            podeSincronizar={podeEmitir}
            podeImportar={podeConfigurar}
            textos={textos}
          />
        </TabsContent>

        {podeEmitir && (
          <TabsContent value="emitir" className="mt-4">
            <EmitirNota
              faturados={(faturados ?? []) as unknown as PedidoComercial[]}
              configInicial={config as unknown as Parameters<typeof EmitirNota>[0]["configInicial"]}
              textos={textos}
            />
          </TabsContent>
        )}

        {podeEmitir && (
          <TabsContent value="acoes" className="mt-4">
            <AcoesFiscais
              configInicial={
                config as unknown as Parameters<typeof AcoesFiscais>[0]["configInicial"]
              }
              inutilizacoesIniciais={(inutilizacoes ?? []) as unknown as InutilizacaoSalva[]}
              textos={textos}
            />
          </TabsContent>
        )}

        {(podeEmitir || podeConfigurar) && (
          <TabsContent value="sped" className="mt-4">
            <SpedFiscal
              equivalentesIniciais={(equivalentes ?? []) as unknown as CfopEquivalenteSalvo[]}
              podeConfigurar={podeConfigurar}
              textos={textos}
            />
          </TabsContent>
        )}

        {podeConfigurar && (
          <TabsContent value="config" className="mt-4">
            <ConfigFiscal
              configInicial={
                config as unknown as Parameters<typeof ConfigFiscal>[0]["configInicial"]
              }
              textos={textos}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
