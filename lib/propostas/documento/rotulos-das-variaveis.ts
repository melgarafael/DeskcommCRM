/**
 * O nome de cada `{{variável}}` para uma pessoa ler, e onde ela se preenche.
 *
 * A tela e a trava de envio falavam em `project.objective`; quem revisa uma
 * proposta não sabe o que é isso. O teste ao lado VARRE os modelos da
 * plataforma e reprova variável nova sem nome — a lista não envelhece calada.
 */
export const ROTULO_DA_VARIAVEL: Readonly<Record<string, string>> = Object.freeze({
  "approval.date": "Data da aprovação",
  "client.company": "Empresa do cliente",
  "client.company_or_name": "Empresa ou nome do cliente",
  "client.name": "Nome do cliente",
  "commercial_terms.validity_days": "Validade da proposta (dias)",
  "excluded.list": "O que não está incluído",
  "included.list": "O que está incluído",
  "investment.total_formatted": "Investimento total",
  "lead.etapa": "Etapa do negócio",
  "lead.responsavel_nome": "Responsável pelo negócio",
  "lead.responsavel_telefone": "WhatsApp do responsável",
  "lead.titulo": "Título do negócio",
  "project.business_context": "Contexto do negócio",
  "project.description": "Descrição da solução",
  "project.name": "Nome do projeto",
  "project.objective": "Objetivo do projeto",
  "project.primary_conversion_action": "Ação principal de conversão",
  "schedule.estimated_days": "Prazo (dias úteis)",
  "scope.actions": "Ações da automação",
  "scope.admin_features": "Recursos administrativos",
  "scope.assumptions": "Premissas",
  "scope.content.client_provided_list": "Materiais fornecidos pelo cliente",
  "scope.content.initial_population": "Cadastro inicial de imóveis",
  "scope.content.provider_provided_list": "Conteúdos produzidos pelo fornecedor",
  "scope.features_conversion_list": "Elementos de conversão",
  "scope.features_list": "Funcionalidades",
  "scope.integrations_list": "Integrações",
  "scope.pages_list": "Lista de páginas",
  "scope.payment_methods": "Meios de pagamento",
  "scope.product_catalog_fields": "Campos do catálogo de produtos",
  "scope.property_filters": "Filtros de busca de imóveis",
  "scope.services_list": "Serviços oferecidos",
  "scope.shipping_rules": "Regras de entrega e frete",
  "scope.triggers": "Gatilhos da automação",
  "scope.user_roles": "Perfis de usuário",
  "scope.workflow": "Fluxo principal da automação",
  "scope.workflows": "Fluxos principais",
});

/**
 * O campo do funil no mínimo que um RÓTULO precisa — estrutural, para este
 * módulo continuar puro e leve o bastante para o editor de modelos (client
 * component) importar sem arrastar o schema do funil para o bundle.
 */
export interface CampoDoFunilParaRotulo {
  key: string;
  label: string;
  type?: string;
  /** Ausente é `negocio` — a mesma régua de `escopoDoCampo` (#2791). */
  escopo?: string;
}

/**
 * As variáveis `{{lead.<chave>}}` com o nome que a EMPRESA deu ao campo (#4533).
 *
 * O modelo da proposta é escrito por quem vende, não por quem programou: sem
 * este mapa o editor mostra "Endereco do imovel" (o fallback de
 * `rotuloDaVariavel`), e quem escreve precisa decorar a chave do funil. Aqui o
 * rótulo é o mesmo que a pessoa vê no card.
 *
 * Campo do CONTATO fica de fora — o valor dele mora em `contacts.custom_fields`
 * e não existe em `{{lead.<chave>}}` —, e campo `file` também (o anexo mora em
 * `crm_lead_attachments`, nunca no jsonb).
 */
export function rotulosDoNegocio(
  campos: readonly CampoDoFunilParaRotulo[],
): Record<string, string> {
  const saida: Record<string, string> = {
    "lead.titulo": ROTULO_DA_VARIAVEL["lead.titulo"]!,
    "lead.etapa": ROTULO_DA_VARIAVEL["lead.etapa"]!,
    "lead.responsavel_nome": ROTULO_DA_VARIAVEL["lead.responsavel_nome"]!,
    "lead.responsavel_telefone": ROTULO_DA_VARIAVEL["lead.responsavel_telefone"]!,
  };
  for (const campo of campos) {
    if (campo.escopo === "contato") continue;
    if (campo.type === "file") continue;
    saida[`lead.${campo.key}`] = campo.label;
  }
  return saida;
}

/**
 * O nome legível de uma variável. `extras` são os rótulos que só existem em
 * runtime — hoje, os campos do funil do negócio (`rotulosDoNegocio`).
 */
export function rotuloDaVariavel(caminho: string, extras?: Readonly<Record<string, string>>): string {
  if (Object.hasOwn(ROTULO_DA_VARIAVEL, caminho)) return ROTULO_DA_VARIAVEL[caminho]!;
  if (extras && Object.hasOwn(extras, caminho)) return extras[caminho]!;
  const ultimo = caminho.split(".").pop() ?? caminho;
  const texto = ultimo.replace(/_/g, " ").trim();
  return texto.length === 0 ? caminho : texto.charAt(0).toUpperCase() + texto.slice(1);
}

export type OndePreencher = "briefing" | "campo_prazo" | "itens" | "contato" | "negocio" | "sistema";

/**
 * `montarDadosDoDocumento` calcula `client.name`, `client.company_or_name`,
 * `investment`, `schedule` e `commercial_terms` de colunas gravadas; o resto
 * vem do `briefing_json`. Esta função é o espelho daquela, para a tela saber
 * se oferece um campo ou aponta para outro lugar.
 *
 * `lead.*` é `negocio`: o valor é do CARD (#4533) e não se digita na proposta —
 * oferecer uma caixa de texto ali gravaria em `briefing_json`, que o dataset
 * sobrescreve. Quem preenche é o funil.
 */
export function ondePreencher(caminho: string): OndePreencher {
  if (caminho === "schedule.estimated_days") return "campo_prazo";
  if (caminho === "investment" || caminho.startsWith("investment.")) return "itens";
  if (caminho === "client.name" || caminho === "client.company_or_name") return "contato";
  if (caminho === "lead" || caminho.startsWith("lead.")) return "negocio";
  if (
    caminho === "numero" ||
    caminho === "commercial_terms.validity_days" ||
    caminho === "approval" ||
    caminho.startsWith("approval.")
  ) {
    return "sistema";
  }
  return "briefing";
}
