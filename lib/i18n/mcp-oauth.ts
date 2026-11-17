/**
 * Textos da conexão OAuth do MCP (migration 9390): a tela de consentimento
 * (`app/oauth/mcp/consentir`), as recusas da rota que a atende e a nota da
 * tela de API Tokens. A chave é o português, como no resto do dicionário.
 */
export const TEXTOS_MCP_OAUTH = {
  "Não foi possível continuar a conexão": { es: "No se pudo continuar la conexión" },
  "O pedido de conexão está incompleto ou expirou. Volte ao aplicativo e tente conectar de novo.": {
    es: "La solicitud de conexión está incompleta o expiró. Vuelve a la aplicación e intenta conectar de nuevo.",
  },
  "Só quem administra a empresa pode conectar aplicativos": {
    es: "Solo quien administra la empresa puede conectar aplicaciones",
  },
  "Peça a quem administra a sua empresa no CRM para fazer a conexão.": {
    es: "Pide a quien administra tu empresa en el CRM que haga la conexión.",
  },
  "Não foi possível concluir a autorização. Tente de novo.": {
    es: "No se pudo completar la autorización. Inténtalo de nuevo.",
  },
  Conectar: { es: "Conectar" },
  "Este aplicativo está pedindo acesso aos dados do CRM pela sua conta": {
    es: "Esta aplicación está pidiendo acceso a los datos del CRM con tu cuenta",
  },
  "A autorização será enviada para:": { es: "La autorización se enviará a:" },
  "O que o aplicativo poderá fazer": { es: "Lo que la aplicación podrá hacer" },
  "Somente ler": { es: "Solo leer" },
  "Consultar contatos, conversas, negócios e relatórios.": {
    es: "Consultar contactos, conversaciones, negocios e informes.",
  },
  "Ler e alterar": { es: "Leer y modificar" },
  "Também criar e alterar contatos, negócios, agenda, tarefas e automações, como um administrador.": {
    es: "También crear y modificar contactos, negocios, agenda, tareas y automatizaciones, como un administrador.",
  },
  "E enviar mensagens de WhatsApp e materiais diretamente aos seus clientes, em nome da empresa.": {
    es: "Y enviar mensajes de WhatsApp y materiales directamente a tus clientes, en nombre de la empresa.",
  },
  "Você pode desligar esta conexão quando quiser na tela API Tokens do CRM.": {
    es: "Puedes desactivar esta conexión cuando quieras en la pantalla API Tokens del CRM.",
  },
  "Autorizando…": { es: "Autorizando…" },
  Permitir: { es: "Permitir" },
  Cancelar: { es: "Cancelar" },
  "Durante um acompanhamento de suporte não é possível conectar aplicativos.": {
    es: "Durante un acompañamiento de soporte no es posible conectar aplicaciones.",
  },
  "Muitas tentativas. Espere alguns minutos.": { es: "Demasiados intentos. Espera unos minutos." },
  "Este aplicativo não está registrado, ou o endereço de volta não confere.": {
    es: "Esta aplicación no está registrada, o la dirección de retorno no coincide.",
  },
  "O aplicativo pediu acesso a outro endereço.": { es: "La aplicación pidió acceso a otra dirección." },
  "O aplicativo não pediu permissão para alterar dados.": {
    es: "La aplicación no pidió permiso para modificar datos.",
  },
  "Conectar o ChatGPT ou outro aplicativo de MCP": { es: "Conectar ChatGPT u otra aplicación de MCP" },
  "No aplicativo, adicione um servidor MCP com o endereço": {
    es: "En la aplicación, agrega un servidor MCP con la dirección",
  },
  'e escolha a autenticação OAuth. Você entra com a sua conta do CRM e decide se ele só lê ou também altera dados. A conexão aparece nesta lista com "(OAuth)" no nome; revogar a desliga. A data em Expira é a do acesso em uso, renovado sozinho a cada hora.':
    {
      es: 'y elige la autenticación OAuth. Entras con tu cuenta del CRM y decides si solo lee o también modifica datos. La conexión aparece en esta lista con "(OAuth)" en el nombre; revocarla la desactiva. La fecha en Expira es la del acceso en uso, que se renueva solo cada hora.',
    },
} as const;
