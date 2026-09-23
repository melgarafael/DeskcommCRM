/**
 * Os textos das telas que a equipe usa todo dia.
 *
 * ─── A regra de ouro deste arquivo ─────────────────────────────────────────
 *
 * A CHAVE é o texto em português. Não `inbox.filtro.todas`, não `INBOX_ALL`.
 *
 * Duas razões, e as duas doem quando se descobre tarde:
 *
 *   1. Quem lê o componente vê a frase, não um código. `t("Todas as tags")`
 *      continua legível; `t("inbox.tags.all")` obriga a abrir outro arquivo
 *      para saber o que a tela diz.
 *   2. Falta de tradução DEGRADA para português em vez de mostrar a chave. Um
 *      `t("Assumir")` sem entrada em espanhol devolve "Assumir" — feio, mas
 *      compreensível. Com chave simbólica devolveria `inbox.claim`, que não é
 *      nada para ninguém.
 *
 * ─── Foi parcial; hoje o que decide é um guarda, não esta frase ────────────
 *
 * Este bloco dizia "só as telas do dia a dia", e era verdade. Deixou de ser: o
 * PR #352 trouxe IA e Admin, e o passe seguinte fechou Agenda, Desempenho,
 * Radar e Respostas rápidas.
 *
 * Não vale trocar por um número novo — ele envelheceria igual. Quem responde
 * "o que falta" é `tests/unit/i18n-espanhol-cobre-a-tela`, que varre o AST de
 * toda tela: chave usada sem espanhol reprova, e prosa portuguesa fora de `t()`
 * reprova. Uma tela nova entra na conta no dia em que é escrita, sem ninguém
 * lembrar de atualizar prosa nenhuma.
 *
 * O que segue valendo: falta de tradução DEGRADA para português, nunca para a
 * chave crua nem para erro. Uma tradução incompleta não pode deixar a tela pior
 * do que estava.
 */
import type { Idioma } from "./idiomas";

/** `pt-BR` não aparece: é a chave. Só o que DIFERE precisa de linha. */
type Traducoes = Record<string, Partial<Record<Exclude<Idioma, "pt-BR">, string>>>;

export const DICIONARIO: Traducoes = {
  "Sobre a empresa": { es: "Sobre la empresa" },
  "Não foi possível carregar o enriquecimento.": { es: "No se pudo cargar el enriquecimiento." },
  "Sem dados de enriquecimento para este contato.": { es: "Sin datos de enriquecimiento para este contacto." },
  "Avaliações no Google": { es: "Reseñas en Google" },
  "E-mails comerciais": { es: "Correos comerciales" },
  "Fonte: pesquisa de empresas": { es: "Fuente: búsqueda de empresas" },
  "Ver no Google Maps": { es: "Ver en Google Maps" },
  "Dados públicos coletados na busca; podem ter mudado.": { es: "Datos públicos recopilados en la búsqueda; pueden haber cambiado." },

  "Mensagens rápidas": { es: "Mensajes rápidos" },
  "Voltar às conversas": { es: "Volver a las conversaciones" },
  "Minimizar mensagens": { es: "Minimizar mensajes" },
  "conversas não lidas": { es: "conversaciones no leídas" },
  "Não foi possível atualizar as mensagens.": { es: "No se pudieron actualizar los mensajes." },
  "Não foi possível carregar as conversas.": { es: "No se pudieron cargar las conversaciones." },
  "Escolher contato para conversar": { es: "Elegir contacto para conversar" },
  "Acompanhamento somente leitura": { es: "Seguimiento de solo lectura" },
  "A janela de atendimento fechou. Abra o Inbox para ver as opções deste canal.": { es: "La ventana de atención se cerró. Abre el Inbox para ver las opciones de este canal." },

  "A espera foi interrompida. O teste já enviado pode continuar no provedor.": { es: "Se interrumpió la espera. La prueba ya enviada puede continuar en el proveedor." },
  "Não foi possível testar o agente.": { es: "No se pudo probar el agente." },
  "Testar como cliente": { es: "Probar como cliente" },
  "Experimente a conversa antes de publicar": { es: "Prueba la conversación antes de publicar" },
  "Escreva como um cliente. O teste usa um rascunho pausado e consome créditos de IA, sem enviar mensagens aos seus contatos.": { es: "Escribe como un cliente. La prueba usa un borrador pausado y consume créditos de IA, sin enviar mensajes a tus contactos." },
  "Mensagem do cliente para o teste": { es: "Mensaje del cliente para la prueba" },
  "Tenho interesse, mas preciso entender como isso ajudaria minha empresa.": { es: "Me interesa, pero necesito entender cómo ayudaría a mi empresa." },
  "Preparando rascunho…": { es: "Preparando borrador…" },
  "Testando resposta…": { es: "Probando respuesta…" },
  "Testar resposta": { es: "Probar respuesta" },
  "Parar de esperar": { es: "Dejar de esperar" },
  "Resultado da simulação": { es: "Resultado de la simulación" },
  "Resposta de teste": { es: "Respuesta de prueba" },
  "O agente não produziu uma resposta para esta mensagem.": { es: "El agente no generó una respuesta para este mensaje." },
  "Resposta de um provedor de teste controlado; nenhuma IA externa foi chamada.": { es: "Respuesta de un proveedor de pruebas controlado; no se llamó a ninguna IA externa." },
  "Revise a resposta: ela contém termos internos do sistema.": { es: "Revisa la respuesta: contiene términos internos del sistema." },
  "Verificações que dependem de uma conversa real": { es: "Verificaciones que dependen de una conversación real" },
  "Cada teste avalia uma mensagem. Ações sobre contatos e envios não são executados nesta simulação.": { es: "Cada prueba evalúa un mensaje. La simulación no ejecuta acciones sobre contactos ni hace envíos." },
  "Configurar assistente de voz neste rascunho": { es: "Configurar el asistente de voz en este borrador" },
  "Etapa inicial": { es: "Etapa inicial" },
  "Etapa de qualificados": { es: "Etapa de calificados" },
  "Pronto para testar e publicar": { es: "Listo para probar y publicar" },
  "Seu agente está tomando forma": { es: "Tu agente está tomando forma" },
  "definições preenchidas": { es: "ajustes completados" },
  "Vamos definir na conversa": { es: "Lo definiremos en la conversación" },
  "Permissões: consultar contatos e atualizar negócios no funil escolhido.": { es: "Permisos: consultar contactos y actualizar negocios en el embudo elegido." },
  "Agente publicado e selecionado.": { es: "Agente publicado y seleccionado." },
  "Configurar por conversa": { es: "Configurar conversando" },
  "Usar agente existente / configurar manualmente": { es: "Usar un agente existente / configurar manualmente" },
  "Agente selecionado": { es: "Agente seleccionado" },
  "Configurar assistente de voz": { es: "Configurar asistente de voz" },
  "Agente pronto. Escolha o ritmo abaixo e inicie quando estiver preparado.": { es: "Agente listo. Elige el ritmo abajo e inicia cuando estés listo." },
  "Resposta interrompida. Sua mensagem foi mantida para tentar novamente.": { es: "Se interrumpió la respuesta. Tu mensaje se conservó para que vuelvas a intentarlo." },
  "Complete a configuração e recupere uma publicação pendente antes de testar.": { es: "Completa la configuración y recupera cualquier publicación pendiente antes de probar." },
  "Não foi possível recuperar o rascunho.": { es: "No se pudo recuperar el borrador." },
  "Não foi possível publicar o agente.": { es: "No se pudo publicar el agente." },
  "Carregando sua conversa…": { es: "Cargando tu conversación…" },
  "Recarregar conversa salva": { es: "Volver a cargar la conversación guardada" },
  "Qualificar interessados": { es: "Calificar interesados" },
  "Quero montar um agente para descobrir o problema do cliente e qualificar interessados.": { es: "Quiero crear un agente para identificar el problema del cliente y calificar interesados." },
  "Agendar uma conversa": { es: "Programar una conversación" },
  "Quero que o agente entenda a necessidade e convide o cliente para uma conversa com a equipe.": { es: "Quiero que el agente entienda la necesidad e invite al cliente a conversar con el equipo." },
  "Configuração por conversa": { es: "Configuración mediante conversación" },
  "Conte o que você quer alcançar. O resumo acompanha suas escolhas.": { es: "Cuéntanos qué quieres lograr. El resumen se actualiza con tus elecciones." },
  "Conversa com alterações não salvas": { es: "Conversación con cambios sin guardar" },
  "Conversa salva no CRM": { es: "Conversación guardada en el CRM" },
  "Modo do assistente": { es: "Modo del asistente" },
  "Configurar conversando": { es: "Configurar conversando" },
  "O que você oferece e o que quer descobrir na conversa com essas empresas?": { es: "¿Qué ofreces y qué quieres descubrir al conversar con estas empresas?" },
  "Organizando suas escolhas e preparando a próxima pergunta…": { es: "Organizando tus elecciones y preparando la siguiente pregunta…" },
  "Preparando resposta…": { es: "Preparando respuesta…" },
  "Rascunho salvo e pausado. Você pode testar e ajustar antes de publicar.": { es: "Borrador guardado y pausado. Puedes probarlo y ajustarlo antes de publicar." },
  "Ao publicar, o agente poderá atender mensagens recebidas neste canal. A prospecção começa apenas quando você iniciar a campanha.": { es: "Al publicar, el agente podrá responder a los mensajes recibidos en este canal. La prospección solo comienza cuando inicies la campaña." },
  "Publicando agente…": { es: "Publicando agente…" },
  "Recuperando rascunho…": { es: "Recuperando borrador…" },
  "Recuperar rascunho de teste": { es: "Recuperar borrador de prueba" },
  "Publicar e usar agente": { es: "Publicar y usar agente" },
  "A última criação ainda precisa de confirmação. Recupere a mesma solicitação para evitar outro agente.": { es: "La última creación aún necesita confirmación. Recupera la misma solicitud para evitar crear otro agente." },
  "Consultar criação salva": { es: "Consultar la creación guardada" },
  "Conta conectada": { es: "Cuenta conectada" },
  "Conectar conta": { es: "Conectar cuenta" },
  "Salvar chave e conectar": { es: "Guardar clave y conectar" },
  "Conta conectada. Agora escolha como seu assistente deve falar.": { es: "Cuenta conectada. Ahora elige cómo debe hablar tu asistente." },
  "Assistente de voz salvo. Você já pode conversar com ele aqui.": { es: "Asistente de voz guardado. Ya puedes conversar con él aquí." },
  "Salvando assistente…": { es: "Guardando asistente…" },
  "Recuperar e salvar configuração": { es: "Recuperar y guardar configuración" },
  "Salvar assistente de voz": { es: "Guardar asistente de voz" },
  "Conectando e preparando o microfone…": { es: "Conectando y preparando el micrófono…" },
  "Assistente falando": { es: "Asistente hablando" },
  "Ouvindo você": { es: "Escuchándote" },
  "Salve as alterações para testar esta versão.": { es: "Guarda los cambios para probar esta versión." },
  "Pronto para testar": { es: "Listo para probar" },
  "Salve a configuração para começar.": { es: "Guarda la configuración para empezar." },
  "Esta campanha já começou a preparar contatos. Sua configuração foi preservada para retomar com segurança.": { es: "Esta campaña ya empezó a preparar contactos. Su configuración se conservó para reanudar con seguridad." },
  "Criar agente para esta campanha": { es: "Crear agente para esta campaña" },
  "Configurações avançadas do agente": { es: "Configuración avanzada del agente" },
  "Agente criado e selecionado.": { es: "Agente creado y seleccionado." },
  "Revise o ritmo e inicie a campanha quando estiver pronto.": { es: "Revisa el ritmo e inicia la campaña cuando estés listo." },
  "Não foi possível continuar a conversa.": { es: "No se pudo continuar la conversación." },
  "Ainda faltam informações. Continue a conversa para completar a configuração.": { es: "Todavía falta información. Continúa la conversación para completar la configuración." },
  "Não foi possível criar o agente.": { es: "No se pudo crear el agente." },
  "Vamos montar seu agente": { es: "Vamos a preparar tu agente" },
  "Conte o que você precisa. Eu preparo as instruções e permissões com você.": { es: "Cuéntame qué necesitas. Preparo las instrucciones y los permisos contigo." },
  "Conversa para criar agente": { es: "Conversación para crear un agente" },
  "Assistente de configuração": { es: "Asistente de configuración" },
  "O que você quer que este agente ofereça e consiga descobrir na conversa com essas empresas?": { es: "¿Qué quieres que este agente ofrezca y averigüe al conversar con estas empresas?" },
  "Pensando na configuração…": { es: "Pensando en la configuración…" },
  "Resumo do agente": { es: "Resumen del agente" },
  "Pronto para criar": { es: "Listo para crear" },
  "Como vai abordar": { es: "Cómo se acercará" },
  "Quando qualificar": { es: "Cuándo calificar" },
  "Permissões: consultar contatos e atualizar negócios neste funil.": { es: "Permisos: consultar contactos y actualizar negocios en este embudo." },
  "Manter a continuidade do agente neste canal": { es: "Mantener la continuidad del agente en este canal" },
  "Dar continuidade com o mesmo agente, salvo mudança de assunto ou transferência. Esta configuração vale para as conversas deste canal.": { es: "Continuar con el mismo agente, salvo cambio de tema o transferencia. Esta configuración se aplica a las conversaciones de este canal." },
  "O agente será publicado e poderá atender mensagens recebidas neste canal. As abordagens só começam quando você iniciar a campanha.": { es: "El agente se publicará y podrá atender los mensajes que lleguen a este canal. El contacto con las empresas solo empieza cuando inicies la campaña." },
  "Preparando agente…": { es: "Preparando agente…" },
  "Recuperar criação do agente": { es: "Recuperar la creación del agente" },
  "Criar e usar agente": { es: "Crear y usar agente" },
  "Mantenha os dados desta tentativa. Recuperar a criação consulta a mesma solicitação, sem criar outro agente.": { es: "Conserva los datos de este intento. Al recuperar la creación se consulta la misma solicitud y no se crea otro agente." },
  "Revisar o agente salvo": { es: "Revisar el agente guardado" },
  "Mensagem para configurar o agente": { es: "Mensaje para configurar el agente" },
  "Conte o que você quer que o agente faça…": { es: "Describe lo que quieres que haga el agente…" },
  "Voltar à campanha": { es: "Volver a la campaña" },
  "Pensando…": { es: "Pensando…" },
  "Prospecção": { es: "Prospección" },
  "Encontre empresas, aborde aos poucos e acompanhe quem avança na conversa.": { es: "Encuentra empresas, contáctalas poco a poco y da seguimiento a quienes avanzan en la conversación." },
  "Configurar busca": { es: "Configurar búsqueda" },
  "Falha ao carregar a prospecção.": { es: "Error al cargar la prospección." },
  "Chave de busca salva.": { es: "Clave de búsqueda guardada." },
  "Chave da Apify": { es: "Clave de Apify" },
  "A chave fica cifrada no servidor. Cada busca tem seu próprio limite de gasto.": { es: "La clave queda cifrada en el servidor. Cada búsqueda tiene su propio límite de gasto." },
  "1. Encontrar empresas": { es: "1. Encontrar empresas" },
  "Solicitação registrada. Acompanhe o estado da busca nesta tela.": { es: "Solicitud registrada. Da seguimiento al estado de la búsqueda en esta pantalla." },
  "Público ou segmento": { es: "Público o segmento" },
  "Ex.: clínicas de estética": { es: "Ej.: clínicas de estética" },
  "Cidade ou região": { es: "Ciudad o región" },
  "Ex.: São Paulo, SP": { es: "Ej.: São Paulo, SP" },
  "Até quantas empresas": { es: "Máximo de empresas" },
  "Teto da busca (US$)": { es: "Límite de la búsqueda (US$)" },
  "Enriquecer com e-mails comerciais e redes encontradas no site": { es: "Enriquecer con correos comerciales y redes sociales encontrados en el sitio" },
  "A pesquisa usa seu saldo da Apify. A quantidade encontrada pode ser menor que o limite. Nenhuma abordagem começa nesta etapa.": { es: "La búsqueda usa tu saldo de Apify. Es posible que se encuentren menos empresas que el límite. En esta etapa no se contacta a nadie." },
  "Aguarde…": { es: "Espera…" },
  "Buscar empresas": { es: "Buscar empresas" },
  "Suas campanhas": { es: "Tus campañas" },
  "empresas": { es: "empresas" },
  "Sua próxima conversa começa aqui": { es: "Tu próxima conversación comienza aquí" },
  "Escolha um segmento e uma região. Depois da pesquisa, defina como a IA deve abordar e o que precisa confirmar para qualificar.": { es: "Elige un segmento y una región. Después de la búsqueda, define cómo debe contactar la IA y qué necesita confirmar para calificar." },
  "Encontrados": { es: "Encontrados" },
  "Na fila": { es: "En cola" },
  "Responderam": { es: "Respondieron" },
  "Qualificados": { es: "Calificados" },
  "resultados repetidos ou indisponíveis foram desconsiderados.": { es: "resultados repetidos o no disponibles se descartaron." },
  "Ritmo:": { es: "Ritmo:" },
  "abordagens em 24 horas, com pelo menos": { es: "contactos en 24 horas, con al menos" },
  "minutos entre elas.": { es: "minutos entre cada uno." },
  "Novas abordagens pausadas.": { es: "Nuevos contactos pausados." },
  "Pausar abordagens": { es: "Pausar contactos" },
  "Campanha retomada.": { es: "Campaña reanudada." },
  "Retomar fila": { es: "Reanudar cola" },
  "2. Preparar a abordagem": { es: "2. Preparar el contacto" },
  "A IA usa o agente escolhido para abrir a conversa e atender as respostas. As proteções do canal continuam valendo.": { es: "La IA usa el agente elegido para abrir la conversación y atender las respuestas. Las protecciones del canal siguen vigentes." },
  "Campanha iniciada. A primeira abordagem será preparada após um minuto.": { es: "Campaña iniciada. El primer contacto se preparará en un minuto." },
  "Escolha um agente publicado": { es: "Elige un agente publicado" },
  "Publique e ative um agente para continuar.": { es: "Publica y activa un agente para continuar." },
  "Conexão de saída": { es: "Conexión de salida" },
  "Escolha uma conexão ativa": { es: "Elige una conexión activa" },
  "Ver conexões e proteções de envio": { es: "Ver conexiones y protecciones de envío" },
  "O que a IA deve oferecer e como iniciar": { es: "Qué debe ofrecer la IA y cómo iniciar" },
  "Descreva sua oferta e o objetivo da primeira conversa.": { es: "Describe tu oferta y el objetivo de la primera conversación." },
  "Quando considerar o cliente qualificado": { es: "Cuándo considerar al cliente calificado" },
  "Ex.: confirmou a necessidade, participa da decisão e deseja conversar sobre a solução.": { es: "Ej.: confirmó la necesidad, participa en la decisión y desea conversar sobre la solución." },
  "Máximo em 24 horas": { es: "Máximo en 24 horas" },
  "Intervalo mínimo (minutos)": { es: "Intervalo mínimo (minutos)" },
  "Referência da avaliação de legítimo interesse": { es: "Referencia de la evaluación de interés legítimo" },
  "Informe a referência real da avaliação que fundamenta esta prospecção. Isso não registra consentimento dos contatos.": { es: "Indica la referencia real de la evaluación que fundamenta esta prospección. Esto no registra consentimiento de los contactos." },
  "Ao iniciar, os contatos novos com telefone entram no funil. Contatos já existentes são preservados. A fila faz uma primeira abordagem; respostas seguem no Inbox. Uma mensagem já em transmissão pode concluir após a pausa.": { es: "Al iniciar, los contactos nuevos con teléfono entran al embudo y los que ya existen se conservan. La cola hace un primer contacto y las respuestas llegan al Inbox. Un mensaje que ya se está enviando puede terminar de salir después de la pausa." },
  "Iniciar abordagens com IA": { es: "Iniciar contactos con IA" },
  "3. Acompanhar resultados": { es: "3. Seguimiento de resultados" },
  "Encontrado é diferente de qualificado. A qualificação depende do que for confirmado na conversa.": { es: "Encontrado no es lo mismo que calificado. La calificación depende de lo que se confirme en la conversación." },
  "Empresa": { es: "Empresa" },
  "Progresso": { es: "Progreso" },
  "Site da empresa": { es: "Sitio de la empresa" },
  "avaliações": { es: "reseñas" },
  "Mensagem:": { es: "Mensaje:" },
  "Abrir no Inbox": { es: "Abrir en Inbox" },
  "Preparar campanha": { es: "Preparar campaña" },
  "Abordagens concluídas": { es: "Contactos completados" },
  "Iniciando busca": { es: "Iniciando búsqueda" },
  "Busca concluída": { es: "Búsqueda completada" },
  "Revisar falha": { es: "Revisar error" },
  "Busca sem confirmação": { es: "Búsqueda sin confirmación" },
  "Preparando abordagem": { es: "Preparando contacto" },
  "Abordado": { es: "Contactado" },
  "Não abordado": { es: "No contactado" },
  "Respondeu": { es: "Respondió" },
  // /admin/email — o servidor SMTP da instalação (PR #714, @betoarts, recorte).
  "Servidor de e-mail conectado e autenticado.": { es: "Servidor de correo conectado y autenticado." },
  "Preencha e salve o servidor e o remetente antes de testar.": {
    es: "Completa y guarda el servidor y el remitente antes de probar.",
  },
  "O servidor respondeu, mas recusou o usuário e a senha.": {
    es: "El servidor respondió, pero rechazó el usuario y la contraseña.",
  },
  "Não foi possível falar com o servidor. Confira o endereço, a porta e a segurança.": {
    es: "No se pudo conectar con el servidor. Revisa la dirección, el puerto y la seguridad.",
  },
  "Servidor de e-mail salvo.": { es: "Servidor de correo guardado." },
  "Serviço externo de envio": { es: "Servicio externo de envío" },
  "A alternativa ao servidor próprio: um serviço que entrega o e-mail por você. Se as duas coisas estiverem configuradas, o servidor próprio tem preferência.": {
    es: "Es la alternativa al servidor propio: un servicio que entrega el correo por ti. Si ambos están configurados, se usa el servidor propio.",
  },
  "O serviço de envio de e-mail — próprio ou externo — fica em E-mail →": {
    es: "El servicio de envío de correo, propio o externo, está en Correo →",
  },
  "Extensões da instalação": { es: "Extensiones de la instalación" },
  "O que este servidor conhece, de onde veio e quem está usando. Instalar e configurar continua sendo feito dentro de cada empresa.": {
    es: "Lo que conoce este servidor, de dónde viene y quién lo usa. La instalación y la configuración se siguen haciendo dentro de cada empresa.",
  },
  "De onde vêm as extensões": { es: "De dónde vienen las extensiones" },
  "O catálogo admitido neste servidor. É a origem que o instalador aceita.": {
    es: "El catálogo admitido en este servidor. Es el origen que el instalador acepta.",
  },
  "Nenhum catálogo admitido ainda — enquanto não houver, não há extensão para instalar.": {
    es: "Aún no hay catálogos admitidos. Sin uno, no hay extensiones que instalar.",
  },
  "admitido em": { es: "admitido el" },
  "impressão digital": { es: "huella digital" },
  "Instaladas neste servidor": { es: "Instaladas en este servidor" },
  "Cada extensão é instalada uma vez no servidor e ligada por empresa.": {
    es: "Cada extensión se instala una vez en el servidor y se activa por empresa.",
  },
  "Nenhuma extensão instalada ainda.": { es: "Ninguna extensión instalada todavía." },
  "Nenhuma empresa usa esta extensão": { es: "Ninguna empresa usa esta extensión" },
  "empresa(s) com ela ligada": { es: "empresa(s) con ella activada" },
  "instalada em": { es: "instalada el" },
  "Para instalar ou configurar uma extensão, entre na empresa:": {
    es: "Para instalar o configurar una extensión, entra a la empresa:",
  },
  "Extensões da empresa →": { es: "Extensiones de la empresa →" },
  "Servidor de e-mail desta instalação": { es: "Servidor de correo de esta instalación" },
  "Convite de equipe, entrega de dados de LGPD e aviso de prazo saem por aqui. Preencher esta tela é a alternativa a contratar um serviço externo de envio: o e-mail passa a sair pelo seu próprio servidor.": {
    es: "Por aquí salen las invitaciones al equipo, la entrega de datos personales y los avisos de plazo. Completar esta pantalla es la alternativa a contratar un servicio externo de envío: el correo saldrá por tu propio servidor.",
  },
  "Endereço do servidor": { es: "Dirección del servidor" },
  "Normalmente é a palavra smtp seguida do seu domínio. Só o endereço: sem smtp:// na frente e sem a porta no fim.": {
    es: "Normalmente es la palabra smtp seguida de tu dominio. Solo la dirección: sin smtp:// al principio y sin el puerto al final.",
  },
  "Porta": { es: "Puerto" },
  "STARTTLS (normalmente a porta 587)": { es: "STARTTLS (normalmente el puerto 587)" },
  "TLS/SSL (normalmente a porta 465)": { es: "TLS/SSL (normalmente el puerto 465)" },
  "Sem criptografia": { es: "Sin cifrado" },
  "Senha do e-mail": { es: "Contraseña del correo" },
  "Já existe uma senha gravada. Deixe em branco para mantê-la, ou digite uma nova para substituir.": {
    es: "Ya hay una contraseña guardada. Déjalo en blanco para mantenerla, o escribe una nueva para reemplazarla.",
  },
  "E-mail que aparece como remetente": { es: "Correo que aparece como remitente" },
  "Nome que aparece como remetente": { es: "Nombre que aparece como remitente" },
  "Estes valores vieram do arquivo de configuração do servidor. O que você salvar aqui passa a valer no lugar dele; apagar o que está aqui faz o sistema voltar a usar o arquivo.": {
    es: "Estos valores vienen del archivo de configuración del servidor. Lo que guardes aquí los reemplaza. Si lo borras, el sistema vuelve a usar el archivo.",
  },
  "Em uso: o e-mail está saindo por este servidor.": { es: "En uso: el correo sale por este servidor." },
  "O e-mail desta instalação já sai por um serviço externo. Preencher esta tela passa a entrega para o seu servidor.": {
    es: "El correo de esta instalación ya sale por un servicio externo. Si completas esta pantalla, la entrega pasa a tu servidor.",
  },
  "Nenhum caminho de e-mail configurado: os convites aparecem como link para copiar, em vez de chegar na caixa de entrada.": {
    es: "No hay ningún medio de envío de correo configurado: las invitaciones aparecen como un enlace para copiar, en lugar de llegar a la bandeja de entrada.",
  },
  "Testar conexão": { es: "Probar conexión" },
  "Informe uma porta entre 1 e 65535.": { es: "Indica un puerto entre 1 y 65535." },
  "Informe somente o e-mail do remetente, por exemplo suporte@empresa.com.": {
    es: "Indica solo el correo del remitente, por ejemplo soporte@empresa.com.",
  },
  "Selecione STARTTLS, TLS ou Sem criptografia.": { es: "Selecciona STARTTLS, TLS o Sin cifrado." },
  "Revise os dados SMTP informados.": { es: "Revisa los datos SMTP indicados." },
  "A cifra está indisponível nesta instalação; a senha não foi gravada.": {
    es: "El cifrado no está disponible en esta instalación; la contraseña no se guardó.",
  },
  // vocabulario.ts (followups) — MatchReplyForm.tsx não traduzia, ClassifyForm.tsx sim.
  "Se a informação já existir": { es: "Si la información ya existe" },
  "Perguntar de novo e substituir": { es: "Preguntar de nuevo y reemplazar" },
  "Confirmar com o usuário": { es: "Confirmar con el usuario" },
  "A captação ou a ficha podem já ter o nome (ou o campo). Escolha se o fluxo pula, pergunta de novo ou pede confirmação.": {
    es: "Puede que la captación o la ficha ya tengan el nombre (o el campo). Elige si el flujo lo omite, vuelve a preguntar o pide confirmación.",
  },
  // chaveDaIa.ts (onboarding/setup-ai) — erros do cadastro da chave de IA.
  // "Sua sessão expirou. Entre de novo." já existe (politicaDeMfa.ts), reaproveitada aqui.
  "Só um administrador pode cadastrar a chave da inteligência artificial.": {
    es: "Solo un administrador puede registrar la clave de la inteligencia artificial.",
  },
  "Escolha qual inteligência artificial você contratou.": {
    es: "Elige qué inteligencia artificial contrataste.",
  },
  "Essa chave parece incompleta. Cole a chave inteira, do começo ao fim.": {
    es: "Esa clave parece incompleta. Pega la clave entera, de principio a fin.",
  },
  "Já existe uma chave cadastrada com esse nome. Veja em IA › Credenciais.": {
    es: "Ya existe una clave registrada con ese nombre. Puedes verla en IA › Credenciales.",
  },
  "Não consegui guardar a chave agora. Tente de novo.": {
    es: "No pude guardar la clave ahora. Intenta de nuevo.",
  },
  // AgentForm.tsx — prompt padrão de um agente novo (vira o system_prompt de
  // verdade se ninguém editar, por isso instrui a IA a responder em espanhol).
  "Você é um atendente. Responda de forma educada e clara, em pt-BR.": {
    es: "Eres un agente de atención al cliente. Responde de forma educada y clara, en español.",
  },
  // PACOTES (lib/mcp/tools/pacotes.ts) — rótulo/explicação dos pacotes de
  // capacidade na tela de criar/editar agente (ToolPicker.tsx).
  "Atender e responder": { es: "Atender y responder" },

  // Painel de configuração da instalação (migration 0341) — os motivos pelos
  // quais uma chave NÃO é editável pela tela. São valores de uma tabela de
  // rótulo (`MOTIVO_CURTO`), então o teste de cobertura exige TODOS os valores
  // que a expressão pode assumir, não só os que aparecem hoje.
  "Necessária para o sistema ligar": { es: "Necesaria para que el sistema arranque" },
  "É a chave que protege as outras": { es: "Es la clave que protege a las demás" },
  "Gravada quando o programa foi montado": { es: "Grabada cuando se compiló el programa" },
  "Tem um par em outro programa do servidor": {
    es: "Tiene un par en otro programa del servidor",
  },
  "Lida por outro programa ao ligar": { es: "La lee otro programa al arrancar" },

  // Painel de configuração da instalação — a tela, o formulário e a porta do
  // modo administrador no menu do usuário.
  "Configuração da instalação": { es: "Configuración de la instalación" },
  "O que este servidor precisa saber para funcionar. O que dá para trocar aqui, você troca e vale na hora — sem mexer no servidor.":
    {
      es: "Lo que este servidor necesita saber para funcionar. Lo que puedas cambiar aquí surte efecto al instante, sin tocar el servidor.",
    },
  "Modo administrador": { es: "Modo administrador" },
  "Configurar este servidor": { es: "Configurar este servidor" },
  "Não configurado": { es: "Sin configurar" },
  "Definido aqui nesta tela": { es: "Definido aquí, en esta pantalla" },
  "Vem do arquivo de instalação do servidor": {
    es: "Viene del archivo de instalación del servidor",
  },
  "Pronto, já está valendo.": { es: "Listo, ya surtió efecto." },
  "Voltou para o valor do arquivo de instalação.": {
    es: "Volvió al valor del archivo de instalación.",
  },
  "Guardado, terminando em": { es: "Guardado, termina en" },
  "Agora:": { es: "Ahora:" },
  "Escreva para substituir": { es: "Escribe para reemplazar" },
  "Escreva para configurar": { es: "Escribe para configurar" },
  "Voltar ao padrão": { es: "Volver al valor por defecto" },
  "Não se troca por aqui": { es: "No se cambia por aquí" },
  "ocultar": { es: "ocultar" },
  "por quê?": { es: "¿por qué?" },
  "O agente lê a conversa, entende o histórico e responde ao cliente sem pedir que ele repita o que já disse.": {
    es: "El agente lee la conversación, entiende el historial y responde al cliente sin pedirle que repita lo que ya dijo.",
  },
  "Vender e mover o funil": { es: "Vender y mover el embudo" },
  "O agente registra a oportunidade, atualiza o negócio e move o cliente de etapa conforme a conversa avança.": {
    es: "El agente registra la oportunidad, actualiza el negocio y mueve al cliente de etapa a medida que avanza la conversación.",
  },
  "Não perder o cliente": { es: "No perder al cliente" },
  "O agente agenda retornos e acompanha quem esfriou, para que nenhum interessado morra por falta de resposta.": {
    es: "El agente programa seguimientos y retoma el contacto con quien se enfrió, para que ningún interesado se pierda por falta de respuesta.",
  },
  "Passar para um humano": { es: "Pasar a un humano" },
  "O agente reconhece quando não é o caso dele resolver, chama uma pessoa e entrega o resumo do que já aconteceu.": {
    es: "El agente reconoce cuándo no le corresponde resolverlo, llama a una persona y entrega el resumen de lo que ya pasó.",
  },
  "Organizar a operação": { es: "Organizar la operación" },
  "O agente mantém a casa em ordem: marcadores, etapas do funil, avisos automáticos e distribuição de trabalho.": {
    es: "El agente mantiene todo en orden: etiquetas, etapas del embudo, avisos automáticos y distribución del trabajo.",
  },
  "Aprender e evoluir": { es: "Aprender y evolucionar" },
  "O agente consulta o que a empresa já sabe, aprende com os atendimentos e sugere melhorias para você aprovar.": {
    es: "El agente consulta lo que la empresa ya sabe, aprende de cada atención y sugiere mejoras para que las apruebes.",
  },
  // vocabulario.ts (followups) — ESPERA_PELA_RESPOSTA.ajuda era string pronta
  // em português; virou função composta com t() (ver lib/followup/vocabulario.ts).
  "Se o contato não responder dentro desse tempo, o fluxo segue sozinho pelo caminho": {
    es: "Si el contacto no responde dentro de ese tiempo, el flujo sigue solo por el camino",
  },
  "QR Code": { es: "Código QR" },
  "Forma de conectar": { es: "Forma de conectar" },
  "Conectar por código": { es: "Conectar por código" },
  "Telefone com código do país e DDD": { es: "Teléfono con código de país y área" },
  "Gerando código…": { es: "Generando código…" },
  "Aguarde": { es: "Espera" },
  "Gerar outro código": { es: "Generar otro código" },
  "Gerar código": { es: "Generar código" },
  "Código de pareamento": { es: "Código de vinculación" },
  "Aguardando a confirmação no celular. Se o código expirar, gere outro.": { es: "Esperando la confirmación en el celular. Si el código caduca, genera otro." },
  "No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone. Digite o código mostrado aqui.": { es: "En el celular: WhatsApp → Dispositivos vinculados → Vincular un dispositivo → Vincular con número de teléfono. Escribe el código que aparece aquí." },
  "Se essa opção não aparecer no celular, use o QR Code.": { es: "Si esta opción no aparece en el celular, usa el código QR." },
  "Escolha QR Code ou código de pareamento e confirme no WhatsApp do celular.": { es: "Elige código QR o código de vinculación y confirma desde WhatsApp en tu celular." },
  "Uso o WhatsApp no celular": { es: "Uso WhatsApp en el celular" },
  "Conecte com QR Code ou digite um código de pareamento no WhatsApp do celular.": { es: "Conecta con un código QR o escribe un código de vinculación en WhatsApp desde tu celular." },
  "Informe o telefone completo com código do país e DDD.": { es: "Indica el teléfono completo con código de país y área." },
  "Não foi possível gerar o código. Tente novamente.": { es: "No se pudo generar el código. Inténtalo de nuevo." },
  "Não foi possível consultar esta conexão. Tente novamente.": { es: "No se pudo consultar esta conexión. Inténtalo de nuevo." },
  "Este canal foi excluído. Conecte um número para voltar a atender.": { es: "Este canal fue eliminado. Conecta un número para volver a atender." },
  "Este canal não conecta por código de pareamento.": { es: "Este canal no se puede conectar con código de vinculación." },
  "O serviço de conexão não está configurado.": { es: "El servicio de conexión no está configurado." },
  "Aguarde 30 segundos antes de pedir outro código.": { es: "Espera 30 segundos antes de solicitar otro código." },
  "Este WhatsApp já está conectado.": { es: "Este WhatsApp ya está conectado." },
  "A conexão ainda não está pronta. Aguarde ou use Reconectar e tente novamente.": { es: "La conexión aún no está lista. Espera o usa Reconectar e inténtalo de nuevo." },
  "Não foi possível gerar o código. Confira o número e tente novamente, ou use o QR Code.": { es: "No se pudo generar el código. Revisa el número e inténtalo de nuevo, o usa el código QR." },
  "O serviço de conexão não respondeu. Tente novamente ou use o QR Code.": { es: "El servicio de conexión no respondió. Inténtalo de nuevo o usa el código QR." },

  "Versão publicada": { es: "Versión publicada" },
  "Publicado em": { es: "Publicado el" },
  "Nenhum agente publicado": { es: "Ningún agente publicado" },
  "Não foi possível carregar o agente do tenant. Tente recarregar a página.": { es: "No se pudo cargar el agente del tenant. Intenta recargar la página." },
  "números de teste autorizados": { es: "números de prueba autorizados" },
  "1 número de teste autorizado": { es: "1 número de prueba autorizado" },
  "Nenhum número autorizado — a IA não responde ninguém neste canal.": {
    es: "Ningún número autorizado — la IA no responde a nadie en este canal.",
  },
  "Novos canais começam em modo de teste. Após concluir a configuração, abra Conexões para autorizar seus números de teste ou liberar o público.": { es: "Los canales nuevos empiezan en modo de prueba. Al terminar la configuración, abre Conexiones para autorizar tus números de prueba o habilitar al público." },
  "IA em modo de teste": { es: "IA en modo de prueba" },
  "IA aberta ao público": { es: "IA abierta al público" },
  "IA restrita por origem": { es: "IA restringida por origen" },
  "Configurar acesso da IA": { es: "Configurar acceso de la IA" },
  "Acesso da IA no WhatsApp": { es: "Acceso de la IA en WhatsApp" },
  "Teste com pessoas de confiança antes de liberar o atendimento automático.": { es: "Prueba con personas de confianza antes de habilitar la atención automática." },
  "Não foi possível carregar o acesso da IA.": { es: "No se pudo cargar el acceso de la IA." },
  "Use um telefone com DDI por linha, por exemplo +5511999998888.": { es: "Usa un teléfono con prefijo internacional por línea, por ejemplo +5511999998888." },
  "Acesso da IA atualizado.": { es: "Acceso de la IA actualizado." },
  "Não foi possível confirmar o salvamento. Reabra este painel para conferir a configuração.": { es: "No se pudo confirmar el guardado. Vuelve a abrir este panel para comprobar la configuración." },
  "Somente os números desta lista podem receber respostas automáticas neste canal.": { es: "Solo los números de esta lista pueden recibir respuestas automáticas en este canal." },
  "A lista de teste não restringe o atendimento enquanto a IA está aberta ao público.": { es: "La lista de prueba no restringe la atención mientras la IA esté abierta al público." },
  "Este canal usa autorizações por origem. Ativar o modo de teste substitui essa regra pela lista abaixo.": { es: "Este canal usa autorizaciones por origen. Activar el modo de prueba sustituye esa regla por la lista de abajo." },
  "Números autorizados para teste": { es: "Números autorizados para prueba" },
  "Um telefone com DDI por linha. Lista vazia no modo de teste bloqueia todas as respostas automáticas.": { es: "Un teléfono con prefijo internacional por línea. Una lista vacía en modo de prueba bloquea todas las respuestas automáticas." },
  "As mensagens continuam chegando ao Inbox, e sua equipe pode responder manualmente. Os testes são mensagens reais no WhatsApp, com os custos normais de uso.": { es: "Los mensajes siguen llegando al Inbox y tu equipo puede responder manualmente. Las pruebas son mensajes reales en WhatsApp, con los costos normales de uso." },
  "O agente precisa estar publicado e vinculado a este canal. Bloqueios do contato e atendimento humano continuam sendo respeitados.": { es: "El agente debe estar publicado y vinculado a este canal. Se siguen respetando los bloqueos del contacto y la atención humana." },
  "Salvar lista de teste": { es: "Guardar lista de prueba" },
  "Ativar modo de teste": { es: "Activar modo de prueba" },
  "Liberar atendimento ao público": { es: "Habilitar atención al público" },
  "Liberar a IA para o público?": { es: "¿Habilitar la IA para el público?" },
  "A lista de teste deixará de limitar as respostas. A IA poderá atender qualquer pessoa que enviar mensagem neste canal, respeitando os demais bloqueios.": { es: "La lista de prueba dejará de limitar las respuestas. La IA podrá atender a cualquier persona que envíe mensajes en este canal, respetando los demás bloqueos." },
  "Continuar em teste": { es: "Continuar en prueba" },
  "Confirmar liberação": { es: "Confirmar habilitación" },
  "Novos canais começam em modo de teste, sem respostas automáticas até você autorizar números ou liberar o público.": { es: "Los canales nuevos empiezan en modo de prueba, sin respuestas automáticas hasta que autorices números o habilites al público." },
  "Assistência do agente": { es: "Asistencia del agente" },
  "Resposta aprovada. Acompanhe o envio aqui.": { es: "Respuesta aprobada. Sigue el envío aquí." },
  "Sugestão rejeitada. O feedback será usado na próxima sugestão.": {
    es: "Sugerencia rechazada. Los comentarios se usarán en la próxima sugerencia.",
  },
  "Sua edição foi preservada. Confira se a conversa mudou antes de aprovar novamente.": {
    es: "Tu edición se conservó. Comprueba si la conversación cambió antes de aprobar de nuevo.",
  },
  "Preparando sugestão…": { es: "Preparando sugerencia…" },
  "Sugestão para revisar": { es: "Sugerencia para revisar" },
  "Resposta aprovada: aguardando envio": { es: "Respuesta aprobada: esperando envío" },
  "Enviando resposta aprovada…": { es: "Enviando respuesta aprobada…" },
  "Resposta aprovada enviada": { es: "Respuesta aprobada enviada" },
  "Sugestão rejeitada": { es: "Sugerencia rechazada" },
  "Nenhum agente publicado atende este canal. Publique uma versão do agente em IA › Agentes.": {
    es: "Ningún agente publicado atiende este canal. Publica una versión del agente en IA › Agentes.",
  },
  "Não dá para sugerir nesta conversa: o contato pediu para não receber mensagens, foi anonimizado, ou o histórico não pôde ser lido.":
    {
      es: "No se puede sugerir en esta conversación: el contacto pidió no recibir mensajes, fue anonimizado, o no se pudo leer el historial.",
    },
  "Não foi possível gerar a sugestão. O motivo ficou registrado no servidor com o identificador abaixo.":
    {
      es: "No se pudo generar la sugerencia. El motivo quedó registrado en el servidor con el identificador de abajo.",
    },
  "Sugestão obsoleta: a conversa mudou": { es: "Sugerencia obsoleta: la conversación cambió" },
  "Não foi possível concluir a sugestão ou o envio": {
    es: "No se pudo completar la sugerencia o el envío",
  },
  "Aprovar envia somente este texto. Não altera dados, agenda ou a autonomia do agente.": {
    es: "Aprobar envía solo este texto. No cambia datos, calendario ni la autonomía del agente.",
  },
  "Resposta sugerida": { es: "Respuesta sugerida" },
  "Ações propostas: precisam de autorização separada": {
    es: "Acciones propuestas: necesitan autorización por separado",
  },
  "Abra a ação correspondente no CRM ou na agenda para confirmar.": {
    es: "Abre la acción correspondiente en el CRM o en el calendario para confirmar.",
  },
  "Feedback para a próxima sugestão": { es: "Comentarios para la próxima sugerencia" },
  "Aprovar e enviar": { es: "Aprobar y enviar" },
  Rejeitar: { es: "Rechazar" },
  "Confira a configuração do agente e tente gerar novamente.": {
    es: "Revisa la configuración del agente e intenta generar de nuevo.",
  },
  "Operação do agente": { es: "Operación del agente" },
  "Modo de operação": { es: "Modo de operación" },
  "Assistido: revisar antes de enviar": { es: "Asistido: revisar antes de enviar" },
  "Automático: responder com as regras do agente": {
    es: "Automático: responder con las reglas del agente",
  },
  "Retomar automático": { es: "Reanudar automático" },
  "Pausar automático": { es: "Pausar automático" },
  "Automático pausado. A versão publicada foi preservada e a assistência continua disponível.": {
    es: "Automático pausado. La versión publicada se conservó y la asistencia sigue disponible.",
  },
  "O modo assistido prepara sugestões na conversa. Só a aprovação humana autoriza o envio.": {
    es: "El modo asistido prepara sugerencias en la conversación. Solo la aprobación humana autoriza el envío.",
  },
  "Recuperar agente legado": { es: "Recuperar agente anterior" },
  "Este agente precisa concluir a configuração para atender.": {
    es: "Este agente necesita completar la configuración para atender.",
  },
  "O prompt e o conhecimento serão preservados. Nenhuma permissão para alterar negócios ou agenda será adicionada.":
    {
      es: "Se conservarán las instrucciones y el conocimiento. No se añadirán permisos para cambiar negocios o calendario.",
    },
  "Já existe uma versão preservada. Revise, teste e publique pelo editor abaixo.": {
    es: "Ya existe una versión conservada. Revísala, pruébala y publícala con el editor de abajo.",
  },
  "Canal da recuperação": { es: "Canal de recuperación" },
  "Escolha um canal": { es: "Elige un canal" },
  "Credencial da recuperação": { es: "Credencial de recuperación" },
  "Chave da instalação (se configurada)": { es: "Clave de la instalación (si está configurada)" },
  "Conferindo configuração…": { es: "Comprobando configuración…" },
  "Conferir e publicar configuração preservada": {
    es: "Comprobar y publicar la configuración conservada",
  },
  "Mesmo motor e conhecimento do agente; nenhuma alteração é aplicada ao cliente.": {
    es: "Mismo motor y conocimiento del agente; no se aplica ningún cambio al cliente.",
  },
  "Estado do contato simulado. Canal, opt-out e contexto serão conferidos novamente antes de um envio real.":
    {
      es: "Estado del contacto simulado. El canal, la baja y el contexto se comprobarán de nuevo antes de un envío real.",
    },
  "Verificações da resposta": { es: "Comprobaciones de la respuesta" },
  "Provedor de teste controlado. O motor e as verificações são os mesmos; não há chamada a uma IA externa.":
    {
      es: "Proveedor de prueba controlado. El motor y las comprobaciones son los mismos; no se llama a una IA externa.",
    },
  "Responsáveis por número": { es: "Responsables por número" },
  "A capacidade e o horário de cada pessoa valem para todos os números. A distribuição automática respeita os responsáveis de cada canal.": { es: "La capacidad y el horario de cada persona se aplican a todos los números. La distribución automática respeta los responsables de cada canal." },
  "Conecte um número para escolher os responsáveis.": { es: "Conecta un número para elegir responsables." },
  "Usa todos os atendentes elegíveis da organização.": { es: "Usa todos los asesores elegibles de la organización." },
  "Ninguém configurado — as conversas ficarão na fila.": { es: "Nadie configurado: las conversaciones permanecerán en la cola." },
  "Somente as pessoas selecionadas recebem este número.": { es: "Solo las personas seleccionadas reciben este número." },
  "Nenhum atendente ativo na equipe.": { es: "No hay asesores activos en el equipo." },
  "Salvar responsáveis": { es: "Guardar responsables" },
  "Voltar ao padrão da organização": { es: "Volver al valor predeterminado de la organización" },
  "Responsáveis salvos.": { es: "Responsables guardados." },
  "Não foi possível salvar. Tente novamente.": { es: "No se pudo guardar. Inténtalo de nuevo." },
  "Atendente sem nome": { es: "Asesor sin nombre" },
  "Configurar responsáveis por número": { es: "Configurar responsables por número" },
  "Consulte os responsáveis em Atendimento.": { es: "Consulta los responsables en Atención." },
  "Detalhes para suporte": { es: "Detalles para soporte" },
  "Copiar detalhes": { es: "Copiar detalles" },
  "Conversa aguardando responsável": { es: "Conversación esperando responsable" },
  "Confira os responsáveis em Configurações → Atendimento.": { es: "Revisa los responsables en Configuración → Atención." },

  "Suas agendas Google": { es: "Tus calendarios de Google" },
  "Escolha quais agendas ocupam seus horários e onde publicar novos compromissos. Os já publicados permanecem na agenda original.": { es: "Elige qué calendarios ocupan tus horarios y dónde publicar las citas nuevas. Las que ya se publicaron se quedan en el calendario original." },
  "Carregando agendas…": { es: "Cargando calendarios…" },
  "Não foi possível carregar suas agendas.": { es: "No se pudieron cargar tus calendarios." },
  "Conecte sua conta pela Agenda": { es: "Conecta tu cuenta desde la Agenda" },
  "Atualizar lista e sincronização": { es: "Actualizar lista y sincronización" },
  "Conta como ocupado": { es: "Cuenta como ocupado" },
  "Destino dos novos compromissos": { es: "Destino de las nuevas citas" },
  "Leitura permitida. Esta agenda não está disponível para publicação.": { es: "Lectura permitida. Este calendario no está disponible para publicar." },
  "Esta permissão não oferece a leitura de eventos necessária. Revise o acesso no Google.": { es: "Este permiso no permite leer los eventos, y es necesario. Revisa el acceso en Google." },
  "Última sincronização": { es: "Última sincronización" },
  "Ainda não sincronizada": { es: "Aún no sincronizado" },
  "Leitura em andamento; a cobertura será confirmada ao terminar.": { es: "Lectura en curso; la cobertura se confirmará al terminar." },
  "Salvar agendas": { es: "Guardar calendarios" },
  "Sincronização Google": { es: "Sincronización con Google" },
  "Este compromisso precisa de uma decisão de sincronização.": { es: "Esta cita necesita una decisión de sincronización." },
  "Há alterações aguardando sincronização.": { es: "Hay cambios pendientes de sincronización." },
  "Alterações sincronizadas.": { es: "Cambios sincronizados." },
  "Ainda não publicado no Google.": { es: "Aún no publicado en Google." },
  "Aqui": { es: "Aquí" },
  "No Google": { es: "En Google" },
  "Evento indisponível ou incompatível": { es: "Evento no disponible o incompatible" },
  "A publicação também substituiria campos alterados no Google. Revise antes de continuar.": { es: "La publicación también reemplazaría campos modificados en Google. Revisa antes de continuar." },
  "Preservamos o histórico daqui. Revise o evento no Google ou crie outro compromisso pela Agenda.": { es: "Conservamos el historial de aquí. Revisa el evento en Google o crea otra cita desde la Agenda." },
  "Usar horário do Google": { es: "Usar horario de Google" },
  "Usar cancelamento do Google": { es: "Usar cancelación de Google" },
  "Publicar alteração daqui": { es: "Publicar el cambio de aquí" },
  "Manter horário daqui": { es: "Mantener el horario de aquí" },
  "Preservar campos do Google": { es: "Conservar campos de Google" },
  "Decisão registrada. O Google será relido antes de aplicar; mudanças novas exigem outra decisão.": { es: "Decisión registrada. Se volverá a consultar Google antes de aplicarla. Los cambios nuevos requieren otra decisión." },
  "Tentar sincronizar novamente": { es: "Reintentar sincronización" },
  "Configurar suas agendas": { es: "Configurar tus calendarios" },
  "Ocupação do Google ainda não verificada neste período.": { es: "La ocupación de Google aún no se ha verificado en este período." },
  "Marcar compromisso": {es:"Programar cita"},
  "Recuperação encerrada. Revise o próximo passo.": {es:"Recuperación finalizada. Revisa el siguiente paso."},
  "Acompanhamento encerrado sem novo envio": {es:"Seguimiento finalizado sin nuevo envío"},
  "Só começa após falta confirmada pela equipe. Remarcação, cancelamento ou nova resposta interrompem a recuperação. Outro acompanhamento ativo impede o início.": {es:"Solo inicia después de que el equipo confirme una ausencia. Si la cita se reprograma o se cancela, o si el cliente vuelve a responder, la recuperación se interrumpe. Si ya hay otro seguimiento activo, no se inicia."},
  "Tipos de compromisso (nenhum selecionado = todos)": {es:"Tipos de cita (ninguno seleccionado = todos)"},
  "Não foi possível carregar os tipos de compromisso.": {es:"No se pudieron cargar los tipos de cita."},
  // Agenda: presença confirmada pela equipe e recuperação.
  "Abrir compromisso": { es: "Abrir cita" },
  "Abra o compromisso e confirme a presença.": { es: "Abre la cita y confirma la asistencia." },
  "Confira o motivo e escolha o próximo passo no compromisso.": { es: "Revisa el motivo y elige el siguiente paso en la cita." },
  "Compromisso": { es: "Cita" },
  "Este compromisso está indisponível para você.": { es: "Esta cita no está disponible para ti." },
  "Compareceu": { es: "Asistió" },
  "Compromisso pessoal, sem cliente vinculado.": { es: "Cita personal, sin cliente vinculado." },
  "Presença registrada pela equipe": { es: "Asistencia registrada por el equipo" },
  "O horário sozinho não confirma falta. A equipe precisa registrar o que aconteceu.": { es: "La hora por sí sola no confirma una ausencia. El equipo debe registrar lo ocurrido." },
  "Falta confirmada. O resultado da recuperação ainda não está disponível.": { es: "Ausencia confirmada. El resultado de la recuperación todavía no está disponible." },
  "O compromisso mudou ou a alteração não foi concluída. Revise os dados antes de decidir novamente.": {es:"La cita cambió o la modificación no se completó. Revisa los datos antes de decidir de nuevo."},
  "Descartar rascunho e revisar": {es:"Descartar borrador y revisar"},
  "Recuperação iniciada": { es: "Recuperación iniciada" },
  "Não iniciada: outro acompanhamento já está ativo.": { es: "No iniciada: ya hay otro seguimiento activo." },
  "Não iniciada: mais de um fluxo foi configurado para esta falta.": { es: "No iniciada: hay más de un flujo configurado para esta ausencia." },
  "Não iniciada: configure um fluxo e habilite-o em um assistente publicado.": { es: "No iniciada: configura un flujo y habilítalo en un asistente publicado." },
  "Não iniciada: o atendimento ou a resposta do cliente mudou.": { es: "No iniciada: cambió la atención o la respuesta del cliente." },
  "Sem contato vinculado. Este compromisso não inicia uma recuperação.": { es: "Sin contacto vinculado. Esta cita no inicia una recuperación." },
  "Recuperação iniciada e interrompida porque o cliente respondeu.": { es: "Recuperación iniciada e interrumpida porque el cliente respondió." },
  "Revise o próximo passo.": { es: "Revisa el siguiente paso." },
  "Revisar acompanhamentos": { es: "Revisar seguimientos" },
  "Mensagem do cliente usada como evidência (opcional)": { es: "Mensaje del cliente usado como evidencia (opcional)" },
  "Mensagem de evidência": { es: "Mensaje de evidencia" },
  "Confirmação da equipe, sem mensagem": { es: "Confirmación del equipo, sin mensaje" },
  "Mensagem sem texto": { es: "Mensaje sin texto" },
  "Ao confirmar, você valida o significado da mensagem para este compromisso.": { es: "Al confirmar, validas el significado del mensaje para esta cita." },
  "Lembrar em uma hora": { es: "Recordar en una hora" },
  "Motivo do cancelamento": { es: "Motivo de cancelación" },
  "Confirmação de presença": { es: "Confirmación de asistencia" },
  "Depois do compromisso, peça confirmação à equipe. Sem confirmação, o sistema mantém a presença desconhecida e nunca presume falta.": { es: "Después de la cita, pide confirmación al equipo. Sin confirmación, la asistencia queda como desconocida y el sistema nunca da por hecha una ausencia." },
  "Pedir confirmação após o fim (minutos)": { es: "Pedir confirmación después del final (minutos)" },
  "Proteger de cobranças por silêncio após o fim (minutos)": { es: "Proteger de mensajes por silencio después del final (minutos)" },
  "Quando esse prazo acabar, a pendência continua visível. Outro compromisso vivo ainda protege o contato.": { es: "Al terminar este plazo, el pendiente sigue visible. Si el contacto tiene otra cita vigente, seguirá protegido." },
  "Salvar prazos": { es: "Guardar plazos" },
  "Prazos salvos.": { es: "Plazos guardados." },
  "Buscar cliente": { es: "Buscar cliente" },
  "Quem será atendido": { es: "Quién será atendido" },
  "Compromisso pessoal, sem cliente": { es: "Cita personal, sin cliente" },
  "Conversa vinculada (opcional)": { es: "Conversación vinculada (opcional)" },
  "Sem conversa vinculada": { es: "Sin conversación vinculada" },
  "Não foi possível carregar os vínculos. Tente novamente.": { es: "No se pudieron cargar los vínculos. Inténtalo de nuevo." },
  "Falta confirmada pela equipe": { es: "Ausencia confirmada por el equipo" },
  "Gatilho: falta confirmada pela equipe": { es: "Disparador: ausencia confirmada por el equipo" },
  "Presença não confirmada · revise o compromisso": { es: "Asistencia sin confirmar · revisa la cita" },
  "Confirme a presença · cobrança aguardando": { es: "Confirma la asistencia · mensaje en espera" },
  "Compromisso agendado · cobrança aguardando": { es: "Cita programada · mensaje en espera" },
  "Ver compromisso": { es: "Ver cita" },
  "Confirmar presença": { es: "Confirmar asistencia" },
  "Revisar recuperação": { es: "Revisar recuperación" },

  "Abrir conversa": { es: "Abrir conversación" },
  "Abrir negócio": { es: "Abrir negocio" },
  "Abrir acompanhamento": { es: "Abrir seguimiento" },
  "Revisar conexão": { es: "Revisar conexión" },
  "Revisar agente": { es: "Revisar agente" },
  "Testar ou revisar resposta": { es: "Probar o revisar respuesta" },
  "Abrir base de conhecimento": { es: "Abrir base de conocimiento" },
  "Abrir evolução do assistente": { es: "Abrir evolución del asistente" },
  "Revisar conexões": { es: "Revisar conexiones" },
  "Revisar provedores de IA": { es: "Revisar proveedores de IA" },
  "Revisar modelos do canal": { es: "Revisar plantillas del canal" },
  "Abrir uma conversa afetada": { es: "Abrir una conversación afectada" },
  "Abrir uso de IA": { es: "Abrir uso de IA" },
  "Abrir Radar": { es: "Abrir Radar" },
  "Peça a quem administra para revisar a conexão do WhatsApp.": { es: "Pide a quien administra que revise la conexión de WhatsApp." },
  "Confira o motivo deste aviso com quem administra antes de tentar a operação novamente.": { es: "Revisa el motivo de este aviso con quien administra antes de intentar la operación de nuevo." },
  "Peça a quem administra para conferir o processamento descrito neste aviso.": { es: "Pide a quien administra que revise el procesamiento descrito en este aviso." },
  "Peça ao gestor para revisar o limite e o uso de IA.": { es: "Pide al responsable que revise el límite y el uso de IA." },
  "Confira o atendimento descrito e combine quem assume o próximo passo.": { es: "Revisa la atención descrita y acuerda quién asume el siguiente paso." },
  "Na evolução do assistente, confira as propostas disponíveis. Este aviso não identifica uma proposta específica.": { es: "En la evolución del asistente, revisa las propuestas disponibles. Este aviso no identifica una propuesta específica." },
  "Na evolução do assistente, confira a avaliação de qualidade. Este aviso não identifica uma avaliação específica.": { es: "En la evolución del asistente, revisa la evaluación de calidad. Este aviso no identifica una evaluación específica." },
  "Peça ao gestor para revisar o acompanhamento que parou.": { es: "Pide al responsable que revise el seguimiento que se detuvo." },
  "Confira se cabe retomar o atendimento descrito neste aviso.": { es: "Revisa si corresponde retomar la atención descrita en este aviso." },
  "Confira os negócios do contato e escolha a qual deles pertence a próxima ação.": { es: "Revisa los negocios del contacto y elige a cuál pertenece la siguiente acción." },
  "Revise os negócios parados no Radar e defina o próximo passo.": { es: "Revisa los negocios detenidos en el Radar y define el siguiente paso." },
  "Revise no Radar se ainda cabe retomar os negócios indicados.": { es: "Revisa en el Radar si todavía corresponde retomar los negocios indicados." },
  "Peça ao gestor para revisar as ferramentas habilitadas para o assistente deste atendimento.": { es: "Pide al responsable que revise las herramientas habilitadas para el asistente de esta atención." },
  "Confira a resposta que não chegou antes de decidir se precisa enviar novamente.": { es: "Revisa la respuesta que no llegó antes de decidir si debes enviarla de nuevo." },
  "Peça ao gestor para revisar o provedor e as credenciais de leitura de fotos e áudios.": { es: "Pide al responsable que revise el proveedor y las credenciales para leer fotos y audios." },
  "Confira os modelos na conexão WhatsApp via Parceiro. Este aviso não identifica um modelo específico.": { es: "Revisa las plantillas en la conexión de WhatsApp vía proveedor asociado. Este aviso no identifica una plantilla específica." },
  "Peça a quem administra para revisar a situação do número nas conexões.": { es: "Pide a quien administra que revise la situación del número en las conexiones." },
  "Peça a quem administra para autorizar os números de teste em Conexões ou abrir o canal ao público.": { es: "Pide a quien administra que autorice los números de prueba en Conexiones o que abra el canal al público." },
  "Confira o compromisso descrito e defina quem fica responsável.": { es: "Revisa el compromiso descrito y define quién se hace responsable." },
  "A sugestão venceu. Se a informação ainda for relevante, confirme com o cliente antes de editar sua ficha.": { es: "La sugerencia venció. Si la información sigue siendo relevante, confírmala con el cliente antes de editar su ficha." },
  "Peça ao gestor para conferir o material e o motivo da falha na base de conhecimento.": { es: "Pide al responsable que revise el material y el motivo de la falla en la base de conocimiento." },
  "Confira a situação descrita neste aviso com a pessoa responsável.": { es: "Revisa la situación descrita en este aviso con la persona responsable." },
  "Este aviso não tem um contexto que possa ser aberto nesta versão.": { es: "Este aviso no tiene un contexto que pueda abrirse en esta versión." },
  "Este contexto não está disponível para você. Ele pode ter sido removido ou seu acesso pode ter mudado.": { es: "Este contexto no está disponible para ti. Puede que se haya eliminado o que tu acceso haya cambiado." },
  "Peça a quem administra para revisar este contexto.": { es: "Pide a quien administra que revise este contexto." },
  "Peça ao gestor para revisar este contexto.": { es: "Pide al responsable que revise este contexto." },
  "Seu acesso aos avisos não está disponível. Confira sua sessão e tente novamente.": { es: "Tu acceso a los avisos no está disponible. Revisa tu sesión e inténtalo de nuevo." },
  "Não foi possível atualizar os avisos. A lista abaixo pode estar desatualizada.": { es: "No se pudieron actualizar los avisos. La lista de abajo puede estar desactualizada." },
  "Não foi possível carregar os avisos. Tente novamente.": { es: "No se pudieron cargar los avisos. Inténtalo de nuevo." },
  "Não foi possível atualizar este aviso. Tente novamente.": { es: "No se pudo actualizar este aviso. Inténtalo de nuevo." },
  "Encerrar demanda": { es: "Cerrar caso" },
  "Desfecho registrado.": { es: "Resultado registrado." },
  "Não foi possível encerrar. Cancele esta edição e abra novamente para revisar o desfecho.": { es: "No se pudo cerrar. Cancela esta edición y vuelve a abrirla para revisar el resultado." },
  "Desfecho da demanda": { es: "Resultado del caso" },
  "Resolvida": { es: "Resuelto" },
  "Convertida": { es: "Convertido" },
  "Não procede": { es: "No procede" },
  "Encerrada pelo cliente": { es: "Cerrado por el cliente" },
  "Perdida": { es: "Perdido" },
  "Expirada sem resposta": { es: "Vencido sin respuesta" },
  "Registra o resultado desta demanda. As conversas dos outros canais permanecem disponíveis.": { es: "Registra el resultado de este caso. Las conversaciones de los otros canales siguen disponibles." },
  "Confirmar desfecho": { es: "Confirmar resultado" },
  "Demanda vigente neste canal": { es: "Caso vigente en este canal" },
  "Memória do contato": { es: "Memoria del contacto" },
  "Fatos duráveis registrados nas notas. Pendências pertencem à demanda vigente.": { es: "Hechos duraderos registrados en las notas. Los pendientes corresponden al caso vigente." },
  "Nenhum fato durável registrado.": { es: "No hay hechos duraderos registrados." },
  "Histórico encerrado — sem tarefas pendentes": { es: "Historial cerrado — sin tareas pendientes" },

  "Interface": { es: "Interfaz" },
  "Perfil de interface": { es: "Perfil de interfaz" },
  "Completa": { es: "Completa" },
  "Simplificada": { es: "Simplificada" },
  "Personalizada": { es: "Personalizada" },
  "Define quais áreas aparecem na navegação. As permissões continuam sendo determinadas pelo papel. Links de conversas e avisos podem abrir áreas autorizadas que estejam ocultas.": { es: "Define qué áreas aparecen en la navegación. Los permisos siguen dependiendo del rol. Los enlaces de conversaciones y avisos pueden abrir áreas autorizadas aunque estén ocultas." },
  "Trocar o perfil restaura sua seleção padrão. Perfil, segurança e acesso à equipe de quem administra continuam disponíveis.": { es: "Al cambiar el perfil se restaura la selección predeterminada. Quien administra sigue teniendo acceso a su perfil, a la seguridad y al equipo." },
  "A seleção contém áreas antigas. Confira e salve novamente.": { es: "La selección contiene áreas antiguas. Revísala y vuelve a guardar." },
  "Personalizar áreas visíveis": { es: "Personalizar áreas visibles" },
  " (personalizada)": { es: " (personalizada)" },
  "Selecione ao menos uma área de trabalho permitida ao papel.": { es: "Selecciona al menos un área de trabajo permitida para el rol." },
  "Interface atualizada.": { es: "Interfaz actualizada." },
  "Interface de": { es: "Interfaz de" },
  "membro": { es: "miembro" },
  "A alteração vale apenas nesta organização e aparece para o membro sem sair da conta.": { es: "El cambio solo aplica en esta organización y el miembro lo verá sin cerrar sesión." },
  "A seleção anterior contém áreas que não existem mais. Confira e salve novamente.": { es: "La selección anterior contiene áreas que ya no existen. Revísala y vuelve a guardar." },
  "Salvar interface": { es: "Guardar interfaz" },
  "Sua navegação foi atualizada. Você pode continuar nesta tela.": { es: "Se actualizó tu navegación. Puedes seguir en esta pantalla." },
  // ─── Cabeçalhos de grupo da barra lateral ───
  //
  // ⚠️ NUNCA TIVERAM TRADUÇÃO, e o defeito era invisível: `Sidebar.tsx:83` já
  // chamava `t(group.label)`, então o espanhol recebia os cabeçalhos em
  // português e nada ficava vermelho — `traduzir()` devolve a chave ausente
  // como está. Achado pelo cruzamento novo entre DICIONARIO e NAV_GROUPS.
  Atendimento: { es: "Atención" },
  CRM: { es: "CRM" },
  "Agente de IA": { es: "Agente de IA" },
  Canais: { es: "Canales" },
  Análise: { es: "Análisis" },
  Organização: { es: "Organización" },
  "Selecionar org": { es: "Seleccionar org" },
  "o dia todo": { es: "todo el día" },
  "Dias sem atendimento": { es: "Días sin atención" },
  "Feriado, férias, viagem. Nesses dias o sistema deixa de oferecer horários — e o que já estava marcado continua marcado, para você decidir o que fazer com cada um.": { es: "Días festivos, vacaciones, viajes. Esos días el sistema deja de ofrecer horarios. Las citas que ya estaban programadas se mantienen, para que decidas qué hacer con cada una." },
  "Ex.: feriado": { es: "Ej.: día festivo" },
  "Fechar este dia": { es: "Cerrar este día" },
  "Dias fora da rotina": { es: "Días fuera de la rutina" },
  "Feche um dia (feriado, férias, viagem) ou abra um dia que a sua jornada semanal não cobre. Em dia fechado o sistema deixa de oferecer horários, e o que já estava marcado continua marcado, para você decidir o que fazer com cada um.": { es: "Cierra un día (festivo, vacaciones, viaje) o abre uno que tu jornada semanal no cubre. En un día cerrado el sistema deja de ofrecer horarios, y las citas que ya estaban programadas se mantienen para que decidas qué hacer con cada una." },
  "O que fazer": { es: "Qué hacer" },
  "Fechar o dia": { es: "Cerrar el día" },
  "Abrir para atendimento": { es: "Abrir para atender" },
  "Das": { es: "Desde" },
  "Abrir este dia": { es: "Abrir este día" },
  "Repetir toda semana até (opcional)": { es: "Repetir cada semana hasta (opcional)" },
  "dia(s) gravado(s)": { es: "día(s) guardado(s)" },
  "já existia(m)": { es: "ya existía(n)" },
  "A hora final precisa ser maior que a inicial.": { es: "La hora final debe ser posterior a la inicial." },
  "Nenhum dia fora da rotina daqui para a frente.": { es: "No hay días fuera de la rutina a partir de hoy." },
  "Nenhum dia fechado daqui para a frente.": { es: "No hay días cerrados a partir de hoy." },
  "aberto excepcionalmente": { es: "abierto excepcionalmente" },
  "Abrir atendimento": { es: "Abrir atención" },
  "Abra o atendimento e diga o que fazer: concluir, pedir informação ao cliente ou passar para uma pessoa.": { es: "Abre la atención e indica qué hacer: concluirla, pedir información al cliente o pasarla a una persona." },
  "Um atendimento espera decisão da equipe": { es: "Una atención espera la decisión del equipo" },
  "Soltar o horário de um pedido não confirmado após (minutos)": { es: "Liberar el horario de una solicitud no confirmada después de (minutos)" },
  "Vale só para tipos de atendimento que pedem confirmação. Enquanto o pedido espera, o horário fica reservado e ninguém mais o pega; passado o prazo sem decisão, ele volta a ser oferecido. O cliente não é avisado, e o pedido continua na fila.": { es: "Solo aplica a los tipos de cita que requieren confirmación. Mientras la solicitud espera, el horario queda reservado y nadie más puede tomarlo. Si pasa el plazo sin una decisión, el horario vuelve a ofrecerse. El cliente no recibe aviso y la solicitud sigue en la fila." },
  Financeiro: { es: "Finanzas" },
  "Onde o dinheiro fica, como o cliente paga e como cada lançamento é classificado.": { es: "Dónde está el dinero, cómo paga el cliente y cómo se clasifica cada movimiento." },
  "Contas, formas de pagamento e como cada lançamento é classificado.": { es: "Cuentas, formas de pago y cómo se clasifica cada movimiento." },
  "conta removida": { es: "cuenta eliminada" },
  "Contas": { es: "Cuentas" },
  "Onde o dinheiro fica. O saldo que aparece nos relatórios é sempre somado dos lançamentos — o valor aqui é só o ponto de partida.": { es: "Dónde está el dinero. El saldo de los informes siempre se calcula sumando los movimientos; el valor que ingresas aquí es solo el punto de partida." },
  "Nome da conta": { es: "Nombre de la cuenta" },
  "Ex.: Caixa": { es: "Ej.: Caja" },
  "Tipo da conta": { es: "Tipo de cuenta" },
  "Caixa": { es: "Caja" },
  "Banco": { es: "Banco" },
  "Outra": { es: "Otra" },
  "Adicionar conta": { es: "Agregar cuenta" },
  "Nenhuma conta cadastrada.": { es: "No hay cuentas registradas." },
  "Formas de pagamento": { es: "Formas de pago" },
  "Como o cliente paga. A conta escolhida aqui é onde esse dinheiro entra quando a comanda é fechada.": { es: "Cómo paga el cliente. La cuenta que elijas aquí recibe ese dinero cuando se cierra la orden de servicio." },
  "Nome da forma de pagamento": { es: "Nombre de la forma de pago" },
  "Ex.: Pix": { es: "Ej.: Pix" },
  "Conta de destino": { es: "Cuenta de destino" },
  "Decidir depois": { es: "Decidir después" },
  "Adicionar forma": { es: "Agregar forma" },
  "Nenhuma forma de pagamento cadastrada.": { es: "No hay formas de pago registradas." },
  "sem conta definida": { es: "sin cuenta definida" },
  "Plano de contas": { es: "Plan de cuentas" },
  "Como cada lançamento é classificado. Entrada e saída são coisas diferentes.": { es: "Cómo se clasifica cada movimiento. Entrada y salida son cosas distintas." },
  "Nome do plano de contas": { es: "Nombre del plan de cuentas" },
  "Ex.: Serviços": { es: "Ej.: Servicios" },
  "Entrada ou saída": { es: "Entrada o salida" },
  "Entrada ou saída?": { es: "¿Entrada o salida?" },
  "Entrada": { es: "Entrada" },
  "Saída": { es: "Salida" },
  "Adicionar plano": { es: "Agregar plan" },
  "Nenhum plano de contas cadastrado.": { es: "No hay planes de cuentas registrados." },

  // ─── Navegação (a barra lateral, presente em toda tela) ───
  Inbox: { es: "Inbox" },
  Agenda: { es: "Agenda" },
  Radar: { es: "Radar" },
  "Respostas rápidas": { es: "Respuestas rápidas" },
  Contatos: { es: "Contactos" },
  // A CHAVE É O TEXTO PT-BR, então renomear um rótulo no registro de navegação
  // sem mexer aqui NÃO quebra teste nenhum — degrada em silêncio: `traduzir()`
  // devolve a chave ausente como português e o espanhol da barra lateral some.
  // "Kanban" saiu do menu (a tela virou "Funis"); "Etapas do funil" é o nome novo
  // da tela de configuração, que antes disputava "Funis" com ela.
  Funis: { es: "Embudos" },
  "Etapas do funil": { es: "Etapas del embudo" },
  "Tipos de agendamento": { es: "Tipos de cita" },
  Automação: { es: "Automatización" },
  Agentes: { es: "Agentes" },
  "Follow-ups": { es: "Seguimientos" },
  Roteadores: { es: "Enrutadores" },
  "Ver tudo em IA": { es: "Ver todo en IA" },
  "Ver tudo em CRM": { es: "Ver todo en CRM" },
  "Ver tudo em Análise": { es: "Ver todo en Análisis" },
  Conexões: { es: "Conexiones" },
  Webhooks: { es: "Webhooks" },
  Desempenho: { es: "Rendimiento" },
  "Evolução da IA": { es: "Evolución de la IA" },
  "Audit Log": { es: "Registro de auditoría" },
  Configurações: { es: "Configuración" },
  Recolher: { es: "Contraer" },
  Buscar: { es: "Buscar" },

  // ─── Inbox: filtros e lista ───
  "Nenhuma conversa com esses filtros": { es: "No hay conversaciones con esos filtros" },
  "Ativos:": { es: "Activos:" },
  "Busca": { es: "Búsqueda" },
  "Etiqueta": { es: "Etiqueta" },
  "Buscar por nome, telefone ou última mensagem…": {
    es: "Buscar por nombre, teléfono o último mensaje…",
  },
  "Buscar mensagens…": { es: "Buscar mensajes…" },
  "Todos os números": { es: "Todos los números" },
  "Todas as tags": { es: "Todas las etiquetas" },
  "Apenas não lidos": { es: "Solo no leídos" },
  "Não lidos": { es: "No leídos" },
  Fila: { es: "Cola" },
  Minhas: { es: "Mías" },
  Todas: { es: "Todas" },
  Fechadas: { es: "Cerradas" },
  // O estado `archived` é terminal como `closed`, mas conta outra coisa: é a
  // pasta do histórico. Sem entrada própria, a aba "Arquivadas" apareceria
  // traduzida como "Cerradas" para um operador hispanofalante.
  Arquivadas: { es: "Archivadas" },
  IA: { es: "IA" },
  "Sem mensagens": { es: "Sin mensajes" },
  "Nenhuma conversa": { es: "Sin conversaciones" },

  // ─── Inbox: cabeçalho e ações da conversa ───
  Assumir: { es: "Asumir" },
  Liberar: { es: "Liberar" },
  Transferir: { es: "Transferir" },
  Lembrar: { es: "Recordar" },
  Fechar: { es: "Cerrar" },
  "Devolver ao automático": { es: "Devolver al automático" },
  Aberta: { es: "Abierta" },
  Fechada: { es: "Cerrada" },
  "Em atendimento": { es: "En atención" },
  "Aguardando atendente": { es: "Esperando asesor" },
  "Automático atendendo": { es: "Automático atendiendo" },
  "Automático pausado": { es: "Automático pausado" },
  // Os motivos do silêncio (lib/inbox/comando-da-conversa.ts). "Automático
  // pausado" sozinho respondia a três situações que pedem ações diferentes:
  // alguém assumiu, o cliente inteiro está travado, ou foi pausa explícita.
  "Automático pausado — alguém assumiu": {
    es: "Automático pausado — alguien la asumió",
  },
  "Automático pausado para este cliente": {
    es: "Automático pausado para este cliente",
  },
  "Automático volta em instantes": { es: "El automático vuelve en unos instantes" },
  "Cliente pediu para não receber mensagens": { es: "El cliente pidió no recibir mensajes" },
  "Pausar o automático": { es: "Pausar el automático" },
  "Ver contato": { es: "Ver contacto" },

  // ─── Inbox: composer ───
  Responder: { es: "Responder" },
  "Nota interna": { es: "Nota interna" },
  "Escreva uma mensagem…": { es: "Escribe un mensaje…" },
  "Escreva uma nota interna… (só o time vê)": {
    es: "Escribe una nota interna… (solo la ve el equipo)",
  },
  Enviar: { es: "Enviar" },
  "Enviar modelo": { es: "Enviar plantilla" },
  "Escolha um modelo aprovado…": { es: "Elige una plantilla aprobada…" },

  // ─── Painel do contato ───
  CONTATO: { es: "CONTACTO" },
  "TAGS DA CONVERSA": { es: "ETIQUETAS DE LA CONVERSACIÓN" },
  "DEMANDAS ABERTAS": { es: "CASOS ABIERTOS" },
  "LEADS RECENTES": { es: "LEADS RECIENTES" },
  "PEDIDOS RECENTES": { es: "PEDIDOS RECIENTES" },
  ATIVIDADE: { es: "ACTIVIDAD" },
  "Sem tags.": { es: "Sin etiquetas." },
  "Sem leads.": { es: "Sin leads." },
  "Sem pedidos.": { es: "Sin pedidos." },
  "Sem atividade.": { es: "Sin actividad." },
  "Nova tag…": { es: "Nueva etiqueta…" },
  "Sem próximo passo definido": { es: "Sin siguiente paso definido" },
  "Marcar próximo passo": { es: "Definir siguiente paso" },
  Lead: { es: "Lead" },
  Tag: { es: "Etiqueta" },

  // ─── Kanban ───
  "Apenas atrasados": { es: "Solo atrasados" },
  "Sem responsável": { es: "Sin responsable" },
  "Editar campos": { es: "Editar campos" },
  "Linha do tempo": { es: "Línea de tiempo" },
  "DADOS DO NEGÓCIO": { es: "DATOS DEL NEGOCIO" },
  Título: { es: "Título" },
  Descrição: { es: "Descripción" },
  "Fechamento previsto": { es: "Cierre previsto" },
  "Tags (separadas por vírgula)": { es: "Etiquetas (separadas por coma)" },
  Salvar: { es: "Guardar" },
  vazio: { es: "vacío" },
  "Abrir conversa no Inbox": { es: "Abrir conversación en el Inbox" },

  // ─── Contatos ───
  "Buscar contatos…": { es: "Buscar contactos…" },
  Nome: { es: "Nombre" },
  Telefone: { es: "Teléfono" },
  "Nenhum contato": { es: "Sin contactos" },
  Bloqueado: { es: "Bloqueado" },

  // ─── Conexões ───
  "Números por QR": { es: "Números por QR" },
  "API Oficial (Meta)": { es: "API Oficial (Meta)" },
  "API oficial": { es: "API oficial" },
  "Provedor parceiro": { es: "Proveedor asociado" },
  Conexão: { es: "Conexión" },
  "Modelos do parceiro": { es: "Plantillas del proveedor" },
  "Templates da Meta": { es: "Plantillas de Meta" },
  Sincronizar: { es: "Sincronizar" },
  "Criar modelo": { es: "Crear plantilla" },
  Cancelar: { es: "Cancelar" },
  "Enviar para revisão": { es: "Enviar a revisión" },
  Reconectar: { es: "Reconectar" },
  Conectar: { es: "Conectar" },
  Desconectar: { es: "Desconectar" },
  "Fuso horário da janela": { es: "Zona horaria de la ventana" },

  // ─── Estados e avisos que aparecem em várias telas ───
  "Carregando…": { es: "Cargando…" },
  "Nenhum resultado": { es: "Sin resultados" },
  Erro: { es: "Error" },
  Excluir: { es: "Eliminar" },
  Editar: { es: "Editar" },
  Voltar: { es: "Volver" },
  // ─── Configurações: hub, perfil e tenant ───
  "Dados inválidos.": { es: "Datos inválidos." },
  "Perfil atualizado.": { es: "Perfil actualizado." },
  "Organização atualizada.": { es: "Organización actualizada." },
  "Salvando…": { es: "Guardando…" },
  "Nome completo": { es: "Nombre completo" },
  "Trocar email — em breve.": { es: "Cambiar email — próximamente." },
  "Fuso horário": { es: "Zona horaria" },
  "Avatar URL": { es: "URL de avatar" },
  "Upload de arquivo — em breve. Cole uma URL pública.": {
    es: "La carga de archivos llegará pronto. Pega una URL pública.",
  },
  "Nome de exibição": { es: "Nombre para mostrar" },
  "Razão social": { es: "Razón social" },
  "DPO email": { es: "Email del DPO" },
  "Retenção de mídia (dias)": { es: "Retención de archivos multimedia (días)" },
  "URL política de privacidade": { es: "URL de la política de privacidad" },
  "Informações pessoais. Email só pode ser trocado em breve.": {
    es: "Información personal. Pronto podrás cambiar el email.",
  },
  "Dados da empresa, retenção de mídia, DPO. Admin only.": {
    es: "Datos de la empresa, retención de archivos multimedia, DPO. Solo administradores.",
  },

  // ─── Hub de IA (NavHub: seções, rótulos e descrições) ───
  "Montar o agente": { es: "Configurar el agente" },
  "Ensinar o agente": { es: "Enseñar al agente" },
  "Acompanhar o agente": { es: "Supervisar al agente" },
  "Tudo que define quem atende por você — e como acompanhar o que ele faz.": {
    es: "Todo lo que define quién atiende por ti, y cómo dar seguimiento a lo que hace.",
  },
  "Quem atende por você: instruções, modelo, ferramentas e publicação.": {
    es: "Quién atiende por ti: instrucciones, modelo, herramientas y publicación.",
  },
  "Como o agente retoma uma conversa que esfriou, para nenhuma morrer no silêncio.": {
    es: "Cómo el agente retoma una conversación que se enfrió, para que ninguna muera en silencio.",
  },
  "Qual agente pega qual conversa, e quando o humano assume.": {
    es: "Qué agente toma cada conversación y cuándo interviene una persona.",
  },
  Credenciais: { es: "Credenciales" },
  "A chave do provedor de IA que os agentes usam para pensar.": {
    es: "La clave del proveedor de IA que los agentes usan para pensar.",
  },
  Provedores: { es: "Proveedores" },
  "Qual inteligência atende cada parte do sistema — e o que acontece se ela falhar.": {
    es: "Qué inteligencia atiende cada parte del sistema y qué ocurre si falla.",
  },
  Conhecimento: { es: "Conocimiento" },
  "Os materiais que o agente consulta antes de responder sobre o seu negócio.": {
    es: "Los materiales que el agente consulta antes de responder sobre tu negocio.",
  },
  Memória: { es: "Memoria" },
  "O que o agente já aprendeu sobre a sua operação e reaproveita.": {
    es: "Lo que el agente ya aprendió sobre tu operación y vuelve a utilizar.",
  },
  Skills: { es: "Skills" },
  "As ações que o agente pode executar sozinho durante o atendimento.": {
    es: "Las acciones que el agente puede ejecutar por sí solo durante la atención.",
  },
  "Os atendimentos que o agente conduziu, do início ao desfecho.": {
    es: "Las atenciones que llevó el agente, de principio a fin.",
  },
  "O que a IA encontrou e precisa de uma decisão sua.": {
    es: "Lo que encontró la IA y requiere tu decisión.",
  },
  Alertas: { es: "Alertas" },
  "Melhorias que a IA sugere para si mesma, esperando sua decisão.": {
    es: "Mejoras que la IA sugiere para sí misma y que esperan tu decisión.",
  },
  "O que a IA fez — e, quando falhou, o que aconteceu e o que fazer.": {
    es: "Lo que hizo la IA y, cuando falló, qué ocurrió y qué hacer.",
  },
  "Uso e orçamento": { es: "Uso y presupuesto" },
  "Quanto a IA consumiu e qual é o teto de gasto do mês.": {
    es: "Cuánto consumió la IA y cuál es el límite de gasto del mes.",
  },

  // ─── Hub do CRM (NavHub: seções e subtítulo) ───
  //
  // As duas seções são a régua que decide o menu, escrita por extenso: o que se
  // abre todo dia fica no sidebar, o que se define uma vez fica só no hub.
  "O dia a dia da venda": { es: "El día a día de la venta" },
  "Preparar a venda": { es: "Preparar la venta" },
  "Onde a venda acontece — e o que você define uma vez para ela funcionar.": {
    es: "Donde ocurre la venta — y lo que defines una vez para que funcione.",
  },

  // ─── Hub da Análise (NavHub: seções e subtítulo) ───
  //
  // As duas seções são a régua do menu escrita por extenso: o que se pergunta
  // toda semana fica no sidebar, o que se visita de propósito fica só no hub.
  "Os números do período": { es: "Los números del período" },
  "O histórico que se consulta": { es: "El historial que se consulta" },
  "Como o negócio foi no período — e o histórico para quando alguém perguntar por quê.": {
    es: "Cómo le fue al negocio en el período y el historial para cuando alguien pregunte por qué.",
  },

  // ─── Hub de Configurações (NavHub: seções, rótulos e descrições das cards) ───
  "Sua conta": { es: "Tu cuenta" },
  "Sua empresa": { es: "Tu empresa" },
  "Dados e acesso": { es: "Datos y acceso" },
  Segurança: { es: "Seguridad" },
  Notificações: { es: "Notificaciones" },
  Equipe: { es: "Equipo" },
  "Distribuição de atendimento": { es: "Distribución de atención" },
  "Sua conta, os dados da empresa e quem tem acesso ao quê.": {
    es: "Tu cuenta, los datos de la empresa y quién tiene acceso a qué.",
  },
  "Seu nome, idioma, fuso horário e avatar.": {
    es: "Tu nombre, idioma, zona horaria y avatar.",
  },
  "Verificação em duas etapas, códigos de recuperação e sessões.": {
    es: "Verificación en dos pasos, códigos de recuperación y sesiones.",
  },
  "Por onde e sobre o quê você quer ser avisado.": {
    es: "Por dónde y sobre qué quieres recibir avisos.",
  },
  "Quem trabalha aqui, com qual papel e quanta conversa cada um aguenta.": {
    es: "Quién trabaja aquí, con qué rol y cuántas conversaciones puede tomar cada uno.",
  },
  "Quem recebe cada cliente novo, e o que cada atendente enxerga.": {
    es: "Quién recibe cada cliente nuevo y qué ve cada asesor.",
  },
  "Dados da empresa, retenção de dados e encarregado de LGPD.": {
    es: "Datos de la empresa, retención de datos y encargado de LGPD.",
  },
  "O nome e a cor que sua empresa mostra dentro do sistema.": {
    es: "El nombre y el color que tu empresa muestra dentro del sistema.",
  },
  "Plano e cobrança.": { es: "Plan y facturación." },
  "Pedidos de exportação e exclusão de dados feitos por clientes.": {
    es: "Solicitudes de exportación y eliminación de datos hechas por clientes.",
  },
  "Chaves para outro sistema conversar com o seu CRM.": {
    es: "Claves para que otro sistema se comunique con tu CRM.",
  },
  // ─── Shell persistente (sidebar, topbar, ⌘K, menu do usuário) ───
  "Navegação principal": { es: "Navegación principal" },
  "Expandir sidebar": { es: "Expandir barra lateral" },
  "Recolher sidebar": { es: "Contraer barra lateral" },
  Versão: { es: "Versión" },
  versão: { es: "versión" },
  "Nova versão": { es: "Nueva versión" },
  disponível: { es: "disponible" },
  "Abrir navegação": { es: "Abrir navegación" },
  "Buscar telas": { es: "Buscar pantallas" },
  "Buscar telas do sistema…": { es: "Buscar pantallas del sistema…" },
  Telas: { es: "Pantallas" },
  // O gatilho da busca no topo mostra RETICENCIA ASCII desde antes do i18n
  // (`Buscar...`). A chave e o byte que a tela ja mostrava: trocar por "…"
  // aqui mudaria a tela de quem usa em portugues — que e o unico jeito de
  // esta feature piorar alguma coisa.
  "Buscar...": { es: "Buscar..." },
  // Rotulo so-para-leitor-de-tela do X de fechar em Dialog e Sheet. Ele esta
  // em INGLES no produto desde o shadcn, e continua: traduzi-lo mudaria o
  // portugues. Consertar o rotulo pt-BR e mudanca de UX, com PR proprio.
  Close: { es: "Cerrar" },
  "Menu do usuário": { es: "Menú del usuario" },
  Sair: { es: "Cerrar sesión" },
  "Central de avisos": { es: "Central de avisos" },
  "em aberto": { es: "abiertos" },
  // ─── Agentes de IA: lista ───
  "Agents de IA": { es: "Agentes de IA" },
  "Configure o comportamento dos agents que respondem no WhatsApp.": {
    es: "Configura el comportamiento de los agentes que responden en WhatsApp.",
  },
  "Nenhum agent configurado": { es: "Ningún agente configurado" },
  "Crie um agent para responder a conversas no WhatsApp com IA. Você configura prompt, tools, gatilhos e janela de contexto.": {
    es: "Crea un agente para responder conversaciones de WhatsApp con IA. Configuras el prompt, las herramientas, los disparadores y la ventana de contexto.",
  },
  "Novo agente": { es: "Nuevo agente" },
  "Nenhum agent corresponde aos filtros atuais.": {
    es: "Ningún agente coincide con los filtros actuales.",
  },
  "Buscar por nome…": { es: "Buscar por nombre…" },
  "Buscar agents": { es: "Buscar agentes" },
  "Filtrar por status": { es: "Filtrar por estado" },
  Status: { es: "Estado" },
  status: { es: "estado" },
  Todos: { es: "Todos" },
  Publicado: { es: "Publicado" },
  Rascunho: { es: "Borrador" },
  Pausado: { es: "Pausado" },
  Arquivado: { es: "Archivado" },
  Inválido: { es: "Inválido" },
  default: { es: "predeterminado" },
  "Incluir arquivados": { es: "Incluir archivados" },
  "Menu de ações": { es: "Menú de acciones" },
  Duplicar: { es: "Duplicar" },
  Renomear: { es: "Renombrar" },
  Despausar: { es: "Reanudar" },
  Pausar: { es: "Pausar" },
  Arquivar: { es: "Archivar" },
  "Agent duplicado.": { es: "Agente duplicado." },
  "Agent reativado.": { es: "Agente reanudado." },
  "Agent pausado.": { es: "Agente pausado." },
  "Agent arquivado.": { es: "Agente archivado." },
  Falha: { es: "Error" },
  "Erro ao executar ação.": { es: "Error al ejecutar la acción." },
  "O agent deixa de responder gatilhos e some das listas ativas. Versões publicadas são preservadas para auditoria. Não é possível desarquivar pela UI nesta versão.": {
    es: "El agente deja de responder a los disparadores y desaparece de las listas activas. Las versiones publicadas se conservan para auditoría. En esta versión no se puede desarchivar desde la interfaz.",
  },
  "Renomear agent": { es: "Renombrar agente" },
  "Apenas o nome interno muda. Versões publicadas e histórico são preservados.": {
    es: "Solo cambia el nombre interno. Las versiones publicadas y el historial se conservan.",
  },
  "Renomeado.": { es: "Renombrado." },
  "Modelo da versão publicada — é o que atende o cliente.": {
    es: "Modelo de la versión publicada: es el que atiende al cliente.",
  },
  "Modelo do cadastro; nenhuma versão publicada ainda.": {
    es: "Modelo del registro; todavía no hay versión publicada.",
  },
  Tipo: { es: "Tipo" },
  Prioridade: { es: "Prioridad" },
  Visualizar: { es: "Ver" },
  // ─── Agentes de IA: editor de detalhe (AgentForm) ───
  "Dê um nome para este agente.": { es: "Ponle un nombre a este agente." },
  "O nome pode ter até 120 caracteres.": { es: "El nombre puede tener hasta 120 caracteres." },
  "Escreva as instruções do agente (pelo menos uma frase).": {
    es: "Escribe las instrucciones del agente (al menos una frase).",
  },
  "As instruções têm": { es: "Las instrucciones tienen" },
  "caracteres, e o máximo é 20.000. Corte": {
    es: "caracteres, y el máximo es 20.000. Recorta",
  },
  "para conseguir salvar.": { es: "para poder guardar." },
  "Escolha o modelo de inteligência artificial.": {
    es: "Elige el modelo de inteligencia artificial.",
  },
  "Escolha a chave de acesso da empresa de inteligência artificial.": {
    es: "Elige la clave de acceso de la empresa de inteligencia artificial.",
  },
  "Esta instalação não tem chave de": { es: "Esta instalación no tiene clave de" },
  "Escolha outra empresa de IA ou cadastre uma chave.": {
    es: "Elige otra empresa de IA o registra una clave.",
  },
  "Escolha por qual número de WhatsApp ele atende.": {
    es: "Elige el número de WhatsApp con el que atiende.",
  },
  "Escolha por qual número de WhatsApp ele atende. O rascunho está salvo; conecte um número em Conexões e volte aqui para publicar.":
    {
      es: "Elige el número de WhatsApp con el que atiende. El borrador está guardado; conecta un número en Conexiones y vuelve aquí para publicar.",
    },
  "Nenhum número conectado ainda — o rascunho salva sem ele.": {
    es: "Aún no hay ningún número conectado. El borrador se guarda sin él.",
  },
  "Conectar WhatsApp": { es: "Conectar WhatsApp" },
  "para poder publicar.": { es: "para poder publicar." },
  "Escolha o número para poder publicar. Sem ele, o rascunho salva mas não atende.": {
    es: "Elige el número para poder publicar. Sin él, el borrador se guarda pero no atiende.",
  },
  "Máximo de": { es: "Máximo de" },
  "capacidades por agente.": { es: "capacidades por agente." },
  "Campo inválido.": { es: "Campo inválido." },
  "Salve o agent antes de publicar.": { es: "Guarda el agente antes de publicar." },
  "Sem rascunho para publicar.": { es: "No hay borrador para publicar." },
  "Resolva os erros do formulário.": { es: "Corrige los errores del formulario." },
  "Salve o rascunho antes de publicar.": { es: "Guarda el borrador antes de publicar." },
  Credencial: { es: "Credencial" },
  "ainda não validada": { es: "todavía no validada" },
  inválida: { es: "inválida" },
  "Número WhatsApp não está conectado (status:": {
    es: "El número de WhatsApp no está conectado (estado:",
  },
  "Formulário inválido.": { es: "Formulario inválido." },
  "salvo.": { es: "guardado." },
  "Validação falhou.": { es: "La validación falló." },
  "Agent criado.": { es: "Agente creado." },
  "Falha ao publicar:": { es: "Error al publicar:" },
  "publicada e ativa.": { es: "publicada y activa." },
  Novo: { es: "Nuevo" },
  "O rascunho v": { es: "El borrador v" },
  " é anterior a esta versão e foi superado por ela — ele continua no Histórico.": {
    es: " es anterior a esta versión y quedó superado por ella. Sigue en el Historial.",
  },
  "(rascunho v": { es: "(borrador v" },
  " superado)": { es: " superado)" },
  "· editando a v": { es: "· editando la v" },
  "Sem versão": { es: "Sin versión" },
  "Descartar alterações": { es: "Descartar cambios" },
  "Salvar rascunho": { es: "Guardar borrador" },
  "Criar agente": { es: "Crear agente" },
  "Publicar v": { es: "Publicar v" },
  Publicar: { es: "Publicar" },
  "Publicando…": { es: "Publicando…" },
  "Papéis do agente": { es: "Roles del agente" },
  "Conversa com o cliente": { es: "Conversa con el cliente" },
  "Organiza o sistema": { es: "Organiza el sistema" },
  "Confere antes de enviar": { es: "Revisa antes de enviar" },
  "Quem é este agente": { es: "Quién es este agente" },
  "Ordem de preferência (0 a 1000)": { es: "Orden de preferencia (0 a 1000)" },
  "Quando mais de um agente puder atender a mesma conversa, o de número maior tenta primeiro. Se você só tem um agente, pode deixar como está.": {
    es: "Si más de un agente puede atender la misma conversación, el de número mayor es el primero en intentarlo. Si solo tienes un agente, puedes dejarlo como está.",
  },
  "A inteligência que ele usa": { es: "La inteligencia que usa" },
  "Empresa de inteligência artificial": { es: "Empresa de inteligencia artificial" },
  "Credencial selecionada está com status": {
    es: "La credencial seleccionada tiene el estado",
  },
  ". Publish bloqueado até validar.": { es: ". Publicación bloqueada hasta validar." },
  "Por qual número ele atende": { es: "Con qué número atiende" },
  "Este agente é acionado pelo roteador": { es: "Este agente se activa mediante el enrutador" },
  "— o campo de número abaixo não se aplica.": {
    es: "— el campo de número de abajo no aplica.",
  },
  "Número conectado": { es: "Número conectado" },
  "Selecione um número": { es: "Selecciona un número" },
  "Nenhum número conectado": { es: "Ningún número conectado" },
  "Freios de segurança": { es: "Límites de seguridad" },
  "Ações por atendimento (1 a 25)": { es: "Acciones por atención (1 a 25)" },
  "Volume de texto por atendimento": { es: "Volumen de texto por atención" },
  "Custo máximo por atendimento (centavos)": { es: "Costo máximo por atención (centavos)" },
  "Mensagens anteriores que ele lê": { es: "Mensajes anteriores que lee" },
  "Tamanho máximo desse histórico": { es: "Tamaño máximo de ese historial" },
  "As instruções dele": { es: "Sus instrucciones" },
  "Estilo de resposta": { es: "Estilo de respuesta" },
  "Responder em várias mensagens curtas (como uma pessoa digita)": {
    es: "Responder en varios mensajes cortos (como escribe una persona)",
  },
  "Em vez de um bloco único, a resposta sai em bolhas separadas, espaçadas pelo mesmo ritmo anti-banimento do envio. O agente também é instruído a escrever em parágrafos curtos.": {
    es: "En lugar de un solo bloque, la respuesta sale en burbujas separadas, con el mismo ritmo anti-bloqueo que el envío. Además, el agente recibe la instrucción de escribir en párrafos cortos.",
  },
  "Tamanho máximo por bolha (80–4000)": { es: "Tamaño máximo por burbuja (80–4000)" },
  "O que o agente pode fazer": { es: "Lo que el agente puede hacer" },
  "Ligue por jornada de trabalho. O agente só consegue fazer o que estiver ligado aqui — e o que estiver ligado, ele fará sozinho durante o atendimento.": {
    es: "Actívalas por jornada de trabajo. El agente solo puede hacer lo que esté activado aquí, y lo que esté activado lo hará por sí solo durante la atención.",
  },
  "Quando ele entra em ação": { es: "Cuándo entra en acción" },
  "Passar para uma pessoa": { es: "Pasar a una persona" },
  "Deixar o agente chamar uma pessoa quando perceber que não é caso dele": {
    es: "Dejar que el agente llame a una persona cuando note que no le corresponde atender el caso",
  },
  "Pedir ajuda sem sair da conversa": { es: "Pedir ayuda sin salir de la conversación" },
  "Deixar o agente pedir uma tarefa a alguém e seguir conversando": {
    es: "Dejar que el agente pida una tarea a alguien y siga conversando",
  },
  "Diferente de passar a conversa: aqui o agente continua atendendo. Quando esbarra em algo que só uma pessoa resolve — aprovar um desconto, por exemplo — ele abre um pedido interno e retoma assim que for respondido.": {
    es: "A diferencia de transferir la conversación, aquí el agente sigue atendiendo. Si se topa con algo que solo una persona puede resolver, como aprobar un descuento, abre una solicitud interna y continúa en cuanto la responden.",
  },
  "Follow-up": { es: "Seguimiento" },
  "Retomar sozinho quem parou de responder, para o interessado não sumir sem ninguém perceber.": {
    es: "Retomar automáticamente el contacto con quien dejó de responder, para que ningún interesado desaparezca sin que nadie lo note.",
  },
  "Habilitar gatilhos automáticos de follow-up": {
    es: "Habilitar disparadores automáticos de seguimiento",
  },
  "Os fluxos abaixo só entram em ação para um cliente se este agente estiver publicado com follow-up habilitado.": {
    es: "Los flujos de abajo solo entran en acción para un cliente si este agente está publicado con el seguimiento habilitado.",
  },
  // ─── Agentes de IA: seletor de modelo, capacidades, credencial, handoff ───
  Modelo: { es: "Modelo" },
  "Selecione um modelo": { es: "Selecciona un modelo" },
  "Digite o identificador do modelo": { es: "Escribe el identificador del modelo" },
  "Nenhum modelo disponível": { es: "Ningún modelo disponible" },
  "Nenhuma capacidade disponível ainda para esta jornada.": {
    es: "Todavía no hay capacidades disponibles para esta jornada.",
  },
  "capacidade ligada": { es: "capacidad activada" },
  "capacidades ligadas": { es: "capacidades activadas" },
  de: { es: "de" },
  "Carregando as capacidades…": { es: "Cargando las capacidades…" },
  "Não foi possível carregar as capacidades. Recarregue a página.": {
    es: "No se pudieron cargar las capacidades. Recarga la página.",
  },
  "Limite atingido. Desligue algo para ligar outra coisa.": {
    es: "Alcanzaste el límite. Desactiva algo para activar otra cosa.",
  },
  "Acima disso o agente erra na hora de escolher o que usar.": {
    es: "Por encima de esto, el agente se equivoca al elegir qué usar.",
  },
  "Ligar este pacote passaria de": { es: "Activar este paquete pasaría de" },
  "capacidades (faltam": { es: "capacidades (faltan" },
  vaga: { es: "cupo" },
  vagas: { es: "cupos" },
  "). Desligue um pacote que você usa menos antes.": {
    es: "). Antes, desactiva un paquete que uses menos.",
  },
  "Você já ligou": { es: "Ya activaste" },
  "capacidades. Desligue uma antes de ligar outra.": {
    es: "capacidades. Desactiva una antes de activar otra.",
  },
  "Só ligando uma a uma — o pacote não liga por você:": {
    es: "Solo se pueden activar una por una. El paquete no las activa por ti:",
  },
  "Esconder a lista completa": { es: "Ocultar la lista completa" },
  "Escolher uma a uma (modo avançado)": { es: "Elegir una por una (modo avanzado)" },
  "Cada linha é uma capacidade. O nome em cinza é como ela aparece para quem integra o sistema por fora.": {
    es: "Cada línea es una capacidad. El nombre en gris es el que ve quien integra el sistema desde fuera.",
  },
  "Uma capacidade ligada não existe mais": { es: "Una capacidad activada ya no existe" },
  "capacidades ligadas não existem mais": { es: "capacidades activadas ya no existen" },
  "nesta versão do sistema (": { es: "en esta versión del sistema (" },
  "). Elas continuam salvas, mas o agente não consegue usá-las.": {
    es: "). Siguen guardadas, pero el agente no puede usarlas.",
  },
  Desligar: { es: "Desactivar" },
  "essa capacidade": { es: "esa capacidad" },
  "essas capacidades": { es: "esas capacidades" },
  parcial: { es: "parcial" },
  "Chave de acesso": { es: "Clave de acceso" },
  "Escolha uma chave": { es: "Elige una clave" },
  "A chave desta instalação": { es: "La clave de esta instalación" },
  validada: { es: "validada" },
  validando: { es: "validando" },
  "não validada": { es: "no validada" },
  inativa: { es: "inactiva" },
  "Nenhuma credencial": { es: "Ninguna credencial" },
  cadastrada: { es: "registrada" },
  "Cadastrar credencial": { es: "Registrar credencial" },
  "na aba Credenciais.": { es: "en la pestaña Credenciales." },
  "Palavras que chamam uma pessoa na hora": { es: "Palabras que llaman a una persona al instante" },
  Remover: { es: "Quitar" },
  "Sem palavras-chave.": { es: "Sin palabras clave." },
  "Digite uma expressão e aperte Enter": { es: "Escribe una expresión y presiona Enter" },
  Adicionar: { es: "Agregar" },
  // ─── Agentes de IA: funis do agente, fluxos de follow-up ───
  "Em que negócios ele pode mexer": { es: "En qué negocios puede intervenir" },
  "Marque os funis que este assistente cuida. Ele conversa com qualquer cliente, mas só move, edita ou encerra negócio dos funis marcados aqui.": {
    es: "Marca los embudos que este asistente gestiona. Conversa con cualquier cliente, pero solo mueve, edita o cierra negocios de los embudos marcados aquí.",
  },
  "Você ainda não tem nenhum funil. Crie um em Funis para poder liberar o assistente.": {
    es: "Todavía no tienes ningún embudo. Crea uno en Embudos para poder habilitar al asistente.",
  },
  "(é para cá que vão as conversas novas)": {
    es: "(aquí es donde van las conversaciones nuevas)",
  },
  "— ele não sabe organizar este funil ainda": {
    es: "— todavía no sabe organizar este embudo",
  },
  "Sem nenhum funil marcado, ele conversa com os clientes normalmente, mas não mexe em negócio nenhum — nem move, nem encerra, nem marca.": {
    es: "Sin ningún embudo marcado, conversa con los clientes con normalidad, pero no interviene en ningún negocio — no mueve, no cierra, no marca.",
  },
  "Você marcou": { es: "Marcaste" },
  ", mas ninguém disse ao assistente o que cada etapa desse funil significa — ele vai atender e deixar os negócios parados onde estão.": {
    es: ", pero nadie le ha explicado al asistente qué significa cada etapa de ese embudo. Atenderá y dejará los negocios parados donde están.",
  },
  "funis em que ninguém disse ao assistente o que cada etapa significa — ele vai atender e deixar os negócios parados onde estão.": {
    es: "embudos en los que nadie le ha explicado al asistente qué significa cada etapa. Atenderá y dejará los negocios parados donde están.",
  },
  " Isso se configura em Configurações › Funis.": {
    es: " Esto se configura en Configuración › Embudos.",
  },
  "As conversas novas viram negócio em": {
    es: "Las conversaciones nuevas se convierten en negocio en",
  },
  ", que não está marcado. O assistente vai atender e os negócios vão se acumular ali sem que ele possa organizá-los.": {
    es: ", que no está marcado. El asistente atenderá y los negocios se acumularán ahí sin que pueda organizarlos.",
  },
  "Carregando fluxos publicados…": { es: "Cargando flujos publicados…" },
  "Erro ao carregar fluxos.": { es: "Error al cargar los flujos." },
  "Nenhum fluxo publicado ainda.": { es: "Todavía no hay ningún flujo publicado." },
  "Publique um fluxo de follow-up": { es: "Publica un flujo de seguimiento" },
  "para vinculá-lo.": { es: "para vincularlo." },
  "Fluxos publicados": { es: "Flujos publicados" },
  "Máximo de 20 fluxos por agent.": { es: "Máximo de 20 flujos por agente." },
  // ─── Agentes de IA: gatilhos e painel de segurança ───
  "O que faz ele responder": { es: "Qué hace que responda" },
  "Uma mensagem nova do cliente": { es: "Un mensaje nuevo del cliente" },
  "Não responder em grupos": { es: "No responder en grupos" },
  "Não responder às mensagens que saem do seu próprio número": {
    es: "No responder a los mensajes que salen de tu propio número",
  },
  "Só responder quando a mensagem falar de algo específico (opcional)": {
    es: "Responder solo cuando el mensaje trate de algo específico (opcional)",
  },
  "Ex.: pedido|status|orçamento": { es: "Ej.: pedido|estado|cotización" },
  "Deixe em branco para o agente responder a tudo. Se preencher, ele só entra quando a mensagem contiver uma dessas palavras — separe por barra vertical (|). Aceita expressão regular, para quem já conhece.": {
    es: "Déjalo en blanco para que el agente responda a todo. Si lo llenas, solo responderá cuando el mensaje contenga alguna de esas palabras. Sepáralas con una barra vertical (|). Acepta expresiones regulares, para quien ya las conozca.",
  },
  "Quantos atendimentos ao mesmo tempo": { es: "Cuántas atenciones al mismo tiempo" },
  "Um de cada vez por conversa": { es: "Una a la vez por conversación" },
  "Um de cada vez por cliente": { es: "Una a la vez por cliente" },
  "Só atender em horário de funcionamento": { es: "Atender solo en horario de funcionamiento" },
  "Só enviar follow-up nestes horários": { es: "Enviar seguimientos solo en estos horarios" },
  Início: { es: "Inicio" },
  Fim: { es: "Fin" },
  Dias: { es: "Días" },
  Dom: { es: "Dom" },
  Seg: { es: "Lun" },
  Ter: { es: "Mar" },
  Qua: { es: "Mié" },
  Qui: { es: "Jue" },
  Sex: { es: "Vie" },
  Sáb: { es: "Sáb" },
  "Isto não se desliga.": { es: "Esto no se puede desactivar." },
  "carregando…": { es: "cargando…" },
  Ligada: { es: "Activada" },
  Desligada: { es: "Desactivada" },
  "— vem da configuração do servidor": { es: "— viene de la configuración del servidor" },
  "Ligada por você": { es: "Activada por ti" },
  "Desligada por você": { es: "Desactivada por ti" },
  Custa: { es: "Cuesta" },
  ". O modelo usado se escolhe em": { es: ". El modelo usado se elige en" },
  "Provedores de IA": { es: "Proveedores de IA" },
  "Modelo padrão": { es: "Modelo predeterminado" },
  "Vale em todo ponto que você não configurou individualmente — hoje,": {
    es: "Se aplica a todos los puntos que no configuraste por separado — hoy,",
  },
  "Trocar aqui muda todos eles de uma vez.": {
    es: "Si lo cambias aquí, cambian todos a la vez.",
  },
  "Salvar padrão": { es: "Guardar predeterminado" },
  "O padrão agora é": { es: "El predeterminado ahora es" },
  "pontos precisam de um modelo especialista (embedding ou áudio) e não seguem este padrão — configure cada um abaixo:": {
    es: "puntos necesitan un modelo especializado (embedding o audio) y no siguen el predeterminado. Configura cada uno abajo:",
  },
  "Antes de cada mensagem sair": { es: "Antes de que cada mensaje salga" },
  "O assistente escreve, e o sistema confere. São": {
    es: "El asistente escribe, y el sistema revisa. Son",
  },
  "verificações, nesta ordem — a primeira que barra interrompe as seguintes, e o assistente recebe de volta o motivo para reescrever.": {
    es: "verificaciones, en este orden. Si una bloquea el mensaje, las siguientes ya no se ejecutan y el asistente recibe el motivo para reescribirlo.",
  },
  "Antes de o assistente ler": { es: "Antes de que el asistente lea" },
  "Esta roda sobre a mensagem que chega, antes das outras — por isso aparece separada.": {
    es: "Esta se aplica al mensaje que llega, antes que las demás. Por eso aparece por separado.",
  },
  // ─── Agentes de IA: papel Operador, propostas, diálogo de publicação ───
  "Nenhuma conversa passou por aqui nos últimos": {
    es: "Ninguna conversación pasó por aquí en los últimos",
  },
  "dias. Assim que o assistente atender alguém, o que ele organizar aparece nesta área.": {
    es: "días. En cuanto el asistente atienda a alguien, lo que organice aparece en esta área.",
  },
  "Como está indo (últimos": { es: "Cómo va (últimos" },
  "dias)": { es: "días)" },
  "Organizou o sistema em": { es: "Organizó el sistema en" },
  "conversas.": { es: "conversaciones." },
  De: { es: "De" },
  "promessas feitas ao cliente,": { es: "promesas hechas al cliente," },
  "ficaram com um responsável": { es: "quedaron con un responsable" },
  " — e ": { es: " — y " },
  " não.": { es: " no." },
  "Elas aparecem na Central de avisos, uma por conversa.": {
    es: "Aparecen en la Central de avisos, una por conversación.",
  },
  Em: { es: "En" },
  "delas o assistente tinha algo a registrar e nenhuma capacidade marcada para isso — o que resolve é marcar abaixo o que ele pode fazer.": {
    es: "de ellas el asistente tenía algo que registrar, pero no tenía marcada ninguna capacidad para hacerlo. Se resuelve marcando abajo lo que puede hacer.",
  },
  "Deixar o agente organizar o sistema depois de cada conversa": {
    es: "Dejar que el agente organice el sistema después de cada conversación",
  },
  "Quem conversa com o cliente é uma coisa; quem mantém o sistema em dia é outra. Separar os dois evita que o assistente comente com o cliente o que está fazendo por dentro — e é o que faz ele realmente registrar, em vez de só responder bem.": {
    es: "Una cosa es conversar con el cliente y otra mantener el sistema al día. Separarlas evita que el asistente le cuente al cliente lo que hace por dentro, y hace que realmente registre la información en lugar de solo responder bien.",
  },
  "Com isto desligado:": { es: "Con esto desactivado:" },
  "o assistente continua atendendo e o básico continua sendo registrado sozinho — a etapa do cliente, o retorno que ele prometeu e o histórico da conversa.": {
    es: "el asistente sigue atendiendo y lo básico se registra solo: la etapa del cliente, el seguimiento que prometió y el historial de la conversación.",
  },
  "O que ele deixa de fazer é": { es: "Lo que deja de hacer es" },
  "decidir sobre a operação": { es: "decidir sobre la operación" },
  ": abrir chamados, distribuir para a pessoa certa, organizar marcadores e etapas. Isso passa a ser trabalho de alguém do time.": {
    es: ": abrir casos, asignarlos a la persona correcta, organizar etiquetas y etapas. Eso pasa a ser trabajo de alguien del equipo.",
  },
  "A inteligência que ele usa para organizar": { es: "La inteligencia que usa para organizar" },
  "Pode ser diferente da que conversa. Organizar o sistema é uma tarefa mais mecânica que atender uma pessoa — costuma sair bem com um modelo mais barato.": {
    es: "Puede ser diferente de la que conversa. Organizar el sistema es una tarea más mecánica que atender a una persona — suele funcionar bien con un modelo más barato.",
  },
  "A mesma que conversa": { es: "La misma que conversa" },
  "Usar a mesma que conversa": { es: "Usar la misma que conversa" },
  "O que ele pode mexer no sistema": { es: "Lo que puede modificar en el sistema" },
  "Esta lista é só deste papel — nada aqui é usado enquanto ele conversa com o cliente. Ligue por jornada de trabalho.": {
    es: "Esta lista es solo de este rol: nada de aquí se usa mientras conversa con el cliente. Activa las opciones según cada jornada de trabajo.",
  },
  "Sem nada marcado, ele ainda avisa você quando o assistente prometer algo a um cliente e ninguém cumprir — mas não consegue resolver sozinho.": {
    es: "Sin nada marcado, aun así te avisa cuando el asistente le prometa algo a un cliente y nadie lo cumpla, pero no puede resolverlo por sí solo.",
  },
  "Regra de playbook": { es: "Regla de playbook" },
  "Caso exemplar": { es: "Caso ejemplar" },
  "Gatilho de reengajamento": { es: "Disparador de reactivación" },
  "Memória da organização": { es: "Memoria de la organización" },
  "Proposta aplicada como memória da organização.": {
    es: "Propuesta aplicada como memoria de la organización.",
  },
  "Proposta aplicada como versão nova do agente.": {
    es: "Propuesta aplicada como versión nueva del agente.",
  },
  "Não foi possível aplicar a proposta.": { es: "No se pudo aplicar la propuesta." },
  "Nenhuma proposta ainda": { es: "Todavía no hay propuestas" },
  "O assistente aprende com as conversas reais e propõe melhorias aqui. Você decide o que entra — nada é aplicado sozinho.": {
    es: "El asistente aprende de las conversaciones reales y propone mejoras aquí. Tú decides qué entra; nada se aplica solo.",
  },
  aplicada: { es: "aplicada" },
  pendente: { es: "pendiente" },
  proposta: { es: "propuesta" },
  "Aplicar como memória da org": { es: "Aplicar como memoria de la org" },
  "Aplicar como versão nova": { es: "Aplicar como versión nueva" },
  "Esta versão se tornará a ativa no atendimento. A versão atual (": {
    es: "Esta versión será la activa en la atención. La versión actual (",
  },
  ") será marcada como superseded.": { es: ") quedará marcada como reemplazada." },
  nenhuma: { es: "ninguna" },
  "Provider:": { es: "Proveedor:" },
  "Modelo:": { es: "Modelo:" },
  "Tools adicionadas:": { es: "Herramientas agregadas:" },
  "Tools removidas:": { es: "Herramientas eliminadas:" },
  "Prompt:": { es: "Prompt:" },
  chars: { es: "caracteres" },
  "sem alteração": { es: "sin cambios" },
  // ─── Agentes de IA: execuções e trace ───
  Execução: { es: "Ejecución" },
  Iniciado: { es: "Iniciado" },
  Concluído: { es: "Concluido" },
  "Tokens (in/out)": { es: "Tokens (entrada/salida)" },
  Custo: { es: "Costo" },
  Latência: { es: "Latencia" },
  Steps: { es: "Pasos" },
  error: { es: "error" },
  "Ver conversa": { es: "Ver conversación" },
  "Ver inbound": { es: "Ver mensaje entrante" },
  Trace: { es: "Traza" },
  "Selecione uma execução.": { es: "Selecciona una ejecución." },
  "Sem trace disponível.": { es: "Sin traza disponible." },
  "(sem nome)": { es: "(sin nombre)" },
  erro: { es: "error" },
  Args: { es: "Argumentos" },
  Result: { es: "Resultado" },
  Error: { es: "Error" },
  "Mensagem que SERIA enviada": { es: "Mensaje que SE enviaría" },
  "Sem tool calls (resposta direta do LLM).": {
    es: "Sin llamadas a herramientas (respuesta directa del LLM).",
  },
  "execuções recentes": { es: "ejecuciones recientes" },
  "Atualizando…": { es: "Actualizando…" },
  Atualizar: { es: "Actualizar" },
  "Erro ao carregar execuções.": { es: "Error al cargar las ejecuciones." },
  Ações: { es: "Acciones" },
  "Nenhuma execução ainda.": { es: "Todavía no hay ejecuciones." },
  teste: { es: "prueba" },
  produção: { es: "producción" },
  Detalhes: { es: "Detalles" },
  // ─── Agentes de IA: painel de teste ───
  "A resposta não usa palavras internas do sistema.": {
    es: "La respuesta no usa palabras internas del sistema.",
  },
  "Esta resposta usa palavras que o cliente não deveria ver.": {
    es: "Esta respuesta usa palabras que el cliente no debería ver.",
  },
  "Em produção ela seria barrada e o assistente teria que reescrever. Encontrado:": {
    es: "En producción se bloquearía y el asistente tendría que reescribirla. Encontrado:",
  },
  "O teste não consegue verificar tudo (": { es: "La prueba no puede verificarlo todo (" },
  "verificações ficam de fora)": { es: "verificaciones quedan afuera)" },
  "Estas só acontecem numa conversa real, com um cliente de verdade do outro lado. Para ver a lista inteira do que é conferido — e o que cada verificação protege — abra a aba": {
    es: "Estas solo se ejecutan en una conversación real, con un cliente de verdad al otro lado. Para ver la lista completa de lo que se revisa y qué protege cada verificación, abre la pestaña",
  },
  "Configure e salve uma versão antes de testar.": {
    es: "Configura y guarda una versión antes de probar.",
  },
  "(publicada)": { es: "(publicada)" },
  "(rascunho)": { es: "(borrador)" },
  "Informe uma mensagem de teste.": { es: "Ingresa un mensaje de prueba." },
  "Teste executado.": { es: "Prueba ejecutada." },
  "Erro inesperado.": { es: "Error inesperado." },
  "Versão alvo": { es: "Versión de destino" },
  "⚠ Modo teste consome créditos do provider.": {
    es: "⚠ El modo de prueba consume créditos del proveedor.",
  },
  "Nenhuma mensagem é enviada via WhatsApp. O run é registrado como dry-run.": {
    es: "No se envía ningún mensaje por WhatsApp. La ejecución se registra como dry-run.",
  },
  "Mensagem do cliente (sample)": { es: "Mensaje del cliente (ejemplo)" },
  "Oi, quanto custa X?": { es: "Hola, ¿cuánto cuesta X?" },
  "Nome (opcional)": { es: "Nombre (opcional)" },
  "Telefone (opcional)": { es: "Teléfono (opcional)" },
  "Executando…": { es: "Ejecutando…" },
  "Executar teste": { es: "Ejecutar prueba" },
  Resultado: { es: "Resultado" },
  "Nenhum teste executado ainda.": { es: "Todavía no se ejecutó ninguna prueba." },
  "Executando dry-run…": { es: "Ejecutando dry-run…" },
  "Stub: o runtime real é entregue na S-13.08. O trace abaixo é simulado.": {
    es: "Stub: el runtime real se entrega en S-13.08. La traza de abajo es simulada.",
  },
  "Tokens in/out": { es: "Tokens entrada/salida" },
  "Custo (cents)": { es: "Costo (centavos)" },
  // ─── Agentes de IA: diff e histórico de versões, uso das capacidades ───
  Provider: { es: "Proveedor" },
  Model: { es: "Modelo" },
  Canal: { es: "Canal" },
  Configuração: { es: "Configuración" },
  Tools: { es: "Herramientas" },
  "Handoff keywords": { es: "Palabras clave de transferencia" },
  "System prompt": { es: "Prompt del sistema" },
  "Sem mudanças.": { es: "Sin cambios." },
  Campo: { es: "Campo" },
  Adicionadas: { es: "Agregadas" },
  Removidas: { es: "Eliminadas" },
  "Habilitado:": { es: "Habilitado:" },
  "Fluxos adicionados": { es: "Flujos agregados" },
  "Fluxos removidos": { es: "Flujos eliminados" },
  "Nenhuma versão criada ainda.": { es: "Todavía no se creó ninguna versión." },
  "Não há outra versão para comparar.": { es: "No hay otra versión para comparar." },
  "Revertido para versão equivalente a v": { es: "Revertido a una versión equivalente a v" },
  " (publicada como v": { es: " (publicada como v" },
  Substituída: { es: "Reemplazada" },
  "publicada em": { es: "publicada el" },
  "Diff v": { es: "Comparar v" },
  " ↔ v": { es: " ↔ v" },
  Diff: { es: "Comparar" },
  Reverter: { es: "Revertir" },
  "Reverter para v": { es: "Revertir a v" },
  "Uma nova versão idêntica a v": { es: "Se creará una versión idéntica a v" },
  " será criada e publicada imediatamente. A versão atualmente publicada vira superseded.": {
    es: " y se publicará de inmediato. La versión actualmente publicada queda reemplazada.",
  },
  "Revertendo…": { es: "Revirtiendo…" },
  "Confirmar revert": { es: "Confirmar reversión" },
  "falhando sempre": { es: "falla siempre" },
  falhas: { es: "fallas" },
  "usada sem estar ligada": { es: "usada sin estar activada" },
  "nunca usada": { es: "nunca usada" },
  "ligada agora": { es: "activada ahora" },
  "só em teste": { es: "solo en prueba" },
  funcionando: { es: "funcionando" },
  "que você está editando": { es: "que estás editando" },
  "que está no ar": { es: "que está activa" },
  antiga: { es: "antigua" },
  "Carregando o uso das capacidades…": { es: "Cargando el uso de las capacidades…" },
  "Não foi possível carregar o uso das capacidades.": {
    es: "No se pudo cargar el uso de las capacidades.",
  },
  uso: { es: "uso" },
  usos: { es: "usos" },
  "nos últimos": { es: "en los últimos" },
  dias: { es: "días" },
  falha: { es: "falla" },
  "capacidade pede uma decisão sua": { es: "capacidad necesita tu decisión" },
  "capacidades pedem uma decisão sua": { es: "capacidades necesitan tu decisión" },
  "Nada pedindo decisão no momento.": { es: "Nada requiere tu decisión por ahora." },
  " O que está ligado vem da versão": { es: " Lo que está activado viene de la versión" },
  "Este agente ainda não tem nenhuma capacidade ligada, e nenhuma foi usada. Ligue o que ele pode fazer na aba Configuração.": {
    es: "Este agente todavía no tiene capacidades activadas ni ha usado ninguna. Activa lo que puede hacer en la pestaña Configuración.",
  },
  desligada: { es: "desactivada" },
  "em teste": { es: "en prueba" },
  "última vez": { es: "última vez" },
  nunca: { es: "nunca" },
  // ─── Agentes de IA: abas do editor ───
  Teste: { es: "Prueba" },
  Capacidades: { es: "Capacidades" },
  Execuções: { es: "Ejecuciones" },
  Histórico: { es: "Historial" },
  Propostas: { es: "Propuestas" },
  // ─── Follow-up: lista de fluxos ───
  "Fluxos automáticos de reengajamento — silêncio, mudança de etapa ou fim de conversa disparam mensagens sem intervenção manual.": {
    es: "Flujos automáticos para retomar el contacto. Un silencio, un cambio de etapa o el fin de la conversación envían mensajes sin intervención manual.",
  },
  Fluxos: { es: "Flujos" },
  "Novo fluxo": { es: "Nuevo flujo" },
  "Nenhum fluxo de follow-up ainda": { es: "Todavía no hay ningún flujo de seguimiento" },
  "Follow-ups reengajam contatos automaticamente após silêncio, mudança de etapa ou fim de conversa — sem depender de alguém lembrar de mandar mensagem.": {
    es: "Los seguimientos retoman el contacto de forma automática tras un silencio, un cambio de etapa o el fin de la conversación, sin depender de que alguien se acuerde de escribir.",
  },
  publicada: { es: "publicada" },
  Handoff: { es: "Transferencia" },
  "Atualizado em": { es: "Actualizado el" },
  Ativo: { es: "Activo" },
  Desativado: { es: "Desactivado" },
  // ─── Follow-up: fila e estados de enrollment/promessa ───
  "Não consegui criar o fluxo. Tente de novo.": {
    es: "No pude crear el flujo. Intenta de nuevo.",
  },
  "Não consegui renomear o fluxo. Tente de novo.": {
    es: "No pude renombrar el flujo. Intenta de nuevo.",
  },
  "Renomear fluxo": { es: "Renombrar flujo" },
  "Só o nome interno muda. Inscrições e a versão publicada continuam as mesmas.": {
    es: "Solo cambia el nombre interno. Las inscripciones y la versión publicada siguen iguales.",
  },
  "Duplicando…": { es: "Duplicando…" },
  "Fluxo duplicado.": { es: "Flujo duplicado." },
  "Fluxo renomeado.": { es: "Flujo renombrado." },
  "Novo fluxo de follow-up": { es: "Nuevo flujo de seguimiento" },
  "Nasce como rascunho. Você monta as etapas no editor visual em seguida.": {
    es: "Se crea como borrador. Después armarás las etapas en el editor visual.",
  },
  "Ex: Recuperação de carrinho abandonado": { es: "Ej.: Recuperación de carrito abandonado" },
  "Criando…": { es: "Creando…" },
  "Criar fluxo": { es: "Crear flujo" },
  "Buscar contato…": { es: "Buscar contacto…" },
  "Buscar contato": { es: "Buscar contacto" },
  "Todos os status": { es: "Todos los estados" },
  "Filtrar por fluxo": { es: "Filtrar por flujo" },
  "Todos os fluxos": { es: "Todos los flujos" },
  "Nenhum item na fila": { es: "Ningún elemento en la cola" },
  "Enrollments ativos e promessas de retorno agendadas pela IA aparecem aqui.": {
    es: "Aquí aparecen las inscripciones activas y las promesas de seguimiento que programó la IA.",
  },
  Contato: { es: "Contacto" },
  "Fluxo / Promessa": { es: "Flujo / Promesa" },
  "Nó atual / Motivo": { es: "Nodo actual / Motivo" },
  "Próximo disparo": { es: "Próximo disparo" },
  Promessa: { es: "Promesa" },
  agente: { es: "agente" },
  "Cancelar retorno": { es: "Cancelar seguimiento" },
  "Cancelar follow-up": { es: "Cancelar seguimiento" },
  "Carregando...": { es: "Cargando..." },
  "Carregar mais": { es: "Cargar más" },
  "Cancelar este retorno?": { es: "¿Cancelar este seguimiento?" },
  "Cancelar este follow-up?": { es: "¿Cancelar este seguimiento?" },
  "O agente não voltará a falar com esta pessoa no horário combinado, e vai saber que você desmarcou.": {
    es: "El agente no volverá a hablar con esta persona en el horario acordado, y sabrá que cancelaste.",
  },
  "O lead não receberá mais mensagens deste fluxo. Essa ação não pode ser desfeita.": {
    es: "El lead no recibirá más mensajes de este flujo. Esta acción no se puede deshacer.",
  },
  "Aguardando resposta": { es: "Esperando respuesta" },
  "Pausado (atendimento humano)": { es: "Pausado (atención humana)" },
  "Pausado por uma pessoa": { es: "Pausado por una persona" },
  "Parou de tentar": { es: "Dejó de intentar" },
  Cancelado: { es: "Cancelado" },
  Agendada: { es: "Programada" },
  "Concluída": { es: "Concluida" },
  Cancelada: { es: "Cancelada" },
  "Fluxo criado.": { es: "Flujo creado." },
  "Follow-up cancelado.": { es: "Seguimiento cancelado." },
  "Retorno cancelado.": { es: "Seguimiento cancelado." },
  "Rascunho salvo.": { es: "Borrador guardado." },
  "Fluxo publicado.": { es: "Flujo publicado." },
  "Fluxo desativado.": { es: "Flujo desactivado." },
  "Fluxo revertido para a versão anterior.": { es: "Flujo revertido a la versión anterior." },
  "Gatilho atualizado.": { es: "Disparador actualizado." },
  "Política de handoff atualizada.": { es: "Política de transferencia actualizada." },
  "Follow-up pausado.": { es: "Seguimiento pausado." },
  "Follow-up retomado.": { es: "Seguimiento reanudado." },
  "Follow-up adiado.": { es: "Seguimiento aplazado." },
  "Passo pulado.": { es: "Paso omitido." },
  pausar: { es: "pausar" },
  cancelar: { es: "cancelar" },
  permitir: { es: "permitir" },
  "Adicionar nó": { es: "Agregar nodo" },
  "Início do fluxo": { es: "Inicio del flujo" },
  min: { es: "min" },
  adaptativo: { es: "adaptativo" },
  "regra · uma saída por regra": { es: "regla · una salida por regla" },
  "regras · uma saída por regra": { es: "reglas · una salida por regla" },
  "condição": { es: "condición" },
  "condições": { es: "condiciones" },
  E: { es: "Y" },
  OU: { es: "O" },
  classes: { es: "clases" },
  "Template fixo": { es: "Plantilla fija" },
  Convertido: { es: "Convertido" },
  Esgotado: { es: "Agotado" },
  Personalizado: { es: "Personalizado" },
  Gatilho: { es: "Disparador" },
  Aguardar: { es: "Esperar" },
  Condição: { es: "Condición" },
  "Classificar (IA)": { es: "Clasificar (IA)" },
  "Ação": { es: "Acción" },
  "Verificar condição": { es: "Verificar condición" },
  "Classificar resposta": { es: "Clasificar respuesta" },
  "Enviar mensagem": { es: "Enviar mensaje" },
  "Fim do fluxo": { es: "Fin del flujo" },
  "Rótulo precisa ter 1 a 60 caracteres.": { es: "La etiqueta debe tener entre 1 y 60 caracteres." },
  "Alterações aplicam no rascunho ao digitar — salve na barra de publicação.": {
    es: "Los cambios se aplican al borrador mientras escribes. Guarda desde la barra de publicación.",
  },
  "Rótulo": { es: "Etiqueta" },
  "Início do fluxo — sem configuração adicional. O disparo (manual, mudança de etapa, silêncio ou fim de conversa) é definido nas configurações do fluxo.":
    {
      es: "Inicio del flujo. No requiere configuración adicional. El disparador (manual, cambio de etapa, silencio o fin de conversación) se define en la configuración del flujo.",
    },
  "Condição da aresta": { es: "Condición de la arista" },
  "Excluir nó": { es: "Eliminar nodo" },
  "Excluir aresta": { es: "Eliminar arista" },
  "Excluir este nó?": { es: "¿Eliminar este nodo?" },
  "Excluir esta aresta?": { es: "¿Eliminar esta arista?" },
  "Este nó e as arestas ligadas a ele são apagados. Não é possível desfazer.": {
    es: "Se borrarán este nodo y las aristas conectadas a él. No se puede deshacer.",
  },
  "A aresta entre os dois nós é apagada. Não é possível desfazer.": {
    es: "Se borrará la arista entre los dos nodos. No se puede deshacer.",
  },
  Organizar: { es: "Organizar" },
  "Quando seguir por esta aresta": { es: "Cuándo seguir por esta arista" },
  "São as saídas do nó": { es: "Son las salidas del nodo" },
  "as mesmas que aparecem no card.": { es: "las mismas que aparecen en la tarjeta." },
  "Configuração inválida.": { es: "Configuración inválida." },
  "Tempo fixo": { es: "Tiempo fijo" },
  "A IA escolhe a hora": { es: "La IA elige el momento" },
  "Como calcular a espera": { es: "Cómo calcular la espera" },
  "Duração (minutos)": { es: "Duración (minutos)" },
  "Mínimo (min)": { es: "Mínimo (min)" },
  "Máximo (min)": { es: "Máximo (min)" },
  "Orientação (opcional)": { es: "Orientación (opcional)" },
  "Classes (separadas por vírgula)": { es: "Clases (separadas por comas)" },
  "Esperar a resposta por (minutos)": { es: "Esperar la respuesta durante (minutos)" },
  "O que a IA vai ler": { es: "Qué va a leer la IA" },
  "Última resposta": { es: "Última respuesta" },
  Resumo: { es: "Resumen" },
  "Instrução (opcional)": { es: "Instrucción (opcional)" },
  "interessado, sem interesse": { es: "interesado, sin interés" },
  "Como as regras decidem o caminho": { es: "Cómo deciden el camino las reglas" },
  "Avaliar as regras juntas (uma saída de sim e uma de não)": {
    es: "Evaluar las reglas en conjunto (una salida para “sí” y otra para “no”)",
  },
  "Uma saída por regra": { es: "Una salida por regla" },
  "Trocar de modo deixa": { es: "Cambiar de modo deja" },
  "ligação sem saída": { es: "conexión sin salida" },
  "ligações sem saída": { es: "conexiones sin salida" },
  "neste nó. Elas continuam desenhadas, mas param de levar a lugar nenhum até você religá-las.": {
    es: "en este nodo. Siguen dibujadas, pero no llevan a ningún lado hasta que las vuelvas a conectar.",
  },
  "Trocar mesmo assim": { es: "Cambiar de todas formas" },
  "Seguir por aqui quando": { es: "Seguir por aquí cuando" },
  "Todas as condições": { es: "Todas las condiciones" },
  "Qualquer uma das condições": { es: "Cualquiera de las condiciones" },
  "Remover condição": { es: "Eliminar condición" },
  "Nome da saída": { es: "Nombre de la salida" },
  "Nome desta saída (opcional)": { es: "Nombre de esta salida (opcional)" },
  Operador: { es: "Operador" },
  "Etapa do funil": { es: "Etapa del embudo" },
  "Etiqueta do contato": { es: "Etiqueta del contacto" },
  "Passos já dados no fluxo": { es: "Pasos ya dados en el flujo" },
  "Desfecho do passo anterior": { es: "Resultado del paso anterior" },
  "está na etapa": { es: "está en la etapa" },
  "não está na etapa": { es: "no está en la etapa" },
  "contém": { es: "contiene" },
  "é pelo menos": { es: "es al menos" },
  "é no máximo": { es: "es como máximo" },
  "tem a etiqueta": { es: "tiene la etiqueta" },
  "tem a tag": { es: "tiene la etiqueta" },
  "não tem a etiqueta": { es: "no tiene la etiqueta" },
  "é exatamente": { es: "es exactamente" },
  "não é": { es: "no es" },
  foi: { es: "fue" },
  "não foi": { es: "no fue" },
  Valor: { es: "Valor" },
  "Ex.: 3": { es: "Ej.: 3" },
  "Comparar maior/menor só funciona com número. Do jeito que está, esta condição nunca é verdadeira.": {
    es: "Comparar mayor/menor solo funciona con números. Tal como está, esta condición nunca se cumple.",
  },
  "“Contém” só funciona com texto. Em número, esta condição nunca é verdadeira.": {
    es: "“Contiene” solo funciona con texto. Con un número, esta condición nunca se cumple.",
  },
  "Carregando seus modelos…": { es: "Cargando tus plantillas…" },
  "Não consegui carregar seus modelos de mensagem. Recarregue a página.": {
    es: "No pude cargar tus plantillas de mensaje. Recarga la página.",
  },
  "Você ainda não tem modelos de mensagem. Crie um em Ajustes → Modelos e ele aparece aqui.": {
    es: "Todavía no tienes plantillas de mensaje. Crea una en Ajustes → Plantillas y aparecerá aquí.",
  },
  "Escolha um modelo": { es: "Elige una plantilla" },
  Nenhum: { es: "Ninguno" },
  "Como escrever a mensagem": { es: "Cómo escribir el mensaje" },
  "Mensagem escrita pela IA": { es: "Mensaje escrito por la IA" },
  "Modelo de mensagem pronto": { es: "Plantilla de mensaje predefinida" },
  "Instrução para a IA": { es: "Instrucción para la IA" },
  "Se a IA não conseguir escrever, mandar este modelo": { es: "Si la IA no puede redactar el mensaje, enviar esta plantilla" },
  "Modelo de mensagem": { es: "Plantilla de mensaje" },
  "Nota (opcional)": { es: "Nota (opcional)" },
  "Fluxo reprovado na validação — corrija os nós destacados.": {
    es: "El flujo no pasó la validación. Corrige los nodos resaltados.",
  },
  "Alterações não salvas": { es: "Cambios sin guardar" },
  "Pausar durante handoff": { es: "Pausar durante la transferencia" },
  "Cancelar durante handoff": { es: "Cancelar durante la transferencia" },
  "Permitir durante handoff": { es: "Permitir durante la transferencia" },
  "Política de handoff": { es: "Política de transferencia" },
  Desativar: { es: "Desactivar" },
  Rollback: { es: "Revertir" },
  Silêncio: { es: "Silencio" },
  "entrou em": { es: "entró en" },
  em: { es: "en" },
  "Agente pediu ajuda": { es: "El agente pidió ayuda" },
  "Cliente voltou": { es: "El cliente volvió" },
  "Tempo sem o cliente falar": { es: "Tiempo sin que el cliente hable" },
  minuto: { es: "minuto" },
  "O fluxo começa quando o cliente escreve depois de ficar este tempo sem mandar mensagem. Não é o mesmo que silêncio: silêncio avisa enquanto ele some; este avisa quando ele volta.":
    {
      es: "El flujo empieza cuando el cliente escribe después de estar este tiempo sin mandar mensaje. No es lo mismo que el silencio: el silencio avisa mientras desaparece; este avisa cuando vuelve.",
    },
  "quando o agente pede ajuda": { es: "cuando el agente pide ayuda" },
  Manual: { es: "Manual" },
  "indisponível": { es: "no disponible" },
  "Tipo de gatilho": { es: "Tipo de disparador" },
  "Etapa que dispara o fluxo": { es: "Etapa que dispara el flujo" },
  "Carregando etapas…": { es: "Cargando etapas…" },
  "Escolha a etapa": { es: "Elige la etapa" },
  "Nenhuma etapa ativa encontrada — crie o funil antes de usar esta regra.": {
    es: "No hay ninguna etapa activa. Crea el embudo antes de usar esta regla.",
  },
  "A etapa escolhida não está mais na lista de etapas ativas — foi arquivada ou apagada. Escolha outra.": {
    es: "La etapa elegida ya no aparece entre las etapas activas: se archivó o se eliminó. Elige otra.",
  },
  "Esta regra vale para todo contato. A saída dela leva todo mundo, e as saídas seguintes nunca são usadas.": {
    es: "Esta regla aplica a todos los contactos. Su salida los lleva a todos, así que las salidas siguientes nunca se usan.",
  },
  "Não consegui carregar as etapas agora. O que estava escolhido continua salvo — recarregue a página para escolher outra.": {
    es: "No pude cargar las etapas por ahora. Lo que habías elegido sigue guardado. Recarga la página para elegir otra.",
  },
  "foi digitado à mão e não é uma etapa do funil. Escolha a etapa na lista — do jeito que está, esta regra nunca decide nada.": {
    es: "se escribió a mano y no es una etapa del embudo. Elige la etapa en la lista. Así como está, esta regla nunca decide nada.",
  },
  "Esta regra não aponta para uma etapa ativa do funil. Abra o nó e escolha a etapa na lista.": {
    es: "Esta regla no apunta a una etapa activa del embudo. Abre el nodo y elige la etapa en la lista.",
  },
  "Nenhuma etapa ativa encontrada — crie o funil antes de armar este gatilho.": {
    es: "No hay ninguna etapa activa. Crea el embudo antes de configurar este disparador.",
  },
  "O fluxo começa quando um negócio entra nesta etapa, por arrasto no quadro ou por automação. A entrada na fila leva poucos minutos, não é instantânea.":
    {
      es: "El flujo empieza cuando un negocio entra a esta etapa, ya sea porque lo arrastras en el tablero o por una automatización. Entrar a la cola tarda unos minutos; no es instantáneo.",
    },
  "O fluxo começa quando o agente abre um caso — o momento em que ele diz que precisa de uma pessoa. Não há o que escolher aqui: vale para qualquer caso desta conta.":
    {
      es: "El flujo empieza cuando el agente abre un caso, es decir, cuando avisa que necesita a una persona. Aquí no hay nada que elegir: aplica a cualquier caso de esta cuenta.",
    },
  "Comece o fluxo por uma espera.": { es: "Empieza el flujo con una espera." },
  "O agente continua conversando depois de abrir o caso — sem espera, o cliente recebe duas mensagens ao mesmo tempo.":
    {
      es: "El agente sigue conversando después de abrir el caso. Sin una espera, el cliente recibe dos mensajes a la vez.",
    },
  "Se o caso for resolvido antes, o follow-up é cancelado sozinho.": {
    es: "Si el caso se resuelve antes, el seguimiento se cancela solo.",
  },
  "Minutos de silêncio": { es: "Minutos de silencio" },
  "Mínimo de": { es: "Mínimo de" },
  "minutos.": { es: "minutos." },
  "Segmentos (tags, opcional)": { es: "Segmentos (tags, opcional)" },
  "ex: vip, carrinho-abandonado": { es: "Ej.: vip, carrito-abandonado" },
  "Cancelar se o lead responder": { es: "Cancelar si el lead responde" },
  "Salvar gatilho": { es: "Guardar disparador" },
  "Fila de follow-ups": { es: "Cola de seguimientos" },
  "Fluxo removido": { es: "Flujo eliminado" },
  Agente: { es: "Agente" },
  "Nenhum agente fixado": { es: "Ningún agente fijado" },
  "Começou": { es: "Empezó" },
  "Passos dados": { es: "Pasos dados" },
  "Onde está agora": { es: "Dónde está ahora" },
  passo: { es: "paso" },
  "não existe mais na versão publicada deste fluxo": { es: "ya no existe en la versión publicada de este flujo" },
  "Volta a andar": { es: "Se reanuda" },
  "Parado até alguém retomar": { es: "En pausa hasta que alguien lo reanude" },
  "Encerrado em": { es: "Finalizado el" },
  "Sem próximo passo agendado": { es: "Sin próximo paso programado" },
  "Desfecho": { es: "Resultado" },
  Motivo: { es: "Motivo" },
  "Última falha": { es: "Último error" },
  tentativa: { es: "intento" },
  "O automático está executando este follow-up agora — as ações abaixo podem ser recusadas por alguns instantes.": {
    es: "El proceso automático está ejecutando este seguimiento ahora. Es posible que las acciones de abajo se rechacen durante unos instantes.",
  },
  Retomar: { es: "Reanudar" },
  "Pular este passo": { es: "Omitir este paso" },
  "O que já aconteceu": { es: "Lo que ya pasó" },
  "Adiar o próximo passo": { es: "Aplazar el próximo paso" },
  "O follow-up continua no mesmo passo e volta a andar no horário que você escolher.": {
    es: "El seguimiento se queda en el mismo paso y se reanuda a la hora que elijas.",
  },
  "Novo horário": { es: "Nuevo horario" },
  "O lead não receberá mais mensagens deste fluxo. Diferente de pausar, isto não pode ser desfeito.": {
    es: "El lead no recibirá más mensajes de este flujo. A diferencia de pausar, esto no se puede deshacer.",
  },
  "Por onde seguir?": { es: "¿Por dónde seguir?" },
  "Este passo tem mais de um caminho no fluxo. Escolher por você seria decidir o rumo do atendimento sem perguntar.": {
    es: "Este paso tiene más de un camino en el flujo. Elegir uno por ti sería decidir el rumbo de la atención sin consultarte.",
  },
  // ─── lib/followup/intervencao.ts (respostaDaFalha) ───
  "O automático está executando este follow-up agora. Nada foi alterado — tente de novo em alguns instantes.": {
    es: "El proceso automático está ejecutando este seguimiento ahora. No se cambió nada. Inténtalo de nuevo en unos instantes.",
  },
  "Este follow-up mudou de estado enquanto você decidia. Nada foi alterado — recarregue e confira.": {
    es: "Este seguimiento cambió de estado mientras decidías. No se cambió nada. Recarga y revisa.",
  },
  "Só dá para pausar um follow-up que está andando (ativo ou aguardando resposta).": {
    es: "Solo se puede pausar un seguimiento que está en curso (activo o esperando respuesta).",
  },
  "Este follow-up não está pausado por uma pessoa.": {
    es: "Este seguimiento no está pausado por una persona.",
  },
  "Data inválida.": { es: "Fecha inválida." },
  "Escolha um horário no futuro.": { es: "Elige un horario en el futuro." },
  "O adiamento máximo é de 90 dias.": { es: "El aplazamiento máximo es de 90 días." },
  "Só dá para adiar um follow-up que está andando (ativo ou aguardando resposta).": {
    es: "Solo se puede aplazar un seguimiento que está en curso (activo o esperando respuesta).",
  },
  "Só dá para pular o passo de um follow-up que está andando (ativo ou aguardando resposta).": {
    es: "Solo se puede omitir el paso de un seguimiento que está en curso (activo o esperando respuesta).",
  },
  "Este passo não tem saída no fluxo — não há para onde pular.": {
    es: "Este paso no tiene salida en el flujo, así que no hay a dónde avanzar.",
  },
  "O caminho escolhido não sai deste passo.": { es: "El camino elegido no sale de este paso." },
  "Este passo tem mais de um caminho. Escolha por onde seguir.": {
    es: "Este paso tiene más de un camino. Elige por dónde seguir.",
  },
  "O tempo que o agente escolheu": { es: "El tiempo que eligió el agente" },
  Decidido: { es: "Decidido" },
  "no início do follow-up": { es: "al inicio del seguimiento" },
  esperar: { es: "esperar" },
  "bateu no seu limite": { es: "llegó a tu límite" },
  "a IA pediu": { es: "la IA pidió" },
  Sim: { es: "Sí" },
  "Não": { es: "No" },
  Sempre: { es: "Siempre" },
  "Nenhuma delas": { es: "Ninguna de ellas" },
  "Outros casos": { es: "Otros casos" },
  "Sem resposta": { es: "Sin respuesta" },
  // Rótulos das saídas do nó de repetição: chegaram por outra branch e nunca
  // entraram aqui, então o card do repeat aparecia meio em português no espanhol.
  "Próxima volta": { es: "Siguiente vuelta" },
  Acabou: { es: "Terminó" },
  Salvo: { es: "Guardado" },
  "Reindexação enfileirada — atualizando em segundo plano.": {
    es: "Reindexación en cola. Actualizando en segundo plano.",
  },
  "Fontes de Conhecimento": { es: "Fuentes de conocimiento" },
  "Configure as fontes de RAG do agent default da organização.": {
    es: "Configura las fuentes de RAG del agente predeterminado de la organización.",
  },
  "Nenhum agent default encontrado. Crie um agent default em": {
    es: "No se encontró ningún agente predeterminado. Crea uno en",
  },
  "primeiro.": { es: "primero." },
  "Ir para Agents": { es: "Ir a Agentes" },
  "Status e ações sobre as fontes RAG do agent": { es: "Estado y acciones de las fuentes RAG del agente" },
  Pronto: { es: "Listo" },
  Falhou: { es: "Falló" },
  Parcial: { es: "Parcial" },
  "Não indexado": { es: "No indexado" },
  "Citações da resposta IA": { es: "Referencias de la respuesta de la IA" },
  "Resposta sem RAG hits — modelo respondeu sem usar a base de conhecimento.": {
    es: "Respuesta sin RAG hits: el modelo respondió sin usar la base de conocimiento.",
  },
  FAQ: { es: "FAQ" },
  "Política": { es: "Política" },
  "Conversa": { es: "Conversación" },
  "Catálogo": { es: "Catálogo" },
  Fonte: { es: "Fuente" },
  "Mostrar citações da resposta": { es: "Mostrar referencias de la respuesta" },
  "Perguntas frequentes do tenant.": { es: "Preguntas frecuentes del tenant." },
  "Documento PDF de políticas (troca, devolução, privacidade).": {
    es: "Documento PDF de políticas (cambios, devoluciones, privacidad).",
  },
  "Conversas opt-in": { es: "Conversaciones opt-in" },
  "Conversas anonimizadas para aprendizado.": { es: "Conversaciones anonimizadas para aprendizaje." },
  "Entra sozinha: conversas resolvidas que alguém marcar como aproveitáveis pela IA são anonimizadas e indexadas em lote. Não há conteúdo para colar aqui.":
    {
      es: "Se alimenta sola: las conversaciones resueltas que alguien marque como aprovechables para la IA se anonimizan y se indexan por lotes. Aquí no hay contenido que pegar.",
    },
  "Produtos sincronizados do e-commerce.": { es: "Productos sincronizados desde el e-commerce." },
  "Os produtos vêm da sincronização com o e-commerce, não de conteúdo digitado aqui.": {
    es: "Los productos vienen de la sincronización con el e-commerce, no de contenido escrito aquí.",
  },
  "Nunca indexado": { es: "Nunca indexado" },
  "agora há pouco": { es: "hace un momento" },
  "há": { es: "hace" },
  "Nenhuma fonte configurada.": { es: "Ninguna fuente configurada." },
  Configurar: { es: "Configurar" },
  "Última indexação": { es: "Última indexación" },
  "Chunks indexados": { es: "Fragmentos indexados" },
  "Detalhes do erro": { es: "Detalles del error" },
  "Reindexando...": { es: "Reindexando..." },
  "Re-indexar": { es: "Reindexar" },
  "Editar conteúdo": { es: "Editar contenido" },
  "Editor de FAQ em breve.": { es: "Editor de FAQ próximamente." },
  "Upload novo arquivo": { es: "Subir nuevo archivo" },
  "Upload de política em breve.": { es: "Subida de política próximamente." },
  "da loja": { es: "de la tienda" },
  "Cole o conteúdo antes de criar.": { es: "Pega el contenido antes de crear." },
  "Não consegui criar a fonte.": { es: "No pude crear la fuente." },
  "Fonte criada. A indexação começa em instantes.": { es: "Fuente creada. La indexación empieza en unos instantes." },
  "Não consegui falar com o servidor.": { es: "No pude comunicarme con el servidor." },
  "Cadastrar": { es: "Registrar" },
  "Cole as perguntas e respostas. O agente passa a consultar isso antes de responder.": {
    es: "Pega las preguntas y respuestas. El agente empieza a consultarlas antes de responder.",
  },
  "Nome da fonte": { es: "Nombre de la fuente" },
  "Conteúdo": { es: "Contenido" },
  "Uma linha": { es: "Una línea" },
  "e uma": { es: "y una" },
  "por item, separados por uma linha em branco.": { es: "por elemento, separados por una línea en blanco." },
  "Criar fonte": { es: "Crear fuente" },
  "Você é um assistente da loja. Responda com clareza e cordialidade…": {
    es: "Eres un asistente de la tienda. Responde con claridad y cordialidad…",
  },
  "Mínimo 20 caracteres, máximo 10.000. Use placeholders para injetar contexto dinâmico.": {
    es: "Mínimo 20 caracteres, máximo 10.000. Usa placeholders para inyectar contexto dinámico.",
  },
  "Placeholders": { es: "Placeholders" },
  "Inserir": { es: "Insertar" },
  "Vocabulário do tenant para 'lead' (ex: cliente)": { es: "Vocabulario del tenant para 'lead' (ej.: cliente)" },
  "Vocabulário do tenant para 'deal' (ex: pedido)": { es: "Vocabulario del tenant para 'deal' (ej.: pedido)" },
  "Vocabulário do tenant para 'won' (ex: pago)": { es: "Vocabulario del tenant para 'won' (ej.: pagado)" },
  "Vocabulário do tenant para 'lost' (ex: cancelado)": { es: "Vocabulario del tenant para 'lost' (ej.: cancelado)" },
  "Nome do contato em atendimento": { es: "Nombre del contacto en atención" },
  "Locale do contato (ex: pt-BR)": { es: "Locale del contacto (ej.: pt-BR)" },
  "Últimas N mensagens da conversa": { es: "Últimos N mensajes de la conversación" },
  "Trechos da base de conhecimento (RAG)": { es: "Fragmentos de la base de conocimiento (RAG)" },
  "Janela horária": { es: "Ventana horaria" },
  "Bloquear conteúdo sensível na resposta": { es: "Bloquear contenido sensible en la respuesta" },
  "Exigir citação da base": { es: "Exigir referencia a la base" },
  "Bloquear input com termo proibido": { es: "Bloquear input con término prohibido" },
  "Janela operacional 7h-22h": { es: "Ventana operativa 7h-22h" },
  "Skip se contato pediu humano": { es: "Omitir si el contacto pidió un humano" },
  "Tipo do novo guardrail": { es: "Tipo de guardrail nuevo" },
  "Adicionar guardrail": { es: "Agregar guardrail" },
  "Nenhum guardrail definido. O agent responde sem restrições adicionais.": {
    es: "Ningún guardrail definido. El agente responde sin restricciones adicionales.",
  },
  "Campos inválidos. Ajuste antes de salvar.": { es: "Campos inválidos. Ajusta antes de guardar." },
  "Citações mínimas": { es: "Referencias mínimas" },
  "Hora início (0-23)": { es: "Hora de inicio (0-23)" },
  "Hora fim (0-23)": { es: "Hora de fin (0-23)" },
  "Valor esperado": { es: "Valor esperado" },
  "Carregando agent…": { es: "Cargando agente…" },
  "Guardrails inválidos.": { es: "Guardrails inválidos." },
  "Guardrails inválidos": { es: "Guardrails inválidos" },
  "Nada para salvar.": { es: "Nada que guardar." },
  "Campos inválidos.": { es: "Campos inválidos." },
  "Erro ao salvar": { es: "Error al guardar" },
  "Agent default": { es: "Agente predeterminado" },
  "Criado em": { es: "Creado el" },
  "Geral": { es: "General" },
  "Descrição interna do agent": { es: "Descripción interna del agente" },
  "Agent ativo": { es: "Agente activo" },
  "read-only — gerenciado pelo backend": { es: "solo lectura — gestionado por el backend" },
  "Janela de contexto (msgs, 1–50)": { es: "Ventana de contexto (msgs, 1–50)" },
  "Top K = quantos trechos buscar. Similarity threshold = mínimo de relevância (cosine). Confidence = limiar abaixo do qual o agent escala para humano.":
    {
      es: "Top K = cuántos fragmentos buscar. Similarity threshold = relevancia mínima (cosine). Confidence = umbral por debajo del cual el agente escala a un humano.",
    },
  "Chaves de acesso à IA": { es: "Claves de acceso a la IA" },
  "A conta de inteligência artificial é sua: você contrata direto na Anthropic, OpenAI ou Google e cola a chave aqui. Ela é guardada criptografada e nunca mais aparece na tela depois de salva — nem para você.":
    {
      es: "La cuenta de inteligencia artificial es tuya: la contratas directamente con Anthropic, OpenAI o Google y pegas aquí la clave. Se guarda cifrada y, una vez guardada, no vuelve a mostrarse en pantalla, ni siquiera para ti.",
    },
  "Nenhuma chave cadastrada ainda": { es: "Todavía no hay ninguna clave registrada" },
  "Seus agentes só conseguem pensar depois que você cola aqui uma chave da Anthropic, da OpenAI ou do Google. A cobrança vai direto para a sua conta no provedor, e a chave fica guardada criptografada.":
    {
      es: "Tus agentes no pueden pensar hasta que pegues aquí una clave de Anthropic, OpenAI o Google. El cobro se hace directo a tu cuenta con el proveedor, y la clave se guarda cifrada.",
    },
  "Adicionar credencial": { es: "Agregar credencial" },
  Validada: { es: "Validada" },
  "Não validada": { es: "Sin validar" },
  Inválida: { es: "Inválida" },
  "A validação não terminou. Clique em revalidar para testar a chave agora.": {
    es: "La validación no terminó. Haz clic en revalidar para probar la clave ahora.",
  },
  "O provedor recusou a chave. Confira se copiou inteira ou gere uma nova.": {
    es: "El proveedor rechazó la clave. Verifica que la hayas copiado completa o genera una nueva.",
  },
  "O provedor limitou as chamadas desta chave. Tente de novo em alguns minutos.": {
    es: "El proveedor limitó las llamadas de esta clave. Inténtalo de nuevo en unos minutos.",
  },
  "O provedor está fora do ar. A chave pode estar certa; revalide mais tarde.": {
    es: "El proveedor está caído. La clave puede estar bien; revalida más tarde.",
  },
  "Não foi possível falar com o provedor a partir deste servidor. Revalide mais tarde.": {
    es: "No se pudo conectar con el proveedor desde este servidor. Revalida más tarde.",
  },
  "Falha na validação": { es: "Falló la validación" },
  "Pegar chave em": { es: "Obtener clave en" },
  "O padrão recomendado para conversar com o cliente: é o que melhor segue instruções longas e usa as ferramentas do CRM.": {
    es: "La opción recomendada por defecto para conversar con el cliente. Es la que mejor sigue instrucciones largas y usa las herramientas del CRM.",
  },
  "Necessário para transcrever áudio e para indexar o seu material — esses dois pontos usam tecnologia da OpenAI mesmo quando o resto está em outro provedor.": {
    es: "Necesario para transcribir audio e indexar tu material: ambas funciones usan tecnología de OpenAI, aunque el resto esté con otro proveedor.",
  },
  "Alternativa com contexto muito longo e custo baixo para tarefas de classificação.": {
    es: "Alternativa con contexto muy largo y bajo costo para tareas de clasificación.",
  },
  "Uma chave só dá acesso a centenas de modelos de dezenas de fabricantes, inclusive os gratuitos. É o caminho mais simples para experimentar sem abrir conta em cada provedor.": {
    es: "Una sola clave da acceso a cientos de modelos de decenas de fabricantes, incluidos los gratuitos. Es la forma más sencilla de experimentar sin abrir una cuenta con cada proveedor.",
  },
  Inativa: { es: "Inactiva" },
  "Revalidando…": { es: "Revalidando…" },
  "Credencial removida.": { es: "Credencial eliminada." },
  "Excluir credencial": { es: "Eliminar credencial" },
  Modelos: { es: "Modelos" },
  "Em uso por": { es: "En uso por" },
  publicado: { es: "publicado" },
  "Revalidar credencial": { es: "Revalidar credencial" },
  "Remover credencial": { es: "Eliminar credencial" },
  "Agents que usam esta credencial vão falhar ao executar. Esta ação não pode ser desfeita.": {
    es: "Los agentes que usan esta credencial fallarán al ejecutarse. Esta acción no se puede deshacer.",
  },
  "A chave é cifrada (AES-GCM) antes de gravar e nunca é retornada em texto claro.": {
    es: "La clave se cifra (AES-GCM) antes de guardarse y nunca se devuelve en texto plano.",
  },
  "Ex: Produção": { es: "Ej.: Producción" },
  "Credencial salva. Validando…": { es: "Credencial guardada. Validando…" },
  "Credencial salva. Validação em segundo plano.": { es: "Credencial guardada. Se validará en segundo plano." },
  "modelos disponíveis.": { es: "modelos disponibles." },
  "Salvar e validar": { es: "Guardar y validar" },
  "Obrigatório": { es: "Obligatorio" },
  "API key muito curta": { es: "API key demasiado corta" },
  Casos: { es: "Casos" },
  "Quando a IA trava em algo que só um humano resolve, ela abre um caso aqui — e continua conversando com o cliente enquanto espera sua resposta.":
    {
      es: "Cuando la IA se atora con algo que solo una persona puede resolver, abre un caso aquí y sigue conversando con el cliente mientras espera tu respuesta.",
    },
  Abertos: { es: "Abiertos" },
  "Concluídos": { es: "Concluidos" },
  "Nenhum caso aberto": { es: "Ningún caso abierto" },
  "Nenhum caso concluído": { es: "Ningún caso concluido" },
  "Quando a IA precisar de você, aparece aqui.": { es: "Cuando la IA te necesite, lo verás aquí." },
  "Casos concluídos, cancelados ou repassados ficam aqui.": {
    es: "Los casos concluidos, cancelados o transferidos quedan aquí.",
  },
  "Contato sem nome": { es: "Contacto sin nombre" },
  "Selecione um caso à esquerda": { es: "Selecciona un caso a la izquierda" },
  "Os detalhes e a resposta aparecem aqui.": { es: "Los detalles y la respuesta aparecen aquí." },
  "Sem telefone": { es: "Sin teléfono" },
  "Aberto automaticamente": { es: "Abierto automáticamente" },
  "Aberto automaticamente pelo sistema — a IA prometeu passar pra humano mas não abriu o caso, então o sistema abriu por ela.":
    {
      es: "Abierto automáticamente por el sistema. La IA prometió pasar a un humano, pero no abrió el caso, así que el sistema lo abrió por ella.",
    },
  "O que o cliente precisa": { es: "Qué necesita el cliente" },
  "Por que a IA travou": { es: "Por qué se atoró la IA" },
  "O que você quer fazer?": { es: "¿Qué quieres hacer?" },
  "Resposta registrada; não repassada porque o atendimento mudou. Revise a conversa.": { es: "Respuesta registrada; no se transmitió porque la atención cambió. Revisa la conversación." },
  "Resposta registrada para processamento.": { es: "Respuesta registrada para su procesamiento." },
  "Resposta enviada.": { es: "Respuesta enviada." },
  "Escreva sua resposta para a IA...": { es: "Escribe tu respuesta para la IA..." },
  "Escolha uma das opções acima para enviar.": { es: "Elige una de las opciones de arriba para enviar." },
  "Enviando...": { es: "Enviando..." },
  // ─── lib/ai/case-copy.ts (status, ações e timeline dos casos humanos) ───
  "Aguardando você": { es: "Esperando tu respuesta" },
  "Virou atendimento humano": { es: "Pasó a atención humana" },
  "Aguardando o cliente responder — a IA avisa você quando tiver a informação.": {
    es: "Esperando la respuesta del cliente. La IA te avisará cuando tenga la información.",
  },
  "Este caso já foi concluído.": { es: "Este caso ya está concluido." },
  "Este caso virou atendimento humano — não precisa mais de resposta aqui.": {
    es: "Este caso pasó a atención humana. Ya no necesita respuesta aquí.",
  },
  "Este caso foi cancelado.": { es: "Este caso está cancelado." },
  "Concluí": { es: "Concluí" },
  "A IA avisa o cliente e encerra o assunto.": { es: "La IA avisa al cliente y cierra el asunto." },
  "Preciso de info do cliente": { es: "Necesito info del cliente" },
  "A IA pergunta ao cliente e o caso volta pra você quando ele responder.": {
    es: "La IA le pregunta al cliente y el caso vuelve a ti cuando responda.",
  },
  "Não consigo — passar pra humano": { es: "No puedo: pasar a una persona" },
  "Sai da IA: a conversa vira um atendimento humano de verdade.": {
    es: "Sale de la IA: la conversación pasa a atención humana de verdad.",
  },
  "A IA abriu o caso": { es: "La IA abrió el caso" },
  "Você respondeu": { es: "Respondiste" },
  "A IA perguntou ao cliente": { es: "La IA le preguntó al cliente" },
  "O cliente respondeu": { es: "El cliente respondió" },
  "O cliente não respondeu a tempo": { es: "El cliente no respondió a tiempo" },
  "Você concluiu o caso": { es: "Concluiste el caso" },
  "Você pediu uma informação ao cliente": { es: "Pediste información al cliente" },
  "Você decidiu passar para atendimento humano": { es: "Decidiste pasar a atención humana" },
  "O sistema abriu o caso automaticamente": { es: "El sistema abrió el caso automáticamente" },
  "Atualização do caso": { es: "Actualización del caso" },
  "Um roteador entende o que o cliente quer e entrega a conversa para o agente certo — plugado em um número de WhatsApp.":
    {
      es: "Un enrutador entiende lo que quiere el cliente y pasa la conversación al agente correcto. Se conecta a un número de WhatsApp.",
    },
  "Novo roteador": { es: "Nuevo enrutador" },
  "Um roteador entende o que o cliente quer e entrega a conversa para o agente certo — um número de vendas fala com quem quer comprar, um de suporte com quem já é cliente, tudo no mesmo WhatsApp. Crie um para o seu número e escolha quais agentes ele aciona.":
    {
      es: "Un enrutador entiende lo que quiere el cliente y pasa la conversación al agente correcto. En un mismo WhatsApp, quien quiere comprar habla con ventas y quien ya es cliente, con soporte. Crea uno para tu número y elige qué agentes activa.",
    },
  "Criar meu primeiro roteador": { es: "Crear mi primer enrutador" },
  "Número removido": { es: "Número eliminado" },
  "Sem intenções configuradas": { es: "Sin intenciones configuradas" },
  "intenção": { es: "intención" },
  "intenções": { es: "intenciones" },
  "Roteador criado — agora escolha as intenções.": {
    es: "Enrutador creado. Ahora elige las intenciones.",
  },
  "Escolha o número de WhatsApp que ele vai atender. Depois de criado, você define as intenções e para qual agente cada uma vai.":
    {
      es: "Elige el número de WhatsApp que atenderá. Después de crearlo, definirás las intenciones y a qué agente corresponde cada una.",
    },
  "Número de WhatsApp": { es: "Número de WhatsApp" },
  "Só é possível ter um roteador ativo por número.": { es: "Solo puede haber un enrutador activo por número." },
  "Criar roteador": { es: "Crear enrutador" },
  ativo: { es: "activo" },
  inativo: { es: "inactivo" },
  "Excluir roteador": { es: "Eliminar enrutador" },
  "Identificação": { es: "Identificación" },
  "O número não pode ser trocado depois de criado — crie outro roteador para um número diferente.": {
    es: "El número no se puede cambiar una vez creado el enrutador. Para usar otro número, crea otro enrutador.",
  },
  "Ativo — está roteando as conversas deste número": { es: "Activo: está enrutando las conversaciones de este número" },
  "Inativo — não roteia nada": { es: "Inactivo: no enruta nada" },
  "Modelo que identifica a intenção": { es: "Modelo que identifica la intención" },
  "Modelo do classificador": { es: "Modelo del clasificador" },
  "Automático — usa o provedor da organização": { es: "Automático: usa el proveedor de la organización" },
  "chave desta instalação": { es: "clave de esta instalación" },
  "Nenhuma chave de IA utilizável nesta organização — cadastre uma em Agentes IA › Credenciais para poder escolher o modelo.":
    {
      es: "No hay ninguna clave de IA que se pueda usar en esta organización. Registra una en Agentes IA › Credenciales para poder elegir el modelo.",
    },
  "Só aparecem modelos de provedores com chave cadastrada aqui. Se a conta do provedor estiver sem crédito, a identificação falha e tudo cai no fallback.":
    {
      es: "Solo aparecen modelos de proveedores con clave registrada aquí. Si la cuenta del proveedor se queda sin crédito, la identificación falla y todo cae en el fallback.",
    },
  "Se nenhuma intenção casar": { es: "Si ninguna intención coincide" },
  "Agente de fallback": { es: "Agente de fallback" },
  "Nenhum — responde com o atendimento padrão": { es: "Ninguno: responde con la atención estándar" },
  "Quando a IA não tem certeza do que o cliente quer, ela chama este agente em vez de travar a conversa.": {
    es: "Cuando la IA no está segura de lo que quiere el cliente, llama a este agente en vez de trabar la conversación.",
  },
  "Intenções": { es: "Intenciones" },
  "Cada intenção descreve uma situação e diz qual agente deve assumir a conversa quando o cliente quer aquilo.": {
    es: "Cada intención describe una situación e indica qué agente debe hacerse cargo de la conversación cuando el cliente busca eso.",
  },
  "Intenção": { es: "Intención" },
  "Nenhuma intenção ainda. Sem intenções, toda conversa cai direto no agente de fallback (ou fica sem resposta automática, se você não escolher um).":
    {
      es: "Aún no hay intenciones. Sin ellas, todas las conversaciones van directo al agente de fallback (o se quedan sin respuesta automática si no eliges uno).",
    },
  "O número volta a ser atendido pelos gatilhos normais dos agentes (sem roteamento por intenção). As intenções deste roteador são apagadas junto. Não é possível desfazer.":
    {
      es: "El número volverá a atenderse con los disparadores normales de los agentes, sin enrutamiento por intención. Las intenciones de este enrutador también se borrarán. No se puede deshacer.",
    },
  "Nome da intenção": { es: "Nombre de la intención" },
  "Ex.: quer comprar": { es: "Ej.: quiere comprar" },
  "Agente que atende": { es: "Agente que atiende" },
  "Selecione o agente": { es: "Selecciona el agente" },
  "Remover intenção": { es: "Quitar intención" },
  "Quando escolher esta intenção": { es: "Cuándo elegir esta intención" },
  "Escreva como explicaria para um atendente novo: em que situação o cliente cai aqui.": {
    es: "Escribe como se lo explicarías a un asesor nuevo: en qué situación entra el cliente en esta intención.",
  },
  "Já existe outra intenção com este nome.": { es: "Ya existe otra intención con este nombre." },
  "Frases de exemplo (opcional)": { es: "Frases de ejemplo (opcional)" },
  "Remover exemplo": { es: "Quitar ejemplo" },
  "Sem frases de exemplo.": { es: "Sin frases de ejemplo." },
  "Ex.: quanto custa? (Enter)": { es: "Ej.: ¿cuánto cuesta? (Enter)" },
  "Testar classificação": { es: "Probar clasificación" },
  "Escreva uma frase como um cliente escreveria e veja qual intenção e qual agente o roteador escolheria — sem afetar nenhuma conversa real.":
    {
      es: "Escribe una frase como lo haría un cliente y mira qué intención y qué agente elegiría el enrutador. No afecta ninguna conversación real.",
    },
  "Ative o roteador para poder testar a classificação.": { es: "Activa el enrutador para poder probar la clasificación." },
  "Ex.: oi, quero saber o preço do plano premium": { es: "Ej.: hola, quiero saber el precio del plan premium" },
  "Testando…": { es: "Probando…" },
  "nenhuma casou": { es: "ninguna coincidió" },
  "confiança": { es: "confianza" },
  "Confiança": { es: "Confianza" },
  "abaixo do mínimo de": { es: "por debajo del mínimo de" },
  "cairia no atendimento padrão em produção.": { es: "caería en la atención estándar en producción." },
  "Agente que atenderia": { es: "Agente que atendería" },
  "nenhum (sem fallback)": { es: "ninguno (sin fallback)" },
  "Resolva os campos destacados antes de salvar.": { es: "Resuelve los campos resaltados antes de guardar." },
  "Roteador salvo.": { es: "Enrutador guardado." },
  "Roteador removido.": { es: "Enrutador eliminado." },
  "Escolha o agente que atende esta intenção.": { es: "Elige el agente que atiende esta intención." },
  "Dê um nome curto para a intenção.": { es: "Dale un nombre corto a la intención." },
  "Descreva quando a IA deve escolher esta intenção.": { es: "Describe cuándo la IA debe elegir esta intención." },
  "1 ponto deste grupo precisa da sua atenção.": { es: "1 punto de este grupo necesita tu atención." },
  "A IA nunca para por gasto. Você vê o número nesta tela e decide o que fazer.": {
    es: "La IA nunca se detiene por gasto. Ves el número en esta pantalla y decides qué hacer.",
  },
  "A IA para de responder ao chegar em": { es: "La IA deja de responder al llegar a" },
  "A parada começa a valer": { es: "La parada entra en vigor" },
  "A parada começa a valer em": { es: "La parada entra en vigor el" },
  "A proteção de gasto está desligada nesta instalação. O que estiver escolhido aqui não vale até que alguém religue em Comportamento, no Admin.": {
    es: "La protección de gasto está desactivada en esta instalación. Lo que elijas aquí no tendrá efecto hasta que alguien la vuelva a activar en Comportamiento, dentro de Admin.",
  },
  "Comportamento": {
    es: "Comportamiento",
  },
  "Comportamento desta instalação": {
    es: "Comportamiento de esta instalación",
  },
  "Como esta instalação se comporta em operação. Vale para todas as empresas hospedadas aqui.": {
    es: "Cómo se comporta esta instalación en operación. Aplica a todas las empresas alojadas aquí.",
  },
  "O que esta instalação faz": {
    es: "Qué hace esta instalación",
  },
  "Cada escolha vale para todas as empresas daqui. Quem cuida do servidor pode declarar um valor no arquivo de ambiente, mas ele só responde até a primeira leitura do banco: a partir daí, manda o que estiver aqui.": {
    es: "Cada opción se aplica a todas las empresas de esta instalación. Quien administra el servidor puede definir un valor en el archivo de entorno, pero solo se toma en cuenta hasta la primera lectura de la base de datos. Desde entonces, manda lo que esté configurado aquí.",
  },
  "Proteção de gasto de IA": {
    es: "Protección de gasto de IA",
  },
  "Decide o que acontece quando o gasto passa do teto que a empresa escolheu. Não liga a proteção de ninguém: só pode afrouxá-la.": {
    es: "Decide qué pasa cuando el gasto supera el límite que eligió la empresa. No activa la protección de nadie: solo puede aflojarla.",
  },
  "Respeita o teto de cada empresa": {
    es: "Respeta el límite de cada empresa",
  },
  "Só avisa, nunca para a IA": {
    es: "Solo avisa, nunca detiene la IA",
  },
  "Exigir assinatura nas entregas do canal": {
    es: "Exigir firma en las entregas del canal",
  },
  "Ligado, toda entrega de webhook precisa vir assinada com o segredo da sessão. Desligado por padrão porque nem todo servidor de canal assina: ligar sem que ele assine corta a entrada de mensagens.": {
    es: "Si está activado, cada entrega de webhook debe llegar firmada con el secreto de la sesión. Viene desactivado por defecto porque no todos los servidores de canal firman: activarlo sin que firmen corta la entrada de mensajes.",
  },
  "Divulgação de pagamento no atendimento": {
    es: "Divulgación de pago en la atención",
  },
  "Injetar acrescenta o texto de divulgação à primeira mensagem. Vetar bloqueia o envio sem ele e devolve ao modelo a razão, para ele reescrever.": {
    es: "Inyectar agrega el texto de divulgación al primer mensaje. Vetar bloquea el envío si falta ese texto y le indica al modelo el motivo para que reescriba el mensaje.",
  },
  "Injetar": {
    es: "Inyectar",
  },
  "Vetar": {
    es: "Vetar",
  },
  "Conferência de promessa antes de enviar": {
    es: "Verificación de promesa antes de enviar",
  },
  "Ligado, cada envio passa por uma conferência de modelo para não prometer o que a empresa não cumpre. Custa uma chamada de modelo por envio.": {
    es: "Si está activado, cada envío pasa por una verificación con un modelo para no prometer lo que la empresa no cumple. Cuesta una llamada al modelo por envío.",
  },
  // ─── app/admin/(protected)/sistema/_form.tsx (módulos opcionais, doc 37) ───
  "Módulos opcionais": {
    es: "Módulos opcionales",
  },
  "Recursos que a maioria das instalações não usa. Desligados, eles não aparecem para nenhuma empresa daqui.": {
    es: "Funciones que la mayoría de las instalaciones no usa. Desactivadas, no aparecen para ninguna empresa de esta instalación.",
  },
  "Banco de dados externo": {
    es: "Base de datos externa",
  },
  "Ligado, cada empresa pode conectar o banco de outro sistema (um ERP, outro CRM) para o agente consultar. Isso guarda a senha daquele banco neste servidor e abre conexão com ele. Desligado, a tela, o menu e as ferramentas do agente somem.": {
    es: "Si está activado, cada empresa puede conectar la base de datos de otro sistema (un ERP, otro CRM) para que el agente la consulte. Eso guarda la contraseña de esa base en este servidor y abre una conexión con ella. Si está desactivado, la pantalla, el menú y las herramientas del agente desaparecen.",
  },
  "Abrimos um aviso na Central de avisos. A IA continua respondendo normalmente.": {
    es: "Abrimos un aviso en la Central de avisos. La IA sigue respondiendo normalmente.",
  },
  "Aguardando decisão": { es: "Esperando decisión" },
  "Aprendizado adicionado.": { es: "Aprendizaje agregado." },
  "Aprendizado arquivado.": { es: "Aprendizaje archivado." },
  "Aprendizado reativado.": { es: "Aprendizaje reactivado." },
  Aprendizados: { es: "Aprendizajes" },
  Aprovada: { es: "Aprobada" },
  Aprovar: { es: "Aprobar" },
  "Aprovar e ignorar viram registro — os dois. Quando você decidir a primeira, ela fica aqui.": {
    es: "Tanto aprobar como ignorar dejan un registro. Cuando tomes la primera decisión, aparecerá aquí.",
  },
  "As conversas em andamento vão para a fila de atendimento humano — ninguém fica sem resposta, mas alguém precisa responder. Cada uma volta ao automático pelo botão \"Devolver ao automático\" no cabeçalho dela.": {
    es: "Las conversaciones en curso pasan a la fila de atención humana. Nadie se queda sin respuesta, pero alguien tiene que responder. Cada una vuelve al modo automático con el botón \"Devolver al automático\" de su encabezado.",
  },
  "Assuntos mais procurados": { es: "Temas más buscados" },
  "Atendimentos com IA": { es: "Atenciones con IA" },
  Até: { es: "Hasta" },
  "Até lá, só avisamos.": { es: "Hasta entonces, solo avisamos." },
  "Avisamos ao passar de": { es: "Avisamos al pasar de" },
  "Avisar ao chegar em (% do limite)": { es: "Avisar al llegar a (% del límite)" },
  "Avisos que você marcar como resolvidos ficam aqui.": { es: "Los avisos que marques como resueltos quedan aquí." },
  "Cada linha aqui é uma coisa que está limitando seu agente, e o que fazer a respeito — às vezes você mesmo, às vezes quem cuida da sua instalação.": {
    es: "Cada línea es algo que limita a tu agente y qué hacer al respecto. A veces te toca a ti; otras, a quien administra tu instalación.",
  },
  "Cada linha é uma coisa nova que o agente passou a saber, na ordem em que aconteceu.": {
    es: "Cada línea es algo nuevo que el agente aprendió, en el orden en que ocurrió.",
  },
  "Cadastrar assuntos": { es: "Registrar temas" },
  "Cadastrar uma chave": { es: "Registrar una clave" },
  "Carregando orçamento...": { es: "Cargando presupuesto..." },
  "Casos que precisaram de uma pessoa": { es: "Casos que necesitaron a una persona" },
  Chave: { es: "Clave" },
  "Começar a valer agora, sem esperar as 72 horas": { es: "Entrar en vigor ahora, sin esperar las 72 horas" },
  "Configurar no agente": { es: "Configurar en el agente" },
  "Configurar um roteador": { es: "Configurar un enrutador" },
  "Configuração avançada": { es: "Configuración avanzada" },
  "Consultas aos seus materiais": { es: "Consultas a tus materiales" },
  "Conteúdo da": { es: "Contenido de la" },
  "Conversas encaminhadas": { es: "Conversaciones derivadas" },
  "O horário da sua reunião mudou. Agora é": { es: "El horario de tu reunión cambió. Ahora es" },
  "O horário do seu compromisso mudou. Agora é": { es: "El horario de tu compromiso cambió. Ahora es" },
  "Mandar ao cliente": { es: "Enviar al cliente" },
  "Dados não enviados ainda.": { es: "Datos aún no enviados." },
  "Envio autorizado: aguardando a vez na fila.": { es: "Envío autorizado: esperando su turno en la fila." },
  "Dados aguardando envio nesta conversa.": { es: "Datos esperando envío en esta conversación." },
  "Dados enviados na conversa autorizada.": { es: "Datos enviados en la conversación autorizada." },
  "Conversa que receberá os dados": { es: "Conversación que recibirá los datos" },
  "Mandar de novo os dados deste compromisso para o cliente?": { es: "¿Enviar de nuevo los datos de este compromiso al cliente?" },
  "Seu compromisso está marcado para": { es: "Tu compromiso está programado para" },
  "Enviar de novo": { es: "Enviar de nuevo" },
  "Confirmar reenvio": { es: "Confirmar reenvío" },
  "Mandar de novo o link desta reunião para o cliente?": { es: "¿Enviar de nuevo el enlace de esta reunión al cliente?" },
  "Mandar de novo": { es: "Enviar de nuevo" },
  "O atendimento desta conversa mudou depois que o link foi criado. Escolha a conversa atual e autorize o envio de novo.": { es: "La atención de esta conversación cambió después de crearse el enlace. Elige la conversación actual y autoriza el envío de nuevo." },
  "Este cliente está sendo atendido neste instante. Espere alguns segundos e tente de novo.": { es: "Este cliente está siendo atendido en este momento. Espera unos segundos e inténtalo de nuevo." },
  "Este compromisso mudou enquanto a tela estava aberta. Atualize a página e tente de novo.": { es: "Este compromiso cambió mientras la pantalla estaba abierta. Actualiza la página e inténtalo de nuevo." },
  "O Google e o CRM discordam sobre este compromisso. Resolva a diferença antes de enviar o link.": { es: "Google y el CRM no coinciden sobre este compromiso. Resuelve la diferencia antes de enviar el enlace." },
  "Esta conversa não pode receber o link: ela é de outro contato, é um grupo, ou você não tem acesso a ela.": { es: "Esta conversación no puede recibir el enlace: es de otro contacto, es un grupo, o no tienes acceso a ella." },
  "Confirme a verificação em duas etapas nesta sessão para enviar o link.": { es: "Confirma la verificación en dos pasos en esta sesión para enviar el enlace." },
  "Só quem é responsável pelo compromisso pode enviar o link dele.": { es: "Solo el responsable del compromiso puede enviar su enlace." },
  "Ação desconhecida para o link do Meet.": { es: "Acción desconocida para el enlace de Meet." },
  "Não foi possível registrar a ação. O motivo ficou registrado no servidor com o identificador abaixo.": { es: "No se pudo registrar la acción. El motivo quedó registrado en el servidor con el identificador de abajo." },
  "Custo da IA no período": { es: "Costo de la IA en el período" },
  "Custo no período": { es: "Costo en el período" },
  // ── Administração › Destinos internos (decisão 22-d, #1004) ──────────────
  "Destinos internos": { es: "Destinos internos" },
  "Endereços da rede deste servidor que a instalação pode alcançar.": {
    es: "Direcciones de la red de este servidor que la instalación puede alcanzar.",
  },
  "Endereços liberados": { es: "Direcciones liberadas" },
  "Por padrão esta instalação não fala com a própria rede: um endereço como 10.0.0.5 ou 192.168.1.20 é recusado antes de qualquer arquivo ou chave sair daqui. O que estiver nesta lista deixa de ser recusado — e só isso: o endereço continua precisando ser https em produção, e continua valendo só para o que a INSTALAÇÃO configura. O endereço que uma empresa escolhe no painel dela segue sem poder apontar para dentro, esteja aqui ou não.": {
    es: "Por defecto, esta instalación no se comunica con su propia red: una dirección como 10.0.0.5 o 192.168.1.20 se rechaza antes de que salga de aquí cualquier archivo o clave. Lo que está en esta lista deja de rechazarse, y nada más: la dirección debe seguir siendo https en producción y sigue aplicando solo a lo que configura la INSTALACIÓN. La dirección que una empresa elige en su propio panel sigue sin poder apuntar hacia adentro, esté aquí o no.",
  },
  "Um endereço por linha": { es: "Una dirección por línea" },
  "Aceita um IP (10.1.2.7) ou uma faixa (10.1.0.0/16). Nome de máquina não entra: o que se confere é o endereço para o qual o nome aponta na hora, e não o nome.": {
    es: "Acepta una IP (10.1.2.7) o un rango (10.1.0.0/16). No se admiten nombres de host: lo que se verifica es la dirección a la que apunta el nombre en ese momento, no el nombre.",
  },
  "Esta lista ainda vem do arquivo de configuração do servidor, porque nunca foi salva por aqui. Ao salvar, passa a valer o que está nesta tela, e o arquivo deixa de ser consultado.": {
    es: "Esta lista aún viene del archivo de configuración del servidor, porque nunca se ha guardado desde aquí. Al guardar, se aplicará lo que aparece en esta pantalla y el archivo dejará de consultarse.",
  },
  "Cada endereço aqui é uma porta que este servidor passa a poder abrir para dentro da própria rede, levando junto a chave da instalação. Declare o endereço do serviço que você mesmo colocou lá — nunca uma faixa inteira por conveniência.": {
    es: "Cada dirección de esta lista es una puerta que el servidor podrá abrir hacia el interior de su propia red, con la clave de la instalación. Declara solo la dirección del servicio que tú mismo pusiste allí, nunca un rango completo por comodidad.",
  },
  "Não entendi estas linhas:": { es: "No entendí estas líneas:" },
  "Lista salva.": { es: "Lista guardada." },
  "Deixe em branco para usar o endereço oficial do provedor. Use isto para apontar para um gateway compatível com a API da OpenAI. Um endereço na rede do servidor só funciona se quem administra a instalação o tiver liberado em Administração › Destinos internos — e, mesmo liberado, ele não vale para o endereço que esta empresa escolhe aqui.": {
    es: "Déjalo en blanco para usar la dirección oficial del proveedor. Úsalo para apuntar a un gateway compatible con la API de OpenAI. Una dirección de la red del servidor solo funciona si quien administra la instalación la liberó en Administración › Destinos internos. Aun así, no se acepta para la dirección que esta empresa define aquí.",
  },
  "Descreva a regra ou o aprendizado em texto simples.": {
    es: "Describe la regla o el aprendizaje en texto simple.",
  },
  Desinstalar: { es: "Desinstalar" },
  "Disponível depois de salvar \"Me avisar\" — e, quando você armar a parada, ela só começa a valer 72 horas depois.": {
    es: "Disponible después de guardar \"Avisarme\". Cuando actives la parada, solo entrará en vigor 72 horas después.",
  },
  "Documento da organização": { es: "Documento de la organización" },
  "Editar limite": { es: "Editar límite" },
  "Endereço próprio (opcional)": { es: "Dirección propia (opcional)" },
  "Enviar skill (.zip)": { es: "Subir skill (.zip)" },
  "Escolha o que acontece quando o gasto do mês chega no limite. Os valores são em dólar — é a moeda em que o provedor de IA cobra.": {
    es: "Elige qué pasa cuando el gasto del mes llega al límite. Los montos están en dólares, la moneda en que cobra el proveedor de IA.",
  },
  "Este ponto usa o modelo definido na versão publicada do agente.": {
    es: "Este punto usa el modelo definido en la versión publicada del agente.",
  },
  "Ex.: Nunca prometa desconto sem confirmar com um humano. Horário de atendimento: 9h–18h, seg-sex. Sempre chame o cliente pelo primeiro nome.": {
    es: "Ej.: Nunca prometas un descuento sin confirmar con un humano. Horario de atención: 9h–18h, lun-vie. Llama siempre al cliente por su primer nombre.",
  },
  "Ex.: Não oferecer frete grátis no primeiro contato": { es: "Ej.: No ofrecer envío gratis en el primer contacto" },
  "Execuções de IA": { es: "Ejecuciones de IA" },
  "Fatos e correções pontuais que os agentes também levam em conta — adicionados à mão ou aprendidos automaticamente pelo sistema a partir de conversas reais.": {
    es: "Datos y correcciones puntuales que los agentes también toman en cuenta. Se agregan a mano o el sistema los aprende automáticamente de conversaciones reales.",
  },
  "Gasto de": { es: "Gasto de" },
  "Habilidades especializadas que seus agentes carregam só quando a conversa pede — instale prontas do catálogo ou envie a sua.": {
    es: "Habilidades especializadas que tus agentes cargan solo cuando la conversación lo requiere. Instala las que ya vienen listas en el catálogo o envía la tuya.",
  },
  "Habilidades instaladas": { es: "Habilidades instaladas" },
  "Habilidades mais usadas": { es: "Habilidades más usadas" },
  "Habilidades usadas": { es: "Habilidades usadas" },
  "Histórico de versões": { es: "Historial de versiones" },
  "IA parada por gasto": { es: "IA detenida por gasto" },
  Ignorada: { es: "Ignorada" },
  Ignorar: { es: "Ignorar" },
  "Instalando…": { es: "Instalando…" },
  Instalar: { es: "Instalar" },
  "Instalar uma habilidade": { es: "Instalar una habilidad" },
  "Instruções publicadas na Memória da IA. Valem para toda conversa, de todos os agentes.": {
    es: "Instrucciones publicadas en la Memoria de la IA. Se aplican en todas las conversaciones de todos los agentes.",
  },
  "Isto é só acompanhamento. A IA não vai parar sozinha por gasto.": {
    es: "Esto es solo seguimiento. La IA no se va a detener sola por gasto.",
  },
  "Já decididas": { es: "Ya decididas" },
  "Limite mensal (US$)": { es: "Límite mensual (US$)" },
  "Linha do tempo do aprendizado": { es: "Línea de tiempo del aprendizaje" },
  "Marcar resolvido": { es: "Marcar resuelto" },
  "Marcar todos resolvidos": { es: "Marcar todos como resueltos" },
  "Não foi possível resolver todos os avisos. Confira a lista e tente novamente.": {
    es: "No se pudieron resolver todos los avisos. Revisa la lista e inténtalo de nuevo.",
  },
  "Falha ao resolver os avisos.": { es: "Error al resolver los avisos." },
  "Me avisar ao passar de": { es: "Avisarme al pasar de" },
  "Melhorias que você aprovou": { es: "Mejoras que aprobaste" },
  "Memória da IA": { es: "Memoria de la IA" },
  "Mensagem técnica do provedor": { es: "Mensaje técnico del proveedor" },
  "Mostrando só as falhas": { es: "Mostrando solo las fallas" },
  "Mudanças de passo no atendimento": { es: "Cambios de paso en la atención" },
  "Negócios fechados pelo agente": { es: "Negocios cerrados por el agente" },
  "Negócios perdidos pelo agente": { es: "Negocios perdidos por el agente" },
  "Nenhum aprendizado ainda. Use \"+ Novo aprendizado\" para ensinar algo que os agentes devem lembrar em toda conversa — ou aguarde o sistema sugerir aprendizados automaticamente a partir do atendimento real.": {
    es: "Todavía no hay aprendizajes. Usa \"+ Nuevo aprendizaje\" para enseñar algo que los agentes deban recordar en todas las conversaciones, o espera a que el sistema sugiera aprendizajes automáticamente a partir de la atención real.",
  },
  "Nenhum aprendizado arquivado.": { es: "No hay aprendizajes archivados." },
  "Nenhum aviso em aberto": { es: "No hay avisos abiertos" },
  "Nenhum aviso resolvido": { es: "No hay avisos resueltos" },
  "Nenhuma conversa foi classificada por assunto. Os assuntos são os que você cadastra no roteador do seu número.": {
    es: "No se clasificó ninguna conversación por asunto. Los asuntos son los que registras en el enrutador de tu número.",
  },
  "Nenhuma conversa foi encaminhada. Isso só acontece em números que têm um roteador configurado — sem ele, tudo cai no atendimento padrão.": {
    es: "No se enrutó ninguna conversación. Esto solo ocurre en números que tienen un enrutador configurado; sin él, todo va a la atención estándar.",
  },
  "Nenhuma decisão registrada ainda": { es: "Todavía no hay decisiones registradas" },
  "Nenhuma execução ainda. Assim que o agente atender alguém, aparece aqui.": {
    es: "Todavía no hay ejecuciones. En cuanto el agente atienda a alguien, aparecerá aquí.",
  },
  "Nenhuma falha": { es: "Sin fallas" },
  "Nenhuma falha registrada.": { es: "No hay fallas registradas." },
  "Nenhuma habilidade foi usada neste período, então não há o que ranquear.": {
    es: "No se usó ninguna habilidad en este período, así que no hay nada que ordenar.",
  },
  "Nenhuma habilidade foi usada. Ou o agente ainda não tem nenhuma instalada, ou as conversas do período não pediram nenhuma.": {
    es: "No se usó ninguna habilidad. Puede que el agente todavía no tenga ninguna instalada, o que las conversaciones del período no hayan requerido ninguna.",
  },
  "Nenhuma proposta esperando você": { es: "No hay propuestas esperando tu decisión" },
  "Nenhuma skill instalada ainda. Instale uma pronta do catálogo abaixo ou envie a sua em \"Enviar skill (.zip)\".": {
    es: "Todavía no hay skills instaladas. Instala una del catálogo de abajo o sube la tuya con \"Subir skill (.zip)\".",
  },
  "Nenhuma skill nova no catálogo — você já instalou tudo que a plataforma oferece hoje.": {
    es: "No hay skills nuevas en el catálogo: ya instalaste todo lo que la plataforma ofrece hoy.",
  },
  "Nenhuma versão publicada ainda": { es: "Todavía no hay versiones publicadas" },
  'Nesta instalação a proteção só avisa: mesmo com "Parar a IA" escolhido, ela vai continuar respondendo. Quem administra a instalação escolheu assim em Comportamento, no Admin.': {
    es: "En esta instalación la protección solo avisa: aunque elijas \"Detener la IA\", la IA seguirá respondiendo. Quien administra la instalación lo configuró así en Comportamiento, dentro de Admin.",
  },
  "Novo aprendizado": { es: "Nuevo aprendizaje" },
  "Não consegui carregar a configuração de IA": { es: "No pude cargar la configuración de IA" },
  "Não consegui carregar as execuções": { es: "No pude cargar las ejecuciones" },
  "Não conseguimos carregar os números agora. Recarregue a página em alguns instantes — se continuar assim, avise quem cuida da sua instalação.": {
    es: "No pudimos cargar los números en este momento. Recarga la página en unos instantes. Si el problema continúa, avisa a quien administra tu instalación.",
  },
  "O agente não consultou seus materiais. Ou não há nada publicado na base de conhecimento, ou as conversas não chegaram a precisar.": {
    es: "El agente no consultó tus materiales. Puede que no haya nada publicado en la base de conocimiento, o que las conversaciones no lo hayan necesitado.",
  },
  "O catálogo deste provedor ainda não foi baixado. Digite o identificador do modelo como o provedor o nomeia — a lista completa aparece sozinha depois da primeira sincronização.": {
    es: "Aún no se descargó el catálogo de este proveedor. Escribe el identificador del modelo tal como lo nombra el proveedor; la lista completa aparecerá sola después de la primera sincronización.",
  },
  "O que aconteceu:": { es: "Qué pasó:" },
  "O que ele fez": { es: "Lo que hizo" },
  "O que está travando": { es: "Lo que está frenando" },
  "O que fazer:": { es: "Qué hacer:" },
  "O que mudou no resultado": { es: "Lo que cambió en el resultado" },
  "O que o agente deve saber": { es: "Lo que el agente debe saber" },
  "O que o assistente precisou escalar para o time: conexões caídas, tarefas que falharam, atendimentos passados a humanos.": {
    es: "Lo que el asistente tuvo que escalar al equipo: conexiones caídas, tareas que fallaron y atenciones que pasaron a una persona.",
  },
  "O que os clientes mais quiseram, segundo o que o roteador entendeu de cada conversa.": {
    es: "Lo que más buscaron los clientes, según lo que el enrutador entendió en cada conversación.",
  },
  "O que seu agente aprendeu": { es: "Lo que tu agente aprendió" },
  "O que seu agente aprendeu no período, o que ele fez com isso, o que mudou no seu resultado — e o que ainda está travando.": {
    es: "Lo que tu agente aprendió en el período, lo que hizo con eso, lo que cambió en tu resultado y lo que sigue frenando.",
  },
  "O que seus agentes já sabem fazer além da conversa comum — cada skill só entra em ação quando o assunto pede.": {
    es: "Lo que tus agentes ya saben hacer más allá de la conversación normal. Cada skill solo entra en acción cuando el tema lo requiere.",
  },
  "O que você pagou aos provedores de IA para tudo isto acontecer.": {
    es: "Lo que pagaste a los proveedores de IA para que todo esto pasara.",
  },
  "O texto-base que qualquer agente de IA lê antes de responder — como a \"política da casa\" que todo atendente novo teria que decorar.": {
    es: "El texto base que cualquier agente de IA lee antes de responder, como la \"política de la casa\" que tendría que aprenderse de memoria todo asesor nuevo.",
  },
  "O trabalho do dia a dia: quantas vezes ele usou cada recurso que você deu a ele.": {
    es: "El trabajo del día a día: cuántas veces usó cada recurso que le diste.",
  },
  Ocultar: { es: "Ocultar" },
  "Onde o agente mais precisou de conhecimento especializado.": {
    es: "Dónde necesitó el agente más conocimiento especializado.",
  },
  "Orçamento de IA": { es: "Presupuesto de IA" },
  "Orçamento mensal de IA": { es: "Presupuesto mensual de IA" },
  "Para avisar ou parar no limite, ele precisa ser de pelo menos": {
    es: "Para avisar o detenerse en el límite, tiene que ser de al menos",
  },
  "Para personalizar uma skill instalada, basta reenviar um .zip com o mesmo nome — a sua versão passa a valer no lugar da do catálogo. Não há editor dentro do sistema nesta fase.": {
    es: "Para personalizar una skill instalada, solo reenvía un .zip con el mismo nombre: tu versión reemplaza a la del catálogo. Por ahora no hay un editor dentro del sistema.",
  },
  "Parar a IA ao chegar em": { es: "Detener la IA al llegar a" },
  "Passaram para uma pessoa": { es: "Pasaron a una persona" },
  "Passou do limite": { es: "Pasó del límite" },
  "Período analisado": { es: "Período analizado" },
  Provedor: { es: "Proveedor" },
  "Próximos passos que o assistente sugeriu e esperam sua decisão. Aprovar e ignorar são registrados — ignorar é uma decisão, não a falta dela.": {
    es: "Próximos pasos que el asistente sugirió y esperan tu decisión. Tanto aprobar como ignorar quedan registrados: ignorar también es una decisión.",
  },
  "Publicada em": { es: "Publicada el" },
  "Publicar material": { es: "Publicar material" },
  "Publicar uma regra": { es: "Publicar una regla" },
  "Publicar versão": { es: "Publicar versión" },
  "Quando isso acontecer, as conversas em andamento vão para a fila de atendimento humano e voltam ao automático uma a uma, pelo cabeçalho de cada conversa.": {
    es: "Cuando eso pase, las conversaciones en curso pasan a la fila de atención humana. Después puedes devolverlas al modo automático una por una, desde el encabezado de cada conversación.",
  },
  "Quando o assistente precisar de você, o aviso aparece aqui.": {
    es: "Cuando el asistente te necesite, el aviso aparece aquí.",
  },
  "Quando o assistente sugerir um próximo passo, ele aparece aqui — e some daqui assim que você decidir.": {
    es: "Cuando el asistente sugiera un próximo paso, aparecerá aquí y desaparecerá en cuanto decidas.",
  },
  "Quantas vezes o agente foi procurar a resposta no que você escreveu, em vez de improvisar.": {
    es: "Cuántas veces el agente fue a buscar la respuesta en lo que escribiste, en vez de improvisar.",
  },
  "Quantas vezes o agente puxou uma habilidade especializada para dar conta da conversa.": {
    es: "Cuántas veces el agente recurrió a una habilidad especializada para manejar la conversación.",
  },
  "Quantas vezes o sistema leu o que o cliente queria e escolheu qual atendimento devia responder.": {
    es: "Cuántas veces el sistema leyó lo que el cliente quería y eligió qué atención debía responder.",
  },
  "Quanto a inteligência artificial custou, quantos atendimentos ela fez, quanto demorou para responder e quantas vezes precisou chamar uma pessoa — nos últimos 30 dias.": {
    es: "Cuánto costó la inteligencia artificial, cuántas conversaciones atendió, cuánto tardó en responder y cuántas veces necesitó llamar a una persona en los últimos 30 días.",
  },
  "Quanto foi para uma pessoa (%)": { es: "Cuánto pasó a una persona (%)" },
  "Quanto gastou por dia (R$)": { es: "Cuánto gastaste por día (R$)" },
  Reabrir: { es: "Reabrir" },
  Reativar: { es: "Reactivar" },
  "Regras e aprendizados que TODOS os agentes de IA desta organização seguem em qualquer conversa — não é uma configuração de um agente específico.": {
    es: "Reglas y aprendizajes que TODOS los agentes de IA de esta organización siguen en cualquier conversación. No es la configuración de un agente en particular.",
  },
  "Regras que você ensinou": { es: "Reglas que enseñaste" },
  Resolvidos: { es: "Resueltos" },
  "Restaurar como nova versão": { es: "Restaurar como nueva versión" },
  "Salvando...": { es: "Guardando..." },
  "Salvar aprendizado": { es: "Guardar aprendizaje" },
  "Se falhar:": { es: "Si falla:" },
  "Sem dados no período": { es: "Sin datos en el período" },
  "Sem limite definido — a IA não vai parar sozinha por gasto.": {
    es: "Sin límite definido — la IA no se va a detener sola por gasto.",
  },
  "Seu agente ainda não aprendeu nada neste período. Ele aprende de três jeitos: você publica uma regra na Memória da IA, aprova uma sugestão de melhoria na aba Propostas do agente, ou instala uma habilidade em Skills da IA.": {
    es: "Tu agente todavía no aprendió nada en este período. Puede aprender de tres formas: cuando publicas una regla en la Memoria de la IA, cuando apruebas una sugerencia de mejora en la pestaña Propuestas del agente o cuando instalas una habilidad en Skills de la IA.",
  },
  "Seu sistema usa inteligência artificial em": { es: "Tu sistema usa inteligencia artificial en" },
  "Skills da IA": { es: "Skills de la IA" },
  "Skills instaladas": { es: "Skills instaladas" },
  "Skills prontas, mantidas pela plataforma, disponíveis para instalar com um clique.": {
    es: "Skills listas para usar, mantenidas por la plataforma e instalables con un clic.",
  },
  "Skills que o agente passou a carregar quando a conversa pede — por exemplo, fechar um agendamento.": {
    es: "Skills que el agente empezó a cargar cuando la conversación lo pide, por ejemplo para concretar una cita.",
  },
  "Somente admins podem publicar uma nova versão.": { es: "Solo los admins pueden publicar una nueva versión." },
  "Sugestões que o sistema tirou dos próprios atendimentos e que você revisou e aceitou.": {
    es: "Sugerencias que el sistema sacó de las propias atenciones y que revisaste y aceptaste.",
  },
  "Só acompanhar": { es: "Solo monitorear" },
  "Tempo de resposta": { es: "Tiempo de respuesta" },
  "Tempo de resposta por dia (segundos)": { es: "Tiempo de respuesta por día (segundos)" },
  "Tentar de novo": { es: "Intentar de nuevo" },
  "Tipo de uso": { es: "Tipo de uso" },
  "Todos os números desta página são só deste intervalo. Mude as datas para comparar um mês com o outro.": {
    es: "Todos los números de esta página corresponden solo a este intervalo. Cambia las fechas para comparar un mes con otro.",
  },
  Tokens: { es: "Tokens" },
  "Tudo o que entrou na cabeça dele neste período, e de onde veio.": {
    es: "Todo lo que entró en su cabeza en este período, y de dónde vino.",
  },
  "Tudo que a inteligência artificial fez por aqui — e, quando algo falhou, o que aconteceu e o que fazer.": {
    es: "Todo lo que la inteligencia artificial hizo por aquí — y, cuando algo falló, qué pasó y qué hacer.",
  },
  "Usando:": { es: "Usando:" },
  "Uso de IA": { es: "Uso de IA" },
  "Ver aprendizados arquivados": { es: "Ver aprendizajes archivados" },
  "Ver aprendizados ativos": { es: "Ver aprendizajes activos" },
  "Ver habilidades disponíveis": { es: "Ver habilidades disponibles" },
  "Ver sugestões de melhoria": { es: "Ver sugerencias de mejora" },
  "Ver só as falhas": { es: "Ver solo las fallas" },
  "Você ainda não cadastrou nenhuma chave de provedor. Enquanto isso, tudo usa a chave que veio na instalação.": {
    es: "Todavía no registraste ninguna clave de proveedor. Mientras tanto, todo usa la clave que vino con la instalación.",
  },
  "Volume de texto processado por dia": { es: "Volumen de texto procesado por día" },
  "a cada 100": { es: "por cada 100" },
  "a maioria responde em": { es: "la mayoría responde en" },
  "agora usa": { es: "ahora usa" },
  "aprendido automaticamente": { es: "aprendido automáticamente" },
  ativa: { es: "activa" },
  "atualizada em": { es: "actualizada el" },
  caracteres: { es: "caracteres" },
  "carregado no editor. Clique em \"Publicar versão\" para confirmar.": {
    es: "cargado en el editor. Haz clic en \"Publicar versión\" para confirmar.",
  },
  código: { es: "código" },
  "da instalação": { es: "de la instalación" },
  "depois de salvar. É o tempo de você ver o aviso chegar antes que alguma conversa pare.": {
    es: "después de guardar. Es el tiempo para que veas llegar el aviso antes de que alguna conversación se detenga.",
  },
  "desinstalada.": { es: "desinstalada." },
  "do catálogo": { es: "del catálogo" },
  "do limite": { es: "del límite" },
  "do limite. A IA não para.": { es: "del límite. La IA no se detiene." },
  "enviada e instalada com sucesso.": { es: "enviada e instalada con éxito." },
  escolha: { es: "elige" },
  "este é o pior caso comum": { es: "este es el peor caso común" },
  "execuções falharam.": { es: "ejecuciones fallaron." },
  "execuções.": { es: "ejecuciones." },
  falhou: { es: "falló" },
  fixo: { es: "fijo" },
  "gastos de": { es: "gastados de" },
  "gastos este mês": { es: "gastados este mes" },
  horas: { es: "horas" },
  "instalada — já vale para os agentes desta organização.": {
    es: "instalada — ya está disponible para los agentes de esta organización.",
  },
  "lugares diferentes. Aqui você vê qual está atendendo cada um — e troca, se quiser.": {
    es: "lugares diferentes. Aquí ves cuál atiende en cada uno y puedes cambiarlo si quieres.",
  },
  manual: { es: "manual" },
  "menos de 0,1 a cada 100": { es: "menos de 0,1 por cada 100" },
  "nas últimas": { es: "en las últimas" },
  "no dia": { es: "en el día" },
  "no período": { es: "en el período" },
  "não consegui carregar": { es: "no pude cargar" },
  "não consegui carregar a configuração": { es: "no pude cargar la configuración" },
  "não consegui falar com o servidor": { es: "no pude comunicarme con el servidor" },
  "não consegui salvar": { es: "no pude guardar" },
  "não definido": { es: "no definido" },
  "pior caso comum": { es: "peor caso común" },
  ponto: { es: "punto" },
  pontos: { es: "puntos" },
  "pontos deste grupo precisam da sua atenção.": { es: "puntos de este grupo necesitan tu atención." },
  por: { es: "por" },
  "por mês. Abaixo disso não é orçamento de": { es: "por mes. Por debajo de eso no es presupuesto de" },
  "precisa de ferramentas": { es: "necesita herramientas" },
  "publicada — já vale para todos os agentes.": { es: "publicada — ya se aplica a todos los agentes." },
  "quanto mais alto, mais a IA precisou de ajuda": { es: "cuanto más alto, más ayuda necesitó la IA" },
  "resposta inesperada do servidor": { es: "respuesta inesperada del servidor" },
  "sem ferramentas": { es: "sin herramientas" },
  "um atendimento — é erro de digitação. Se você só quer acompanhar o gasto sem limite, escolha \"Só acompanhar\".": {
    es: "una atención — es un error al escribir. Si solo quieres monitorear el gasto sin límite, elige \"Solo monitorear\".",
  },
  "valores em dólar (é a moeda em que o provedor de IA cobra)": {
    es: "valores en dólares (es la moneda en la que cobra el proveedor de IA)",
  },
  "⚠️ Atenção: o produto ainda não sabe o preço do modelo em uso, então o gasto medido é menor que o real e esta parada pode não disparar.": {
    es: "⚠️ Atención: el producto todavía no conoce el precio del modelo en uso. Por eso el gasto medido es menor que el real y es posible que esta detención no se active.",
  },
  "O que aconteceu com os seus negócios neste período. Para saber se melhorou, mude as datas acima e compare com o mês anterior.": {
    es: "Lo que pasó con tus negocios en este período. Para saber si mejoró, cambia las fechas de arriba y compara con el mes anterior.",
  },
  "Clientes que o agente marcou como fechados. Negócio que a sua equipe fechou na mão, movendo o cartão no quadro, não entra aqui.": {
    es: "Clientes que el agente marcó como cerrados. Los negocios que tu equipo cerró a mano, moviendo la tarjeta en el tablero, no se cuentan aquí.",
  },
  "Clientes que o agente marcou como perdidos — contraponto necessário, porque ganhos sem perdidos ao lado enganam. Também não conta o que a sua equipe marcou na mão.": {
    es: "Clientes que el agente marcó como perdidos. Es un contrapeso necesario, porque mostrar solo los negocios cerrados, sin los perdidos al lado, engaña. Tampoco cuenta lo que tu equipo marcó a mano.",
  },
  "Quantas vezes o agente registrou que um cliente mudou de passo no atendimento — o sinal de que a conversa andou, e não só aconteceu. Inclui as mudanças para fechado e para perdido, então não leia como só progresso. Cartão movido à mão no quadro não entra aqui.": {
    es: "Cuántas veces el agente registró que un cliente cambió de paso en la atención. Es la señal de que la conversación avanzó y no solo ocurrió. Incluye los cambios a cerrado y a perdido, así que no lo interpretes solo como progreso. Las tarjetas movidas a mano en el tablero no se cuentan aquí.",
  },
  "Conversas que o agente passou para um atendente humano, a cada 100 mensagens recebidas. Leia como estimativa: no geral o mesmo caso conta uma vez só, mesmo que o cliente peça ajuda várias vezes, mas em parte dos atendimentos ele pode contar mais de uma.": {
    es: "Conversaciones que el agente pasó a una persona, por cada 100 mensajes recibidos. Tómalo como una estimación: en general un mismo caso cuenta una sola vez, aunque el cliente pida ayuda varias veces, pero en algunas atenciones puede contar más de una vez.",
  },
  "Não houve atendimento neste período, então os zeros abaixo querem dizer \"nada aconteceu\", e não \"foi mal\". Mude as datas acima para um período com movimento.": {
    es: "No hubo atención en este período, así que los ceros de abajo significan \"no pasó nada\", no que algo haya salido mal. Elige un período con movimiento en las fechas de arriba.",
  },
  "Parte do que a IA gastou este mês não entra nesta conta: o produto ainda não sabe o preço do modelo que está em uso, então o número abaixo é MENOR que o real e a parada no limite pode não acontecer. Enquanto isso, acompanhe o gasto direto no painel do seu provedor de IA.": {
    es: "Parte de lo que gastó la IA este mes no entra en este cálculo: el producto todavía no conoce el precio del modelo en uso, así que el número de abajo es MENOR que el real y es posible que la detención al llegar al límite no ocurra. Mientras tanto, consulta el gasto directamente en el panel de tu proveedor de IA.",
  },
  "Atender o cliente": {
    es: "Atender al cliente",
  },
  "Escrever o que o cliente lê e agir no funil durante a conversa.": {
    es: "Escribir lo que el cliente lee y actuar en el embudo durante la conversación.",
  },
  "Entender a conversa": {
    es: "Entender la conversación",
  },
  "Ler o que chegou e decidir o que aquilo significa para o negócio.": {
    es: "Leer lo que llegó y decidir qué significa eso para el negocio.",
  },
  "Proteger a operação": {
    es: "Proteger la operación",
  },
  "Barrar manipulação e promessa que a empresa não pode cumprir.": {
    es: "Frenar la manipulación y las promesas que la empresa no puede cumplir.",
  },
  "Lembrar e buscar": {
    es: "Recordar y buscar",
  },
  "Guardar o essencial da conversa e achar o material certo do seu negócio.": {
    es: "Guardar lo esencial de la conversación y encontrar el material correcto de tu negocio.",
  },
  "Ver e ouvir": {
    es: "Ver y oír",
  },
  "Transformar áudio, imagem e vídeo do cliente em texto que o agente entende.": {
    es: "Transformar audio, imagen y video del cliente en texto que el agente entiende.",
  },
  "Melhorar e testar": {
    es: "Mejorar y probar",
  },
  "Avaliar o próprio desempenho e conferir se a configuração está de pé.": {
    es: "Evaluar su propio desempeño y comprobar que la configuración funcione bien.",
  },
  "Responder o cliente": {
    es: "Responder al cliente",
  },
  "Escreve a resposta que o cliente lê no WhatsApp, consultando o material do seu negócio e usando as ferramentas do CRM.": {
    es: "Escribe la respuesta que el cliente lee en WhatsApp, consultando el material de tu negocio y usando las herramientas del CRM.",
  },
  "O cliente manda mensagem e ninguém responde. A conversa fica parada na Caixa de entrada sem aviso.": {
    es: "El cliente manda un mensaje y nadie responde. La conversación se queda parada en la Bandeja de entrada, sin aviso.",
  },
  "Trabalhar o funil": {
    es: "Trabajar el embudo",
  },
  "Cria o lead, move de etapa e registra o que ficou combinado, enquanto a conversa acontece.": {
    es: "Crea el lead, lo mueve de etapa y registra lo acordado mientras avanza la conversación.",
  },
  "O cliente é atendido normalmente, mas nada aparece no funil — nenhum lead criado, nenhuma etapa movida.": {
    es: "El cliente recibe atención normal, pero en el embudo no aparece nada: ni leads nuevos ni cambios de etapa.",
  },
  "Abordar quem preencheu o formulário": {
    es: "Abordar a quien completó el formulario",
  },
  "Escreve a primeira mensagem para quem acabou de preencher um formulário, usando os campos que a pessoa respondeu e a orientação que você deu na automação.": {
    es: "Escribe el primer mensaje para quien acaba de completar un formulario, a partir de sus respuestas y de las indicaciones que diste en la automatización.",
  },
  "O lead entra pelo formulário, a automação roda, e a mensagem de abordagem nunca é escrita — o contato fica no funil sem ninguém falar com ele.": {
    es: "El lead llega por el formulario y la automatización se ejecuta, pero el mensaje inicial nunca se escribe. El contacto queda en el embudo sin que nadie le hable.",
  },
  "Sugerir resposta ao atendente": {
    es: "Sugerir respuesta al asesor humano",
  },
  "Escreve um rascunho de resposta para o atendente humano revisar antes de enviar.": {
    es: "Escribe un borrador de respuesta para que el asesor humano lo revise antes de enviarlo.",
  },
  "O botão de sugerir resposta não traz nada, e o atendente escreve do zero sem saber por quê.": {
    es: "El botón de sugerir respuesta no muestra nada y el asesor humano escribe desde cero sin saber por qué.",
  },
  "Responder (motor antigo)": {
    es: "Responder (motor antiguo)",
  },
  "Caminho de resposta anterior ao motor de agentes atual, mantido para instalações que ainda o usam.": {
    es: "Flujo de respuesta anterior al motor de agentes actual. Se mantiene para las instalaciones que todavía lo usan.",
  },
  "Nas instalações que ainda dependem dele, o cliente fica sem resposta e a conversa não avança.": {
    es: "En las instalaciones que todavía dependen de él, el cliente se queda sin respuesta y la conversación no avanza.",
  },
  "Escolher qual agente atende": {
    es: "Elegir qué agente atiende",
  },
  "Lê a mensagem que chegou e decide qual dos seus agentes deve pegar aquela conversa.": {
    es: "Lee el mensaje que llegó y decide cuál de tus agentes debe tomar esa conversación.",
  },
  "A conversa cai sempre no mesmo agente, ou em nenhum — como se os roteadores que você configurou não existissem.": {
    es: "La conversación cae siempre en el mismo agente, o en ninguno — como si los enrutadores que configuraste no existieran.",
  },
  "Identificar a etapa do lead": {
    es: "Identificar la etapa del lead",
  },
  "Lê a conversa e sugere em que etapa do funil aquele cliente está de verdade.": {
    es: "Lee la conversación y sugiere en qué etapa del embudo está realmente ese cliente.",
  },
  "Os leads param de andar sozinhos pelo funil e ficam todos na etapa em que entraram.": {
    es: "Los leads dejan de avanzar solos por el embudo y quedan todos en la etapa en la que entraron.",
  },
  "Medir o clima da conversa": {
    es: "Medir el clima de la conversación",
  },
  "Avalia se o cliente está satisfeito ou irritado, para escalar ao humano antes de perder a venda.": {
    es: "Evalúa si el cliente está satisfecho o molesto, para escalar a una persona antes de perder la venta.",
  },
  "Cliente irritado não é mais escalado para um humano, e a insatisfação só aparece quando ele já sumiu.": {
    es: "El cliente molesto deja de escalarse a una persona, y la insatisfacción solo se nota cuando el cliente ya desapareció.",
  },
  "Ler a resposta ao follow-up": {
    es: "Leer la respuesta al seguimiento",
  },
  "Entende se o cliente aceitou, recusou ou pediu para falar depois, e encaminha o fluxo conforme isso.": {
    es: "Entiende si el cliente aceptó, rechazó o pidió hablar más tarde, y dirige el flujo en consecuencia.",
  },
  "O follow-up trava no mesmo passo: o cliente respondeu, mas o fluxo não segue para lugar nenhum.": {
    es: "El seguimiento se traba en el mismo paso: el cliente respondió, pero el flujo no avanza a ningún lado.",
  },
  "Escolher a hora do follow-up": {
    es: "Elegir la hora del seguimiento",
  },
  "Decide o melhor momento para retomar uma conversa que esfriou.": {
    es: "Decide el mejor momento para retomar una conversación que se enfrió.",
  },
  "As retomadas saem todas no mesmo horário fixo, sem respeitar o ritmo de cada cliente.": {
    es: "Los seguimientos salen todos a la misma hora fija, sin respetar el ritmo de cada cliente.",
  },
  "Barrar tentativa de manipulação": {
    es: "Frenar intentos de manipulación",
  },
  "Percebe quando alguém tenta enganar o agente para ele fugir das suas regras.": {
    es: "Detecta cuando alguien intenta engañar al agente para que se salga de sus reglas.",
  },
  "O agente passa a aceitar instruções de estranhos e pode falar em nome da empresa coisas que você nunca autorizou.": {
    es: "El agente pasa a aceptar instrucciones de extraños y puede decir en nombre de la empresa cosas que nunca autorizaste.",
  },
  "Impedir promessa que não se cumpre": {
    es: "Impedir promesas que no se cumplen",
  },
  "Confere se a resposta promete prazo, desconto ou condição que a empresa não pode honrar.": {
    es: "Verifica si la respuesta promete un plazo, descuento o condición que la empresa no puede cumplir.",
  },
  "O agente promete ao cliente coisas que a operação não entrega, e a cobrança chega depois.": {
    es: "El agente le promete al cliente cosas que la operación no entrega, y el reclamo llega después.",
  },
  "Resumir a conversa longa": {
    es: "Resumir la conversación larga",
  },
  "Condensa uma conversa comprida no essencial, para o agente não perder o fio nem encarecer cada resposta.": {
    es: "Condensa una conversación larga en lo esencial, para que el agente no pierda el hilo ni encarezca cada respuesta.",
  },
  "Em conversas longas o agente esquece o que já foi combinado e começa a repetir perguntas.": {
    es: "En conversaciones largas el agente olvida lo que ya se acordó y empieza a repetir preguntas.",
  },
  "Guardar o combinado": {
    es: "Guardar lo acordado",
  },
  "Extrai da conversa os compromissos, objeções e dados do cliente antes de fechar o atendimento.": {
    es: "Extrae de la conversación los compromisos, objeciones y datos del cliente antes de cerrar la atención.",
  },
  "O que foi combinado com o cliente não fica registrado, e o próximo atendimento começa do zero.": {
    es: "Lo que se acordó con el cliente no queda registrado, y la próxima atención empieza de cero.",
  },
  "Fechar o atendimento": {
    es: "Cerrar la atención",
  },
  "Escreve o resumo de encerramento do turno, que o próximo atendimento lê ao abrir.": {
    es: "Escribe el resumen de cierre del turno para que la próxima atención lo lea al empezar.",
  },
  "Cada retomada de conversa parece a primeira: o agente não sabe o que aconteceu antes.": {
    es: "Cada vez que se retoma una conversación parece la primera: el agente no sabe qué pasó antes.",
  },
  "Indexar o seu material": {
    es: "Indexar tu material",
  },
  "Prepara os documentos do seu negócio para que o agente consiga encontrá-los na hora de responder.": {
    es: "Prepara los documentos de tu negocio para que el agente pueda encontrarlos a la hora de responder.",
  },
  "O material indexado e a busca precisam usar exatamente o mesmo modelo — são coordenadas de um mesmo mapa. Trocar só um dos lados não dá erro: o agente simplesmente para de achar o seu conteúdo, sem avisar. Para mudar de modelo aqui é preciso reindexar tudo de uma vez.": {
    es: "El material indexado y la búsqueda deben usar exactamente el mismo modelo, porque funcionan como coordenadas de un mismo mapa. Si cambias solo uno de los dos, no aparece ningún error: el agente simplemente deja de encontrar tu contenido, sin avisar. Para cambiar de modelo aquí, hay que reindexar todo de una vez.",
  },
  "Você sobe um documento e ele nunca fica pronto para uso; o agente responde sem conhecer o seu material.": {
    es: "Subes un documento y nunca queda listo para usar; el agente responde sin conocer tu material.",
  },
  "Buscar no seu material": {
    es: "Buscar en tu material",
  },
  "Encontra, entre os seus documentos, os trechos que respondem à pergunta do cliente.": {
    es: "Encuentra, entre tus documentos, los fragmentos que responden a la pregunta del cliente.",
  },
  "Precisa usar o mesmo modelo com que o material foi indexado. Se divergir, a busca continua funcionando e devolve resultados errados — falha silenciosa, e por isso a troca é feita junto com a reindexação, não aqui.": {
    es: "Debe usar el mismo modelo con el que se indexó el material. Si no coinciden, la búsqueda sigue funcionando, pero devuelve resultados incorrectos. Es una falla silenciosa, por eso el cambio se hace junto con la reindexación y no aquí.",
  },
  "O agente responde de forma genérica, ignorando o que está escrito nos seus documentos.": {
    es: "El agente responde de forma genérica, ignorando lo que está escrito en tus documentos.",
  },
  "Ouvir o áudio do cliente": {
    es: "Escuchar el audio del cliente",
  },
  "Transforma o áudio que o cliente mandou em texto que o agente lê.": {
    es: "Transforma el audio que envió el cliente en texto que el agente lee.",
  },
  "Usa o padrão de transcrição da OpenAI, que é o formato que os serviços do mercado implementam. Aceita apontar para outro serviço compatível — inclusive um rodando na sua própria máquina — mas exige uma chave desse serviço, separada da chave do modelo de conversa.": {
    es: "Usa el estándar de transcripción de OpenAI, el formato que implementan los servicios del mercado. Permite apuntar a otro servicio compatible, incluso uno que corra en tu propio equipo, pero requiere una clave de ese servicio, distinta de la clave del modelo de conversación.",
  },
  "O cliente manda áudio e o agente responde como se não tivesse recebido nada.": {
    es: "El cliente manda audio y el agente responde como si no hubiera recibido nada.",
  },
  "Ver a imagem do cliente": {
    es: "Ver la imagen del cliente",
  },
  "Descreve a foto, o print ou o comprovante que o cliente enviou, para o agente saber do que se trata.": {
    es: "Describe la foto, la captura o el comprobante que envió el cliente, para que el agente sepa de qué se trata.",
  },
  "O cliente manda uma foto do produto ou um comprovante e o agente age como se a imagem não existisse.": {
    es: "El cliente manda una foto del producto o un comprobante y el agente actúa como si la imagen no existiera.",
  },
  "Avaliar o próprio atendimento": {
    es: "Evaluar la propia atención",
  },
  "Revisa atendimentos já concluídos e julga quais foram bons, para o agente aprender com eles.": {
    es: "Revisa atenciones ya concluidas y evalúa cuáles fueron buenas, para que el agente aprenda de ellas.",
  },
  "A tela de Propostas para de sugerir melhorias, e o agente estaciona no desempenho atual.": {
    es: "La pantalla de Propuestas deja de sugerir mejoras, y el agente se estanca en el desempeño actual.",
  },
  "Extrair a lição": {
    es: "Extraer la lección",
  },
  "Transforma os bons atendimentos em orientação prática para o agente aplicar nos próximos.": {
    es: "Convierte las buenas atenciones en indicaciones prácticas que el agente pueda aplicar en las siguientes.",
  },
  "As melhorias identificadas não viram instrução, e o mesmo acerto precisa ser redescoberto toda vez.": {
    es: "Las mejoras detectadas no se convierten en instrucciones y hay que redescubrir el mismo acierto cada vez.",
  },
  "Testar a conexão com o provedor": {
    es: "Probar la conexión con el proveedor",
  },
  "Faz uma chamada de verdade ao provedor para confirmar que a chave e o modelo escolhidos funcionam.": {
    es: "Hace una llamada real al proveedor para confirmar que la clave y el modelo elegidos funcionan.",
  },
  "O botão de testar não conclui, e você fica sem saber se a configuração está de pé antes de colocar no ar.": {
    es: "El botón de probar no termina y no sabes si la configuración funciona antes de activarla.",
  },
  "Ensaiar o agente antes de publicar": {
    es: "Ensayar el agente antes de publicar",
  },
  "Roda o agente contra uma conversa de mentira, para você ver como ele responderia sem falar com cliente de verdade.": {
    es: "Ejecuta el agente con una conversación simulada, para que veas cómo respondería sin hablar con un cliente real.",
  },
  "Usa o modelo da versão do agente que você está ensaiando — e é exatamente isso que faz o ensaio valer. Se este ponto tivesse modelo próprio, você testaria uma configuração diferente da que vai publicar, e o ensaio deixaria de prever o comportamento real. Para trocar o modelo, troque na versão do agente.": {
    es: "Usa el modelo de la versión del agente que estás ensayando, y eso es justo lo que hace válido el ensayo. Si este punto tuviera un modelo propio, probarías una configuración distinta de la que vas a publicar y el ensayo dejaría de anticipar el comportamiento real. Para cambiar el modelo, hazlo en la versión del agente.",
  },
  "O ensaio do agente não devolve resposta, e você precisa publicar às cegas para descobrir se ficou bom.": {
    es: "El ensayo del agente no devuelve respuesta, y tienes que publicar a ciegas para descubrir si quedó bien.",
  },
  "Medir o tamanho do contexto": {
    es: "Medir el tamaño del contexto",
  },
  "Calcula quanto do limite do modelo a conversa já ocupa, para decidir a hora de resumir.": {
    es: "Calcula cuánto del límite del modelo ocupa ya la conversación, para saber cuándo resumir.",
  },
  "Cada família de modelo conta o tamanho do texto de um jeito próprio, então a medida precisa vir do mesmo provedor do modelo em uso — não é uma escolha à parte.": {
    es: "Cada familia de modelos mide el tamaño del texto a su manera, así que la medición debe venir del mismo proveedor que el modelo en uso. No es una elección independiente.",
  },
  "O sistema erra a hora de resumir a conversa: resume cedo demais e perde contexto, ou tarde demais e a resposta é recusada.": {
    es: "El sistema no acierta con el momento de resumir la conversación: resume demasiado pronto y pierde contexto, o demasiado tarde y la respuesta se rechaza.",
  },
  "O provedor não aceitou a chave. Confira se ela ainda é válida em Credenciais — chaves são revogadas ou expiram.": {
    es: "El proveedor no aceptó la clave. Revisa si todavía es válida en Credenciales — las claves se revocan o expiran.",
  },
  "O modelo escolhido não existe mais nesse provedor. Escolha outro no painel de Provedores.": {
    es: "El modelo elegido ya no existe en ese proveedor. Elige otro en el panel de Proveedores.",
  },
  "O provedor recusou por limite de uso ou saldo. Verifique o faturamento na conta do provedor.": {
    es: "El proveedor rechazó la llamada por límite de uso o de saldo. Revisa la facturación en la cuenta del proveedor.",
  },
  "O provedor está fora do ar ou demorou demais. Costuma se resolver sozinho; se persistir, troque de provedor nesse ponto.": {
    es: "El proveedor está caído o tardó demasiado. Suele resolverse solo; si persiste, cambia de proveedor en ese punto.",
  },
  "O modelo escolhido não sabe usar as ferramentas do CRM. Troque por um que saiba, no painel de Provedores.": {
    es: "El modelo elegido no sabe usar las herramientas del CRM. Cámbialo por uno que sepa, en el panel de Proveedores.",
  },
  "A IA parou porque o gasto do mês atingiu o limite que você definiu. Ajuste o limite (ou desligue a parada) em Uso de IA › Orçamento.": {
    es: "La IA se detuvo porque el gasto del mes llegó al límite que definiste. Ajusta el límite (o desactiva el corte) en Uso de IA › Presupuesto.",
  },
  "A chamada foi recusada porque este ponto usa um endereço próprio e a empresa não tem chave cadastrada para ele — a chave da instalação não vai para endereço escolhido pela empresa. Cadastre a chave da empresa em Agente de IA › Provedores, ou tire o endereço próprio do ponto.": {
    es: "Se rechazó la llamada porque este punto usa una dirección propia y la empresa no tiene una clave registrada para esa dirección. La clave de la instalación no se envía a direcciones que elige la empresa. Registra la clave de la empresa en Agente de IA › Proveedores o quita la dirección propia del punto.",
  },
  "Não conseguimos classificar esta falha. A mensagem original do provedor está abaixo.": {
    es: "No pudimos clasificar esta falla. El mensaje original del proveedor está abajo.",
  },
  "Definido na versão publicada do agente.": {
    es: "Definido en la versión publicada del agente.",
  },
  "Escolhido por você no painel de provedores.": {
    es: "Elegido por ti en el panel de proveedores.",
  },
  "Definido em variável de ambiente na instalação.": {
    es: "Definido en una variable de entorno de la instalación.",
  },
  "Herdado de quem disparou a chamada — o agente publicado, ou o roteador de intenção.": {
    es: "Heredado de quien inició la llamada: el agente publicado o el enrutador de intención.",
  },
  "Usando o padrão da organização.": {
    es: "Usando el valor predeterminado de la organización.",
  },
  "Default:": { es: "Predeterminado:" },
  "API key": { es: "Clave de API" },

  // ─── Admin de plataforma: casca (shell, sidebar, banner, impersonate) ───
  "Acesso negado": { es: "Acceso denegado" },
  "Esta área é restrita a administradores da plataforma com MFA ativo. Se você acredita que isso é um erro, contate o time de operações.": {
    es: "Esta área es solo para administradores de la plataforma con MFA activo. Si crees que es un error, contacta al equipo de operaciones.",
  },
  "Voltar para /app": { es: "Volver a /app" },
  "Menu de navegação": { es: "Menú de navegación" },
  "Abrir menu de navegação": { es: "Abrir menú de navegación" },
  "Admin Plataforma": { es: "Admin de la plataforma" },
  "MODO PLATAFORMA": { es: "MODO PLATAFORMA" },
  "— operação cross-tenant": { es: "— operación cross-tenant" },
  "Modo Plataforma": { es: "Modo plataforma" },
  "Sair pra app pessoal": { es: "Salir a la app personal" },
  "Navegação plataforma": { es: "Navegación de la plataforma" },
  "Voltar pra app": { es: "Volver a la app" },
  Dashboard: { es: "Panel" },
  Tenants: { es: "Tenants" },
  Audit: { es: "Auditoría" },
  Incidents: { es: "Incidentes" },
  Usage: { es: "Uso" },
  Users: { es: "Usuarios" },
  "Platform Admins": { es: "Administradores de la plataforma" },
  Marca: { es: "Marca" },
  LGPD: { es: "LGPD" },
  "Não foi possível iniciar impersonate": { es: "No se pudo iniciar el impersonate" },
  "Erro de rede ao iniciar impersonate": { es: "Error de red al iniciar el impersonate" },
  "Impersonate indisponível": { es: "Impersonate no disponible" },
  "Acompanhar": { es: "Dar seguimiento" },
  "Acompanhe": { es: "Da seguimiento a" },
  "Acompanhar organização": { es: "Dar seguimiento a la organización" },
  "Iniciar acompanhamento?": { es: "¿Iniciar seguimiento?" },
  "com sua identidade de administrador. As ações pelo aplicativo serão registradas em seu nome. O acesso dura até uma hora.": { es: "con tu identidad de administrador. Las acciones que hagas en la aplicación quedarán registradas a tu nombre. El acceso dura hasta una hora." },
  "Acompanhamento encerrado": { es: "Seguimiento finalizado" },
  "Suporte à organização": { es: "Soporte a la organización" },
  "Edição permitida": { es: "Edición permitida" },
  "Sair do acompanhamento": { es: "Salir del seguimiento" },
  "Encerre o acompanhamento para continuar": { es: "Finaliza el seguimiento para continuar" },
  "O prazo ou as permissões desta sessão mudaram. Saia do acompanhamento para voltar à sua organização.": { es: "El plazo o los permisos de esta sesión cambiaron. Sal del seguimiento para volver a tu organización." },
  Impersonar: { es: "Impersonar" },
  "Impersonar tenant": { es: "Impersonar tenant" },
  "Iniciar impersonate?": { es: "¿Iniciar el impersonate?" },
  "Você está prestes a entrar como o tenant": { es: "Estás a punto de entrar como el tenant" },
  "Toda ação será registrada com a flag": { es: "Toda acción quedará registrada con el flag" },
  "A sessão expira em 1 hora. Confirma?": { es: "La sesión expira en 1 hora. ¿Confirmas?" },
  "Entrando…": { es: "Entrando…" },
  "Confirmar e entrar": { es: "Confirmar y entrar" },

  // ─── Admin de plataforma: Dashboard ───
  "Visão cross-tenant — atualiza a cada 30 segundos.": {
    es: "Vista cross-tenant. Se actualiza cada 30 segundos.",
  },
  "IA Budget": { es: "Presupuesto IA" },
  Overflow: { es: "Desborde" },
  Crítico: { es: "Crítico" },
  Atenção: { es: "Atención" },
  Info: { es: "Info" },
  "Nenhum alerta crítico no momento. Tudo certo!": {
    es: "No hay alertas críticas en este momento. ¡Todo en orden!",
  },
  "Alertas ativos": { es: "Alertas activas" },
  alerta: { es: "alerta" },
  alertas: { es: "alertas" },
  "alertas adicionais": { es: "alertas adicionales" },
  "Tenants Ativos": { es: "Tenants activos" },
  "organizações ativas": { es: "organizaciones activas" },
  "Pendentes >10min": { es: "Pendientes >10min" },
  "conversas sem resposta": { es: "conversaciones sin respuesta" },
  "sessões com problema": { es: "sesiones con problema" },
  "LGPD em Risco": { es: "LGPD en riesgo" },
  "requisições próximas do prazo": { es: "solicitudes próximas a vencer" },
  "Budgets IA": { es: "Presupuestos IA" },
  "tenants com gasto acumulado ≥80% do teto": {
    es: "tenants con gasto acumulado ≥80% del tope",
  },

  // ─── Admin de plataforma: Tenants (lista + criação) ───
  "Novo tenant": { es: "Nuevo tenant" },
  "Buscar por nome, slug ou CNPJ...": { es: "Buscar por nombre, slug o CNPJ..." },
  "Buscar tenants": { es: "Buscar tenants" },
  Onboarding: { es: "Onboarding" },
  Suspenso: { es: "Suspendido" },
  Redigido: { es: "Anonimizado" },
  Conversas: { es: "Conversaciones" },
  "Nenhum tenant encontrado": { es: "No se encontró ningún tenant" },
  "Ajuste os filtros ou crie um novo tenant.": {
    es: "Ajusta los filtros o crea un nuevo tenant.",
  },
  Ver: { es: "Ver" },
  "Tenant criado com sucesso!": { es: "¡Tenant creado con éxito!" },
  "Este slug já está em uso": { es: "Este slug ya está en uso" },
  "Erro ao criar tenant:": { es: "Error al crear el tenant:" },
  "Erro inesperado ao criar tenant": { es: "Error inesperado al crear el tenant" },
  "Novo Tenant": { es: "Nuevo tenant" },
  "Cria um novo tenant com status": { es: "Crea un nuevo tenant con estado" },
  "Dados do tenant": { es: "Datos del tenant" },
  "Loja da Maria": { es: "Tienda de María" },
  "Mínimo 2 caracteres": { es: "Mínimo 2 caracteres" },
  "Máximo 120 caracteres": { es: "Máximo 120 caracteres" },
  "Máximo 40 caracteres": { es: "Máximo 40 caracteres" },
  "Apenas letras minúsculas, números e hífens": {
    es: "Solo letras minúsculas, números y guiones",
  },
  "Apenas letras minúsculas, números e hífens. Gerado automaticamente.": {
    es: "Solo letras minúsculas, números y guiones. Se genera automáticamente.",
  },
  "Maria da Silva LTDA": { es: "María García LTDA" },
  "E-mail inválido": { es: "Email inválido" },
  Plano: { es: "Plan" },
  "E-mail do responsável": { es: "Email del responsable" },
  "Criando...": { es: "Creando..." },
  "Criar tenant": { es: "Crear tenant" },

  // ─── Admin de plataforma: Tenant detail (layout, overview, ações) ───
  "Visão Geral": { es: "Vista general" },
  Saúde: { es: "Salud" },
  "em breve": { es: "próximamente" },
  "Não foi possível carregar os dados do tenant. Tente recarregar a página.": {
    es: "No se pudieron cargar los datos del tenant. Intenta recargar la página.",
  },
  Conectando: { es: "Conectando" },
  Conectado: { es: "Conectado" },
  "Token expirado": { es: "Token expirado" },
  "Permissão faltando": { es: "Permiso faltante" },
  Desconectado: { es: "Desconectado" },
  "Limitado (rate limit)": { es: "Limitado (rate limit)" },
  "Com erro": { es: "Con error" },
  "Não integrado": { es: "No integrado" },
  Informações: { es: "Información" },
  "Onboarding concluído": { es: "Onboarding concluido" },
  "Suspenso em": { es: "Suspendido el" },
  Volumes: { es: "Volúmenes" },
  Usuários: { es: "Usuarios" },
  Mensagens: { es: "Mensajes" },
  Leads: { es: "Leads" },
  Pedidos: { es: "Pedidos" },
  Integrações: { es: "Integraciones" },
  "Conectado em": { es: "Conectado el" },
  "Compliance & IA": { es: "Compliance y IA" },
  "Solicitações LGPD pendentes": { es: "Solicitudes LGPD pendientes" },
  "Pendências LGPD": { es: "Pendientes LGPD" },
  "Invocações IA (30d)": { es: "Invocaciones IA (30d)" },
  "Tenant redigido — ação não disponível": { es: "Tenant anonimizado — acción no disponible" },
  "Suspender tenant": { es: "Suspender tenant" },
  "Reativar tenant": { es: "Reactivar tenant" },
  "Tenant redigido — ações de gestão não disponíveis.": {
    es: "Tenant anonimizado — acciones de gestión no disponibles.",
  },
  hoje: { es: "hoy" },
  ontem: { es: "ayer" },
  semana: { es: "semana" },
  semanas: { es: "semanas" },
  "mês": { es: "mes" },
  meses: { es: "meses" },
  ano: { es: "año" },
  anos: { es: "años" },
  "Tenant Suspenso": { es: "Tenant suspendido" },
  "Tenant suspenso": { es: "Tenant suspendido" },
  "Sem razão registrada.": { es: "Sin motivo registrado." },
  "Mínimo 10 caracteres": { es: "Mínimo 10 caracteres" },
  "Máximo 500 caracteres": { es: "Máximo 500 caracteres" },
  "Razão inválida": { es: "Motivo inválido" },
  "A suspensão bloqueará o acesso dos usuários deste tenant à plataforma. Esta ação pode ser revertida.": {
    es: "La suspensión bloqueará el acceso de los usuarios de este tenant a la plataforma. Esta acción se puede revertir.",
  },
  "Motivo da suspensão": { es: "Motivo de la suspensión" },
  "Descreva o motivo da suspensão (mínimo 10 caracteres)...": {
    es: "Describe el motivo de la suspensión (mínimo 10 caracteres)...",
  },
  "Suspendendo...": { es: "Suspendiendo..." },
  "Confirmar suspensão": { es: "Confirmar suspensión" },
  "A reativação restabelece o acesso dos usuários deste tenant à plataforma. Informe o motivo da reativação para o registro de auditoria.": {
    es: "La reactivación restablece el acceso de los usuarios de este tenant a la plataforma. Indica el motivo de la reactivación para el registro de auditoría.",
  },
  "Motivo da reativação": { es: "Motivo de la reactivación" },
  "Descreva o motivo da reativação (mínimo 10 caracteres)...": {
    es: "Describe el motivo de la reactivación (mínimo 10 caracteres)...",
  },
  "Reativando...": { es: "Reactivando..." },
  "Confirmar reativação": { es: "Confirmar reactivación" },

  // ─── Admin de plataforma: Tenant health ───
  "Não foi possível carregar o status de saúde do tenant. Tente recarregar a página.": {
    es: "No se pudo cargar el estado de salud del tenant. Intenta recargar la página.",
  },
  "Status de Saúde": { es: "Estado de salud" },
  "Atualizado às": { es: "Actualizado a las" },
  "Sem sessões": { es: "Sin sesiones" },
  conectada: { es: "conectada" },
  conectadas: { es: "conectadas" },
  "Não conectado": { es: "No conectado" },
  "Última sync": { es: "Última sync" },
  "Expira em": { es: "Expira en" },
  "Token expira": { es: "Token expira" },
  usado: { es: "usado" },
  "Sem orçamento": { es: "Sin presupuesto" },
  Consumido: { es: "Consumido" },
  "Orçamento": { es: "Presupuesto" },
  Ilimitado: { es: "Ilimitado" },
  Limite: { es: "Límite" },
  "Não aplicado": { es: "No aplicado" },
  "Só avisa": { es: "Solo avisa" },
  "Para a IA no limite": { es: "Detiene la IA en el límite" },
  "Último evento": { es: "Último evento" },
  "Orçamento IA": { es: "Presupuesto IA" },

  // ─── Admin de plataforma: Users (lista + detalhe) ───
  "Buscar por email ou nome...": { es: "Buscar por email o nombre..." },
  "Buscar usuários": { es: "Buscar usuarios" },
  "Filtrar por tenant": { es: "Filtrar por tenant" },
  "Todos os tenants": { es: "Todos los tenants" },
  "Filtrar por role": { es: "Filtrar por rol" },
  "Todos os roles": { es: "Todos los roles" },
  "Nenhum usuário encontrado": { es: "No se encontró ningún usuario" },
  "Ajuste os filtros para refinar a busca.": {
    es: "Ajusta los filtros para refinar la búsqueda.",
  },
  "Revogado": { es: "Revocado" },
  "Usuário não encontrado": { es: "Usuario no encontrado" },
  "Usuário sem nome": { es: "Usuario sin nombre" },
  "Informações do usuário": { es: "Información del usuario" },
  "Email confirmado": { es: "Email confirmado" },
  "Pendente": { es: "Pendiente" },
  Inativo: { es: "Inactivo" },
  "Sem memberships registrados.": { es: "Sin memberships registrados." },
  "Aceito em": { es: "Aceptado el" },
  "Audit recente": { es: "Auditoría reciente" },
  "Nenhuma entrada de auditoria encontrada para este usuário.": {
    es: "No se encontró ninguna entrada de auditoría para este usuario.",
  },
  "usuário": { es: "usuario" },
  "usuários": { es: "usuarios" },

  // ─── Admin de plataforma: LGPD (lista + detalhe) ───
  "LGPD — Cross-tenant": { es: "LGPD — Cross-tenant" },
  Recebido: { es: "Recibido" },
  Processando: { es: "Procesando" },
  "Revisão": { es: "Revisión" },
  Vencido: { es: "Vencido" },
  "Crítico (<24h)": { es: "Crítico (<24h)" },
  "Alerta (>50%)": { es: "Alerta (>50%)" },
  "Limpar filtros": { es: "Limpiar filtros" },
  "solicitação vencendo em menos de 24h ou já vencida": {
    es: "solicitud que vence en menos de 24h o ya venció",
  },
  "solicitações vencendo em menos de 24h ou já vencidas": {
    es: "solicitudes que vencen en menos de 24h o ya vencieron",
  },
  "ação imediata requerida.": { es: "se requiere acción inmediata." },
  "Ver detalhes": { es: "Ver detalles" },
  "em atraso": { es: "de atraso" },
  restantes: { es: "restantes" },
  Risco: { es: "Riesgo" },
  "Nenhuma solicitação encontrada": { es: "No se encontró ninguna solicitud" },
  "Ajuste os filtros para ver solicitações.": { es: "Ajusta los filtros para ver solicitudes." },
  "Nenhuma entrada de auditoria registrada para esta solicitação.": {
    es: "No hay entradas de auditoría registradas para esta solicitud.",
  },
  "Falha ao carregar solicitação.": { es: "No se pudo cargar la solicitud." },
  "LGPD Cross-tenant": { es: "LGPD Cross-tenant" },
  Urgente: { es: "Urgente" },
  "Somente leitura — aprovação é feita pelo operador no contexto do tenant.": {
    es: "Solo lectura — la aprobación la hace el operador en el contexto del tenant.",
  },
  Origem: { es: "Origen" },
  Escopo: { es: "Alcance" },
  Tentativas: { es: "Intentos" },
  "Trilha de auditoria": { es: "Pista de auditoría" },
  "Todos os tipos": { es: "Todos los tipos" },
  "Todos os riscos": { es: "Todos los riesgos" },

  // ─── Admin de plataforma: Incidents (lista + detalhe) ───
  incidente: { es: "incidente" },
  incidentes: { es: "incidentes" },
  Reconhecidos: { es: "Reconocidos" },
  Severidade: { es: "Severidad" },
  "Todas severidades": { es: "Todas las severidades" },
  Aberto: { es: "Abierto" },
  Reconhecido: { es: "Reconocido" },
  Resolvido: { es: "Resuelto" },
  Quando: { es: "Cuándo" },
  "Nenhum incidente encontrado": { es: "No se encontró ningún incidente" },
  "Ajuste os filtros para ver outros incidentes.": {
    es: "Ajusta los filtros para ver otros incidentes.",
  },
  "Incidente não encontrado": { es: "Incidente no encontrado" },
  "Criado": { es: "Creado" },
  "Nenhuma entrada de auditoria encontrada.": {
    es: "No se encontró ninguna entrada de auditoría.",
  },
  "Resolução": { es: "Resolución" },
  "Resolvido em": { es: "Resuelto el" },
  "Resolver incidente": { es: "Resolver incidente" },
  "Descreva como o incidente foi resolvido. Esta ação é registrada no audit log e não pode ser desfeita.": {
    es: "Describe cómo se resolvió el incidente. Esta acción queda registrada en el audit log y no se puede deshacer.",
  },
  "Nota de resolução": { es: "Nota de resolución" },
  "mín. 10 caracteres": { es: "mín. 10 caracteres" },
  "Descreva a causa raiz e as ações tomadas para resolver o incidente...": {
    es: "Describe la causa raíz y las acciones tomadas para resolver el incidente...",
  },
  "Mínimo de 10 caracteres": { es: "Mínimo de 10 caracteres" },
  "Resolvendo...": { es: "Resolviendo..." },
  "Confirmar resolução": { es: "Confirmar resolución" },

  // ─── Admin de plataforma: Audit Log (lista + detalhe) ───
  evento: { es: "evento" },
  eventos: { es: "eventos" },
  "Limpar seleção": { es: "Limpiar selección" },
  "Filtrar por actor user ID": { es: "Filtrar por actor user ID" },
  "Data de início": { es: "Fecha de inicio" },
  "Data de fim": { es: "Fecha de fin" },
  "Limpar": { es: "Limpiar" },
  "Recurso": { es: "Recurso" },
  "Nenhum evento encontrado": { es: "No se encontraron eventos" },
  "Ajuste os filtros para ver entradas do audit log.": {
    es: "Ajusta los filtros para ver entradas del audit log.",
  },
  "Entrada de audit não encontrada.": { es: "No se encontró la entrada de audit." },
  "Sem actor registrado": { es: "Sin actor registrado" },
  "Ver tenant": { es: "Ver tenant" },
  "Abrir recurso": { es: "Abrir recurso" },

  // ─── Admin de plataforma: Platform Admins ───
  "Administradores com acesso privilegiado à plataforma": {
    es: "Administradores con acceso privilegiado a la plataforma",
  },
  "Erro ao carregar platform admins. Tente recarregar.": {
    es: "Error al cargar los platform admins. Intenta recargar.",
  },
  "Gerenciamento de Platform Admins é restrito ao DBA": {
    es: "Solo el DBA puede gestionar Platform Admins",
  },
  "Conforme Spec 01 §3.4 T-04: adição, remoção ou alteração de": {
    es: "Según la Spec 01 §3.4 T-04: la adición, eliminación o modificación de",
  },
  "é feita exclusivamente via SQL pelo DBA, com nota explicativa em": {
    es: "se hace exclusivamente vía SQL por el DBA, con una nota explicativa en",
  },
  ". Esta página é informativa e read-only — nenhum botão de modificação está disponível por design.": {
    es: ". Esta página es informativa y de solo lectura: por diseño, no incluye botones para modificar nada.",
  },
  "Ver runbook →": { es: "Ver runbook →" },
  "Usuário": { es: "Usuario" },
  "Concedido em": { es: "Concedido el" },
  "Concedido por": { es: "Concedido por" },
  "Nenhum platform admin encontrado": { es: "No se encontraron platform admins" },
  "Platform admins são configurados exclusivamente via DBA.": {
    es: "Los platform admins solo los configura el DBA.",
  },

  // ─── Admin de plataforma: Usage & Custo ───
  "Uso & Custo": { es: "Uso y Costo" },
  "Consumo de mensagens, conversas e AI por tenant": {
    es: "Consumo de mensajes, conversaciones e IA por tenant",
  },
  "Período": { es: "Período" },
  "Últimos 7 dias": { es: "Últimos 7 días" },
  "Últimos 30 dias": { es: "Últimos 30 días" },
  "Últimos 90 dias": { es: "Últimos 90 días" },
  "Erro ao carregar dados de uso. Tente recarregar.": {
    es: "Error al cargar los datos de uso. Intenta recargar.",
  },
  "Mensagens / dia": { es: "Mensajes / día" },
  "Custo AI / dia (R$)": { es: "Costo IA / día (R$)" },
  "AI Tokens / dia": { es: "Tokens de IA / día" },
  "Não há dados de uso no período selecionado.": {
    es: "No hay datos de uso en el período seleccionado.",
  },
  "Uso por tenant": { es: "Uso por tenant" },
  "Exportar CSV": { es: "Exportar CSV" },
  "Invoc. AI": { es: "Invoc. IA" },
  "Custo AI": { es: "Costo IA" },

  // ─── Admin de plataforma: Marca (page.tsx, _form.tsx, _estado.tsx) ───
  "O nome e a cor que este sistema mostra para todo mundo que usa esta instalação.": {
    es: "El nombre y el color que este sistema muestra a todas las personas que usan esta instalación.",
  },
  "Sua cor": { es: "Tu color" },
  "fora da escala — fica só no logo": { es: "fuera de la escala: solo se usa en el logo" },
  "Botões no modo claro": { es: "Botones en el modo claro" },
  "Botões no modo escuro": { es: "Botones en el modo oscuro" },
  "Confira os campos: algum valor não está no formato esperado.": {
    es: "Revisa los campos: algún valor no está en el formato esperado.",
  },
  "Marca salva.": { es: "Marca guardada." },
  "Nome do sistema": { es: "Nombre del sistema" },
  "Deixe em branco para voltar ao nome padrão. Este nome já aparece no título da aba do navegador, nos menus laterais, nos e-mails que o sistema envia (para as empresas que não definiram um nome próprio), no aplicativo de verificação em duas etapas e no arquivo de códigos de recuperação que o usuário baixa. Ainda NÃO chega às telas de entrada e cadastro nem às da configuração inicial: essas continuam com o nome gravado no arquivo de instalação do servidor até a próxima atualização da stack.": {
    es: "Déjalo en blanco para volver al nombre predeterminado. Este nombre ya aparece en el título de la pestaña del navegador, en los menús laterales, en los correos que envía el sistema (para las empresas que no definieron un nombre propio), en la app de verificación en dos pasos y en el archivo de códigos de recuperación que descarga el usuario. Todavía NO llega a las pantallas de inicio de sesión y registro ni a las de configuración inicial: esas siguen con el nombre escrito en el archivo de instalación del servidor hasta la próxima actualización del stack.",
  },
  "Cor da marca": { es: "Color de la marca" },
  "Escolher a cor visualmente": { es: "Elegir el color visualmente" },
  "Use um código de cor como #7a5cd6.": { es: "Usa un código de color como #7a5cd6." },
  "Deixe em branco para voltar à cor padrão do sistema.": {
    es: "Déjalo en blanco para volver al color predeterminado del sistema.",
  },
  "A partir da sua cor o sistema monta esta escala e escolhe, dentro dela, o tom que vai nos botões:": {
    es: "A partir de tu color el sistema arma esta escala y elige, dentro de ella, el tono que va en los botones:",
  },
  "No modo escuro o sistema usa naturalmente um tom mais claro da escala, para a cor não se perder no fundo escuro.": {
    es: "En el modo oscuro el sistema usa naturalmente un tono más claro de la escala, para que el color no se pierda en el fondo oscuro.",
  },
  "Sem cor definida, o sistema usa a cor padrão dele.": {
    es: "Sin color definido, el sistema usa su color predeterminado.",
  },
  "passa em AA": { es: "cumple con AA" },
  "abaixo do mínimo AA": { es: "por debajo del mínimo AA" },
  "definido nesta tela": { es: "definido en esta pantalla" },
  "veio do arquivo de instalação do servidor": { es: "viene del archivo de instalación del servidor" },
  "padrão do sistema": { es: "predeterminado del sistema" },
  "Como está agora": { es: "Estado actual" },
  "O que o sistema está usando, o que ele mediu e o que ele ajustou sozinho.": {
    es: "Lo que el sistema está usando, lo que midió y lo que ajustó por su cuenta.",
  },
  "A sua marca não está sendo aplicada.": { es: "Tu marca no se está aplicando." },
  "Desde": { es: "Desde" },
  "o sistema voltou a usar as cores padrão dele.": {
    es: "el sistema volvió a usar sus colores predeterminados.",
  },
  "Salvar uma cor válida aqui apaga este alerta.": {
    es: "Guardar un color válido aquí borra esta alerta.",
  },
  "De onde vem cada coisa": { es: "De dónde viene cada cosa" },
  "Logo": { es: "Logo" },
  "O logo ainda é trocado no arquivo de instalação do servidor. Esta tela mostra de onde ele vem para que o valor não pareça ter sumido.": {
    es: "El logo todavía se cambia en el archivo de instalación del servidor. Esta pantalla muestra de dónde viene, para que no parezca que el valor desapareció.",
  },
  "O texto em cima dos botões": { es: "El texto sobre los botones" },
  "Quanto maior o número, mais fácil de ler. AA é o mínimo recomendado internacionalmente para texto.": {
    es: "Cuanto mayor es el número, más fácil de leer. AA es el mínimo recomendado a nivel internacional para texto.",
  },
  "No modo claro": { es: "En el modo claro" },
  "No modo escuro": { es: "En el modo oscuro" },
  "O que o sistema ajustou": { es: "Lo que el sistema ajustó" },
  "Nada foi ajustado — a escala acima mostra onde a sua cor entra.": {
    es: "No se ajustó nada. La escala de arriba muestra dónde entra tu color.",
  },
  "Do jeito que está, esta cor não chegaria à tela: o sistema continuaria com as cores padrão dele.": {
    es: "Tal como está, este color no llegaría a la pantalla: el sistema seguiría con sus colores predeterminados.",
  },
  "Logo atualizado.": { es: "Logo actualizado." },
  "Logo removido.": { es: "Logo eliminado." },
  "PNG ou JPG, até": { es: "PNG o JPG, hasta" },
  "KB. Prefira fundo transparente. SVG não é aceito: ele pode executar código quando aberto direto pelo endereço da imagem.": {
    es: "KB. Prefiere fondo transparente. No se acepta SVG, porque puede ejecutar código cuando se abre directamente desde la dirección de la imagen.",
  },
  "Como o logo aparece nas duas aparências do sistema:": {
    es: "Cómo se ve el logo en las dos apariencias del sistema:",
  },
  "Sem logo próprio, o sistema usa o logo": { es: "Sin logo propio, el sistema usa el logo" },
  "Assim ele aparece:": { es: "Así se ve:" },

  // ─── Marca: linguagem.ts (só os avisos de texto FIXO — os compostos
  // dinamicamente com interpolação, ex. "No modo X, os botões usam..." e
  // "Sua cor ficou parecida com...", ficam deliberadamente em português, mesma
  // categoria de `montaLacunas`/`boaNoticia` já deferida na área ai) ───
  "O valor gravado para a cor não está na forma que o sistema entende.": {
    es: "El valor guardado para el color no tiene un formato que el sistema entienda.",
  },
  "A cor gravada não é um código de cor válido.": {
    es: "El color guardado no es un código de color válido.",
  },
  "A cor foi gravada por uma versão mais nova do sistema, e esta não sabe lê-la.": {
    es: "Una versión más reciente del sistema guardó el color, y esta versión no sabe leerlo.",
  },
  "A cor foi salva por outra versão do sistema. Ela continua valendo — esta versão recalcula os tons a partir dela.": {
    es: "Otra versión del sistema guardó el color. Sigue siendo válido: esta versión recalcula los tonos a partir de él.",
  },
  "Esta versão do sistema não sabe onde aplicar a cor gravada, então ela não pinta a interface.": {
    es: "Esta versión del sistema no sabe dónde aplicar el color guardado, así que no pinta la interfaz.",
  },
  "A cor está guardada só como identidade: ela aparece no logo, mas não pinta os botões.": {
    es: "El color está guardado solo como identidad: aparece en el logo, pero no pinta los botones.",
  },
  "O cálculo dos tons a partir dessa cor não terminou.": {
    es: "El cálculo de los tonos a partir de ese color no terminó.",
  },
  "Sua cor é um tom neutro (cinza, preto ou branco), e uma cor assim não destaca nada na tela. Os botões seguem com a cor padrão do sistema, e a sua fica reservada ao logo.": {
    es: "Tu color es un tono neutro (gris, negro o blanco), y un color así no resalta nada en la pantalla. Los botones siguen con el color predeterminado del sistema, y el tuyo queda reservado al logo.",
  },
  "Não existe tom desta cor que deixe todos os elementos legíveis. Alguns detalhes — como o contorno que marca o campo em foco — ficam difíceis de enxergar.": {
    es: "Ningún tono de este color deja todos los elementos legibles. Algunos detalles, como el contorno que marca el campo enfocado, quedan difíciles de ver.",
  },
  "A verificação de segurança barrou o resultado antes de ele chegar à tela, e a marca não foi aplicada.": {
    es: "La verificación de seguridad bloqueó el resultado antes de que llegara a la pantalla, y la marca no se aplicó.",
  },
  "O sistema recusou a cor gravada por um motivo que esta versão não sabe explicar.": {
    es: "El sistema rechazó el color guardado por un motivo que esta versión no sabe explicar.",
  },
  "A sua cor original continua no logo e nos destaques.": {
    es: "Tu color original sigue en el logo y en los destacados.",
  },
  "Algum campo não está no formato esperado.": {
    es: "Algún campo no está en el formato esperado.",
  },
  "Sua sessão expirou. Entre de novo para salvar.": {
    es: "Tu sesión expiró. Inicia sesión de nuevo para guardar.",
  },
  "Só quem administra a instalação pode mudar a marca.": {
    es: "Solo quien administra la instalación puede cambiar la marca.",
  },
  "Sua sessão expirou. Entre de novo para trocar o logo.": {
    es: "Tu sesión expiró. Inicia sesión de nuevo para cambiar el logo.",
  },
  "Você não tem permissão para trocar este logo.": {
    es: "No tienes permiso para cambiar este logo.",
  },
  "Nenhuma empresa ativa nesta sessão.": {
    es: "No hay ninguna empresa activa en esta sesión.",
  },
  "Confirme o segundo fator nesta sessão e tente de novo.": {
    es: "Confirma el segundo factor en esta sesión e intenta de nuevo.",
  },
  // ─── app/api/v1/marca/logo/route.ts (frontend-traduz via CampoDeLogo.tsx) ───
  "Campo 'escopo' inválido.": { es: "Campo 'escopo' inválido." },
  "O logo precisa ter até 512 KB. Arquivo maior vai inteiro para o navegador em toda página.": {
    es: "El logo debe pesar 512 KB como máximo. Un archivo más grande se envía completo al navegador en cada página.",
  },
  "SVG não é aceito como logo: ele pode executar código quando aberto direto do endereço da imagem. Exporte o mesmo arquivo em PNG (fundo transparente) ou JPG.": {
    es: "No se acepta SVG como logo, porque puede ejecutar código cuando se abre directamente desde la dirección de la imagen. Exporta el mismo archivo como PNG (fondo transparente) o JPG.",
  },
  "Erro ao gravar o logo.": { es: "Error al guardar el logo." },
  "O caminho do logo não pertence a esta empresa.": {
    es: "La ruta del logo no pertenece a esta empresa.",
  },
  "O logo não foi gravado.": { es: "No se guardó el logo." },
  // ─── lib/auth/require-role.ts (gate ÚNICO de autorização — toda rota /api/v1) ───
  "Esta sessão precisa da verificação em duas etapas. Entre novamente com o código do aplicativo.": {
    es: "Esta sesión requiere verificación en dos pasos. Inicia sesión de nuevo con el código de la app.",
  },
  "Muitas trocas seguidas. Tente de novo em alguns minutos.": {
    es: "Demasiados cambios seguidos. Intenta de nuevo en unos minutos.",
  },
  "Não consegui trocar o logo agora.": {
    es: "No pude cambiar el logo ahora.",
  },
  Cor: { es: "Color" },
  "do arquivo de instalação do servidor": {
    es: "del archivo de instalación del servidor",
  },
  "Aparência clara": { es: "Apariencia clara" },
  "Aparência escura": { es: "Apariencia oscura" },
  // ─── Webhooks ───
  "Receba contatos de fora (landing pages, formulários) e crie automações que agem sozinhas.": {
    es: "Recibe contactos de afuera (landing pages, formularios) y crea automatizaciones que actúan solas.",
  },
  "Receber dados": { es: "Recibir datos" },
  "Leads recebidos": { es: "Leads recibidos" },
  Automações: { es: "Automatizaciones" },
  Atividade: { es: "Actividad" },
  Funil: { es: "Embudo" },
  "Escolha o funil": { es: "Elige el embudo" },
  "Escolha o funil primeiro": { es: "Elige primero el embudo" },
  desconectado: { es: "desconectado" },
  "Números desconectados aparecem desabilitados — reconecte em Conexões antes de usar.": {
    es: "Los números desconectados aparecen deshabilitados. Reconéctalos en Conexiones antes de usarlos.",
  },
  "Oi {{nome}}, tudo bem?": { es: "Hola {{nome}}, ¿todo bien?" },
  "Respeitamos a janela de envio e o limite diário configurados para esse número em Conexões — fora da janela, a mensagem espera a próxima.": {
    es: "Respetamos la ventana de envío y el límite diario configurados para ese número en Conexiones. Fuera de la ventana, el mensaje espera a la siguiente.",
  },
  "Qual agente escreve": { es: "Qué agente escribe" },
  "não publicado": { es: "no publicado" },
  "Nenhum agente está publicado. Publique um em Agentes de IA para poder usá-lo aqui.": {
    es: "Ningún agente está publicado. Publica uno en Agentes de IA para poder usarlo aquí.",
  },
  "Ele escreve com o mesmo tom e o mesmo conhecimento que usa no atendimento.": {
    es: "Escribe con el mismo tono y el mismo conocimiento que usa en la atención.",
  },
  "O que a IA deve fazer com os dados": { es: "Qué debe hacer la IA con los datos" },
  "Ex.: Agradeça o interesse citando o segmento que a pessoa informou, mostre em uma frase como a gente resolve a dificuldade que ela descreveu, e pergunte qual o melhor horário para conversar.": {
    es: "Ej.: Agradece el interés mencionando el segmento que indicó la persona, explica en una frase cómo resolvemos la dificultad que describió y pregunta cuál es el mejor horario para conversar.",
  },
  "O agente já sabe que é a PRIMEIRA mensagem, logo depois de a pessoa preencher o formulário, e recebe todos os campos que ela respondeu. Aqui você diz o que fazer com eles — quanto mais concreto, melhor a mensagem.": {
    es: "El agente ya sabe que es el PRIMER mensaje, justo después de que la persona completa el formulario, y recibe todos los campos que respondió. Aquí le indicas qué hacer con ellos. Cuanto más concreto seas, mejor será el mensaje.",
  },
  Atendente: { es: "Asesor" },
  "Escolha o atendente": { es: "Elige el asesor" },
  "Endereço (URL)": { es: "Dirección (URL)" },
  "Segredo (opcional)": { es: "Secreto (opcional)" },
  "•••••••• (definido — digite para trocar)": {
    es: "•••••••• (definido — escribe para cambiarlo)",
  },
  "uma senha só sua": { es: "una contraseña solo tuya" },
  "Já existe um segredo guardado com segurança. Digitar aqui substitui; limpar remove.": {
    es: "Ya hay un secreto guardado de forma segura. Si escribes aquí, lo reemplazas; si borras el campo, se elimina.",
  },
  "Se preencher, enviaremos uma assinatura para o outro sistema conferir que fomos nós.": {
    es: "Si lo completas, enviaremos una firma para que el otro sistema confirme que fuimos nosotros.",
  },
  Sucesso: { es: "Éxito" },
  "Aguardando envio": { es: "Esperando envío" },
  "Essa ação não funcionou.": { es: "Esta acción no funcionó." },
  "Reenviado.": { es: "Reenviado." },
  Reenviar: { es: "Reenviar" },
  "Nova tentativa em": { es: "Nuevo intento:" },
  "Nenhuma automação rodou ainda. Assim que uma regra ligada disparar, o histórico aparece aqui.": {
    es: "Aún no se ha ejecutado ninguna automatización. Cuando se dispare una regla activa, el historial aparecerá aquí.",
  },
  "Automação removida": { es: "Automatización eliminada" },
  Captação: { es: "Captación" },
  "Chegou pela fonte": { es: "Llegó por la fuente" },
  "O que o formulário trouxe": { es: "Lo que trajo el formulario" },
  "Nenhum campo além dos acima.": { es: "No hay otros campos además de los anteriores." },
  "De onde veio": { es: "De dónde vino" },
  Página: { es: "Página" },
  "não informada": { es: "no especificada" },
  "Endereço IP": { es: "Dirección IP" },
  "não identificado — sua instalação não está atrás de um proxy que informe a origem": {
    es: "no identificado: tu instalación no está detrás de un proxy que informe el origen",
  },
  Navegador: { es: "Navegador" },
  "Ver o lead no funil": { es: "Ver el lead en el embudo" },
  "(sem identificação)": { es: "(sin identificación)" },
  "Nome, telefone ou e-mail": { es: "Nombre, teléfono o correo" },
  "quem você procura": { es: "a quién buscas" },
  "Filtrar por fonte": { es: "Filtrar por fuente" },
  "Todas as fontes": { es: "Todas las fuentes" },
  "Filtrar por resultado": { es: "Filtrar por resultado" },
  "Não foi possível carregar o histórico.": { es: "No se pudo cargar el historial." },
  "Isto é uma falha ao consultar — não quer dizer que ninguém preencheu.": {
    es: "Es una falla de la consulta. No significa que nadie haya completado el formulario.",
  },
  "Nenhuma captação com esses filtros. Tente ampliar o período.": {
    es: "No hay captaciones con esos filtros. Intenta ampliar el período.",
  },
  "Ninguém preencheu seus formulários ainda. Assim que o primeiro envio chegar, ele aparece aqui — com os dados, o horário e a origem.": {
    es: "Todavía nadie ha completado tus formularios. Cuando llegue el primer envío, aparecerá aquí con los datos, la hora y el origen.",
  },
  "Escolha o funil e o estágio de entrada.": { es: "Elige el embudo y la etapa de entrada." },
  "Fonte criada. Agora é só conectar seu site.": {
    es: "Fuente creada. Ahora solo falta conectar tu sitio.",
  },
  "Nova fonte de captação": { es: "Nueva fuente de captación" },
  "Dê um nome e diga em qual funil o contato deve entrar quando alguém preencher seu formulário.": {
    es: "Ponle un nombre e indica en qué embudo debe entrar el contacto cuando alguien complete tu formulario.",
  },
  "Landing page de Black Friday": { es: "Landing page de Black Friday" },
  "Funil de entrada": { es: "Embudo de entrada" },
  "Estágio de entrada": { es: "Etapa de entrada" },
  "Escolha o estágio": { es: "Elige la etapa" },
  "URL de obrigado (opcional)": { es: "URL de la página de gracias (opcional)" },
  "Para onde enviar a pessoa depois que ela preencher seu formulário.": {
    es: "A dónde enviar a la persona después de que complete tu formulario.",
  },
  "Automação atualizada.": { es: "Automatización actualizada." },
  "Automação criada — ligue quando estiver pronta.": {
    es: "Automatización creada. Actívala cuando esté lista.",
  },
  "Editar automação": { es: "Editar automatización" },
  "Nova automação": { es: "Nueva automatización" },
  "Monte a regra em três passos: quando algo acontece, opcionalmente confira uma condição, e então dispare uma ou mais ações.": {
    es: "Arma la regla en tres pasos: qué evento la activa, una condición opcional y una o más acciones que se ejecutan.",
  },
  "Nome da automação": { es: "Nombre de la automatización" },
  "Boas-vindas a contato novo": { es: "Bienvenida a contacto nuevo" },
  QUANDO: { es: "CUANDO" },
  "Escolha o gatilho": { es: "Elige el disparador" },
  "SE (opcional)": { es: "SI (opcional)" },
  "ex: lead.custom_fields.minha_chave": { es: "ej: lead.custom_fields.mi_clave" },
  "usar campo da lista": { es: "usar campo de la lista" },
  "usar campo avançado": { es: "usar campo avanzado" },
  "Adicionar condição": { es: "Agregar condición" },
  ENTÃO: { es: "ENTONCES" },
  "Mover ação para cima": { es: "Mover acción hacia arriba" },
  "Mover ação para baixo": { es: "Mover acción hacia abajo" },
  "Remover ação": { es: "Eliminar acción" },
  "Adicionar ação": { es: "Agregar acción" },
  "A automação nasce pausada. Revise e ligue quando estiver pronta.": {
    es: "La automatización se crea en pausa. Revísala y actívala cuando esté lista.",
  },
  "Salvar alterações": { es: "Guardar cambios" },
  "Criar automação": { es: "Crear automatización" },
  "Automação ligada.": { es: "Automatización activada." },
  "Automação pausada.": { es: "Automatización pausada." },
  "Crie sua primeira automação": { es: "Crea tu primera automatización" },
  "Ex.: quando entrar um contato novo, enviar uma mensagem de boas-vindas.": {
    es: "Ej.: cuando entre un contacto nuevo, enviar un mensaje de bienvenida.",
  },
  Ativa: { es: "Activa" },
  Pausada: { es: "Pausada" },
  "Excluir automação": { es: "Eliminar automatización" },
  "Excluir esta automação?": { es: "¿Eliminar esta automatización?" },
  "para de rodar imediatamente. Essa ação não pode ser desfeita.": {
    es: "deja de ejecutarse de inmediato. Esta acción no se puede deshacer.",
  },
  "Automação excluída.": { es: "Automatización eliminada." },
  "Seu WhatsApp": { es: "Tu WhatsApp" },
  "Seu e-mail": { es: "Tu correo" },
  "Quero receber contato": { es: "Quiero que me contacten" },
  // A tela do tronco SIP (#677) — mesma família das duas linhas vizinhas de
  // "não consegui copiar", com o bloco de configuração no lugar do token.
  "Não consegui copiar. Selecione o bloco acima e copie à mão.": {
    es: "No pude copiar. Selecciona el bloque de arriba y cópialo a mano.",
  },
  "Não foi possível copiar — selecione e copie manualmente.": {
    es: "No se pudo copiar. Selecciona y copia manualmente.",
  },
  "Funcionou! Um lead de teste entrou no seu funil.": {
    es: "¡Funcionó! Un lead de prueba entró en tu embudo.",
  },
  "Não conseguimos falar com o endereço. Confira sua internet e tente de novo.": {
    es: "No pudimos comunicarnos con la dirección. Revisa tu conexión e intenta de nuevo.",
  },
  "Cada envio para o endereço abaixo vira um lead no seu funil, automaticamente.": {
    es: "Cada envío a la siguiente dirección se convierte automáticamente en un lead en tu embudo.",
  },
  "Endereço da fonte": { es: "Dirección de la fuente" },
  "Endereço copiado.": { es: "Dirección copiada." },
  "Formulário pronto para colar no seu site": { es: "Formulario listo para pegar en tu sitio" },
  "Formulário copiado.": { es: "Formulario copiado." },
  "Copiar formulário": { es: "Copiar formulario" },
  "Como conectar no seu caso": { es: "Cómo conectarlo en tu caso" },
  "Formulário próprio": { es: "Formulario propio" },
  "Use o HTML pronto logo acima — já aponta para o endereço certo.": {
    es: "Usa el HTML listo que aparece arriba. Ya apunta a la dirección correcta.",
  },
  "Para desenvolvedores": { es: "Para desarrolladores" },
  "Enviar lead de teste": { es: "Enviar lead de prueba" },
  "Ver no Kanban": { es: "Ver en el Kanban" },
  "Últimos recebimentos": { es: "Últimos recibidos" },
  "Ainda não chegou nada por aqui.": { es: "Todavía no ha llegado nada por aquí." },
  "assinatura inválida": { es: "firma inválida" },
  "Fonte ativa": { es: "Fuente activa" },
  "Pausada, ela para de aceitar novos envios.": { es: "Pausada, deja de aceptar nuevos envíos." },
  "Fonte ativada.": { es: "Fuente activada." },
  "Fonte pausada.": { es: "Fuente pausada." },
  "Excluir fonte": { es: "Eliminar fuente" },
  "Excluir esta fonte?": { es: "¿Eliminar esta fuente?" },
  "O endereço para de funcionar imediatamente. Leads já recebidos continuam no seu funil — só a captação futura é interrompida. Essa ação não pode ser desfeita.": {
    es: "La dirección deja de funcionar de inmediato. Los leads que ya recibiste siguen en tu embudo, pero dejarás de captar nuevos. Esta acción no se puede deshacer.",
  },
  "Fonte excluída.": { es: "Fuente eliminada." },
  "nunca recebeu": { es: "nunca recibió" },
  "último recebimento": { es: "último recibido" },
  "Conecte sua landing page em 2 minutos": { es: "Conecta tu landing page en 2 minutos" },
  "1. Crie uma fonte e diga em qual funil o contato entra.": {
    es: "1. Crea una fuente y di en qué embudo entra el contacto.",
  },
  "2. Copie o endereço ou o formulário pronto.": {
    es: "2. Copia la dirección o el formulario listo.",
  },
  "3. Cole no seu site — cada envio vira um lead aqui dentro.": {
    es: "3. Pégalo en tu sitio: cada envío se convierte en un lead aquí.",
  },
  "Criar primeira fonte": { es: "Crear tu primera fuente" },
  "Nova fonte": { es: "Nueva fuente" },
  "Ver no histórico o que foi alterado": { es: "Ver en el historial qué cambió" },
  "— ver o que mudou": { es: "— ver qué cambió" },
  "O envio não trazia nome, telefone nem e-mail reconhecíveis — confira os nomes dos campos do formulário.": {
    es: "El envío no incluía un nombre, teléfono ni correo que se pudieran reconocer. Revisa los nombres de los campos del formulario.",
  },
  "A assinatura não conferiu. Quem enviou não usou o segredo configurado nesta fonte.": {
    es: "La firma no coincidió. Quien envió no usó el secreto configurado en esta fuente.",
  },
  "Os dados chegaram, mas o lead não pôde ser criado — confira se o funil e a etapa da fonte ainda existem.": {
    es: "Los datos llegaron, pero no se pudo crear el lead. Revisa que el embudo y la etapa de la fuente sigan existiendo.",
  },
  "Virou lead": { es: "Se convirtió en lead" },
  Reenvio: { es: "Reenvío" },
  "Não entrou": { es: "No entró" },
  "Criar/mover lead no funil": { es: "Crear/mover lead en el embudo" },
  "Enviar mensagem no WhatsApp": { es: "Enviar mensaje por WhatsApp" },
  "Adicionar tag": { es: "Agregar etiqueta" },
  "Atribuir a um atendente": { es: "Asignar a un asesor" },
  "Avisar outro sistema (webhook)": { es: "Avisar a otro sistema (webhook)" },
  "Esse lead entrou sem contato vinculado, então não havia para quem escrever.": {
    es: "Ese lead entró sin contacto vinculado, así que no había a quién escribirle.",
  },
  "O contato pediu para não receber mensagens (opt-out).": {
    es: "El contacto pidió no recibir mensajes (opt-out).",
  },
  "O contato não tem telefone cadastrado.": { es: "El contacto no tiene teléfono registrado." },
  "Falta preencher alguma configuração desta ação — abra a automação e revise.": {
    es: "Falta completar algún ajuste de esta acción. Abre la automatización y revísala.",
  },
  "Está fora da janela de envio configurada para esse número. A mensagem sai sozinha quando ela reabrir.": {
    es: "Está fuera de la ventana de envío configurada para ese número. El mensaje saldrá solo cuando la ventana vuelva a abrirse.",
  },
  "A mensagem está na fila e sai assim que o canal aceitar.": {
    es: "El mensaje está en la cola y sale en cuanto el canal lo acepte.",
  },
  // ─── lib/channels/frases-de-falha.ts (texto de tela por código do adapter) ───
  "O número escolhido não está conectado no momento. Reconecte em Conexões — a mensagem sai sozinha quando ele voltar.": {
    es: "El número elegido no está conectado en este momento. Reconéctalo en Conexiones y el mensaje saldrá solo en cuanto vuelva a estar conectado.",
  },
  "A conexão de WhatsApp ainda não foi configurada nesta instalação.": {
    es: "La conexión de WhatsApp todavía no se ha configurado en esta instalación.",
  },
  "Esse número foi excluído da Central de Conexões. Escolha outro número nesta automação.": {
    es: "Ese número se eliminó de la Central de Conexiones. Elige otro número en esta automatización.",
  },
  "O contato não tem telefone para receber a mensagem.": {
    es: "El contacto no tiene teléfono para recibir el mensaje.",
  },
  "Não conseguimos falar com o serviço de WhatsApp. Confira se ele está no ar.": {
    es: "No pudimos comunicarnos con el servicio de WhatsApp. Verifica que esté funcionando.",
  },
  "O WhatsApp Oficial recusou o envio. Confira a conexão em Conexões.": {
    es: "El WhatsApp Oficial rechazó el envío. Verifica la conexión en Conexiones.",
  },
  "O canal recusou o envio. Confira a conexão em Conexões.": {
    es: "El canal rechazó el envío. Verifica la conexión en Conexiones.",
  },
  "Não conseguimos preparar o arquivo para envio.": {
    es: "No pudimos preparar el archivo para el envío.",
  },
  "O agente escolhido não tem versão publicada. Publique-o em Agentes de IA para a automação poder usá-lo.": {
    es: "El agente elegido no tiene versión publicada. Publícalo en Agentes de IA para que la automatización pueda usarlo.",
  },
  "A IA não está configurada nesta instalação — cadastre uma chave em Provedores de IA.": {
    es: "La IA no está configurada en esta instalación. Registra una clave en Proveedores de IA.",
  },
  "A IA não devolveu texto. Revise o contexto que você escreveu para ela.": {
    es: "La IA no devolvió texto. Revisa el contexto que le escribiste.",
  },
  // ─── motivos de parada da aba Atividade (issue #1090) ───
  // O gate de espanhol resolve a tabela `MOTIVO_DA_PARADA` (ele atravessa
  // `t(MOTIVO_DA_PARADA[reason])`), mas NÃO enxerga `t(<variável>)`: o valor que
  // chega por `action.error` e a frase que vem de `detail.explicacao` passam
  // fora. Estas chaves são acrescentadas à mão pelo motivo de sempre — a tela
  // desce para o português, calada, quando falta a linha.
  "Não deu para saber quem atende este contato: a consulta ao sistema falhou na hora (rede ou banco), e não é erro de configuração. Tente de novo em alguns minutos.":
    {
      es: "No se pudo saber quién atiende a este contacto. La consulta al sistema falló en ese momento (por la red o la base de datos), no por un error de configuración. Vuelve a intentarlo en unos minutos.",
    },
  "A pessoa escolhida como responsável não é atendente desta equipe. Escolha outra pessoa na automação.":
    {
      es: "La persona elegida como responsable no es asesor de este equipo. Elige a otra persona en la automatización.",
    },
  "A pessoa escolhida como responsável não pode atender — o papel dela é só de visualização. Escolha um atendente.":
    {
      es: "La persona elegida como responsable no puede atender porque su rol es solo de visualización. Elige a un asesor.",
    },
  "A ação não recebeu o que precisava (o lead do evento ou a pessoa configurada). Abra a automação e revise.":
    {
      es: "La acción no recibió lo que necesitaba (el lead del evento o la persona configurada). Abre la automatización y revísala.",
    },
  "Esta ação não tem nenhuma etiqueta escolhida. Abra a automação e escolha pelo menos uma.": {
    es: "Esta acción no tiene ninguna etiqueta elegida. Abre la automatización y elige al menos una.",
  },
  "O evento que disparou a regra não trouxe um lead nem um contato para etiquetar.": {
    es: "El evento que disparó la regla no incluyó un lead ni un contacto para etiquetar.",
  },
  "O evento que disparou a regra não trouxe um lead para criar ou mover.": {
    es: "El evento que disparó la regla no incluyó un lead para crear o mover.",
  },
  "Mover um lead para outro funil está desligado nesta organização.": {
    es: "Mover un lead a otro embudo está desactivado en esta organización.",
  },
  "O funil escolhido não está ativo, então a inscrição não foi feita. Ative o funil ou escolha outro na automação.":
    {
      es: "El embudo elegido no está activo, así que la inscripción no se hizo. Activa el embudo o elige otro en la automatización.",
    },
  "O contato já está em um funil ativo — esta ação não inscreve duas vezes.": {
    es: "El contacto ya está en un embudo activo, así que esta acción no lo inscribe de nuevo.",
  },
  "O contato não autorizou o recebimento de mensagens de marketing.": {
    es: "El contacto no autorizó recibir mensajes de marketing.",
  },
  "O número deste canal ainda não entrou no pré-go-live, então a mensagem escrita pela IA não sai por ele.":
    {
      es: "El número de este canal todavía no ha entrado al pre-go-live, así que el mensaje que redactó la IA no sale por él.",
    },
  "Este número está marcado como número de teste do canal.": {
    es: "Este número está marcado como número de prueba del canal.",
  },
  "Este número está fora da lista de teste do canal, então a mensagem escrita pela IA não sai por ele.": {
    es: "Este número está fuera de la lista de prueba del canal, así que el mensaje que redactó la IA no sale por él.",
  },
  "Não deu para saber se este número pode receber a mensagem da IA: a consulta falhou na hora (rede ou banco), e não é erro de configuração. Tente de novo em alguns minutos.":
    {
      es: "No se pudo saber si este número puede recibir el mensaje de la IA. La consulta falló en ese momento (por la red o la base de datos), no por un error de configuración. Vuelve a intentarlo en unos minutos.",
    },
  "Esta ação de webhook não tem endereço configurado. Abra a automação e preencha.": {
    es: "Esta acción de webhook no tiene dirección configurada. Abre la automatización y complétala.",
  },
  "A regra usa um tipo de ação que esta instalação não tem (pode ter saído em uma atualização). Abra a automação e escolha outra ação.":
    {
      es: "La regla usa un tipo de acción que esta instalación no tiene (puede que se haya retirado en una actualización). Abre la automatización y elige otra acción.",
    },
  "Título do lead": { es: "Título del lead" },
  "Nome do lead": { es: "Nombre del lead" },
  "Tags do lead": { es: "Etiquetas del lead" },
  "Origem (utm_source)": { es: "Origen (utm_source)" },
  // Os quatro níveis abaixo da origem, nas duas telas que os nomeiam: a ficha do
  // contato e o editor de regra. As MESMAS palavras nas duas, de propósito.
  // `Campanha` NÃO se repete aqui: o bloco da tabela de campanhas já a traz,
  // com o mesmo valor. Chave repetida num literal de objeto é erro de tipo.
  Conjunto: { es: "Conjunto" },
  "Anúncio": { es: "Anuncio" },
  Posicionamento: { es: "Ubicación" },
  "Campanha (utm_campaign)": { es: "Campaña (utm_campaign)" },
  "Conjunto (utm_adset)": { es: "Conjunto (utm_adset)" },
  "Anúncio (utm_ad)": { es: "Anuncio (utm_ad)" },
  "Posicionamento (utm_placement)": { es: "Ubicación (utm_placement)" },
  "A plataforma não informa o posicionamento de cada clique em anúncio.": {
    es: "La plataforma no informa la ubicación de cada clic en un anuncio.",
  },
  "Etapa de destino": { es: "Etapa de destino" },
  "Texto da mensagem": { es: "Texto del mensaje" },
  "Tags do contato": { es: "Etiquetas del contacto" },
  "Tag adicionada": { es: "Etiqueta agregada" },
  "Quando entrar um contato novo (webhook)": { es: "Cuando entre un contacto nuevo (webhook)" },
  "Quando um lead mudar de etapa": { es: "Cuando un lead cambie de etapa" },
  "Quando chegar mensagem no WhatsApp": { es: "Cuando llegue un mensaje por WhatsApp" },
  "Quando um lead ganhar uma tag": { es: "Cuando un lead reciba una etiqueta" },
  "Quando um contato ganhar uma tag": { es: "Cuando un contacto reciba una etiqueta" },
  "alterado pelo assistente": { es: "cambiado por el asistente" },
  "alterado automaticamente pelo sistema": { es: "cambiado automáticamente por el sistema" },
  é: { es: "es" },
  "Revise os campos da automação.": { es: "Revisa los campos de la automatización." },
  "Não funcionou. Confira se a fonte está ativa e se o funil/estágio ainda existem.": {
    es: "No funcionó. Revisa que la fuente esté activa y que el embudo y la etapa sigan existiendo.",
  },
  // ─── Conexões / Integrações ───
  "Por onde seu negócio fala com o cliente. Conecte números por QR ou o número oficial da Meta, e acompanhe a saúde de cada um.": {
    es: "Los canales por los que tu negocio habla con tus clientes. Conecta números por QR o el número oficial de Meta, y da seguimiento a la salud de cada uno.",
  },
  "Redirecionando…": { es: "Redirigiendo…" },
  "Conectar com Nuvemshop": { es: "Conectar con Nuvemshop" },
  "Nuvemshop desconectada.": { es: "Nuvemshop desconectada." },
  "Desconectando…": { es: "Desconectando…" },
  "Nuvemshop conectada com sucesso.": { es: "Nuvemshop conectada con éxito." },
  "Sincroniza pedidos, produtos e clientes via OAuth + webhooks.": {
    es: "Sincroniza pedidos, productos y clientes vía OAuth + webhooks.",
  },
  "Integração não configurada": { es: "Integración no configurada" },
  Configure: { es: "Configura" },
  e: { es: "y" },
  "para ativar a integração.": { es: "para activar la integración." },
  "Obtenha as credenciais em": { es: "Obtén las credenciales en" },
  "Conectar Nuvemshop": { es: "Conectar Nuvemshop" },
  "Você será redirecionado para autorizar o app na sua loja.": {
    es: "Te redirigiremos para que autorices la app en tu tienda.",
  },
  "Somente administradores podem conectar integrações.": {
    es: "Solo los administradores pueden conectar integraciones.",
  },
  Loja: { es: "Tienda" },
  "última sync:": { es: "última sync:" },
  "Escopos:": { es: "Permisos:" },
  "Webhooks registrados:": { es: "Webhooks registrados:" },
  "Proteção de envio atualizada.": { es: "Protección de envío actualizada." },
  "Proteção de envio —": { es: "Protección de envío —" },
  "Estes limites protegem o número contra bloqueio do WhatsApp. Campo vazio usa o padrão seguro do sistema (mostrado no campo).": {
    es: "Estos límites protegen el número para que WhatsApp no lo bloquee. Si dejas un campo vacío, se usa el valor predeterminado seguro del sistema (el que aparece en el campo).",
  },
  "A ordem de preferência vai de 0 a 1000.": {
    es: "El orden de preferencia va de 0 a 1000.",
  },
  "Este número é usado desde": { es: "Este número se usa desde" },
  "A conexão pode ser nova sem que o número seja. O aquecimento conta a idade do NÚMERO — em branco, ele é tratado como recém-criado e começa liberando pouco por dia. Uma data já salva não some se você limpar o campo: para mudá-la, informe outra.": {
    es: "La conexión puede ser nueva aunque el número no lo sea. El calentamiento cuenta la antigüedad del NÚMERO. Si el campo queda en blanco, se trata como un número recién creado y empieza liberando pocos envíos por día. Una fecha ya guardada no se borra al limpiar el campo: para cambiarla, ingresa otra.",
  },
  "Este número já está aquecido — pular o aquecimento": {
    es: "Este número ya está calentado: omitir el calentamiento",
  },
  "Vale só o teto diário abaixo. Use apenas se o número já envia há semanas: pular o aquecimento num número novo é o caminho mais rápido para o bloqueio.": {
    es: "Solo aplica el tope diario de abajo. Úsalo únicamente si el número ya lleva semanas enviando: omitir el calentamiento en un número nuevo es la forma más rápida de que lo bloqueen.",
  },
  "Número com": { es: "Número con" },
  "dia(s) de uso — já formado. Vale só o teto diário abaixo.": {
    es: "día(s) de uso, ya establecido. Solo aplica el tope diario de abajo.",
  },
  "Hoje o aquecimento libera": { es: "Hoy el calentamiento libera" },
  "envio(s) — o número tem": { es: "envío(s) — el número tiene" },
  "dia(s) de uso. Enquanto esse número for menor que o teto diário, é ELE que limita, e mexer no teto diário não muda nada.": {
    es: "día(s) de uso. Mientras ese número sea menor que el tope diario, es ÉL quien limita, y cambiar el tope diario no cambia nada.",
  },
  "Janela de envio (horário local)": { es: "Ventana de envío (horario local)" },
  "Hora de início da janela": { es: "Hora de inicio de la ventana" },
  "h até": { es: "h hasta" },
  "Hora de fim da janela": { es: "Hora de fin de la ventana" },
  "O assistente só envia mensagens dentro desta janela. Fora dela, a resposta fica agendada para a próxima abertura — você vê o motivo na conversa.": {
    es: "El asistente solo envía mensajes dentro de esta ventana. Fuera de ella, la respuesta queda programada para cuando se abra de nuevo, y el motivo aparece en la conversación.",
  },
  "Enviar aos domingos": { es: "Enviar los domingos" },
  "Ligado por padrão: quem escreve no domingo espera resposta no domingo. Desligue se você faz prospecção ativa e prefere não incomodar no fim de semana.": {
    es: "Activado por defecto: quien escribe un domingo espera respuesta el domingo. Desactívalo si haces prospección activa y prefieres no molestar el fin de semana.",
  },
  "Ritmo entre envios (segundos)": { es: "Ritmo entre envíos (segundos)" },
  "Intervalo mínimo entre envios em segundos": {
    es: "Intervalo mínimo entre envíos en segundos",
  },
  "+ variação de até": { es: "+ variación de hasta" },
  "Variação aleatória máxima em segundos": { es: "Variación aleatoria máxima en segundos" },
  "Intervalo mínimo entre mensagens do mesmo número, mais uma variação aleatória — ritmo cravado parece robô para o WhatsApp.": {
    es: "Intervalo mínimo entre mensajes del mismo número, más una variación aleatoria. Un ritmo siempre igual hace que WhatsApp lo detecte como un robot.",
  },
  "Teto diário de envios": { es: "Tope diario de envíos" },
  "sem teto definido": { es: "sin tope definido" },
  "Teto diário de mensagens": { es: "Tope diario de mensajes" },
  "Máximo de mensagens que este número envia por dia. Números novos também respeitam o aquecimento automático abaixo, o que for menor.": {
    es: "Máximo de mensajes que este número envía por día. En los números nuevos también rige el calentamiento automático de abajo, y se aplica el límite que sea menor.",
  },
  "Fuso horário IANA": { es: "Zona horaria IANA" },
  "Usar o padrão": { es: "Usar el predeterminado" },
  "A janela de envio é avaliada neste fuso (ex.: America/Sao_Paulo).": {
    es: "La ventana de envío se evalúa en esta zona horaria (ej.: America/Sao_Paulo).",
  },
  "Aquecimento automático de número novo": { es: "Calentamiento automático de número nuevo" },
  "a partir de": { es: "a partir de" },
  "dias: sem limite de aquecimento": { es: "días: sin límite de calentamiento" },
  "dias: até": { es: "días: hasta" },
  dia: { es: "día" },
  "Número recém-conectado envia pouco e sobe aos poucos — enviar demais no início é a causa nº 1 de bloqueio.": {
    es: "Un número recién conectado envía pocos mensajes y aumenta poco a poco. Enviar demasiado al principio es la causa n.º 1 de bloqueos.",
  },
  "Salvar proteção": { es: "Guardar protección" },
  "Copiado.": { es: "Copiado." },
  Copiar: { es: "Copiar" },
  "Conectado:": { es: "Conectado:" },
  "credencial guardada": { es: "credencial guardada" },
  "sem credencial": { es: "sin credencial" },
  número: { es: "número" },
  "Cole isto no painel da Meta": { es: "Pega esto en el panel de Meta" },
  ", na seção de Webhook. Sem esse passo o canal envia, mas": {
    es: ", en la sección de Webhook. Sin este paso el canal envía, pero",
  },
  "não recebe": { es: "no recibe" },
  " — as respostas do cliente não chegam e a janela de 24 horas nunca abre.": {
    es: " — las respuestas del cliente no llegan y la ventana de 24 horas nunca se abre.",
  },
  "URL de callback": { es: "URL de callback" },
  "Token de verificação": { es: "Token de verificación" },
  "Campos a assinar": { es: "Campos a suscribir" },
  "Trocar credencial": { es: "Cambiar credencial" },
  "Conectar canal oficial": { es: "Conectar canal oficial" },
  "Os três valores vêm do seu app na Meta (": { es: "Los tres valores vienen de tu app en Meta (" },
  "Configuração da API": { es: "Configuración de la API" },
  "). A credencial é": { es: "). La credencial es" },
  "validada com a Meta antes de ser gravada": { es: "validada con Meta antes de guardarse" },
  " — se o número não responder, nada é salvo.": {
    es: " — si el número no responde, nada se guarda.",
  },
  "ID do número de telefone": { es: "ID del número de teléfono" },
  "ID da conta do WhatsApp Business": { es: "ID de la cuenta de WhatsApp Business" },
  "Token de acesso": { es: "Token de acceso" },
  "•••• (já guardado — preencha para trocar)": {
    es: "•••• (ya guardado; escribe uno nuevo para reemplazarlo)",
  },
  "Guardado cifrado. Não é exibido de volta em nenhum momento.": {
    es: "Se guarda cifrado y nunca se vuelve a mostrar.",
  },
  "Validando com a Meta…": { es: "Validando con Meta…" },
  "Validar e conectar": { es: "Validar y conectar" },
  "Canal conectado.": { es: "Canal conectado." },
  "Não foi possível conectar.": { es: "No se pudo conectar." },
  "provedor parceiro": { es: "proveedor asociado" },
  "Conectar por": { es: "Conectar por" },
  "Um número oficial (WhatsApp Business) conectado através do seu provedor. As mensagens entram e saem pelo CRM, e os modelos aprovados são os mesmos da sua conta.": {
    es: "Un número oficial (WhatsApp Business) conectado a través de tu proveedor. Los mensajes entran y salen por el CRM, y las plantillas aprobadas son las mismas de tu cuenta.",
  },
  "sem número informado": { es: "sin número indicado" },
  Conta: { es: "Cuenta" },
  "id da conta conectada no provedor": { es: "id de la cuenta conectada en el proveedor" },
  "É o identificador do número no painel do provedor — não o da Meta.": {
    es: "Es el identificador del número en el panel del proveedor, no el de Meta.",
  },
  "Chave de API": { es: "Clave de API" },
  "gravada — preencha para trocar": { es: "guardada; pega otra para cambiarla" },
  "cole a chave": { es: "pega la clave" },
  "Guardada cifrada. Depois de gravar ela não é mostrada de novo — para trocar, cole a nova.": {
    es: "Se guarda cifrada y no se vuelve a mostrar. Para cambiarla, pega una nueva.",
  },
  "Verificando…": { es: "Verificando…" },
  "A credencial é testada contra o provedor antes de ser gravada.": {
    es: "Antes de guardar la credencial, se prueba con el proveedor.",
  },
  "Falta ligar a volta": { es: "Falta conectar la recepción" },
  "Cole os dois valores abaixo no webhook do seu provedor. Sem isso o CRM": {
    es: "Pega los dos valores de abajo en el webhook de tu proveedor. Sin esto el CRM",
  },
  "envia mas não recebe": { es: "envía pero no recibe" },
  ": a resposta do cliente não chega, e nada na tela avisa. O segredo aparece": {
    es: ": la respuesta del cliente no llega y la pantalla no muestra ningún aviso. El secreto aparece",
  },
  "uma única vez": { es: "una sola vez" },
  " — se sair desta tela sem copiá-lo, reconecte para gerar outro.": {
    es: " — si sales de esta pantalla sin copiarlo, reconecta para generar otro.",
  },
  "URL do webhook": { es: "URL del webhook" },
  "Segredo (assinatura)": { es: "Secreto (firma)" },
  "Qualidade do número segundo a plataforma:": { es: "Calidad del número según la plataforma:" },
  "O endereço que o provedor usa para entregar as mensagens. O segredo não é mostrado de novo — para obter um novo, reconecte.": {
    es: "La dirección que el proveedor usa para entregar los mensajes. El secreto no se vuelve a mostrar. Para obtener uno nuevo, reconecta.",
  },
  "Conectar novo WhatsApp": { es: "Conectar un WhatsApp nuevo" },
  "WhatsApp conectado!": { es: "¡WhatsApp conectado!" },
  "Não foi possível carregar seus números.": { es: "No se pudieron cargar tus números." },
  "Nenhum número conectado ainda.": { es: "Todavía no hay números conectados." },
  "número conectado": { es: "número conectado" },
  "números conectados": { es: "números conectados" },
  "Atualizar saúde": { es: "Actualizar salud" },
  "O serviço do WhatsApp não está configurado.": {
    es: "El servicio de WhatsApp no está configurado.",
  },
  "Faltam o endereço e a chave do serviço (": { es: "Faltan la dirección y la clave del servicio (" },
  ") nas variáveis de ambiente desta instalação. Enquanto isso, não dá para conectar, reconectar nem excluir os números pareados por QR — excluir um número também o desconecta do aparelho, e sem o serviço isso não acontece.": {
    es: ") en las variables de entorno de esta instalación. Mientras tanto, no es posible conectar, reconectar ni eliminar los números emparejados por QR. Eliminar un número también lo desconecta del dispositivo, y sin el servicio eso no ocurre.",
  },
  "Se você roda tudo na mesma máquina, o container sobe com": {
    es: "Si corres todo en la misma máquina, el contenedor se levanta con",
  },
  ". Já apareceu aqui o caso oposto: o container no ar e o endereço configurado apontando para um lugar que não existe — subir o container de novo não conserta isso.": {
    es: ". Aquí ya ocurrió el caso opuesto: el contenedor estaba activo, pero la dirección configurada apuntaba a un lugar que no existe. Volver a levantar el contenedor no lo arregla.",
  },
  "Esta instalação está com o banco atrasado.": {
    es: "La base de datos de esta instalación está desactualizada.",
  },
  "Falta aplicar a migration que registra canal excluído. Até lá, um número que você excluir continua aparecendo nesta lista.": {
    es: "Falta aplicar la migración que registra los canales eliminados. Hasta entonces, un número que elimines sigue apareciendo en esta lista.",
  },
  "Carregando conexões…": { es: "Cargando conexiones…" },
  "Não foi possível carregar seus números — esta lista não está mostrando o que existe.": {
    es: "No se pudieron cargar tus números. Esta lista no muestra lo que realmente existe.",
  },
  "Não conecte um número novo por causa disto: recarregue a página. Se persistir, o servidor do sistema está fora do ar.": {
    es: "No conectes un número nuevo por esto: recarga la página. Si persiste, el servidor del sistema está caído.",
  },
  "Conecte seu primeiro número de WhatsApp para começar a atender.": {
    es: "Conecta tu primer número de WhatsApp para empezar a atender.",
  },
  Verificado: { es: "Verificado" },
  "Ainda não verificado": { es: "Aún sin verificar" },
  "Proteção de envio": { es: "Protección de envío" },
  "indisponível enquanto o serviço do WhatsApp não estiver ativo": {
    es: "no disponible mientras el servicio de WhatsApp no esté activo",
  },
  "Este número não tem conversa, mensagem nem configuração ligada a ele.": {
    es: "Este número no tiene conversaciones, mensajes ni configuración asociados.",
  },
  "conversa": { es: "conversación" },
  "mensagem": { es: "mensaje" },
  "versão de agente": { es: "versión de agente" },
  "versões de agente": { es: "versiones de agente" },
  "roteador de IA": { es: "enrutador de IA" },
  "roteadores de IA": { es: "enrutadores de IA" },
  "ajuste de proteção de envio": { es: "ajuste de protección de envío" },
  "ajustes de proteção de envio": { es: "ajustes de protección de envío" },
  "Não foi possível carregar a proteção de envio desta conexão. Ela pode ter sido removida, ou esta lista está desatualizada.": { es: "No se pudo cargar la protección de envío de esta conexión. Puede que se haya eliminado o que esta lista esté desactualizada." },
  "conversa continua": { es: "conversación continúa" },
  "conversas continuam": { es: "conversaciones continúan" },

  // ─── lib/channels/meta/template-contract.ts (preview de template do WhatsApp) ───
  "cabeçalho": { es: "encabezado" },
  "corpo": { es: "cuerpo" },

  // ─── lib/channels/zernio/avisos.ts (avisos de número/conta na Central) ───
  "Número ativado.": { es: "Número activado." },
  "Número reativado.": { es: "Número reactivado." },
  "Documentação enviada para verificação.": { es: "Documentación enviada para verificación." },
  "A plataforma pede verificação deste número.": {
    es: "La plataforma pide verificación de este número.",
  },
  "A plataforma pede uma ação neste número.": {
    es: "La plataforma pide una acción en este número.",
  },
  "Número recusado pela plataforma.": { es: "Número rechazado por la plataforma." },
  "Número SUSPENSO — não é possível enviar.": {
    es: "Número SUSPENDIDO — no se puede enviar.",
  },
  "Número liberado e não utilizável (terminal).": {
    es: "Número liberado, ya no se puede usar (estado final).",
  },
  "A conta do canal foi desconectada.": { es: "Se desconectó la cuenta del canal." },
  "Conta do canal conectada.": { es: "Cuenta del canal conectada." },
  "Verificação recusada.": { es: "Verificación rechazada." },
  "Verificação aprovada.": { es: "Verificación aprobada." },

  "Continua no inbox:": { es: "Sigue en el inbox:" },
  "Fica salvo, mas sem número — para de atender:": {
    es: "Queda guardado, pero sin número, y deja de atender:",
  },
  "Este canal tem registros internos, por isso ele é arquivado em vez de apagado.": {
    es: "Este canal tiene registros internos, por eso se archiva en vez de borrarse.",
  },
  "Canal excluído.": { es: "Canal eliminado." },
  "Canal removido.": { es: "Canal eliminado." },
  "no inbox.": { es: "en el inbox." },
  "Canal removido. O que estava ligado a ele continua guardado.": {
    es: "Canal eliminado. Lo que estaba asociado a él sigue guardado.",
  },
  "O número será desconectado do WhatsApp e sai desta lista.": {
    es: "El número se desconectará de WhatsApp y saldrá de esta lista.",
  },
  "Verificando o que está ligado a este número…": {
    es: "Revisando qué está asociado a este número…",
  },
  "Não foi possível verificar o que está ligado a este número. A exclusão continua possível — quem decide apagar ou arquivar é o servidor, e ele preserva o histórico quando existe.": {
    es: "No se pudo revisar qué está asociado a este número. Aún puedes eliminarlo: el servidor decide si lo borra o lo archiva, y conserva el historial cuando existe.",
  },
  "Para usar este número de novo, será preciso conectá-lo outra vez.": {
    es: "Para volver a usar este número, tendrás que conectarlo de nuevo.",
  },
  "No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie o código.": {
    es: "En el celular: WhatsApp → Dispositivos vinculados → Vincular un dispositivo → escanea el código.",
  },
  "QR Code para conectar WhatsApp": { es: "Código QR para conectar WhatsApp" },
  "Conectado!": { es: "¡Conectado!" },
  "Este número foi desvinculado do WhatsApp. Para usá-lo de novo é preciso parear outra vez.": {
    es: "Este número se desvinculó de WhatsApp. Para volver a usarlo, hay que emparejarlo de nuevo.",
  },
  "Gerar novo QR": { es: "Generar nuevo QR" },
  "Preparando o código…": { es: "Preparando el código…" },
  "Como o cliente vai ver": { es: "Cómo lo verá el cliente" },
  "Preencha o texto para ver a prévia.": { es: "Completa el texto para ver la vista previa." },
  Cabeçalho: { es: "Encabezado" },
  Falta: { es: "Falta" },
  "no texto.": { es: "en el texto." },
  "A numeração é sequencial e a plataforma recusa quando há buraco.": {
    es: "La numeración es secuencial y la plataforma la rechaza si hay un hueco.",
  },
  "Sincronizado:": { es: "Sincronizado:" },
  "novo(s),": { es: "nuevo(s)," },
  "atualizado(s),": { es: "actualizado(s)," },
  "desativado(s).": { es: "desactivado(s)." },
  "Canal oficial não conectado": { es: "Canal oficial no conectado" },
  "Os templates vivem na sua conta do WhatsApp Business (Meta) — esta tela é um espelho deles. Conecte o canal oficial em": {
    es: "Las plantillas están en tu cuenta de WhatsApp Business (Meta) y esta pantalla solo las refleja. Conecta el canal oficial en",
  },
  "Conexões WhatsApp": { es: "Conexiones WhatsApp" },
  "para começar a sincronizar.": { es: "para empezar a sincronizar." },
  "Espelho da conta": { es: "Espejo de la cuenta" },
  "template(s)": { es: "plantilla(s)" },
  "Sincronizando…": { es: "Sincronizando…" },
  "Sincronizar com a Meta": { es: "Sincronizar con Meta" },
  "Nenhum template ainda": { es: "Aún no hay plantillas" },
  "Crie templates no Gerenciador do WhatsApp e clique em": {
    es: "Crea plantillas en el Administrador de WhatsApp y haz clic en",
  },
  "Só templates aprovados podem ser enviados fora da janela de 24 horas.": {
    es: "Solo las plantillas aprobadas se pueden enviar fuera de la ventana de 24 horas.",
  },
  "sem parâmetros": { es: "sin parámetros" },
  "parâmetro(s)": { es: "parámetro(s)" },
  "Recusado:": { es: "Rechazado:" },
  "arquivo de": { es: "archivo de" },
  "enviado no disparo": { es: "enviado en el disparo" },
  "sincronizada(s).": { es: "sincronizada(s)." },
  "Não consegui falar com a plataforma.": { es: "No pude comunicarme con la plataforma." },
  "O que a plataforma aprovou para este número. É daqui que sai a mensagem quando a janela de 24h fecha.": {
    es: "Lo que la plataforma aprobó para este número. De aquí sale el mensaje cuando la ventana de 24h se cierra.",
  },
  "Nome do modelo": { es: "Nombre de la plantilla" },
  Idioma: { es: "Idioma" },
  Categoria: { es: "Categoría" },
  "Utilidade — aviso de pedido, agendamento, cobrança": {
    es: "Utilidad — aviso de pedido, cita, cobro",
  },
  "Marketing — promoção, novidade, reengajamento": {
    es: "Marketing — promoción, novedad, reactivación",
  },
  "Autenticação — código de verificação": { es: "Autenticación — código de verificación" },
  "Cabeçalho de texto (opcional)": { es: "Encabezado de texto (opcional)" },
  "Cabeçalho de texto": { es: "Encabezado de texto" },
  "Subindo…": { es: "Subiendo…" },
  "Trocar imagem": { es: "Cambiar imagen" },
  "Subir imagem (JPG/PNG)": { es: "Subir imagen (JPG/PNG)" },
  "Imagem do cabeçalho": { es: "Imagen del encabezado" },
  "Texto da mensagem. Use {{1}}, {{2}} para os valores que mudam.": {
    es: "Texto del mensaje. Usa {{1}}, {{2}} para los valores que cambian.",
  },
  "Rodapé (opcional) — texto pequeno no fim da mensagem": {
    es: "Pie de página (opcional): texto pequeño al final del mensaje",
  },
  Rodapé: { es: "Pie de página" },
  "Tipo do botão": { es: "Tipo de botón" },
  "Resposta rápida": { es: "Respuesta rápida" },
  "Abrir link": { es: "Abrir enlace" },
  "Texto do botão": { es: "Texto del botón" },
  "URL do botão": { es: "URL del botón" },
  "Telefone do botão": { es: "Teléfono del botón" },
  "Remover botão": { es: "Eliminar botón" },
  remover: { es: "eliminar" },
  "Adicionar botão": { es: "Agregar botón" },
  "A revisão exige um exemplo de cada valor. Sem eles o modelo é recusado.": {
    es: "La revisión requiere un ejemplo de cada valor. Sin ellos, se rechaza la plantilla.",
  },
  "ex.: María": { es: "ej.: María" },
  "Exemplo do valor": { es: "Ejemplo del valor" },
  "A plataforma revisa antes de aprovar — o modelo nasce pendente e some da lista de envio até ela decidir.": {
    es: "La plataforma revisa la plantilla antes de aprobarla. Hasta que decida, queda como pendiente y no aparece en la lista de envío.",
  },
  "Nenhum modelo espelhado ainda. Clique em": { es: "Aún no hay plantillas sincronizadas. Haz clic en" },
  "para trazer os que já existem na plataforma.": {
    es: "para traer las que ya existen en la plataforma.",
  },
  "valor(es)": { es: "valor(es)" },
  mídia: { es: "multimedia" },
  "Sem corpo espelhado — sincronize para trazer o conteúdo.": {
    es: "Sin cuerpo sincronizado. Sincroniza para traer el contenido.",
  },
  "Sincronizado em": { es: "Sincronizado el" },
  // ─── Fusos horários oferecidos (compartilhado com Team/Attendants) ───
  "Assunção (Paraguai)": { es: "Asunción (Paraguay)" },
  "Buenos Aires (Argentina)": { es: "Buenos Aires (Argentina)" },
  "Montevidéu (Uruguai)": { es: "Montevideo (Uruguay)" },
  "Santiago (Chile)": { es: "Santiago (Chile)" },
  "La Paz (Bolívia)": { es: "La Paz (Bolivia)" },
  "Lima (Peru)": { es: "Lima (Perú)" },
  "Bogotá (Colômbia)": { es: "Bogotá (Colombia)" },
  "Cidade do México (México)": { es: "Ciudad de México (México)" },
  "São Paulo (Brasil)": { es: "São Paulo (Brasil)" },
  "Manaus (Brasil)": { es: "Manaus (Brasil)" },
  "Belém (Brasil)": { es: "Belém (Brasil)" },
  "Recife (Brasil)": { es: "Recife (Brasil)" },
  "Fortaleza (Brasil)": { es: "Fortaleza (Brasil)" },
  "Luanda (Angola)": { es: "Luanda (Angola)" },
  "Lisboa (Portugal)": { es: "Lisboa (Portugal)" },
  UTC: { es: "UTC" },
  // ─── Idiomas de definição de template (canal parceiro) ───
  Espanhol: { es: "Español" },
  "Espanhol (Argentina)": { es: "Español (Argentina)" },
  "Espanhol (México)": { es: "Español (México)" },
  "Espanhol (Espanha)": { es: "Español (España)" },
  "Português (Brasil)": { es: "Portugués (Brasil)" },
  "Português (Portugal)": { es: "Portugués (Portugal)" },
  Inglês: { es: "Inglés" },
  "Inglês (EUA)": { es: "Inglés (EE. UU.)" },
  "Inglês (Reino Unido)": { es: "Inglés (Reino Unido)" },
  // ─── Configurações: API Tokens ───
  "Selecione ao menos um escopo.": { es: "Selecciona al menos un alcance." },
  "Criar token": { es: "Crear token" },
  "Nenhum token criado ainda.": { es: "Aún no se ha creado ningún token." },
  Prefixo: { es: "Prefijo" },
  Escopos: { es: "Alcances" },
  Expira: { es: "Expira" },
  "Token revogado.": { es: "Token revocado." },
  Revogar: { es: "Revocar" },
  "Criar novo token": { es: "Crear nuevo token" },
  "O plaintext será mostrado apenas uma vez.": {
    es: "El plaintext se mostrará solo una vez.",
  },
  "Worker de import": { es: "Worker de import" },
  "Expira em (dias) — opcional": { es: "Expira en (días) — opcional" },
  Criar: { es: "Crear" },
  "Token criado": { es: "Token creado" },
  "Copie e guarde agora — não conseguiremos exibir novamente.": {
    es: "Cópialo y guárdalo ahora — no podremos mostrarlo de nuevo.",
  },
  "Token copiado.": { es: "Token copiado." },
  "Não foi possível copiar — selecione o token acima.": {
    es: "No se pudo copiar — selecciona el token de arriba.",
  },
  "Copiar para clipboard": { es: "Copiar al portapapeles" },
  "Tokens server-to-server. Plaintext exibido": {
    es: "Tokens server-to-server. El plaintext se muestra",
  },
  "na criação.": { es: "en la creación." },
  "Agentes de IA podem LER o CRM (MCP)": { es: "Los agentes de IA pueden LEER el CRM (MCP)" },
  "Agentes de IA podem AGIR no CRM (MCP)": {
    es: "Los agentes de IA pueden ACTUAR en el CRM (MCP)",
  },
  "Tratar o token como gerente (necessário p/ criar e atribuir)": {
    es: "Tratar el token como gerente (necesario para crear y asignar)",
  },
  "Ler contatos": { es: "Leer contactos" },
  "Criar e editar contatos": { es: "Crear y editar contactos" },
  "Ler leads": { es: "Leer leads" },
  "Criar e editar leads": { es: "Crear y editar leads" },
  "Ler mensagens": { es: "Leer mensajes" },
  "Enviar mensagens": { es: "Enviar mensajes" },
  "Ler o log de auditoria": { es: "Leer el registro de auditoría" },
  // ─── Configurações: Distribuição de atendimento ───
  "Distribuição de atendimento salva.": { es: "Distribución de atención guardada." },
  "Não consegui salvar.": { es: "No pude guardar." },
  "Quem recebe o cliente novo": { es: "Quién recibe al cliente nuevo" },
  "Vale para conversa que chega sem dono.": { es: "Se aplica a las conversaciones que llegan sin dueño." },
  "Tentativas antes de desistir": { es: "Intentos antes de desistir" },
  "Quando a pessoa some, a IA volta?": { es: "Si la persona deja de responder, ¿la IA retoma la conversación?" },
  "Quando alguém assume uma conversa, o agente de IA para de responder nela até ser devolvido. Se ninguém devolve, o cliente que escreve de novo fica sem resposta.": {
    es: "Cuando alguien asume una conversación, el agente de IA deja de responder en ella hasta que se la devuelvan. Si nadie la devuelve, el cliente que vuelve a escribir se queda sin respuesta.",
  },
  "Devolver ao agente sozinho depois de um tempo sem resposta da equipe": {
    es: "Devolver al agente automáticamente tras un tiempo sin respuesta del equipo",
  },
  "O tempo conta a partir do último sinal de uma pessoa na conversa: assumir, responder pela tela ou pelo celular. Só devolve onde há agente publicado. Desligado, vale a regra de sempre: a IA só volta quando alguém clica em Devolver.": {
    es: "El tiempo se cuenta desde la última actividad de una persona en la conversación: asumirla, responder desde la pantalla o desde el celular. Solo se devuelve donde hay un agente publicado. Si la opción está desactivada, rige la regla de siempre: la IA solo vuelve cuando alguien hace clic en Devolver.",
  },
  "Minutos sem resposta da equipe": { es: "Minutos sin respuesta del equipo" },
  "Entre 5 minutos e 24 horas. Sessenta minutos é a ordem de grandeza de um atendimento humano.": {
    es: "Entre 5 minutos y 24 horas. Sesenta minutos es el orden de magnitud de una atención humana.",
  },
  "Quando não há ninguém disponível, o sistema tenta de novo mais tarde. Ao estourar, a conversa fica na fila esperando alguém.": {
    es: "Cuando no hay nadie disponible, el sistema vuelve a intentarlo más tarde. Si se agotan los intentos, la conversación queda en la fila esperando a alguien.",
  },
  "Espera entre tentativas (segundos)": { es: "Espera entre intentos (segundos)" },
  "O que cada atendente enxerga": { es: "Qué ve cada asesor" },
  "Restringe apenas quem tem o papel": { es: "Restringe solo a quien tiene el rol" },
  "Gerente e administrador continuam vendo a operação inteira.": {
    es: "Gerente y administrador siguen viendo toda la operación.",
  },
  Com: { es: "Con" },
  "só os seus": { es: "solo los tuyos" },
  "e distribuição manual, ninguém enxerga a fila para pegar — e nenhum cliente é atendido. Ligue o rodízio para que alguém receba.": {
    es: "y distribución manual, nadie ve la fila para tomar clientes y ninguno recibe atención. Activa la rotación para que alguien los reciba.",
  },
  "Há mudanças não salvas.": { es: "Hay cambios sin guardar." },
  "Cada um pega o que quiser": { es: "Cada uno toma el que quiera" },
  "Todo cliente novo cai numa fila aberta e o primeiro atendente que clicar assume. Simples, e é onde nasce a discussão de quem furou a fila.": {
    es: "Todo cliente nuevo cae en una fila abierta y lo toma el primer asesor que haga clic. Es simple, pero ahí empiezan las discusiones sobre quién se saltó la fila.",
  },
  "Rodízio automático entre os atendentes": { es: "Rotación automática entre los asesores" },
  "Cliente 1 vai para o atendente A, cliente 2 para o B, e ao acabar a lista volta ao primeiro. Quem recebe é sempre quem está há mais tempo sem receber — entre os que estão disponíveis e dentro do horário. Ninguém escolhe, então não há fila furada.": {
    es: "El cliente 1 va al asesor A, el cliente 2 al B y, al terminar la lista, vuelve al primero. Siempre recibe quien lleva más tiempo sin recibir, entre los que están disponibles y dentro de su horario. Nadie elige, así que nadie se salta la fila.",
  },
  "Todos veem tudo": { es: "Todos ven todo" },
  "Qualquer atendente abre a conversa e o negócio de qualquer colega.": {
    es: "Cualquier asesor puede abrir la conversación y el negocio de cualquier colega.",
  },
  "Os seus, mais os que ainda não têm dono": {
    es: "Los tuyos, más los que todavía no tienen dueño",
  },
  "O atendente vê a própria carteira e a fila de quem chegou agora. Não vê o que já é de um colega.": {
    es: "El asesor ve su propia cartera y la fila de clientes recién llegados. No ve lo que ya es de otro colega.",
  },
  "Só os seus": { es: "Solo los tuyos" },
  "O atendente vê apenas o que foi direcionado a ele — nem a fila. Combine com o rodízio: sem alguém distribuindo, ninguém recebe nada e as telas ficam vazias.": {
    es: "El asesor ve solo lo que se le asignó, ni siquiera la fila. Combínalo con la rotación: si nadie distribuye, nadie recibe nada y las pantallas quedan vacías.",
  },
  "Quem recebe cada cliente novo, e o que cada atendente enxerga. As duas decisões andam juntas: distribuir sem restringir deixa todo mundo vendo a carteira do colega; restringir sem distribuir deixa o funil de cada um vazio.": {
    es: "Quién recibe a cada cliente nuevo y qué ve cada asesor. Las dos decisiones van juntas: si distribuyes sin restringir, todos ven la cartera de sus colegas; si restringes sin distribuir, el embudo de cada uno queda vacío.",
  },
  // ─── Configurações: Atualização do sistema ───
  "Não consegui iniciar a atualização. Tente de novo em instantes.": {
    es: "No pude iniciar la actualización. Inténtalo de nuevo en unos instantes.",
  },
  // ── Os três estados do plantão do atendente. "Fora do horário" é estado
  //    PRÓPRIO de propósito: confundi-lo com "Desligado" faz o operador ir
  //    procurar defeito onde só existe uma jornada que terminou.
  "De plantão": { es: "De guardia" },
  "Fora do horário": { es: "Fuera del horario" },
  "Desligado": { es: "Desactivado" },
  // ── Presença do navegador (issue #996): o segundo selo da mesma célula, o
  //    que responde "tem alguém aí?" sem tocar na decisão de plantão.
  "Com a tela aberta": { es: "Con la pantalla abierta" },
  "Sem sinal de tela": { es: "Sin señal de pantalla" },
  "último sinal às": { es: "última señal a las" },
  "Atualizando para a versão": { es: "Actualizando a la versión" },
  // ── A espera antes de o servidor pegar o pedido, e o fim reconhecido na hora.
  //    Os dois estados que a tela ganhou quando parou de fingir que a conversa
  //    com o host é instantânea (ver o cabeçalho do `UpdatePanel`).
  "Pedido enviado — esperando o servidor pegar": {
    es: "Solicitud enviada: esperando a que el servidor la tome",
  },
  "Anotei o pedido de atualizar para a versão": {
    es: "Registré la solicitud de actualizar a la versión",
  },
  "O servidor confere se há algo a fazer de poucos em poucos minutos, então a atualização pode levar até cerca de cinco minutos para começar.": {
    es: "El servidor revisa si hay algo que hacer cada pocos minutos, así que la actualización puede tardar hasta unos cinco minutos en empezar.",
  },
  "Esta tela ficar parada nesse tempo é normal": {
    es: "Es normal que esta pantalla se quede sin cambios durante ese tiempo",
  },
  " — ela se mexe sozinha assim que o servidor começar.": {
    es: " — avanza sola en cuanto el servidor empiece.",
  },
  "Esperando há": { es: "Esperando desde hace" },
  "Pode fechar esta página: o pedido já está registrado e não se perde.": {
    es: "Puedes cerrar esta página: la solicitud ya está registrada y no se pierde.",
  },
  // As três frases que a janela do `just_updated` usava saíram junto com a
  // promoção da versão do run a "instalada" (issue 1101): elas afirmavam uma
  // versão que o host não confirmou. No lugar delas, o que a tela pode dizer é
  // que o PEDIDO terminou e qual é a última versão que o host confirmou.
  "terminou": { es: "terminó" },
  "O servidor ainda não me confirmou em que versão ele voltou ao ar — a última versão que ele confirmou é a": {
    es: "El servidor todavía no me confirma en qué versión volvió a estar en línea. La última versión que confirmó es la",
  },
  "Assim que ele falar comigo, daqui a alguns minutos, esta tela se atualiza sozinha. Não ofereço atualizar de novo: o pedido já foi atendido.": {
    es: "En cuanto el servidor se comunique conmigo, dentro de unos minutos, esta pantalla se actualizará sola. No ofrezco actualizar de nuevo: la solicitud ya se atendió.",
  },
  "O sistema sai do ar por alguns instantes e volta sozinho. Pode deixar esta página aberta.": {
    es: "El sistema queda fuera de servicio unos instantes y vuelve solo. Puedes dejar esta página abierta.",
  },
  "A atualização para a versão": { es: "La actualización a la versión" },
  "não deu certo": { es: "no funcionó" },
  "Voltei o sistema para a versão": { es: "Regresé el sistema a la versión" },
  "que é a que está no ar agora, e os seus dados estão intactos. O banco de dados já tinha sido atualizado e permanece assim — isso é seguro, a versão": {
    es: "que es la que está activa ahora, y tus datos están intactos. La base de datos ya se había actualizado y se mantiene así. Es seguro: la versión",
  },
  "funciona com ele. Se quiser desfazer também o banco, use a cópia de segurança feita antes da tentativa (": {
    es: "funciona con ella. Si quieres deshacer también la base de datos, usa la copia de seguridad hecha antes del intento (",
  },
  "Para deixar o servidor inteiro de volta na versão": {
    es: "Para regresar todo el servidor a la versión",
  },
  "— inclusive o código, que já foi trocado —, quem tem acesso pode rodar:": {
    es: "— incluido el código, que ya se reemplazó —, quien tenga acceso puede ejecutar:",
  },
  "E eu": { es: "Y yo" },
  "não consegui": { es: "no pude" },
  "voltar sozinho para a versão": { es: "regresar por mi cuenta a la versión" },
  "o sistema pode estar rodando a versão": { es: "el sistema puede estar ejecutando la versión" },
  "com defeito, ou fora do ar. Seus dados estão intactos e a cópia de segurança feita antes da tentativa continua guardada no servidor.": {
    es: "con fallas, o fuera de servicio. Tus datos están intactos y la copia de seguridad hecha antes del intento sigue guardada en el servidor.",
  },
  "Para colocar o sistema de volta no ar na versão": {
    es: "Para volver a poner el sistema en línea con la versión",
  },
  ", quem tem acesso ao servidor precisa rodar:": {
    es: ", quien tenga acceso al servidor debe ejecutar:",
  },
  "Não sei dizer como terminou": { es: "No sé cómo terminó" },
  "Comecei a atualização para a versão": { es: "Empecé la actualización a la versión" },
  "mas perdi contato com o servidor antes do fim. Confira se o sistema está funcionando normalmente — se estiver, provavelmente deu certo.": {
    es: "pero perdí la conexión con el servidor antes de que terminara. Verifica que el sistema funcione con normalidad: si es así, probablemente salió bien.",
  },
  "Para conferir pelo servidor, quem tem acesso pode rodar:": {
    es: "Para comprobarlo desde el servidor, quien tenga acceso puede ejecutar:",
  },
  "Atualização automática indisponível": { es: "Actualización automática no disponible" },
  "Não estou conseguindo falar com o servidor onde o sistema está instalado, então não posso atualizar sozinho. Quem tem acesso ao servidor pode entrar na pasta onde o sistema foi instalado e rodar este comando — se for a primeira vez, rode duas vezes: a primeira baixa o programa novo e a segunda liga o botão desta tela.": {
    es: "No puedo comunicarme con el servidor donde está instalado el sistema, así que no puedo actualizarlo por mi cuenta. Quien tenga acceso al servidor puede entrar a la carpeta donde se instaló el sistema y ejecutar este comando. Si es la primera vez, hay que ejecutarlo dos veces: la primera descarga el programa nuevo y la segunda activa el botón de esta pantalla.",
  },
  "Versão instalada:": { es: "Versión instalada:" },
  "Não consegui checar se há versão nova": { es: "No pude comprobar si hay una versión nueva" },
  "O servidor não conseguiu comparar a sua versão (": {
    es: "El servidor no pudo comparar tu versión (",
  },
  ") com a última publicada — normalmente é internet instável ou falta de espaço em disco na hora da checagem.": {
    es: ") con la última publicada. Normalmente se debe a una conexión de internet inestable o a falta de espacio en disco al momento de comprobar.",
  },
  "Não quer dizer que esteja desatualizado, nem que esteja em dia": {
    es: "No quiere decir que esté desactualizado, ni que esté al día",
  },
  "quer dizer que eu não sei.": { es: "quiere decir que no lo sé." },
  "Vou tentar de novo sozinho a cada poucos minutos. Se continuar assim, quem tem acesso ao servidor pode conferir na hora com:": {
    es: "Volveré a intentarlo automáticamente cada pocos minutos. Si sigue igual, quien tenga acceso al servidor puede comprobarlo de inmediato con:",
  },
  "Você está na versão": { es: "Estás en la versión" },
  "É a mais recente. Não há nada a fazer.": { es: "Es la más reciente. No hay nada que hacer." },
  "Ainda não há nenhuma versão publicada": { es: "Todavía no hay ninguna versión publicada" },
  "Este projeto ainda não tem nenhuma versão publicada para comparar com a sua instalação — normal em um fork novo ou recém-criado a partir do código-fonte.": {
    es: "Este proyecto aún no tiene ninguna versión publicada con la que comparar tu instalación. Es normal en un fork nuevo o recién creado a partir del código fuente.",
  },
  "Não há nada a atualizar agora": { es: "No hay nada que actualizar ahora" },
  "e isso não é um problema.": { es: "y eso no es un problema." },
  "Quando sair a primeira versão publicada, ela aparece aqui sozinha. Quem tem acesso ao servidor pode conferir a qualquer momento com o comando abaixo — ele não muda nada sem avisar:": {
    es: "Cuando salga la primera versión publicada, aparecerá aquí sola. Quien tenga acceso al servidor puede comprobarlo en cualquier momento con el comando de abajo, que no cambia nada sin avisar:",
  },
  "Você está à frente da versão publicada": { es: "Estás por delante de la versión publicada" },
  "Seu sistema roda uma versão mais nova do que a última publicada, então": {
    es: "Tu sistema ejecuta una versión más nueva que la última publicada, así que",
  },
  "não há nada a atualizar": { es: "no hay nada que actualizar" },
  "É assim mesmo quando a instalação acompanha o desenvolvimento, e nada aqui está errado por causa disso — a marca da sua versão é": {
    es: "Es normal cuando la instalación sigue el desarrollo, y no hay ningún problema por eso. La marca de tu versión es",
  },
  "Quando sair uma versão publicada mais nova que a sua, ela aparece aqui sozinha. Quem tem acesso ao servidor pode conferir a qualquer momento com o comando abaixo — ele não muda nada sem avisar:": {
    es: "Cuando salga una versión publicada más nueva que la tuya, aparecerá aquí sola. Quien tenga acceso al servidor puede comprobarlo en cualquier momento con el comando de abajo, que no cambia nada sin avisar:",
  },
  "Sua instalação está numa versão de desenvolvimento. Atualizar vai levá-la para a versão publicada": {
    es: "Tu instalación está en una versión de desarrollo. Actualizar la llevará a la versión publicada",
  },
  "Requer atenção": { es: "Requiere atención" },
  "O que muda": { es: "Qué cambia" },
  "Iniciando…": { es: "Iniciando…" },
  "Atualizar agora": { es: "Actualizar ahora" },
  "O sistema sai do ar por cerca de 2 minutos e volta sozinho. Faço uma cópia de segurança dos seus dados antes.": {
    es: "El sistema queda fuera de servicio unos 2 minutos y vuelve solo. Antes hago una copia de seguridad de tus datos.",
  },
  "Detalhes técnicos (útil se for pedir ajuda)": {
    es: "Detalles técnicos (útil si vas a pedir ayuda)",
  },
  "Atualização do sistema": { es: "Actualización del sistema" },
  "Guardando uma cópia de segurança dos seus dados": {
    es: "Guardando una copia de seguridad de tus datos",
  },
  "Baixando a versão nova": { es: "Descargando la versión nueva" },
  "Atualizando o banco de dados": { es: "Actualizando la base de datos" },
  "Reiniciando o sistema": { es: "Reiniciando el sistema" },
  "Reiniciando…": { es: "Reiniciando…" },
  "O sistema está voltando. Esta página se atualiza sozinha em alguns instantes.": {
    es: "El sistema está volviendo a estar en línea. Esta página se actualiza sola en unos instantes.",
  },
  Copiado: { es: "Copiado" },
  // ─── Configurações: Billing ───
  "Planos, faturas e cobrança.": { es: "Planes, facturas y cobros." },
  "Em breve — Fase 2": { es: "Próximamente — Fase 2" },
  "Billing entra na Fase 2 do roadmap.": { es: "Billing entra en la Fase 2 del roadmap." },
  "Para questões de pagamento, contate": { es: "Para temas de pago, contacta a" },
  "Para questões de pagamento, fale com quem administra este sistema.": {
    es: "Para temas de pago, habla con quien administra este sistema.",
  },
  // ─── Configurações: Menu lateral da empresa (issue #1341) ───
  "Menu lateral": { es: "Menú lateral" },
  "Aplicar interface": { es: "Aplicar interfaz" },
  "Menu lateral da empresa salvo.": { es: "Menú lateral de la empresa guardado." },
  "Não foi possível salvar o menu da empresa.": {
    es: "No se pudo guardar el menú de la empresa.",
  },
  "Escolha as áreas que esta empresa mostra. Cada pessoa escolhe menos do que isto em Equipe — nunca mais — e as áreas essenciais continuam sempre visíveis. As permissões não mudam: o que o papel autoriza segue acessível por link, aviso e busca.": {
    es: "Elige las áreas que muestra esta empresa. Cada persona puede elegir menos áreas que estas en Equipo, nunca más, y las áreas esenciales siempre están visibles. Los permisos no cambian: lo que el rol autoriza sigue accesible por enlace, aviso y búsqueda.",
  },
  // ─── Configurações: Marca da organização ───
  "você definiu aqui": { es: "lo definiste aquí" },
  "é o padrão do sistema": { es: "es el predeterminado del sistema" },
  "veio de quem instalou o sistema": { es: "vino de quien instaló el sistema" },
  "Como sua empresa aparece": { es: "Cómo aparece tu empresa" },
  "Nome da sua empresa": { es: "Nombre de tu empresa" },
  "Aparece no menu lateral, para quem trabalha aqui. Deixe em branco para usar": {
    es: "Aparece en el menú lateral, para quien trabaja aquí. Déjalo en blanco para usar",
  },
  "Cor da sua marca": { es: "Color de tu marca" },
  "Deixe em branco para voltar à cor que o sistema já usa.": {
    es: "Déjalo en blanco para volver al color que el sistema ya usa.",
  },
  "Considerando o que está nos campos acima.": {
    es: "Según lo que hay en los campos de arriba.",
  },
  "Do jeito que está, esta cor não chegaria à tela: o sistema continuaria com a cor que já usa.": {
    es: "Tal como está, este color no se mostraría en pantalla: el sistema seguiría usando el color que ya tiene.",
  },
  "O que isto ainda não muda": { es: "Lo que esto todavía no cambia" },
  "O título da aba do navegador continua com o nome do sistema, e não com o da sua empresa.": {
    es: "El título de la pestaña del navegador sigue mostrando el nombre del sistema, no el de tu empresa.",
  },
  "A tela de entrada é sempre a do sistema: quando alguém digita a senha, ainda não dá para saber de qual empresa ele é.": {
    es: "La pantalla de inicio de sesión siempre es la del sistema: cuando alguien escribe su contraseña, todavía no se sabe a qué empresa pertenece.",
  },
  "Os e-mails que este sistema envia (convite de time, pedidos de LGPD) já saem com o nome da sua empresa.": {
    es: "Los correos que este sistema envía (invitación de equipo, solicitudes de LGPD) ya salen con el nombre de tu empresa.",
  },
  "O aplicativo de verificação em duas etapas continua registrando o nome do sistema: o cadastro acontece antes de saber de qual empresa a pessoa é.": {
    es: "La app de verificación en dos pasos sigue registrando el nombre del sistema, porque el registro ocurre antes de saber a qué empresa pertenece la persona.",
  },
  "O logo que você subir aqui aparece no menu lateral, para quem trabalha nesta empresa. A tela de entrada continua com o logo de quem instalou o sistema: ali ainda não dá para saber de qual empresa a pessoa é.": {
    es: "El logo que subas aquí aparece en el menú lateral para quien trabaja en esta empresa. La pantalla de inicio de sesión mantiene el logo de quien instaló el sistema, porque ahí todavía no se sabe a qué empresa pertenece la persona.",
  },
  "O nome e a cor que a sua empresa mostra para quem trabalha aqui dentro.": {
    es: "El nombre y el color que tu empresa muestra a quienes trabajan aquí dentro.",
  },
  // ─── Configurações: Notificações ───
  "Canais e categorias.": { es: "Canales y categorías." },
  "Preferências de notificação em breve. Por enquanto, alertas críticos são enviados por email.": {
    es: "Las preferencias de notificación llegarán próximamente. Por ahora, las alertas críticas se envían por correo.",
  },
  "Nova mensagem": { es: "Mensaje nuevo" },
  "Lead atribuído a você": { es: "Lead asignado a ti" },
  "Lead ganho": { es: "Lead ganado" },
  "Lead perdido": { es: "Lead perdido" },
  "Você foi mencionado": { es: "Te mencionaron" },
  "Ligação recebida": { es: "Llamada recibida" },
  Email: { es: "Correo" },
  "In-app": { es: "En la app" },
  Push: { es: "Push" },
  // ─── Configurações: Segurança ───
  "Gerar novos códigos invalida TODOS os atuais. Tem certeza?": {
    es: "Generar nuevos códigos invalida TODOS los actuales. ¿Estás seguro?",
  },
  "Novos códigos gerados.": { es: "Nuevos códigos generados." },
  "Erro:": { es: "Error:" },
  "Sair de TODOS os dispositivos? Você precisará fazer login de novo.": {
    es: "¿Cerrar sesión en TODOS los dispositivos? Tendrás que iniciar sesión de nuevo.",
  },
  "Verificação em duas etapas": { es: "Verificación en dos pasos" },
  "Além da senha, o sistema pede um código de 6 dígitos que só existe no seu celular. É a proteção que segura uma senha vazada.": {
    es: "Además de la contraseña, el sistema pide un código de 6 dígitos que solo existe en tu celular. Es la protección que frena una contraseña filtrada.",
  },
  Ativada: { es: "Activada" },
  Desativada: { es: "Desactivada" },
  "Ela é obrigatória para administradores desta empresa, então não dá para desligar aqui. Um administrador pode mudar essa regra abaixo.": {
    es: "Es obligatoria para los administradores de esta empresa, así que no se puede desactivar aquí. Un administrador puede cambiar esta regla abajo.",
  },
  "Desligar a verificação em duas etapas desta conta?": {
    es: "¿Desactivar la verificación en dos pasos de esta cuenta?",
  },
  "Verificação desligada.": { es: "Verificación desactivada." },

  // ─── app/actions/auth/politicaDeMfa.ts (erros do painel de Segurança/MFA) ───
  "Sua sessão expirou. Entre de novo.": { es: "Tu sesión expiró. Entra de nuevo." },
  "Nenhuma empresa ativa.": { es: "Ninguna empresa activa." },
  "Só um administrador pode mudar essa regra.": {
    es: "Solo un administrador puede cambiar esta regla.",
  },
  "Não consegui ler a configuração agora.": { es: "No pude leer la configuración ahora." },
  "Não consegui salvar essa mudança agora.": { es: "No pude guardar ese cambio ahora." },
  "A verificação em duas etapas é obrigatória para administradores desta empresa. Desligue a regra antes.":
    {
      es: "La verificación en dos pasos es obligatoria para los administradores de esta empresa. Primero desactiva esa regla.",
    },
  "Entre de novo e informe o código de 6 dígitos antes de desligar a verificação.": {
    es: "Entra de nuevo e ingresa el código de 6 dígitos antes de desactivar la verificación.",
  },
  "Não consegui remover a verificação agora.": { es: "No pude quitar la verificación ahora." },
  Ativar: { es: "Activar" },
  "Exigir de quem administra": { es: "Exigir a quien administra" },
  "Agora os administradores precisam da verificação.": {
    es: "Ahora los administradores necesitan la verificación.",
  },
  "A verificação deixou de ser obrigatória.": { es: "La verificación dejó de ser obligatoria." },
  "Todo administrador desta empresa precisa configurar a verificação em duas etapas.": {
    es: "Todo administrador de esta empresa necesita configurar la verificación en dos pasos.",
  },
  "Quando ligado, quem administra vê uma tela pedindo a configuração antes de usar o sistema. Ligue se a sua equipe mexe com dados de clientes — é a diferença entre uma senha vazada virar um susto ou virar um vazamento.": {
    es: "Cuando está activado, quien administra ve una pantalla que le pide configurar la verificación antes de usar el sistema. Actívalo si tu equipo maneja datos de clientes: es la diferencia entre que una contraseña filtrada sea un susto o una filtración.",
  },
  "Códigos de recuperação": { es: "Códigos de recuperación" },
  "Use se perder acesso ao autenticador. Cada código é de uso único.": {
    es: "Úsalos si pierdes acceso al autenticador. Cada código es de un solo uso.",
  },
  "Gerando…": { es: "Generando…" },
  "Regenerar códigos de recuperação": { es: "Regenerar códigos de recuperación" },
  "Habilite MFA antes de gerar códigos.": { es: "Habilita MFA antes de generar códigos." },
  "Sessões ativas": { es: "Sesiones activas" },

  // ── Chamada de voz pelo WhatsApp (spec 18) ──────────────────────────────
  // O aviso de risco é a peça mais importante desta tela, e traduzi-lo pela
  // metade seria pior que não traduzir: quem lê espanhol veria o botão em
  // espanhol e o RISCO em português — a parte que precisa ser entendida.
  "Chamada de voz pelo WhatsApp": { es: "Llamadas de voz por WhatsApp" },
  "Ligada. Sua equipe pode ligar e receber chamadas pelo número conectado.": {
    es: "Activada. Tu equipo puede hacer y recibir llamadas por el número conectado.",
  },
  "Desligada. Ninguém consegue ligar nem receber chamadas por aqui.": {
    es: "Desactivada. Nadie puede hacer ni recibir llamadas por aquí.",
  },
  "A chamada de voz está desligada nesta empresa.": {
    es: "Las llamadas de voz están desactivadas en esta empresa.",
  },
  "Conectar o aparelho exige ligá-la antes, em Configurações › Segurança — é lá que está o aviso sobre o risco de o WhatsApp bloquear a conta, e quem liga precisa ter lido.":
    {
      es: "Para conectar el dispositivo, primero hay que activar las llamadas de voz en Configuración › Seguridad. Ahí está el aviso sobre el riesgo de que WhatsApp bloquee la cuenta, y quien las activa debe haberlo leído.",
    },
  "Leia antes de ligar": { es: "Lee antes de activar" },
  "Para fazer chamadas, o sistema precisa conectar um segundo aparelho ao mesmo número de WhatsApp que você já usa para atender. Essa conexão não é feita pelo caminho oficial do WhatsApp.":
    {
      es: "Para hacer llamadas, el sistema necesita conectar un segundo dispositivo al mismo número de WhatsApp que ya usas para atender. Esa conexión no se hace por la vía oficial de WhatsApp.",
    },
  "O WhatsApp pode entender isso como uso indevido e bloquear a CONTA — não só a chamada. Se isso acontecer, você perde também as mensagens desse número, e recuperar depende do WhatsApp, não de nós.":
    {
      es: "WhatsApp puede considerarlo un uso indebido y bloquear la CUENTA, no solo la llamada. Si eso ocurre, también pierdes los mensajes de ese número, y recuperarlo depende de WhatsApp, no de nosotros.",
    },
  "Ligue apenas se a chamada de voz valer esse risco para o seu negócio. Você pode desligar a qualquer momento aqui mesmo — e o aparelho é desconectado na hora.":
    {
      es: "Actívalas solo si las llamadas de voz valen ese riesgo para tu negocio. Puedes desactivarlas en cualquier momento aquí mismo, y el dispositivo se desconecta al instante.",
    },
  "Este servidor não tem a chamada de voz instalada. Quem cuida da instalação precisa ligá-la antes — depois esta opção fica disponível aqui.":
    {
      es: "Este servidor no tiene instaladas las llamadas de voz. Quien administra la instalación debe activarlas primero. Después, esta opción aparecerá aquí.",
    },
  "Só quem é administrador desta empresa pode mudar isto.": {
    es: "Solo un administrador de esta empresa puede cambiar esto.",
  },
  "Risco aceito em": { es: "Riesgo aceptado el" },
  "Não consegui verificar se a chamada de voz está ligada nesta empresa. Recarregue a página; se continuar, avise quem cuida da instalação.":
    {
      es: "No pude verificar si las llamadas de voz están activadas en esta empresa. Recarga la página; si continúa, avisa a quien administra la instalación.",
    },
  "Desligar e desconectar o aparelho": { es: "Desactivar y desconectar el dispositivo" },
  "Desligando…": { es: "Desactivando…" },
  "Eu li o aviso acima e aceito o risco de o WhatsApp bloquear esta conta.": {
    es: "He leído el aviso de arriba y acepto el riesgo de que WhatsApp bloquee esta cuenta.",
  },
  "Ligar chamada de voz": { es: "Activar llamadas de voz" },
  "Ligando…": { es: "Activando…" },
  // Mensagens que as rotas de voz devolvem traduzidas (`traduzir(..., idioma)`).
  "Chamada de voz ligada.": { es: "Llamadas de voz activadas." },
  "Chamada de voz desligada.": { es: "Llamadas de voz desactivadas." },
  "O número de voz está sem conexão com o WhatsApp neste momento. Aguarde alguns segundos e tente de novo; se continuar, desconecte o número e pareie de novo em Configurações › Canais.":
    {
      es: "El número de voz no tiene conexión con WhatsApp en este momento. Espera unos segundos y vuelve a intentarlo. Si el problema continúa, desconecta el número y vincúlalo de nuevo en Configuración › Canales.",
    },
  "Chamada de voz desligada e aparelho desconectado.": {
    es: "Llamadas de voz desactivadas y dispositivo desconectado.",
  },
  "Não foi possível salvar.": { es: "No se pudo guardar." },
  "Para ligar a chamada de voz é preciso aceitar o risco de vincular um segundo aparelho ao seu número.":
    {
      es: "Para activar las llamadas de voz hay que aceptar el riesgo de vincular un segundo dispositivo a tu número.",
    },
  "A chamada de voz não está disponível neste servidor. Quem administra a instalação precisa ligá-la antes.":
    {
      es: "Las llamadas de voz no están disponibles en este servidor. Quien administra la instalación debe activarlas antes.",
    },
  "A chamada de voz não está disponível neste servidor — sem ela o aparelho não pode ser desconectado.":
    {
      es: "Las llamadas de voz no están disponibles en este servidor. Sin ellas, el dispositivo no se puede desconectar.",
    },
  "Listagem de sessões — em breve. Por enquanto, deslogue todos os dispositivos:": {
    es: "Listado de sesiones — próximamente. Por ahora, cierra sesión en todos los dispositivos:",
  },
  "Saindo…": { es: "Cerrando sesión…" },
  "Sair de todos os dispositivos": { es: "Cerrar sesión en todos los dispositivos" },
  "A verificação em duas etapas da sua conta, os códigos de recuperação e as sessões abertas.": {
    es: "La verificación en dos pasos de tu cuenta, los códigos de recuperación y las sesiones abiertas.",
  },
  // ─── Configurações: Funis (etapas + mapeamento do assistente) ───
  "Você ainda não tem nenhum funil. Enquanto for assim, o agente atende normalmente, mas não tem para onde levar o card de ninguém — não há etapas para onde mover. Criar o funil é feito por quem instalou o sistema, direto no banco; depois ele aparece aqui para você escolher a etapa de cada passo.": {
    es: "Todavía no tienes ningún embudo. Mientras tanto, el agente atiende con normalidad, pero no puede mover la tarjeta de nadie porque no hay etapas. El embudo lo crea quien instaló el sistema, directamente en la base de datos. Después aparecerá aquí para que elijas la etapa de cada paso.",
  },
  "Custom fields: JSON inválido. Esperado um array.": {
    es: "Custom fields: JSON inválido. Se esperaba un array.",
  },
  "atualizado.": { es: "actualizado." },
  "Vocabulário e campos": { es: "Vocabulario y campos" },
  "Motivos de perda (separados por vírgula)": { es: "Motivos de pérdida (separados por comas)" },
  "Ex:": { es: "Ej.:" },
  "Salvar vocabulário e campos": { es: "Guardar vocabulario y campos" },
  "As etapas que serviriam para este passo já estão sendo usadas por outros passos. Libere uma delas para poder escolhê-la aqui.": {
    es: "Las etapas que servirían para este paso ya las usan otros pasos. Libera una para poder elegirla aquí.",
  },
  "Este funil não tem nenhuma etapa marcada como fechamento, então não há para onde levar o card quando a pessoa fecha. Marque uma etapa como «aqui o cliente fecha» em «Etapas deste funil».": {
    es: "Este embudo no tiene ninguna etapa marcada como cierre, así que no hay adónde llevar la tarjeta cuando la persona cierra. Marca una etapa como «aquí el cliente cierra» en «Etapas de este embudo».",
  },
  "Este funil não tem nenhuma etapa marcada como perda, então não há para onde levar o card quando a pessoa desiste. Marque uma etapa como «aqui o cliente desiste» em «Etapas deste funil».": {
    es: "Este embudo no tiene ninguna etapa marcada como pérdida, así que no hay adónde llevar la tarjeta cuando la persona desiste. Marca una etapa como «aquí el cliente desiste» en «Etapas de este embudo».",
  },
  "Este funil só tem etapas de fechamento e de perda, então não há etapa comum para receber o card neste passo. Crie as etapas do meio do caminho em «Etapas deste funil».": {
    es: "Este embudo solo tiene etapas de cierre y de pérdida, así que no hay una etapa común para recibir la tarjeta en este paso. Crea las etapas intermedias en «Etapas de este embudo».",
  },
  "Sua sessão expirou. Entre de novo para salvar suas escolhas.": {
    es: "Tu sesión expiró. Vuelve a entrar para guardar tu selección.",
  },
  "Você não tem permissão para mudar a configuração deste funil.": {
    es: "No tienes permiso para cambiar la configuración de este embudo.",
  },
  "Não deu para salvar agora. Tente de novo em instantes.": {
    es: "No se pudo guardar ahora. Inténtalo de nuevo en un momento.",
  },
  "Não foi possível carregar as etapas deste funil agora. Recarregue a página.": {
    es: "No se pudieron cargar las etapas de este embudo ahora. Recarga la página.",
  },
  "Carregando as etapas deste funil…": { es: "Cargando las etapas de este embudo…" },
  "Escolhas salvas.": { es: "Selección guardada." },
  "Para onde o card vai em cada passo": { es: "Adónde va la tarjeta en cada paso" },
  "Quando o agente avança no atendimento, o card do cliente pode andar sozinho no seu funil. Escolha para qual etapa ele vai em cada momento. Deixar em «não mover» é uma escolha válida — o card fica onde está e o agente segue trabalhando.": {
    es: "Cuando el agente avanza en la atención, la tarjeta del cliente puede moverse sola por tu embudo. Elige a qué etapa va en cada momento. Dejarlo en «no mover» también es válido: la tarjeta se queda donde está y el agente sigue trabajando.",
  },
  "Ir para as etapas do funil": { es: "Ir a las etapas del embudo" },
  "Etapa para": { es: "Etapa para" },
  "Não mover o card": { es: "No mover la tarjeta" },
  "As escolhas voltaram para o que está gravado agora — confira e escolha de novo.": {
    es: "La selección volvió a lo que está guardado ahora. Revísala y elige de nuevo.",
  },
  "Salvar estas escolhas": { es: "Guardar selección" },
  negócio: { es: "negocio" },
  negócios: { es: "negocios" },
  "Etapa atualizada.": { es: "Etapa actualizada." },
  "Só uma etapa pode ser a de fechamento. Marcar esta desmarca": {
    es: "Solo una etapa puede ser la de cierre. Marcar esta desmarca",
  },
  "Só uma etapa pode ser a de perda. Marcar esta desmarca": {
    es: "Solo una etapa puede ser la de pérdida. Marcar esta desmarca",
  },
  "saiu do quadro.": { es: "salió del tablero." },
  "entrou no fim do funil.": { es: "entró al final del embudo." },
  "Etapas deste funil": { es: "Etapas de este embudo" },
  "Estas são as colunas do seu quadro, na ordem em que o cliente avança. Você pode renomear, criar, reordenar e arquivar.": {
    es: "Estas son las columnas de tu tablero, en el orden en que el cliente avanza. Puedes renombrar, crear, reordenar y archivar.",
  },
  "Duas colunas têm papel especial: a": { es: "Dos columnas tienen un rol especial: la" },
  "de fechamento": { es: "de cierre" },
  "é onde o negócio vira venda, e a": { es: "es donde el negocio se convierte en venta, y la" },
  "de perda": { es: "de pérdida" },
  "é onde ele se perde. Cada funil precisa de uma de cada — por isso a marcação se muda de lugar, não se apaga.": {
    es: "es donde se pierde. Cada embudo necesita una de cada — por eso la marca se cambia de lugar, no se borra.",
  },
  Mover: { es: "Mover" },
  "uma coluna para trás": { es: "una columna hacia atrás" },
  "uma coluna para frente": { es: "una columna hacia adelante" },
  "no funil": { es: "en el embudo" },
  "O assistente usa esta etapa para": { es: "El asistente usa esta etapa para" },
  "Mudar isso": { es: "Cambiar esto" },
  "Marcar mesmo assim": { es: "Marcar de todas formas" },
  "A coluna sai do quadro e para de receber negócios novos. Nada é apagado — o histórico de quem passou por ela continua guardado —, mas": {
    es: "La columna sale del tablero y deja de recibir negocios nuevos. Nada se borra (el historial de quien pasó por ella sigue guardado), pero",
  },
  "não dá para trazer a coluna de volta por aqui": {
    es: "no se puede recuperar la columna desde aquí",
  },
  "está nesta etapa e não há outra coluna em aberto para recebê-lo.": {
    es: "está en esta etapa y no hay otra columna abierta para recibirlo.",
  },
  "estão nesta etapa e não há outra coluna em aberto para recebê-los.": {
    es: "están en esta etapa y no hay otra columna abierta para recibirlos.",
  },
  "Crie uma etapa antes de arquivar": { es: "Crea una etapa antes de archivar" },
  "está nesta etapa. Para onde ele vai?": { es: "está en esta etapa. ¿Adónde va?" },
  "estão nesta etapa. Para onde eles vão?": { es: "están en esta etapa. ¿Adónde van?" },
  "Para onde vão os negócios de": { es: "Adónde van los negocios de" },
  "Esta etapa é a que o assistente usa para": { es: "Esta es la etapa que el asistente usa para" },
  "Arquivando, ele para de mover o card nesse passo até você escolher outra etapa em": {
    es: "Al archivar, deja de mover la tarjeta en ese paso hasta que elijas otra etapa en",
  },
  "Mover os negócios e arquivar": { es: "Mover los negocios y archivar" },
  "Ir para o mapeamento do assistente": { es: "Ir al mapeo del asistente" },
  "Acrescentar etapa ao fim": { es: "Agregar etapa al final" },
  "Nome da nova coluna": { es: "Nombre de la nueva columna" },
  "Nome da nova etapa": { es: "Nombre de la nueva etapa" },
  "Nome da etapa": { es: "Nombre de la etapa" },
  "Para onde o agente leva o card em cada passo do atendimento": {
    es: "Adónde lleva el agente la tarjeta en cada paso de la atención",
  },
  ", vocabulário, custom fields e motivos de perda": {
    es: ", vocabulario, custom fields y motivos de pérdida",
  },
  "Nada especial": { es: "Nada especial" },
  "Aqui o cliente fecha": { es: "Aquí el cliente cierra" },
  "Aqui o cliente desiste": { es: "Aquí el cliente desiste" },
  "Nome da coluna (clique para renomear)": {
    es: "Nombre de la columna (haz clic para renombrar)",
  },
  Ordem: { es: "Orden" },
  "O que acontece nesta coluna": { es: "Qué pasa en esta columna" },
  "a pessoa acabou de chamar e ninguém respondeu ainda": {
    es: "la persona acaba de escribir y todavía nadie respondió",
  },
  "o agente já respondeu pela primeira vez": { es: "el agente ya respondió por primera vez" },
  "o agente está entendendo o que a pessoa precisa": {
    es: "el agente está entendiendo qué necesita la persona",
  },
  "o agente já entendeu a necessidade": { es: "el agente ya entendió la necesidad" },
  "conversa de preço, proposta ou agendamento": { es: "conversación de precio, propuesta o cita" },
  "a pessoa fechou": { es: "la persona cerró" },
  "a pessoa desistiu ou parou de responder": { es: "la persona desistió o dejó de responder" },
  "Novo lead": { es: "Lead nuevo" },
  "Primeiro contato": { es: "Primer contacto" },
  "Em qualificação": { es: "En calificación" },
  Qualificado: { es: "Calificado" },
  "Em negociação": { es: "En negociación" },
  Ganho: { es: "Ganado" },
  Perdido: { es: "Perdido" },
  // ─── Achados: chamadas com aspas simples (ponto cego do checker por regex) ───
  "O relatório de LGPD entregue ao cliente traz a RAZÃO SOCIAL da sua empresa, e não o nome aqui de cima — é ela que responde legalmente pelos dados. Confira o campo \"Razão social\" em Configurações → Organização.": {
    es: "El informe de LGPD que se entrega al cliente incluye la RAZÓN SOCIAL de tu empresa, no el nombre de arriba, porque es ella quien responde legalmente por los datos. Revisa el campo \"Razón social\" en Configuración → Organización.",
  },
  "Use a ação \"Webhooks\" → POST, apontando para o endereço acima.": {
    es: "Usa la acción \"Webhooks\" → POST y apunta a la dirección de arriba.",
  },
  // ─── Gaps reais achados na varredura completa do codebase (áreas ai/admin já fechadas) ───
  Incidentes: { es: "Incidentes" },
  "Último acesso": { es: "Último acceso" },
  "Este follow-up ainda não deu nenhum passo.": {
    es: "Este seguimiento todavía no dio ningún paso.",
  },
  "Mostrando os primeiros passos — este follow-up tem histórico maior que o desta tela.": {
    es: "Se muestran los primeros pasos. Este seguimiento tiene más historial del que cabe en esta pantalla.",
  },
  "Carregando o follow-up…": { es: "Cargando el seguimiento…" },
  "Não consegui carregar este follow-up. Recarregue a página; se persistir, ele pode ter sido removido.": {
    es: "No pude cargar este seguimiento. Recarga la página; si el problema continúa, es posible que se haya eliminado.",
  },
  "Voltar para a fila": { es: "Volver a la cola" },
  Fluxo: { es: "Flujo" },
  Adiar: { es: "Posponer" },
  "Ex.: Roteador de vendas": { es: "Ej.: Enrutador de ventas" },
  Perfil: { es: "Perfil" },
  CNPJ: { es: "CNPJ" },
  "Cole o endereço acima no campo \"Action\" (ou \"URL de envio\") do seu formulário.": {
    es: "Pega la dirección de arriba en el campo \"Action\" (o \"URL de envío\") de tu formulario.",
  },
  Descartar: { es: "Descartar" },
  Você: { es: "Tú" },
  Cliente: { es: "Cliente" },
  "(sem texto)": { es: "(sin texto)" },
  "Cancelar resposta": { es: "Cancelar respuesta" },
  // ─── Saúde do canal (bolinha da sidebar + estado do canal) ───
  "Todas as conexões ativas": { es: "Todas las conexiones activas" },
  "Conectando…": { es: "Conectando…" },
  "Uma conexão caiu": { es: "Una conexión se cayó" },
  "Nenhuma conexão": { es: "Ninguna conexión" },
  "Não foi possível verificar as conexões": { es: "No se pudieron verificar las conexiones" },
  "Escaneie o QR": { es: "Escanea el QR" },
  Parado: { es: "Detenido" },
  Caiu: { es: "Se cayó" },
  "Situação desconhecida": { es: "Estado desconocido" },
  "Número sem nome": { es: "Número sin nombre" },
  Etapa: { es: "Etapa" },
  "Escolha o número": { es: "Elige el número" },
  Mensagem: { es: "Mensaje" },
  "Escolha o agente": { es: "Elige el agente" },
  "E-mail": { es: "Correo" },
  Quem: { es: "Quién" },
  "ação": { es: "acción" },
  "ações": { es: "acciones" },
  Ligar: { es: "Activar" },
  "Seu nome": { es: "Tu nombre" },
  "Selecione uma conversa para visualizar": {
    es: "Selecciona una conversación para verla",
  },
  "Modo somente-leitura. Use “Impersonate” para responder como atendente do tenant.": {
    es: "Modo de solo lectura. Usa “Impersonate” para responder como asesor del tenant.",
  },
  "Sem nome": { es: "Sin nombre" },
  "Buscar mensagem...": { es: "Buscar mensaje..." },
  "Falha ao carregar conversas.": { es: "No se pudieron cargar las conversaciones." },
  "Nenhuma conversa encontrada.": { es: "No se encontró ninguna conversación." },
  "Falha ao carregar conversa.": { es: "No se pudo cargar la conversación." },
  "Sem mensagens nesta conversa.": { es: "No hay mensajes en esta conversación." },
  "Modo somente-leitura.": { es: "Modo de solo lectura." },
  "Use “Impersonate” (em breve, S-11.07) para responder.": {
    es: "Usa “Impersonate” (próximamente, S-11.07) para responder.",
  },
  "Contato anonimizado": { es: "Contacto anonimizado" },
  "Sem contato vinculado.": { es: "Sin contacto vinculado." },
  "Abrir tenant": { es: "Abrir tenant" },
  "Sem organização vinculada.": { es: "Sin organización vinculada." },
  "Status:": { es: "Estado:" },
  Carregando: { es: "Cargando" },
  Admin: { es: "Administrador" },
  Manager: { es: "Gerente" },
  Viewer: { es: "Visualizador" },

  // ─── Inbox (lado tenant): lista, filtros, cabeçalho da conversa ───
  Aguardando: { es: "Esperando" },
  "Erro ao carregar conversas.": { es: "Error al cargar las conversaciones." },
  "Tentar novamente": { es: "Intentar de nuevo" },
  "Buscar conversas": { es: "Buscar conversaciones" },
  "Filtrar por número de WhatsApp": { es: "Filtrar por número de WhatsApp" },
  "Filtrar por tag": { es: "Filtrar por etiqueta" },
  Anonimizado: { es: "Anonimizado" },
  "Entrou por": { es: "Entró por" },
  "Posição": { es: "Posición" },
  "na fila": { es: "en la cola" },
  "Última mensagem do cliente": { es: "Último mensaje del cliente" },
  "Desde quando o cliente espera resposta": { es: "Desde cuándo el cliente espera respuesta" },
  Arquivada: { es: "Archivada" },
  "Aguardando o cliente": { es: "Esperando al cliente" },

  // ─── Inbox: painel lateral CRM (demandas, leads, pedidos, atividade) ───
  "Nenhuma demanda aberta.": { es: "No hay casos abiertos." },
  "Demandas abertas": { es: "Casos abiertos" },
  "Leads recentes": { es: "Leads recientes" },
  "Pedidos recentes": { es: "Pedidos recientes" },
  "O que acontece a seguir?": { es: "¿Qué pasa a continuación?" },
  "Próximo passo desta demanda": { es: "Siguiente paso de este caso" },
  "Não consegui salvar o próximo passo. Tente de novo.": {
    es: "No pude guardar el siguiente paso. Intenta de nuevo.",
  },
  "Nenhum funil configurado nesta organização.": {
    es: "No hay ningún embudo configurado en esta organización.",
  },
  "Não consegui ler estes dados.": { es: "No pude leer estos datos." },
  "Selecione uma conversa para ver detalhes do contato.": {
    es: "Selecciona una conversación para ver los detalles del contacto.",
  },

  // ─── Inbox: layout, cabeçalho de conversa e thread ───
  "Conversa não encontrada ou fora do seu acesso.": {
    es: "No se encontró la conversación o no tienes acceso a ella.",
  },
  "Selecione uma conversa": { es: "Selecciona una conversación" },
  "Ou navegue com J e K": { es: "O navega con J y K" },
  Ficha: { es: "Ficha" },
  "Ficha do contato": { es: "Ficha del contacto" },
  Hoje: { es: "Hoy" },
  Ontem: { es: "Ayer" },
  "Erro ao carregar mensagens.": { es: "Error al cargar los mensajes." },
  "Nenhuma mensagem nesta conversa.": { es: "No hay mensajes en esta conversación." },
  "Carregar mais antigas": { es: "Cargar más antiguos" },
  Lida: { es: "Leído" },
  Entregue: { es: "Entregado" },
  Enviada: { es: "Enviado" },
  "Responder a esta mensagem": { es: "Responder a este mensaje" },
  "Esta mensagem foi apagada": { es: "Este mensaje fue eliminado" },
  editada: { es: "editado" },
  "O autor editou esta mensagem": { es: "El autor editó este mensaje" },
  "Erro desconhecido": { es: "Error desconocido" },
  "Você passa a responder esta conversa e o atendimento automático para aqui.": {
    es: "Desde ahora tú respondes esta conversación y la atención automática se detiene aquí.",
  },
  "Religa o atendimento automático para este cliente — vale para todas as conversas dele.": {
    es: "Reactiva la atención automática para este cliente — vale para todas sus conversaciones.",
  },
  "Devolve esta conversa ao atendimento automático.": {
    es: "Devuelve esta conversación a la atención automática.",
  },
  "Devolvendo...": { es: "Devolviendo..." },
  "O atendimento automático para nesta conversa. O dono não muda.": {
    es: "La atención automática se detiene en esta conversación. El dueño no cambia.",
  },
  "Pausando...": { es: "Pausando..." },
  "Fechar esta conversa?": { es: "¿Cerrar esta conversación?" },
  "Arquivar esta conversa?": { es: "¿Archivar esta conversación?" },
  "Arquivar encerra este atendimento e guarda a conversa no histórico. Se o cliente escrever de novo, ela volta. Arquivar?": {
    es: "Archivar cierra esta atención y guarda la conversación en el historial. Si el cliente vuelve a escribir, la conversación regresa. ¿Archivar?",
  },
  "Arquivando...": { es: "Archivando..." },
  Automático: { es: "Automático" },
  Alguém: { es: "Alguien" },
  "Nota interna · só o time vê": { es: "Nota interna · solo la ve el equipo" },
  "Excluir nota": { es: "Eliminar nota" },

  // ─── Inbox: transferir conversa / atalhos de teclado ───
  "Transferir conversa": { es: "Transferir conversación" },
  "A transferência é imediata: o atendente escolhido vira o responsável agora e a mudança fica registrada no histórico.": {
    es: "La transferencia es inmediata: el asesor elegido pasa a ser el responsable y el cambio queda registrado en el historial.",
  },
  "Transferir para": { es: "Transferir a" },
  "Carregando atendentes…": { es: "Cargando asesores…" },
  "Nenhum outro atendente disponível nesta organização.": {
    es: "No hay ningún otro asesor disponible en esta organización.",
  },
  "Motivo (opcional)": { es: "Motivo (opcional)" },
  "Ex.: cliente pediu falar com o financeiro": { es: "Ej.: el cliente pidió hablar con finanzas" },
  "Transferindo…": { es: "Transfiriendo…" },
  Gestor: { es: "Gestor" },
  "Atalhos de teclado": { es: "Atajos de teclado" },
  "Próxima conversa": { es: "Siguiente conversación" },
  "Conversa anterior": { es: "Conversación anterior" },
  "Focar resposta": { es: "Ir al campo de respuesta" },
  "Enviar a mensagem": { es: "Enviar el mensaje" },
  "Quebrar linha sem enviar": { es: "Salto de línea sin enviar" },
  "Assumir conversa": { es: "Asumir conversación" },
  "Fechar conversa": { es: "Cerrar conversación" },
  "Mostrar atalhos": { es: "Mostrar atajos" },

  // ─── Inbox: tags de contato/conversa ───
  "Sem tags no contato.": { es: "Sin etiquetas en el contacto." },
  "Adicionar tag ao contato": { es: "Agregar etiqueta al contacto" },
  "Remover tag": { es: "Quitar etiqueta" },
  "Tags da conversa": { es: "Etiquetas de la conversación" },

  "Aguarde uma nova mensagem do cliente para reabrir o atendimento nesta rede.": { es: "Espera un nuevo mensaje del cliente para reabrir la atención en esta red." },
  "aguardando o cliente": { es: "esperando al cliente" },
  "Tempo restante para responder. Uma nova mensagem do cliente reabre a janela.": { es: "Tiempo restante para responder. Un nuevo mensaje del cliente reabre la ventana." },
  // ─── Inbox: janela de 24h fechada / seletor de modelo aprovado ───
  "Modelo enviado — a janela reabre quando o cliente responder.": {
    es: "Plantilla enviada — la ventana se reabre cuando el cliente responda.",
  },
  "Não consegui enviar o modelo.": { es: "No pude enviar la plantilla." },
  "link da imagem": { es: "enlace de la imagen" },
  "Salvar este link no modelo": { es: "Guardar este enlace en la plantilla" },
  "já há um link salvo": { es: "ya hay un enlace guardado" },
  "O modelo saiu, mas não consegui salvar o link nele.": {
    es: "La plantilla se envió, pero no pude guardar el enlace en ella.",
  },
  "link do vídeo": { es: "enlace del video" },
  "link do documento": { es: "enlace del documento" },
  "sufixo da URL": { es: "sufijo de la URL" },
  "código do cupom": { es: "código del cupón" },
  "A mídia do modelo entra por link público — a plataforma baixa o arquivo na hora do envio.": {
    es: "El archivo multimedia de la plantilla va por enlace público: la plataforma lo descarga en el momento del envío.",
  },
  "Nenhum modelo aprovado ainda. Crie um em": { es: "Todavía no hay ninguna plantilla aprobada. Crea una en" },
  "Conexões → Templates": { es: "Conexiones → Plantillas" },
  "e envie quando a plataforma aprovar.": { es: "y envíala cuando la plataforma la apruebe." },
  "Modelo aprovado": { es: "Plantilla aprobada" },
  "Este modelo pede": { es: "Esta plantilla pide" },
  "valor(es) e ainda não dá para preenchê-los aqui — envie por": {
    es: "valor(es) y todavía no se pueden completar aquí — envía por",
  },
  "ou escolha um modelo sem parâmetros.": { es: "o elige una plantilla sin parámetros." },
  "O cliente nunca escreveu": { es: "El cliente nunca escribió" },
  "Janela fechada há": { es: "Ventana cerrada hace" },
  "só modelo": { es: "solo plantilla" },
  "Passaram 24h desde a última mensagem do cliente. Só um modelo aprovado sai daqui — texto livre é recusado pela plataforma.": {
    es: "Pasaron 24h desde el último mensaje del cliente. Desde aquí solo se puede enviar una plantilla aprobada: la plataforma rechaza el texto libre.",
  },
  "Tempo restante para escrever texto livre. Depois disso, só modelo aprovado.": {
    es: "Tiempo restante para escribir texto libre. Después de eso, solo plantilla aprobada.",
  },
  Janela: { es: "Ventana" },
  "Lembrete ativo": { es: "Recordatorio activo" },
  "Cancelar lembrete": { es: "Cancelar recordatorio" },
  "Em 1 hora": { es: "En 1 hora" },
  "Em 3 horas": { es: "En 3 horas" },
  "Em 24 horas": { es: "En 24 horas" },

  // ─── Inbox: composer (anexos, áudio, contato, templates) ───
  Anexar: { es: "Adjuntar" },
  "Fotos e vídeos": { es: "Fotos y videos" },
  Documento: { es: "Documento" },
  "Enviar anexo": { es: "Enviar adjunto" },
  "Legenda (opcional)": { es: "Descripción (opcional)" },
  Legenda: { es: "Descripción" },
  "Gravar áudio": { es: "Grabar audio" },
  "Cancelar gravação": { es: "Cancelar grabación" },
  "Enviar áudio": { es: "Enviar audio" },
  "Não consegui acessar o microfone. Verifique a permissão do navegador.": {
    es: "No pude acceder al micrófono. Verifica el permiso del navegador.",
  },
  "Enviar contato": { es: "Enviar contacto" },
  "Escolha alguém da base ou informe nome e telefone — como no WhatsApp.": {
    es: "Elige a alguien de la base o indica nombre y teléfono — como en WhatsApp.",
  },
  "Buscar por nome ou telefone…": { es: "Buscar por nombre o teléfono…" },
  "Nenhum contato encontrado na base.": { es: "No se encontró ningún contacto en la base." },
  "Nenhum contato com telefone na base.": { es: "No hay ningún contacto con teléfono en la base." },
  "Enviar número informado": { es: "Enviar número indicado" },
  "Ou informe um contato": { es: "O indica un contacto" },
  "Como aparece no cartão": { es: "Cómo aparece en la tarjeta" },
  "Sugerir resposta": { es: "Sugerir respuesta" },
  Emoji: { es: "Emoji" },
  "Templates de script": { es: "Plantillas de guion" },
  "Nenhum template. Crie em Configurações.": { es: "Ninguna plantilla. Crea una en Configuración." },

  // ─── Inbox: mídia (áudio, imagem, figurinha, vídeo, documento) ───
  "Mídia indisponível": { es: "Contenido no disponible" },
  Áudio: { es: "Audio" },
  Imagem: { es: "Imagen" },
  Figurinha: { es: "Sticker" },
  Vídeo: { es: "Video" },
  "Pausar áudio": { es: "Pausar audio" },
  "Reproduzir áudio": { es: "Reproducir audio" },
  "Progresso do áudio": { es: "Progreso del audio" },
  "Velocidade de reprodução": { es: "Velocidad de reproducción" },
  "Ampliar imagem": { es: "Ampliar imagen" },
  "Imagem recebida": { es: "Imagen recibida" },
  Baixar: { es: "Descargar" },
  "Abrir conversa com este contato": { es: "Abrir conversación con este contacto" },
  "Não foi possível abrir a conversa.": { es: "No se pudo abrir la conversación." },
  "Enter salva a nota · Shift+Enter quebra linha": { es: "Enter guarda la nota · Shift+Enter agrega un salto de línea" },
  "Enter envia · Shift+Enter quebra linha": { es: "Enter envía · Shift+Enter agrega un salto de línea" },

  // ─── Inbox: aviso de retenção (before_send) ───
  "sem domingo": { es: "sin domingo" },
  "Fora da janela de envio": { es: "Fuera de la ventana de envío" },
  "A resposta fica agendada para a próxima abertura da janela, às": {
    es: "La respuesta queda programada para cuando se abra de nuevo la ventana, a las",
  },
  "isso protege o número contra bloqueio do WhatsApp.": {
    es: "esto evita que WhatsApp bloquee el número.",
  },
  "Este número ainda está em aquecimento e o limite diário de envios dele foi atingido. Enviar além disso arriscaria bloqueio pelo WhatsApp — libera de novo amanhã, a partir das": {
    es: "Este número aún está en calentamiento y ya alcanzó su límite diario de envíos. Enviar más podría hacer que WhatsApp lo bloquee. El límite se restablece mañana, a partir de las",
  },
  "O limite diário de envios do número foi atingido — proteção contra bloqueio do WhatsApp. Libera de novo amanhã, a partir das": {
    es: "El número alcanzó su límite diario de envíos. Es una protección para evitar que WhatsApp lo bloquee. Se restablece mañana, a partir de las",
  },
  "A mesma mensagem estava se repetindo em massa por este número. O envio foi segurado para variar o texto e não parecer robô para o WhatsApp.": {
    es: "Este número estaba repitiendo el mismo mensaje en masa. Se retuvo el envío para variar el texto y que WhatsApp no lo tome por un robot.",
  },
  "O contato pediu para não receber mensagens (opt-out). Nada será enviado a ele.": {
    es: "El contacto pidió no recibir mensajes (opt-out). No se le enviará nada.",
  },
  "Este contato foi anonimizado (LGPD) — é proibido enviar qualquer mensagem a ele.": {
    es: "Este contacto fue anonimizado (LGPD). Está prohibido enviarle cualquier mensaje.",
  },
  "Não há base legal (LGPD) para o primeiro contato de prospecção com este lead. O time precisa regularizar o cadastro antes de abordar.": {
    es: "No hay base legal (LGPD) para el primer contacto de prospección con este lead. El equipo necesita regularizar el registro antes de contactarlo.",
  },
  "A resposta prometia um preço ou condição fora da tabela aprovada. O assistente foi orientado a corrigir antes de enviar.": {
    es: "La respuesta prometía un precio o una condición fuera de la tabla aprobada. Se indicó al asistente que la corrija antes de enviarla.",
  },
  "A resposta continha uma promessa não autorizada. O assistente foi orientado a reescrever antes de enviar.": {
    es: "La respuesta contenía una promesa no autorizada. Se indicó al asistente que la reescriba antes de enviarla.",
  },
  "A primeira mensagem a um contato novo precisa se apresentar como assistente virtual. O assistente foi orientado a corrigir antes de enviar.": {
    es: "El primer mensaje a un contacto nuevo debe indicar que lo escribe un asistente virtual. Se indicó al asistente que lo corrija antes de enviarlo.",
  },
  "Uma trava de segurança segurou esta resposta": { es: "Una medida de seguridad retuvo esta respuesta" },
  "Ela não foi enviada ao contato.": { es: "No se envió al contacto." },
  "Resposta segurada pela proteção do número": { es: "Respuesta retenida por la protección del número" },
  "Resposta bloqueada por conformidade": { es: "Respuesta bloqueada por cumplimiento normativo" },
  "Resposta retida para correção": { es: "Respuesta retenida para corrección" },

  // ─── Inbox: gaps achados na varredura completa (ambas as aspas) ───
  "Você não tem nenhuma organização ativa. Aceite um convite ou contate o admin.": {
    es: "No tienes ninguna organización activa. Acepta una invitación o contacta al admin.",
  },

  // ─── Recuperação do primeiro acesso (/get-started) ───
  "Você não tem nenhuma organização ativa. Configure sua organização ou aceite um convite.": {
    es: "No tienes ninguna organización activa. Configura tu organización o acepta una invitación.",
  },
  "Configurar minha organização": { es: "Configurar mi organización" },
  "Campos personalizados": { es: "Campos personalizados" },
  "Campos definidos no funil padrão da organização.": {
    es: "Campos definidos en el embudo predeterminado de la organización.",
  },
  "Configure sua organização": { es: "Configura tu organización" },
  "Sua conta foi confirmada, mas a organização inicial ainda não foi criada. Informe o nome da sua empresa para concluir o primeiro acesso e abrir o onboarding do CRM.": {
    es: "Tu cuenta ya está confirmada, pero todavía no se creó la organización inicial. Escribe el nombre de tu empresa para completar el primer acceso y abrir la configuración inicial del CRM.",
  },
  "Se você recebeu um convite, não crie uma organização nova. Use o link do convite ou peça ao administrador para reenviá-lo.": {
    es: "Si recibiste una invitación, no crees una organización nueva. Usa el enlace de la invitación o pide al administrador que la reenvíe.",
  },
  // "Nome da empresa" já existe no bloco do cadastro — a chave é a mesma frase.
  "Preparando seu ambiente…": { es: "Preparando tu entorno…" },
  "Continuar para o onboarding": { es: "Continuar con la configuración inicial" },
  "Informe um nome de empresa com 2 a 120 caracteres.": {
    es: "Indica un nombre de empresa de 2 a 120 caracteres.",
  },
  "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.": {
    es: "Demasiados intentos. Espera unos minutos antes de volver a intentarlo.",
  },
  "Esta conta tem um convite pendente ou inválido. Use o link do convite ou peça um novo ao administrador.": {
    es: "Esta cuenta tiene una invitación pendiente o inválida. Usa el enlace de la invitación o pide una nueva al administrador.",
  },
  "Não foi possível concluir a organização agora. Tente novamente ou contate o administrador da instalação.": {
    es: "No fue posible completar la organización ahora. Inténtalo de nuevo o contacta al administrador de la instalación.",
  },
  "Adicionar tag à conversa": { es: "Agregar etiqueta a la conversación" },
  "Fechar conversa?": { es: "¿Cerrar conversación?" },
  "O cliente ainda não escreveu — a janela de 24h nunca abriu. Só um modelo aprovado sai daqui.": {
    es: "El cliente aún no ha escrito, así que la ventana de 24h nunca se abrió. Desde aquí solo puedes enviar una plantilla aprobada.",
  },
  "A janela de 24h fechou há": { es: "La ventana de 24h se cerró hace" },
  "Só um modelo aprovado sai daqui — texto livre é recusado pela plataforma.": {
    es: "Desde aquí solo puedes enviar una plantilla aprobada. La plataforma rechaza el texto libre.",
  },
  "Contato bloqueado — envio de mensagens desabilitado.": {
    es: "Contacto bloqueado — envío de mensajes deshabilitado.",
  },
  "Contato anonimizado — não é possível enviar mensagens.": {
    es: "Contacto anonimizado — no es posible enviar mensajes.",
  },
  "Responsável": { es: "Responsable" },

  // ─── Onboarding: welcome ───
  "Boas-vindas ao": { es: "Te damos la bienvenida a" },
  "Vamos montar quem vai atender seus clientes — e onde ele vai trabalhar.": {
    es: "Vamos a configurar quién atenderá a tus clientes y dónde trabajará.",
  },
  "Você já instalou o sistema. Isto aqui já está de pé:": {
    es: "Ya instalaste el sistema. Esto ya está funcionando:",
  },
  "Servidor no ar e banco de dados instalado": { es: "Servidor en línea y base de datos instalada" },
  "Inteligência contratada:": { es: "Inteligencia contratada:" },
  "Chave cadastrada — conferindo com a empresa de IA": {
    es: "Clave registrada — verificando con la empresa de IA",
  },
  "Falta a chave da inteligência artificial": { es: "Falta la clave de la inteligencia artificial" },
  "WhatsApp pronto para conectar seu número": { es: "WhatsApp listo para conectar tu número" },
  "O WhatsApp desta instalação ainda não subiu": { es: "El WhatsApp de esta instalación todavía no arrancó" },
  "Funil de vendas criado:": { es: "Embudo de ventas creado:" },
  "Nenhum funil de vendas ainda": { es: "Todavía no hay ningún embudo de ventas" },
  "Agora é montar quem vai atender por você.": { es: "Ahora toca configurar quién atenderá por ti." },
  "O que falta a gente resolve nos próximos passos.": {
    es: "Lo que falta lo resolvemos en los próximos pasos.",
  },
  "Pular tudo (DEV)": { es: "Omitir todo (DEV)" },
  "Como se chama o seu negócio?": { es: "¿Cómo se llama tu negocio?" },
  "É o nome que aparece para o seu time e nos relatórios. Pode ser clínica, loja, escritório — o que for seu.": {
    es: "Es el nombre que verá tu equipo y que aparece en los reportes. Puede ser una clínica, una tienda, un despacho o cualquier otro negocio.",
  },
  "O que vocês fazem?": { es: "¿A qué se dedican?" },
  "Ex.: clínica odontológica, ou venda de roupa fitness pelo WhatsApp": {
    es: "Ej.: clínica dental, o venta de ropa deportiva por WhatsApp",
  },
  "Uma linha basta. É com isso que seu funcionário aprende com quem ele está falando — e que a gente monta o quadro de clientes do seu jeito.": {
    es: "Basta con una línea. Con eso tu empleado sabe con quién está hablando, y armamos el tablero de clientes a tu manera.",
  },
  "Onde você atende": { es: "Dónde atiendes" },
  "Decide o horário em que seu funcionário pode falar com clientes.": {
    es: "Decide el horario en el que tu empleado puede hablar con los clientes.",
  },
  "Li e aceito os": { es: "Leí y acepto los" },
  "Termos de Uso": { es: "Términos de Uso" },
  "e a": { es: "y la" },
  "Política de Privacidade": { es: "Política de Privacidad" },
  "Continuar": { es: "Continuar" },
  "Aceite os termos para continuar.": { es: "Acepta los términos para continuar." },

  // ─── Onboarding: connect-whatsapp ───
  "Dê um telefone a ele": { es: "Dale un teléfono" },
  "É por este número que ele vai atender seus clientes. Se você conecta pelo celular, tenha ele por perto.": {
    es: "Atenderá a tus clientes con este número. Si conectas desde el celular, tenlo cerca.",
  },
  "Pronto para conectar": { es: "Listo para conectar" },
  "O código expirou": { es: "El código expiró" },
  "Não consegui falar com o WhatsApp": { es: "No pude comunicarme con WhatsApp" },
  "Escaneie o código abaixo com o celular que vai atender.": {
    es: "Escanea el código de abajo con el celular que va a atender.",
  },
  "Isso leva alguns segundos. O código aparece aqui sozinho.": {
    es: "Esto tarda unos segundos. El código aparece aquí solo.",
  },
  "O número está no ar. Seguindo para o próximo passo.": {
    es: "El número está en línea. Avanzando al próximo paso.",
  },
  "É normal — ele vale poucos minutos. Dá para gerar outro.": {
    es: "Es normal: solo dura unos minutos. Puedes generar otro.",
  },
  "O serviço roda no seu servidor e não respondeu agora.": {
    es: "El servicio funciona en tu servidor y no respondió en este momento.",
  },
  "Escolher outra forma": { es: "Elegir otra forma" },
  "Falha ao pular:": { es: "Error al omitir:" },
  "Pular por enquanto": { es: "Omitir por ahora" },
  "Falha ao marcar passo:": { es: "Error al marcar el paso:" },
  "Conectei em outro lugar": { es: "Me conecté en otro lugar" },
  "o servidor respondeu": { es: "el servidor respondió" },
  "Não consegui gerar outro código. Tente de novo em alguns segundos.": {
    es: "No pude generar otro código. Intenta de nuevo en unos segundos.",
  },
  "Não consegui falar com o servidor. Confira sua conexão e tente de novo.": {
    es: "No pude comunicarme con el servidor. Revisa tu conexión e intenta de nuevo.",
  },
  "Como você já usa esse número?": { es: "¿Cómo usas hoy ese número?" },
  "Existe mais de um jeito de ter WhatsApp para empresa, e cada um conecta de um jeito. Se você nunca ouviu falar dos outros dois, é o primeiro.": {
    es: "Hay más de una forma de usar WhatsApp para empresas, y cada una se conecta de manera distinta. Si nunca has oído hablar de las otras dos, es la primera.",
  },
  "Leio um código com o celular": { es: "Escaneo un código con el celular" },
  "É assim para quase todo mundo. Você abre o WhatsApp no celular que vai atender e aponta para um código que aparece aqui.": {
    es: "Es lo habitual para casi todos. Abres WhatsApp en el celular que va a atender y apuntas al código que aparece aquí.",
  },
  "Tenho conta oficial na Meta": { es: "Tengo una cuenta oficial de Meta" },
  "Você cadastrou o número na Meta e tem as credenciais em mãos. Não usa o celular para conectar.": {
    es: "Registraste el número en Meta y tienes las credenciales a la mano. No usas el celular para conectar.",
  },
  "Contrato de um provedor parceiro": { es: "Contratado con un proveedor asociado" },
  "Uma empresa parceira cuida do seu WhatsApp e te deu uma chave de acesso.": {
    es: "Una empresa asociada se encarga de tu WhatsApp y te dio una clave de acceso.",
  },
  "Este servidor ainda não está pronto para RECEBER por este caminho.": {
    es: "Este servidor todavía no está listo para RECIBIR por este camino.",
  },
  "Dá para conectar e já enviar, mas as respostas do cliente não vão chegar até quem administra a instalação cadastrar o App da Meta, em Admin › API Oficial (Meta). Se você quer atender hoje, o caminho do código com o celular funciona agora — e dá para trocar depois, sem perder nada.": {
    es: "Puedes conectar y enviar desde ya, pero las respuestas de los clientes no llegarán hasta que quien administra la instalación registre la App de Meta en Admin › API Oficial (Meta). Si quieres atender hoy mismo, la opción del código con el celular funciona ahora, y puedes cambiar después sin perder nada.",
  },
  "O WhatsApp desta instalação ainda não subiu.": { es: "El WhatsApp de esta instalación todavía no arrancó." },
  "Ele roda no seu próprio servidor. Dá para seguir sem ele agora e conectar o número depois, em": {
    es: "Corre en tu propio servidor. Ahora puedes seguir sin él y conectar el número después, en",
  },
  "Canais › Conexões": { es: "Canales › Conexiones" },
  "seu funcionário fica pronto de qualquer jeito, só não terá por onde atender ainda.": {
    es: "tu empleado queda listo de todas formas, solo que aún no tendrá por dónde atender.",
  },
  "Não consegui carregar o código agora. Ele deve reaparecer sozinho em instantes — se não aparecer, gere outro abaixo.": {
    es: "No pude cargar el código en este momento. Debería reaparecer solo en unos instantes. Si no aparece, genera otro abajo.",
  },
  "Código QR para conectar o WhatsApp": { es: "Código QR para conectar el WhatsApp" },
  "Conectado! Avançando…": { es: "¡Conectado! Avanzando…" },
  "O código expirou antes de alguém escanear. É normal — ele vale só alguns minutos.": {
    es: "El código expiró antes de que alguien lo escaneara. Es normal: solo dura unos minutos.",
  },
  "Deixe o WhatsApp já aberto em": { es: "Deja el WhatsApp ya abierto en" },
  "Aparelhos conectados": { es: "Dispositivos vinculados" },
  "antes de gerar o próximo, que aí dá tempo de sobra.": {
    es: "antes de generar el próximo, así te sobra tiempo.",
  },
  "Gerar novo QR Code": { es: "Generar nuevo código QR" },
  "O serviço de WhatsApp desta instalação não respondeu. Ele roda no seu servidor, junto com o resto do sistema — quem instalou consegue religá-lo.": {
    es: "El servicio de WhatsApp de esta instalación no respondió. Funciona en tu servidor, junto con el resto del sistema. Quien lo instaló puede volver a activarlo.",
  },
  "Detalhe técnico:": { es: "Detalle técnico:" },
  "Tentando…": { es: "Intentando…" },

  // ─── Onboarding: connect-nuvemshop ───
  "Importe pedidos, clientes e produtos da sua loja Nuvemshop.": {
    es: "Importa pedidos, clientes y productos de tu tienda Nuvemshop.",
  },
  "Ao clicar em": { es: "Al hacer clic en" },
  "você será redirecionado para autorizar o": { es: "serás redirigido para autorizar a" },
  "na sua conta Nuvemshop.": { es: "en tu cuenta Nuvemshop." },
  "Nuvemshop ainda não configurado neste ambiente.": {
    es: "Nuvemshop todavía no está configurado en este entorno.",
  },
  "Pule por enquanto e configure depois em Integrações.": {
    es: "Omítelo por ahora y configúralo después en Integraciones.",
  },
  "Já conectei": { es: "Ya conecté" },

  // ─── Onboarding: setup-ai ───
  "Treine seu funcionário": { es: "Entrena a tu empleado" },
  "Quem ele é, como fala e o que pode prometer. Dá para mudar tudo depois.": {
    es: "Quién es, cómo habla y qué puede prometer. Puedes cambiarlo todo después.",
  },
  "da inteligência escolhida na instalação": { es: "de la inteligencia elegida en la instalación" },
  "da": { es: "de la" },
  "Falha ao criar agente:": { es: "Error al crear el agente:" },
  "Atendente criado, mas ainda não está no ar.": { es: "Agente creado, pero todavía no está en línea." },
  "Agente criado, mas ainda não publicado.": { es: "Agente creado, pero todavía no publicado." },
  "Como ele vai se chamar": { es: "Cómo se va a llamar" },
  "É o nome que aparece para o seu time. O cliente vê só a conversa.": {
    es: "Es el nombre que aparece para tu equipo. El cliente ve solo la conversación.",
  },
  "O jeito dele falar": { es: "Su forma de hablar" },
  "As regras da casa (opcional)": { es: "Las reglas de la casa (opcional)" },
  "Nunca prometa desconto sem confirmar com uma pessoa.": {
    es: "Nunca prometas descuento sin confirmar con una persona.",
  },
  "Horário de atendimento: 9h às 18h, de segunda a sexta.": {
    es: "Horario de atención: lunes a viernes, de 9:00 a 18:00.",
  },
  "Sempre chame o cliente pelo primeiro nome.": { es: "Llama siempre al cliente por su nombre de pila." },
  "O que vale para qualquer atendimento aqui. Pode deixar em branco agora e escrever depois — ele aprende com você ao longo do tempo.": {
    es: "Lo que aplica en cualquier atención de tu empresa. Puedes dejarlo en blanco por ahora y escribirlo después: con el tiempo aprende de ti.",
  },
  "Ele já vem sabendo": { es: "Ya sabe desde el inicio" },
  "E nunca vai fazer": { es: "Y nunca va a hacer" },
  "Essas conferências acontecem antes de cada mensagem sair, e não têm interruptor.": {
    es: "Estas verificaciones se hacen antes de que salga cada mensaje y no se pueden desactivar.",
  },
  "O atendente foi criado, mas as": { es: "El agente se creó, pero las" },
  "regras da casa": { es: "reglas de la casa" },
  "não foram gravadas. Copie o que você escreveu antes de sair — e salve de novo em": {
    es: "no se guardaron. Copia lo que escribiste antes de salir y vuelve a guardarlo en",
  },
  "IA › Memória": { es: "IA › Memoria" },
  "Erro do banco de dados:": { es: "Error de la base de datos:" },
  "Seu atendente foi criado, mas ficou como": { es: "Tu agente se creó, pero quedó como" },
  "rascunho": { es: "borrador" },
  "— ele ainda não tem com o que pensar.": { es: "— todavía no tiene con qué pensar." },
  "Não achei chave de": { es: "No encontré ninguna clave de" },
  "nem cadastrada aqui, nem vinda da instalação. Cole a chave no campo acima («o cérebro dele») e crie o atendente de novo — ou cadastre em": {
    es: "ni registrada aquí ni incluida con la instalación. Pega la clave en el campo de arriba («su cerebro») y vuelve a crear el agente, o regístrala en",
  },
  "IA › Credenciais": { es: "IA › Credenciales" },
  "A chave que você colou ainda não foi confirmada pelo provedor.": {
    es: "El proveedor todavía no confirma la clave que pegaste.",
  },
  "Assim que ela for confirmada, publique de novo — não precisa colar outra.": {
    es: "En cuanto se confirme, vuelve a publicar; no hace falta pegar otra.",
  },
  "Continuar sem publicar": { es: "Continuar sin publicar" },
  "— e rascunho não responde mensagem.": { es: "— y un borrador no responde mensajes." },
  "Os modelos": { es: "Los modelos" },
  "que esta instalação conhece não sabem usar ferramentas — sem isso ele conversaria bem e nunca criaria um cliente nem moveria um negócio no funil. Escolha outra empresa de IA em": {
    es: "que conoce esta instalación no saben usar herramientas. Sin eso, conversaría bien, pero nunca crearía un cliente ni movería un negocio en el embudo. Elige otra empresa de IA en",
  },
  "IA › Provedores": { es: "IA › Proveedores" },
  "Esta instalação ainda não tem a lista de modelos": {
    es: "Esta instalación todavía no tiene la lista de modelos",
  },
  "Ela é baixada automaticamente uma vez por dia; depois disso, publique em": {
    es: "Se descarga automáticamente una vez al día. Cuando se descargue, publica en",
  },
  "IA › Agentes": { es: "IA › Agentes" },
  "Seu agente foi criado, mas ficou como": { es: "Tu agente se creó, pero quedó como" },
  "não consegui ler os números de WhatsApp desta instalação, então não dá pra dizer em qual número ele atenderia — e rascunho não responde mensagem.": {
    es: "no pude leer los números de WhatsApp de esta instalación, así que no puedo decir en qué número atendería — y un borrador no responde mensajes.",
  },
  "Tente de novo no botão abaixo (clicar de novo não cria um segundo agente) ou siga agora e publique depois em": {
    es: "Vuelve a intentarlo con el botón de abajo (volver a hacer clic no crea otro agente) o continúa ahora y publica después en",
  },
  "Pular": { es: "Omitir" },
  "Criar e continuar": { es: "Crear y continuar" },

  // ─── Onboarding: setup-ai (o cérebro / chave de IA) ───
  "Ele ainda não tem cérebro": { es: "Todavía no tiene cerebro" },
  "Seu funcionário pensa com a inteligência artificial que você contratar. A instalação não trouxe nenhuma chave — cole a sua aqui e ele já nasce funcionando.": {
    es: "Tu empleado piensa con la inteligencia artificial que contrates. La instalación no incluyó ninguna clave: pega la tuya aquí y nacerá funcionando.",
  },
  "Qual você contratou": { es: "Cuál contrataste" },
  "Esta escolha passa a valer para a empresa inteira: é esta inteligência que atende seus clientes.": {
    es: "Esta elección aplica a toda la empresa: esta inteligencia es la que atiende a tus clientes.",
  },
  "A chave": { es: "La clave" },
  "Cole aqui a chave que a empresa de IA te deu": { es: "Pega aquí la clave que te dio la empresa de IA" },
  "Chave guardada. Agora ele pode pensar.": { es: "Clave guardada. Ahora puede pensar." },
  "A chave foi guardada. A lista de modelos desta empresa de IA ainda não chegou nesta instalação — por enquanto a IA da empresa continua a anterior. Não precisa colar a chave de novo.": {
    es: "La clave se guardó. La lista de modelos de esta empresa de IA todavía no llega a esta instalación, así que por ahora la empresa sigue usando la IA anterior. No hace falta pegar la clave de nuevo.",
  },
  "A chave foi guardada, mas não consegui mudar a IA da empresa agora. Dá para trocar em IA › Provedores.": {
    es: "La clave se guardó, pero ahora no pude cambiar la IA de la empresa. Puedes cambiarla en IA › Proveedores.",
  },
  "Guardando...": { es: "Guardando..." },
  "Guardar a chave": { es: "Guardar la clave" },
  "Ela é guardada cifrada — nem nós conseguimos lê-la depois.": {
    es: "Se guarda cifrada, así que ni nosotros podemos leerla después.",
  },
  "O cérebro dele:": { es: "Su cerebro:" },
  "final": { es: "terminación" },
  "Conferindo se a chave tem crédito…": { es: "Verificando si la clave tiene crédito…" },
  "Testei agora: a chave respondeu e tem crédito.": { es: "Acabo de probar: la clave respondió y tiene crédito." },
  "A chave foi aceita, mas o teste não passou:": { es: "La clave se aceptó, pero la prueba no pasó:" },
  "Se for falta de crédito, adicione saldo na conta da empresa de IA — sem isso ele não responde a nenhum cliente.": {
    es: "Si es por falta de crédito, agrega saldo a la cuenta de la empresa de IA. Sin eso, no responderá a ningún cliente.",
  },
  "Não consegui testar o crédito agora. Dá para seguir — mas confira o saldo na conta da empresa de IA antes de confiar nele.": {
    es: "Ahora no pude comprobar el crédito. Puedes continuar, pero revisa el saldo en la cuenta de la empresa de IA antes de confiar en él.",
  },
  "Pronta para uso.": { es: "Lista para usar." },

  // ─── Onboarding: funil (quadro de clientes) ───
  "Onde ele organiza seus clientes": { es: "Dónde organiza a tus clientes" },
  "Cada cliente vira um cartão que anda por essas colunas. Ele mesmo move o cartão conforme a conversa avança — por isso cada coluna diz também quando ele deve usá-la.": {
    es: "Cada cliente se convierte en una tarjeta que avanza por estas columnas. Él mismo mueve la tarjeta a medida que avanza la conversación, por eso cada columna indica también cuándo debe usarla.",
  },
  "Seu funcionário montou este quadro olhando o que você me contou sobre o negócio. Ajuste o que quiser.": {
    es: "Tu empleado armó este tablero a partir de lo que me contaste sobre el negocio. Ajusta lo que quieras.",
  },
  "Não consegui pedir uma sugestão para o seu funcionário agora": {
    es: "No pude pedirle una sugerencia a tu empleado ahora",
  },
  "Comecei por um quadro pronto de": { es: "Empecé con un tablero prediseñado de" },
  "Isso não trava nada: escolha outro modelo abaixo ou ajuste as colunas na mão. Dá para mudar tudo depois, quando quiser.": {
    es: "Esto no bloquea nada: elige otro modelo abajo o ajusta las columnas a mano. Puedes cambiar todo después, cuando quieras.",
  },
  "Nome do quadro": { es: "Nombre del tablero" },
  "Nome da coluna": { es: "Nombre de la columna" },
  "Ele move o cliente para cá quando": { es: "Mueve al cliente aquí cuando" },
  "Coluna que só vocês movem — ele não mexe nesta.": {
    es: "Columna que solo ustedes mueven. Él no la toca.",
  },
  "obrigatória": { es: "obligatoria" },
  "Adicionar coluna": { es: "Agregar columna" },
  "colunas é o máximo — mais que isso não cabe na tela do celular.": {
    es: "columnas es el máximo: más no caben en la pantalla del celular.",
  },
  "O que veio na instalação": { es: "Lo que vino en la instalación" },
  "Este é o quadro padrão, feito para loja online. Ao continuar, ele é substituído pelo de cima.": {
    es: "Este es el tablero predeterminado, pensado para tiendas en línea. Al continuar, se reemplaza por el de arriba.",
  },
  "Prefiro começar de um modelo pronto": { es: "Prefiero empezar con un modelo prediseñado" },
  "Dê um nome à coluna em branco.": { es: "Dale un nombre a la columna en blanco." },
  "Usar este quadro": { es: "Usar este tablero" },

  // ─── Onboarding: testar ───
  "Veja ele atender": { es: "Mira cómo atiende" },
  "Escreva como se fosse um cliente. Nada é enviado pelo WhatsApp — é só um ensaio, entre você e ele.": {
    es: "Escribe como si fueras un cliente. No se envía nada por WhatsApp: es solo un ensayo entre tú y él.",
  },
  "seu funcionário": { es: "tu empleado" },
  "O ensaio falhou": { es: "El ensayo falló" },
  "o ensaio terminou como": { es: "el ensayo terminó como" },
  "Ele executou, mas não devolveu texto nenhum.": { es: "Se ejecutó, pero no devolvió ningún texto." },
  "Você ainda não montou seu funcionário.": { es: "Todavía no armaste a tu empleado." },
  "Sem ninguém treinado, não há o que testar. Dá para voltar ao passo anterior agora ou fazer isso depois, em IA › Agentes.": {
    es: "Sin nadie entrenado, no hay nada que probar. Puedes volver al paso anterior ahora o hacerlo después, en IA › Agentes.",
  },
  "está como": { es: "está como" },
  "ainda não foi para o ar.": { es: "todavía no está en línea." },
  "Rascunho não responde mensagem, então não há o que ensaiar. O passo anterior explicou o que falta; você pode resolver depois em IA › Agentes.": {
    es: "Un borrador no responde mensajes, así que no hay nada que ensayar. El paso anterior explicó qué falta. Puedes resolverlo después en IA › Agentes.",
  },
  "Escreva como se fosse um cliente": { es: "Escribe como si fueras un cliente" },
  "Ele está pensando...": { es: "Está pensando..." },
  "Mandar mensagem": { es: "Enviar mensaje" },
  "respondeu": { es: "respondió" },
  "Esta conversa não foi enviada a ninguém e não aparece no seu inbox.": {
    es: "Esta conversación no se envió a nadie y no aparece en tu bandeja de entrada.",
  },
  "Ele não conseguiu responder — e é melhor descobrir isso agora do que com um cliente de verdade.": {
    es: "No pudo responder. Es mejor descubrirlo ahora que con un cliente de verdad.",
  },
  "Motivo:": { es: "Motivo:" },
  "As causas mais comuns são a chave da empresa de IA sem saldo ou o modelo indisponível. Dá para conferir em": {
    es: "Las causas más comunes son que la clave de la empresa de IA no tenga saldo o que el modelo no esté disponible. Puedes revisarlo en",
  },
  "e seguir daqui mesmo — o que você montou está salvo.": {
    es: "y seguir desde aquí mismo. Lo que armaste está guardado.",
  },
  "Não consegui salvar este passo.": { es: "No pude guardar este paso." },

  // ─── Onboarding: invite-team ───
  "Quem trabalha com ele": { es: "Quién trabaja con él" },
  "Seu funcionário não trabalha sozinho: quando ele passar uma conversa adiante, é uma dessas pessoas que atende.": {
    es: "Tu empleado no trabaja solo: cuando transfiere una conversación, la atiende una de estas personas.",
  },
  "Esta instalação ainda não envia e-mail.": { es: "Esta instalación todavía no envía correo." },
  "Você recebe um link para cada pessoa e manda por onde quiser — WhatsApp, e-mail, o que preferir. O link é o convite: quem abrir entra na sua empresa.": {
    es: "Recibes un enlace para cada persona y lo mandas por donde quieras: WhatsApp, correo o lo que prefieras. El enlace es la invitación: quien lo abra entra a tu empresa.",
  },
  "Falha:": { es: "Error:" },
  "Adicione ao menos um email ou clique em Pular.": { es: "Agrega al menos un correo o haz clic en Omitir." },
  "convite(s) não puderam ser enviados por email. Copie os links abaixo e envie você mesmo.": {
    es: "invitación(es) no se pudieron enviar por correo. Copia los enlaces de abajo y envíalos por tu cuenta.",
  },
  "E-mail de quem vai trabalhar com ele": { es: "Correo de quien va a trabajar con él" },
  "O que essas pessoas podem fazer": { es: "Qué pueden hacer estas personas" },
  "Esta instalação não envia e-mail. Os convites estão prontos — copie o link de cada pessoa e mande por onde você já fala com ela:": {
    es: "Esta instalación no envía correo. Las invitaciones están listas: copia el enlace de cada persona y mándalo por el medio que ya usas para hablar con ella:",
  },
  "Link copiado.": { es: "Enlace copiado." },
  "Não consegui copiar — selecione e copie o link manualmente.": {
    es: "No pude copiar. Selecciona y copia el enlace manualmente.",
  },
  "Copiar link": { es: "Copiar enlace" },

  // ─── Onboarding: done (resumo final) ───
  "Tudo pronto!": { es: "¡Todo listo!" },
  "Seu funcionário está montado. Daqui em diante é só acompanhar.": {
    es: "Tu empleado ya está armado. A partir de aquí, solo te toca darle seguimiento.",
  },
  "Seu funcionário já está de pé. O que ficou para depois continua te esperando.": {
    es: "Tu empleado ya está en marcha. Lo que dejaste para después te sigue esperando.",
  },
  "você pulou": { es: "lo omitiste" },
  "ainda não": { es: "todavía no" },
  "O que mais tem aqui": { es: "Qué más hay aquí" },
  "Você não precisa mexer em nada disso agora. É só para saber que existe.": {
    es: "No necesitas tocar nada de esto ahora. Es solo para saber que existe.",
  },
  "Como funciona": { es: "Cómo funciona" },
  "Finalizando...": { es: "Finalizando..." },
  "Começar a usar": { es: "Empezar a usar" },

  // ─── Onboarding: "O que mais tem aqui" (lib/onboarding/o-que-mais-existe.ts) ───
  "As conversas": { es: "Las conversaciones" },
  "É aqui que as conversas chegam, com você e ele atendendo lado a lado.": {
    es: "Aquí llegan las conversaciones, y tú y él las atienden lado a lado.",
  },
  "O cliente manda uma mensagem no WhatsApp": { es: "El cliente manda un mensaje por WhatsApp" },
  "Ele responde sozinho, seguindo as regras da casa que você escreveu": {
    es: "Él responde solo, siguiendo las reglas de la casa que escribiste",
  },
  "Se você entrar na conversa, ele sai da frente e deixa você atender": {
    es: "Si entras a la conversación, él se hace a un lado y te deja atender",
  },
  "O quadro de clientes": { es: "El tablero de clientes" },
  "Cada cliente vira um card, e ele mesmo move o card conforme a conversa anda.": {
    es: "Cada cliente se convierte en una tarjeta, y él mismo la mueve conforme avanza la conversación.",
  },
  "Cada cliente vira um cartão, na primeira coluna": {
    es: "Cada cliente se convierte en una tarjeta, en la primera columna",
  },
  "Conforme a conversa avança, ele move o cartão de coluna sozinho": {
    es: "Conforme avanza la conversación, él mueve la tarjeta de columna por su cuenta",
  },
  "Você arrasta o cartão na mão quando quiser — o quadro é seu": {
    es: "Puedes arrastrar la tarjeta a mano cuando quieras: el tablero es tuyo",
  },
  "Voltar a falar com quem sumiu": { es: "Volver a hablar con quien desapareció" },
  "Para nenhum cliente sumir no silêncio — ele volta a falar sozinho, na hora certa.": {
    es: "Para que ningún cliente se pierda en el silencio: él retoma la conversación por su cuenta, en el momento justo.",
  },
  "O cliente para de responder no meio da conversa": {
    es: "El cliente deja de responder en medio de la conversación",
  },
  "Depois do tempo que você definir, ele manda uma mensagem puxando o assunto": {
    es: "Después del tiempo que definas, él manda un mensaje retomando el tema",
  },
  "Se o cliente responder, o retorno para na hora — ninguém é perseguido": {
    es: "Si el cliente responde, el seguimiento se detiene al instante: no se persigue a nadie",
  },
  "Se o cliente pedir para parar, ele para e não volta a escrever": {
    es: "Si el cliente pide que se detenga, él para y no vuelve a escribir",
  },
  "E você pode pausar, adiar, pular um passo ou cancelar quando quiser": {
    es: "Y puedes pausar, posponer, omitir un paso o cancelar cuando quieras",
  },
  "O que está esfriando": { es: "Lo que se está enfriando" },
  "Quem esfriou e ainda está aberto, para você agir antes de perder.": {
    es: "Quienes se enfriaron y siguen abiertos, para que actúes antes de perderlos.",
  },
  "Ele observa há quanto tempo cada negócio em aberto não tem resposta": {
    es: "Revisa cuánto tiempo lleva sin respuesta cada negocio abierto",
  },
  "Os que estão esfriando sobem para o topo desta lista": {
    es: "Los que se están enfriando suben al principio de esta lista",
  },
  "Você decide quem merece um empurrão seu, em vez de descobrir tarde demais": {
    es: "Decides a quién vale la pena darle un empujón, en vez de enterarte demasiado tarde",
  },
  "Quando ele pede ajuda": { es: "Cuando pide ayuda" },
  "Quando ele trava em algo que só uma pessoa resolve, o pedido aparece aqui.": {
    es: "Cuando se atora en algo que solo una persona puede resolver, la solicitud aparece aquí.",
  },
  "Ele encontra algo que não pode decidir sozinho — um desconto, uma exceção, um caso estranho": {
    es: "Se topa con algo que no puede decidir solo: un descuento, una excepción, un caso raro",
  },
  "Em vez de inventar, ele para e abre um pedido aqui": {
    es: "En vez de inventar, se detiene y abre una solicitud aquí",
  },
  "Você decide, e ele volta a andar com a sua resposta": {
    es: "Tú decides, y él vuelve a avanzar con tu respuesta",
  },
  "As ideias dele": { es: "Sus ideas" },
  "Com o tempo ele sugere as próprias melhorias — e você decide se entram.": {
    es: "Con el tiempo sugiere mejoras por su cuenta, y tú decides si se aplican.",
  },
  "Ele acompanha os próprios atendimentos e percebe o que poderia ir melhor": {
    es: "Da seguimiento a sus propias conversaciones y detecta qué podría mejorar",
  },
  "Escreve a sugestão aqui, em português, e espera": {
    es: "Escribe la sugerencia aquí, en portugués, y espera",
  },
  "Nada muda sozinho: só entra em vigor quando VOCÊ aprovar": {
    es: "Nada cambia por sí solo: entra en vigor únicamente cuando TÚ apruebas",
  },

  // ─── Onboarding: setup-ai — JEITOS (jeito de falar) ───
  "Próximo e caloroso": { es: "Cercano y cálido" },
  "Conversa como gente, puxa assunto, tranquiliza. Bom para quem vende no dia a dia.": {
    es: "Conversa como una persona, inicia la plática y tranquiliza. Ideal para quien vende día a día.",
  },
  "Objetivo e cordial": { es: "Directo y cordial" },
  "Vai direto ao ponto sem ser seco, e sempre indica o próximo passo.": {
    es: "Va directo al punto sin ser seco, y siempre indica el próximo paso.",
  },
  "Curto e prático": { es: "Corto y práctico" },
  "Frases curtas, pergunta só o essencial e chama uma pessoa cedo.": {
    es: "Frases cortas, pregunta solo lo esencial y recurre pronto a una persona.",
  },

  // ─── Onboarding: invite-team — ROTULO_DO_PAPEL (lib/auth/types.ts) ───
  "Somente leitura": { es: "Solo lectura" },
  "Gerente": { es: "Gerente" },
  "Administrador": { es: "Administrador" },

  // ─── Onboarding: funil — EXPLICACAO_DO_PASSO (lib/leads/agent-mapping.ts) ───
  "acabou de chamar e ninguém respondeu ainda": { es: "acaba de escribir y nadie le ha respondido todavía" },
  "já foi respondido": { es: "ya fue respondido" },
  "ele está entendendo o que a pessoa precisa": { es: "está entendiendo lo que la persona necesita" },
  "já dá para saber o que oferecer": { es: "ya se puede saber qué ofrecer" },
  "está fechando preço, horário ou condições": { es: "está acordando precio, horario o condiciones" },
  "fechou negócio": { es: "cerró el negocio" },
  "não fechou": { es: "no cerró" },
  "seu funcionário ainda não está no ar": { es: "tu empleado todavía no está en línea" },
  "a resposta não veio no formato esperado": { es: "la respuesta no llegó en el formato esperado" },

  // ─── Onboarding: funil — pacotes prontos (lib/onboarding/pacotes-de-funil.ts) ───
  "Clínica, consultório ou salão": { es: "Clínica, consultorio o salón" },
  "Imobiliária ou corretor": { es: "Inmobiliaria o asesor inmobiliario" },
  "Serviços, agência ou obra": { es: "Servicios, agencia u obra" },
  "Curso, mentoria ou infoproduto": { es: "Curso, mentoría o infoproducto" },
  "Loja — online ou de rua": { es: "Tienda en línea o física" },
  "Outro tipo de negócio": { es: "Otro tipo de negocio" },

  // ─── Onboarding: tool catalog (capacidades) usadas em "Ele já vem sabendo" ───
  "Listar oportunidades do funil": { es: "Listar oportunidades del embudo" },
  "Ver uma oportunidade": { es: "Ver una oportunidad" },
  "Listar funis": { es: "Listar embudos" },
  "Criar oportunidade no funil": { es: "Crear oportunidad en el embudo" },
  "Atualizar uma oportunidade": { es: "Actualizar una oportunidad" },
  "Mover oportunidade de etapa": { es: "Mover oportunidad de etapa" },
  "Ver as compras do cliente": { es: "Ver las compras del cliente" },
  "Procurar produto na loja": { es: "Buscar producto en la tienda" },
  "Anotar dado que o cliente informou": { es: "Anotar dato que informó el cliente" },
  "Procurar cliente": { es: "Buscar cliente" },
  "Ver ficha do cliente": { es: "Ver ficha del cliente" },
  "Ver as etapas de um funil": { es: "Ver las etapas de un embudo" },

  // ─── Onboarding: conferências de saída (guardrails), "E nunca vai fazer" ───
  "Respeitar quem pediu para parar": { es: "Respetar a quien pidió parar" },
  "Respeitar dados apagados e a base legal": { es: "Respetar datos borrados y la base legal" },
  "Segurar o ritmo de envio": { es: "Controlar el ritmo de envío" },
  "Respeitar a janela do WhatsApp": { es: "Respetar la ventana de WhatsApp" },
  "Variar o texto das mensagens iguais": { es: "Variar el texto de los mensajes iguales" },
  "Não prometer preço ou prazo por conta própria": { es: "No prometer precio o plazo por cuenta propia" },
  "Conferir promessas em texto livre": { es: "Verificar promesas en texto libre" },
  "Não prometer atendimento humano que não existe": { es: "No prometer atención humana que no existe" },
  "Não falar a nossa língua com o seu cliente": { es: "No hablar nuestro idioma con tu cliente" },
  "Dizer que é um assistente quando perguntam": { es: "Decir que es un asistente cuando preguntan" },
  "Detectar tentativa de manipular o assistente": { es: "Detectar intento de manipular al asistente" },

  // ─── Onboarding: welcome/_form.tsx — cidades do fuso horário ───
  "São Paulo, Rio, Brasília, Sul e Sudeste": { es: "São Paulo, Río, Brasilia, Sur y Sudeste" },
  "Recife, Salvador, Fortaleza e Nordeste": { es: "Recife, Salvador, Fortaleza y Nordeste" },
  "Belém e Pará": { es: "Belém y Pará" },
  "Manaus e Amazonas": { es: "Manaos y Amazonas" },
  "Cuiabá e Mato Grosso": { es: "Cuiabá y Mato Grosso" },
  "Rio Branco e Acre": { es: "Río Branco y Acre" },
  "Buenos Aires": { es: "Buenos Aires" },
  "Lisboa": { es: "Lisboa" },
  "Madri": { es: "Madrid" },
  "Nova York": { es: "Nueva York" },
  "Los Angeles": { es: "Los Ángeles" },
  "Outro (horário universal)": { es: "Otro (horario universal)" },

  // ─── Onboarding: rótulos do Stepper (lib/onboarding/passos.ts) ───
  "Seu negócio": { es: "Tu negocio" },
  "O telefone dele": { es: "Su teléfono" },
  "Sua loja": { es: "Tu tienda" },
  "Treinar": { es: "Entrenar" },
  "Onde ele organiza": { es: "Dónde organiza" },
  "Ver ele atender": { es: "Verlo atender" },

  // ─── Estados vazios compartilhados (components/empty/variants.tsx) ───
  "Sem conversas por aqui": { es: "Sin conversaciones por aquí" },
  "Quando chegarem mensagens, elas aparecem aqui em tempo real.": {
    es: "Cuando lleguen mensajes, aparecerán aquí en tiempo real.",
  },
  "Quadro vazio": { es: "Tablero vacío" },
  "Ainda não há nenhum cliente aqui. Assim que a primeira conversa começar, o cartão aparece nesta coluna.": {
    es: "Todavía no hay ningún cliente aquí. En cuanto empiece la primera conversación, su tarjeta aparecerá en esta columna.",
  },
  "Nenhum contato ainda": { es: "Ningún contacto todavía" },
  "Contatos chegam automaticamente via WhatsApp ou Nuvemshop.": {
    es: "Los contactos llegan automáticamente vía WhatsApp o Nuvemshop.",
  },
  "Sem eventos no período": { es: "Sin eventos en el período" },
  "Ajuste o filtro de datas ou a busca pra ver eventos.": {
    es: "Ajusta el filtro de fechas o la búsqueda para ver eventos.",
  },
  "Nenhum funil ainda": { es: "Ningún embudo todavía" },
  "Um funil é o caminho que o cliente percorre até fechar. Crie o primeiro para ter um quadro.": {
    es: "Un embudo es el camino que el cliente recorre hasta cerrar. Crea el primero para tener un tablero.",
  },
  "Sem membros no time": { es: "Sin miembros en el equipo" },
  "Convide colegas pra atender em conjunto.": { es: "Invita a colegas para atender juntos." },
  "Nenhum token criado": { es: "Ningún token creado" },
  "Tokens permitem integrações server-to-server.": {
    es: "Los tokens permiten integraciones server-to-server.",
  },
  "Sem atividades registradas": { es: "Sin actividades registradas" },
  "A timeline mostra mensagens, mudanças de stage e notas.": {
    es: "La línea de tiempo muestra mensajes, cambios de etapa y notas.",
  },
  "Sem candidatos a merge": { es: "Sin candidatos a fusión" },
  "Contatos duplicados aparecerão aqui pra revisão.": {
    es: "Los contactos duplicados aparecerán aquí para que los revises.",
  },
  "Tente ajustar os filtros ou a busca.": { es: "Intenta ajustar los filtros o la búsqueda." },

  // ─── Contacts: vocabulário da timeline (lib/leads/activity-vocabulary.ts) ───
  "Entrou pelo WhatsApp": { es: "Entró por WhatsApp" },
  "Mudou de estágio": { es: "Cambió de etapa" },
  "Correção do que o assistente tinha feito": { es: "Corrección de lo que había hecho el asistente" },
  "Anotação": { es: "Anotación" },
  "Atendimento da IA": { es: "Atención de la IA" },
  "Envio bloqueado": { es: "Envío bloqueado" },
  "Passou para humano": { es: "Pasó a una persona" },
  "Voltou para o atendimento automático": { es: "Volvió a la atención automática" },
  "Próxima ação aprovada": { es: "Próxima acción aprobada" },
  "Próxima ação descartada": { es: "Próxima acción descartada" },
  "Dados do negócio alterados": { es: "Datos del negocio modificados" },
  "Negócio esfriou": { es: "El negocio se enfrió" },
  "Negócio voltou a andar": { es: "El negocio volvió a avanzar" },
  "Retomada de contato aprovada": { es: "Reactivación de contacto aprobada" },
  "Retomada de contato descartada": { es: "Reactivación de contacto descartada" },
  "Sugestão de retomada venceu sem decisão": { es: "La sugerencia de reactivación caducó sin decisión" },
  "Retorno agendado": { es: "Seguimiento programado" },
  "Retorno cancelado": { es: "Seguimiento cancelado" },
  "Desmarcado por uma pessoa da equipe": { es: "Cancelado por una persona del equipo" },
  "Sem motivo informado": { es: "Sin motivo indicado" },
  "Follow-up pausado": { es: "Follow-up pausado" },
  "Follow-up retomado": { es: "Follow-up retomado" },
  "Follow-up adiado": { es: "Follow-up pospuesto" },
  "Passo do follow-up pulado": { es: "Paso del follow-up saltado" },
  // ─── lib/followup/eventos-legiveis.ts (dossiê do follow-up) ───
  // STATUS (rotuloDoStatus)
  "concluída": { es: "concluida" },
  "cancelada": { es: "cancelada" },
  // TIPO_DO_NO (tipoDoNo)
  "Espera": { es: "Espera" },
  "Interpretação da resposta": { es: "Interpretación de la respuesta" },
  "Resposta (texto)": { es: "Respuesta (texto)" },
  "Repetição": { es: "Repetición" },
  "Passo": { es: "Paso" },
  // DESFECHO (standalone, quando `detalhe` do evento `flow_completed` é só o desfecho)
  "converteu": { es: "convirtió" },
  "esgotou as tentativas": { es: "agotó los intentos" },
  "pediu para parar": { es: "pidió parar" },
  "passou para uma pessoa": { es: "pasó a una persona" },
  "desfecho próprio": { es: "desenlace propio" },
  // descreveEvento — títulos e detalhes fixos (sem interpolação)
  "Seguiu em frente": { es: "Siguió adelante" },
  "Começou a esperar": { es: "Empezó a esperar" },
  "Pediu ao agente para planejar os tempos de espera": {
    es: "Le pidió al agente que planeara los tiempos de espera",
  },
  "Pediu ao agente para escrever a mensagem": { es: "Le pidió al agente que escribiera el mensaje" },
  "Pediu ao agente para interpretar a resposta": { es: "Le pidió al agente que interpretara la respuesta" },
  "Conferiu se a mensagem já tinha saído": { es: "Verificó si el mensaje ya había salido" },
  "Mensagem enviada": { es: "Mensaje enviado" },
  "O agente interpretou a resposta": { es: "El agente interpretó la respuesta" },
  "Fluxo concluído": { es: "Flujo concluido" },
  "O fluxo parou de tentar": { es: "El flujo dejó de intentarlo" },
  "Falhou neste passo": { es: "Falló en este paso" },
  "O cliente respondeu — o fluxo acordou na hora": { es: "El cliente respondió: el flujo despertó al instante" },
  "Encerrado porque o cliente respondeu": { es: "Finalizado porque el cliente respondió" },
  "Encerrado porque o cliente pediu para parar": { es: "Finalizado porque el cliente pidió parar" },
  "Encerrado porque uma pessoa assumiu a conversa": {
    es: "Finalizado porque una persona asumió la conversación",
  },
  "Pausado porque uma pessoa assumiu a conversa": { es: "Pausado porque una persona asumió la conversación" },
  "Retomado: o atendimento voltou para o agente": { es: "Reanudado: la atención volvió al agente" },
  "O agente decidiu quanto esperar em cada passo": { es: "El agente decidió cuánto esperar en cada paso" },
  "Seguiu sem o plano de tempo": { es: "Continuó sin el plan de tiempos" },
  "Cancelado por uma pessoa da equipe": { es: "Cancelado por una persona del equipo" },
  "Pausado por uma pessoa da equipe": { es: "Pausado por una persona del equipo" },
  "Retomado por uma pessoa da equipe": { es: "Reanudado por una persona del equipo" },
  "Adiado por uma pessoa da equipe": { es: "Pospuesto por una persona del equipo" },
  "Passo pulado por uma pessoa da equipe": { es: "Paso saltado por una persona del equipo" },
  "Começou porque o negócio entrou numa etapa": { es: "Empezó porque el negocio entró en una etapa" },
  "Começou porque o agente pediu ajuda de um humano": {
    es: "Empezó porque el agente pidió ayuda a un humano",
  },
  "Cancelado porque o caso foi resolvido": { es: "Cancelado porque el caso se resolvió" },
  "Passo registrado pelo motor": { es: "Paso registrado por el motor" },
  "a etapa escolhida no gatilho deste fluxo": { es: "la etapa elegida en el gatillo de este flujo" },
  "o caso foi aberto por uma trava de segurança, não por decisão do agente": {
    es: "el caso se abrió por un bloqueo de seguridad, no por decisión del agente",
  },
  "o agente abriu um caso de atendimento": { es: "el agente abrió un caso de atención" },
  "o follow-up existia para esse caso e parou junto com ele": {
    es: "el follow-up existía para ese caso y se detuvo junto con él",
  },
  "o agente não respondeu a tempo; cada espera usa o máximo configurado": {
    es: "el agente no respondió a tiempo, así que cada espera usa el máximo configurado",
  },
  // resumoDoNo — trechos fixos (sem interpolação)
  "onde o follow-up começa": { es: "donde empieza el follow-up" },
  "o agente escreve e envia a mensagem": { es: "el agente escribe y envía el mensaje" },
  "envia um texto fixo": { es: "envía un texto fijo" },
  "envia uma mensagem de modelo pronto": { es: "envía un mensaje de plantilla predefinida" },
  // refDoNo
  "sem passo associado": { es: "sin paso asociado" },
  "Promessa sem responsável": { es: "Promesa sin responsable" },
  "Demanda encerrada": { es: "Caso cerrado" },
  "Consentimento de contato recusado no formulário": { es: "Consentimiento de contacto rechazado en el formulario" },
  "Desqualificado na triagem inicial": { es: "Descalificado en el filtro inicial" },
  "Aguardando revisão humana": { es: "Pendiente de revisión humana" },
  "Assumiu a conversa": { es: "Asumió la conversación" },
  "Transferiu a conversa": { es: "Transfirió la conversación" },
  "Liberou a conversa": { es: "Liberó la conversación" },
  "Pausou o automático": { es: "Pausó el automático" },
  "Atividade registrada": { es: "Actividad registrada" },
  "Você/time": { es: "Tú/equipo" },
  "Sistema": { es: "Sistema" },
  "Autor não registrado": { es: "Autor no registrado" },

  // ─── Contacts: lista, ficha, timeline, LGPD ───
  "Erro ao carregar contato.": { es: "Error al cargar el contacto." },
  "Contato anonimizado (LGPD)": { es: "Contacto anonimizado (LGPD)" },
  "edição bloqueada.": { es: "edición bloqueada." },
  "Visão geral": { es: "Resumen" },
  "Última atividade": { es: "Última actividad" },
  "Direito ao esquecimento (LGPD)": { es: "Derecho al olvido (LGPD)" },
  "A anonimização é irreversível. Use somente após confirmação formal do titular ou ordem judicial.": {
    es: "La anonimización es irreversible. Úsala solo si el titular la confirmó formalmente o si hay una orden judicial.",
  },
  "Este contato já foi anonimizado": { es: "Este contacto ya fue anonimizado" },
  "Anonimizar contato": { es: "Anonimizar contacto" },
  "Customer 360 — busque, filtre e gerencie contatos.": {
    es: "Customer 360 — busca, filtra y gestiona contactos.",
  },
  "Importar CSV": { es: "Importar CSV" },
  // ── Juntar contatos duplicados ──────────────────────────────────────────
  "Duplicados": { es: "Duplicados" },
  "Contatos duplicados": { es: "Contactos duplicados" },
  "A mesma pessoa cadastrada duas vezes. Escolha qual cadastro fica; o outro é absorvido sem perder histórico.": {
    es: "La misma persona está registrada dos veces. Elige qué registro se queda: el otro se absorbe sin perder el historial.",
  },
  "Nenhum contato duplicado encontrado.": { es: "No se encontraron contactos duplicados." },
  "Agrupados por": { es: "Agrupados por" },
  "mesmo telefone": { es: "mismo teléfono" },
  "mesmo e-mail": { es: "mismo correo" },
  "telefone que o WhatsApp deixou em conflito": {
    es: "teléfono que WhatsApp dejó en conflicto",
  },
  "Manter este cadastro": { es: "Conservar este registro" },
  "Este fica": { es: "Este se queda" },
  "Será absorvido por quem fica": { es: "Será absorbido por el que se queda" },
  "Conversas, mensagens, negócios e histórico passam para quem fica. O cadastro antigo não é apagado — vira registro de fusão. Não há como desfazer.": {
    es: "Conversaciones, mensajes, negocios e historial pasan al registro que se queda. El registro anterior no se borra: se conserva como constancia de la fusión. No se puede deshacer.",
  },
  "Juntar": { es: "Juntar" },
  "Juntar contatos": { es: "Juntar contactos" },
  "Juntar estes cadastros?": { es: "¿Juntar estos registros?" },
  "fica.": { es: "se queda." },
  "será absorvido e sai da lista de contatos. Mensagens, negócios e histórico passam para quem fica. Não há como desfazer.": {
    es: "será absorbido y sale de la lista de contactos. Mensajes, negocios e historial pasan al que se queda. No se puede deshacer.",
  },
  "Juntando…": { es: "Juntando…" },
  "Contatos juntados.": { es: "Contactos juntados." },
  "Contatos juntados. {n} registro(s) continuaram no cadastro antigo — veja a auditoria.": {
    es: "Contactos juntados. {n} registro(s) permanecieron en el contacto anterior. Revisa la auditoría.",
  },

  // ─── app/api/v1/contacts/merge/route.ts (DESFECHOS que chegam à tela via showApiError) ───
  "Seleção inválida: escolha um contato principal e ao menos um a ser absorvido.": {
    es: "Selección inválida: elige un contacto principal y al menos uno para absorber.",
  },
  "O mesmo contato aparece duas vezes na seleção.": {
    es: "El mismo contacto aparece dos veces en la selección.",
  },
  "O contato principal não está disponível — ele pode ter sido anonimizado ou já mesclado em outro.":
    {
      es: "El contacto principal no está disponible. Puede haberse anonimizado o fusionado con otro.",
    },
  "Um dos contatos selecionados não está disponível — ele pode ter sido anonimizado ou já mesclado em outro.":
    {
      es: "Uno de los contactos seleccionados no está disponible. Puede haberse anonimizado o fusionado con otro.",
    },
  "Organização ativa não resolvida.": { es: "No se pudo determinar la organización activa." },
  "Mostrando os duplicados entre os contatos mais antigos. Junte estes e reabra para ver os próximos.": {
    es: "Se muestran los duplicados de los contactos más antiguos. Junta estos y vuelve a abrir para ver los siguientes.",
  },
  "Novo contato": { es: "Nuevo contacto" },
  "Buscar por nome, email ou telefone…": { es: "Buscar por nombre, email o teléfono…" },
  "todas": { es: "todas" },
  "por página": { es: "por página" },
  "Itens por página": { es: "Elementos por página" },
  "Erro ao carregar contatos.": { es: "Error al cargar los contactos." },
  "contato": { es: "contacto" },
  "contatos": { es: "contactos" },
  "carregados — há mais resultados": { es: "cargados — hay más resultados" },
  "Contato já estava anonimizado.": { es: "El contacto ya estaba anonimizado." },
  "Contato já estava anonimizado, e não faltava nada.": {
    es: "El contacto ya estaba anonimizado y no faltaba nada.",
  },
  "Anonimização retomada: o que faltava foi redigido agora.": {
    es: "Se retomó la anonimización: ya se redactó lo que faltaba.",
  },
  "Contato anonimizado.": { es: "Contacto anonimizado." },
  "Anonimizar contato (LGPD)": { es: "Anonimizar contacto (LGPD)" },
  "Esta ação é irreversível. O nome será substituído por \"Contato Anonimizado #N\", email/telefone/CPF serão limpos, e atividades terão conteúdo redigido.": {
    es: "Esta acción es irreversible. El nombre se reemplazará por \"Contacto Anonimizado #N\", se borrarán el email, el teléfono y el CPF, y se redactará el contenido de las actividades.",
  },
  "Justificativa (mínimo 10 caracteres)": { es: "Justificación (mínimo 10 caracteres)" },
  "Ex.: Solicitação formal do titular via email em DD/MM/YYYY": {
    es: "Ej.: Solicitud formal del titular por email el DD/MM/AAAA",
  },
  "caracteres mínimos": { es: "caracteres mínimos" },
  "Para confirmar, digite": { es: "Para confirmar, escribe" },
  "abaixo.": { es: "abajo." },
  "Confirmação": { es: "Confirmación" },
  "Anonimizando…": { es: "Anonimizando…" },
  "Anonimizar permanentemente": { es: "Anonimizar permanentemente" },
  "Abrir conversa com": { es: "Abrir conversación con" },
  "no Inbox": { es: "en el Inbox" },
  "sem ler": { es: "sin leer" },
  "Selecione…": { es: "Selecciona…" },
  "Formato E.164": { es: "Formato E.164" },
  "Dados inválidos": { es: "Datos inválidos" },
  "Contato atualizado": { es: "Contacto actualizado" },
  "Editar contato": { es: "Editar contacto" },
  "Atualize os dados deste contato.": { es: "Actualiza los datos de este contacto." },
  "Telefone (E.164)": { es: "Teléfono (E.164)" },
  "contato(s) importado(s)": { es: "contacto(s) importado(s)" },
  "linha(s) com problema": { es: "fila(s) con problema" },
  "Não foi possível importar o arquivo.": { es: "No se pudo importar el archivo." },
  "Importar contatos de planilha": { es: "Importar contactos de una hoja de cálculo" },
  "Envie um arquivo .csv com cabeçalho — colunas reconhecidas: nome, telefone, email, cpf, nascimento, tags. Excel: use “Salvar como” → “CSV UTF-8”. Máximo de 500 linhas por arquivo.": {
    es: "Envía un archivo .csv con encabezado — columnas reconocidas: nombre, teléfono, email, cpf, nacimiento, tags. Excel: usa “Guardar como” → “CSV UTF-8”. Máximo 500 líneas por archivo.",
  },
  "Este arquivo não parece ser um CSV de texto. No Excel use “Salvar como” → “CSV UTF-8 (delimitado por vírgulas)”.": {
    es: "Este archivo no parece ser un CSV de texto. En Excel usa “Guardar como” → “CSV UTF-8 (delimitado por comas)”.",
  },
  "Arquivo CSV": { es: "Archivo CSV" },
  "Importando…": { es: "Importando…" },
  "Importar": { es: "Importar" },
  "linha(s) lidas": { es: "fila(s) leída(s)" },
  "importado(s)": { es: "importado(s)" },
  "já existente(s)": { es: "ya existente(s)" },
  "com erro": { es: "con error" },
  "Linha": { es: "Fila" },
  "Importar outro arquivo": { es: "Importar otro archivo" },
  "Concluir": { es: "Finalizar" },
  "Resolver merge de contatos": { es: "Resolver fusión de contactos" },
  "Comparação dos candidatos detectados. A resolução automática via API ainda não está disponível neste MVP — entre em contato com o admin para mesclar via SQL.": {
    es: "Comparación de los candidatos detectados. La resolución automática por API todavía no está disponible en este MVP. Para fusionar contactos, pídele al admin que lo haga por SQL.",
  },
  "Nenhum candidato disponível.": { es: "No hay candidatos disponibles." },
  "Endpoint de resolução não implementado neste MVP": { es: "Endpoint de resolución no implementado en este MVP" },
  "Resolver via SQL (em breve)": { es: "Resolver vía SQL (próximamente)" },
  "Preencha pelo menos um identificador (email ou telefone).": {
    es: "Completa al menos un identificador (email o teléfono).",
  },
  "CPF (opcional)": { es: "CPF (opcional)" },
  "Criar contato": { es: "Crear contacto" },
  "Trocar contato": { es: "Cambiar contacto" },
  "Sem contato, este lead não recebe WhatsApp nem entra nas automações.": {
    es: "Sin contacto, este lead no recibe WhatsApp ni entra en las automatizaciones.",
  },
  "Procure pelo nome ou telefone": { es: "Busca por nombre o teléfono" },
  "Nenhum contato com esse nome ou telefone.": {
    es: "No hay contactos con ese nombre o teléfono.",
  },
  "Contato criado": { es: "Contacto creado" },
  "Não foi possível carregar as sugestões agora.": { es: "No se pudieron cargar las sugerencias en este momento." },
  "Não foi possível registrar a decisão.": { es: "No se pudo registrar la decisión." },
  "O assistente ouviu isto na conversa": { es: "El asistente escuchó esto en la conversación" },
  "aguardando você": { es: "esperando tu decisión" },
  "Nada foi salvo ainda. Confira o que a pessoa escreveu e decida.": {
    es: "Nada se guardó todavía. Revisa lo que la persona escribió y decide.",
  },
  "hoje:": { es: "hoy:" },
  "Está certo, salvar": { es: "Está correcto, guardar" },
  "Erro ao carregar timeline.": { es: "Error al cargar la línea de tiempo." },
  "Nenhuma atividade registrada ainda.": { es: "Aún no hay actividad registrada." },
  "Todas as origens": { es: "Todos los orígenes" },
  "Importado (CSV)": { es: "Importado (CSV)" },
  "Anúncio da Meta": { es: "Anuncio de Meta" },
  "Anúncio do Google": { es: "Anuncio de Google" },

  // ─── Settings: painel de atualização — histórico multi-versão (merge upstream) ───
  "Da versão": { es: "De la versión" },
  "Este histórico começa na versão": { es: "Este historial comienza en la versión" },
  "e pode não alcançar a que você tem instalada": {
    es: "y puede no alcanzar la que tienes instalada",
  },
  "a última parte pode estar cortada. O texto completo está no arquivo CHANGELOG.md do projeto.": {
    es: "la última parte puede estar cortada. El texto completo está en el archivo CHANGELOG.md del proyecto.",
  },

  // ─── App-root-other: páginas de erro, legais e convite (fora do IdiomaProvider) ───
  "403 — Sem permissão": { es: "403 — Sin permiso" },
  "Você não tem acesso a essa área.": { es: "No tienes acceso a esta área." },
  "Voltar pra Inbox": { es: "Volver a Inbox" },
  "404 — Página não encontrada": { es: "404 — Página no encontrada" },
  "Verifique o link ou volte pra inbox.": { es: "Verifica el enlace o vuelve a la bandeja." },
  "500 — Erro interno": { es: "500 — Error interno" },
  "Algo quebrou do nosso lado. Já registramos o ocorrido; tente de novo em instantes.": {
    es: "Algo falló de nuestro lado. Ya registramos el problema. Vuelve a intentarlo en unos instantes.",
  },
  "503 — Em manutenção": { es: "503 — En mantenimiento" },
  "Voltamos em alguns minutos.": { es: "Volvemos en unos minutos." },
  // A recusa por modelo padrão passou a nomear as DUAS topologias: na nuvem o
  // conserto é o script; num Supabase próprio ele não tem Management API para
  // usar, e o caminho são as rotas do app.
  "Este link veio do modelo de e-mail padrão do Supabase, que não fecha o acesso nesta instalação — pedir outro link não resolve. Quem administra o sistema precisa configurar os modelos de e-mail: na nuvem do Supabase, com ":
    {
      es: "Este enlace se generó con la plantilla de correo predeterminada de Supabase, que en esta instalación no protege el acceso. Pedir otro enlace no lo soluciona. Quien administra el sistema debe configurar las plantillas de correo: en la nube de Supabase, con ",
    },
  "; num Supabase próprio, apontando GOTRUE_MAILER_TEMPLATES_* para as rotas /email-templates/ do app.":
    {
      es: "; en un Supabase propio, apuntando GOTRUE_MAILER_TEMPLATES_* a las rutas /email-templates/ de la app.",
    },
  "Conta suspensa": { es: "Cuenta suspendida" },
  // Tela irmã de `/account-suspended`: quem TINHA acesso e não tem mais.
  "Acesso revogado": { es: "Acceso revocado" },
  "Seu acesso a esta organização foi retirado. Se você acredita que isso é um engano, fale com quem administra a empresa — só ela pode devolvê-lo.":
    {
      es: "Se retiró tu acceso a esta organización. Si crees que es un error, habla con quien administra la empresa: solo esa persona puede restablecerlo.",
    },
  "Seu acesso a esta organização foi retirado. Fale com quem administra a empresa — criar uma organização nova não devolve o acesso.":
    {
      es: "Se retiró tu acceso a esta organización. Habla con quien administra la empresa: crear una organización nueva no lo restablece.",
    },
  "Sua conta está suspensa. Entre em contato com": {
    es: "Tu cuenta está suspendida. Contacta a",
  },
  "para mais informações.": { es: "para más información." },
  "Sua conta está suspensa. Fale com quem administra este sistema para saber o motivo e como reativá-la.": {
    es: "Tu cuenta está suspendida. Habla con quien administra este sistema para saber el motivo y cómo reactivarla.",
  },

  "Como esta instalação do": { es: "Cómo esta instalación de" },
  "trata dados pessoais.": { es: "trata los datos personales." },
  "1. Quem é o controlador": { es: "1. Quién es el responsable" },
  "O controlador dos dados tratados aqui é": { es: "El responsable de los datos tratados aquí es" },
  "quem instalou e opera este sistema. Os autores do software não têm acesso a este servidor nem aos dados guardados nele, e não são controladores nem operadores desses dados.": {
    es: "quien instaló y opera este sistema. Los autores del software no tienen acceso a este servidor ni a los datos guardados en él, y no son responsables ni encargados de esos datos.",
  },
  "2. Que dados são tratados": { es: "2. Qué datos se tratan" },
  "De quem é atendido:": { es: "De quien recibe atención:" },
  "nome, telefone, e-mail quando informado, conteúdo das conversas, arquivos enviados (imagens, áudios, documentos) e o histórico de negócios.": {
    es: "nombre, teléfono, correo electrónico si se proporciona, contenido de las conversaciones, archivos enviados (imágenes, audios, documentos) e historial de negocios.",
  },
  "De quem usa o sistema:": { es: "De quien usa el sistema:" },
  "nome, e-mail, papel de acesso e registro das ações realizadas.": {
    es: "nombre, correo electrónico, rol de acceso y registro de las acciones realizadas.",
  },
  "3. Para que são usados": { es: "3. Para qué se usan" },
  "Para atender, responder, registrar o andamento do atendimento e organizar a relação comercial — inclusive por agentes de inteligência artificial que atuam sob as regras configuradas pelo operador. Registros de ação são mantidos para auditoria e segurança.": {
    es: "Para atender y responder, registrar el avance de cada atención y organizar la relación comercial, incluso mediante agentes de inteligencia artificial que actúan con las reglas que configura el operador. Los registros de acciones se conservan para auditoría y seguridad.",
  },
  "4. Com quem são compartilhados": { es: "4. Con quién se comparten" },
  "Os dados ficam no servidor do operador. Para funcionar, o sistema se comunica com terceiros escolhidos e contratados pelo operador:": {
    es: "Los datos permanecen en el servidor del operador. Para funcionar, el sistema se comunica con terceros que el operador elige y contrata:",
  },
  "a plataforma de mensagens usada para conversar com o cliente;": {
    es: "la plataforma de mensajería usada para conversar con el cliente;",
  },
  "o provedor de inteligência artificial contratado pelo operador, que recebe o trecho da conversa necessário para gerar a resposta;": {
    es: "el proveedor de inteligencia artificial contratado por el operador, que recibe el fragmento de la conversación necesario para generar la respuesta;",
  },
  "o provedor de infraestrutura onde o servidor está hospedado.": {
    es: "el proveedor de infraestructura donde el servidor está alojado.",
  },
  "Os dados não são vendidos nem cedidos para publicidade de terceiros.": {
    es: "Los datos no se venden ni se ceden para publicidad de terceros.",
  },
  "5. Por quanto tempo": { es: "5. Por cuánto tiempo" },
  "Conversas e registros de negócio são mantidos enquanto houver relação com o cliente ou obrigação legal de guarda. Arquivos de mídia têm prazo próprio, configurado pelo operador. Registros de auditoria são mantidos por período mais longo, por serem prova de quem fez o quê.": {
    es: "Las conversaciones y los registros de negocio se conservan mientras exista relación con el cliente o una obligación legal de conservarlos. Los archivos multimedia tienen un plazo propio, que configura el operador. Los registros de auditoría se conservan por más tiempo, porque prueban quién hizo qué.",
  },
  "6. Seus direitos": { es: "6. Tus derechos" },
  "A LGPD garante a você confirmar se há tratamento, acessar seus dados, corrigir dados incompletos ou desatualizados, pedir anonimização ou eliminação, saber com quem foram compartilhados e revogar consentimento.": {
    es: "La LGPD te da derecho a confirmar si se tratan tus datos, acceder a ellos, corregir datos incompletos o desactualizados, pedir su anonimización o eliminación, saber con quién se compartieron y revocar tu consentimiento.",
  },
  "O sistema atende esses pedidos por um fluxo próprio: a exportação reúne o que existe sobre a pessoa, e a anonimização remove a identificação preservando o histórico de atendimento — por isso ela": {
    es: "El sistema atiende estas solicitudes con un flujo propio: la exportación reúne lo que existe sobre la persona, y la anonimización elimina su identificación y conserva el historial de atención; por eso",
  },
  "não pode ser desfeita": { es: "no se puede deshacer" },
  "7. Segurança": { es: "7. Seguridad" },
  "O acesso é controlado por conta, senha e papel, com verificação em duas etapas obrigatória para administradores. Cada organização hospedada só enxerga os próprios dados, e as chaves de integração são guardadas cifradas.": {
    es: "El acceso se controla con cuenta, contraseña y rol, y la verificación en dos pasos es obligatoria para los administradores. Cada organización alojada solo ve sus propios datos y las claves de integración se guardan cifradas.",
  },
  "8. Encarregado e contato": { es: "8. Encargado y contacto" },
  "Para exercer seus direitos ou tirar dúvidas sobre privacidade, fale com o encarregado de dados:": {
    es: "Para ejercer tus derechos o resolver dudas sobre privacidad, habla con el encargado de datos:",
  },
  "O operador ainda não publicou um endereço de contato do encarregado de dados nesta instalação. Os pedidos devem ser feitos pelos canais de atendimento da própria organização.": {
    es: "El operador todavía no publicó una dirección de contacto del encargado de datos en esta instalación. Las solicitudes deben hacerse por los canales de atención de la propia organización.",
  },

  "As regras de uso desta instalação do": { es: "Las reglas de uso de esta instalación de" },
  "1. Quem é quem": { es: "1. Quién es quién" },
  "O": { es: "El" },
  "é um software de código aberto instalado e operado por": {
    es: "es un software de código abierto instalado y operado por",
  },
  "daqui em diante": { es: "de aquí en adelante" },
  "o operador": { es: "el operador" },
  "É o operador quem mantém este servidor, decide como o sistema é usado e responde pelos dados tratados aqui.": {
    es: "Es el operador quien mantiene este servidor, decide cómo se usa el sistema y responde por los datos tratados aquí.",
  },
  "Os autores e mantenedores do software não operam esta instalação, não têm acesso a este servidor nem aos dados nele guardados, e não são parte da relação entre o operador e você. Qualquer pedido sobre uso, cobrança, suporte ou dados deve ser dirigido ao operador.": {
    es: "Los autores y mantenedores del software no operan esta instalación, no tienen acceso a este servidor ni a los datos almacenados en él, y no forman parte de la relación entre el operador y tú. Cualquier solicitud sobre uso, cobro, soporte o datos debe dirigirse al operador.",
  },
  "2. O que o sistema faz": { es: "2. Qué hace el sistema" },
  "organiza atendimento e vendas: recebe e envia mensagens pelos canais que o operador conectar, registra contatos e negócios, e permite que agentes de inteligência artificial atendam junto com pessoas, sob as regras que o operador configurar.": {
    es: "organiza atención y ventas: recibe y envía mensajes por los canales que el operador conecte, registra contactos y negocios, y permite que agentes de inteligencia artificial atiendan junto con personas, bajo las reglas que el operador configure.",
  },
  "3. Sua conta": { es: "3. Tu cuenta" },
  "O acesso é pessoal. Você é responsável por manter sua senha em segredo e pelo que for feito com a sua conta. Contas de administrador exigem verificação em duas etapas. Avise o operador imediatamente se suspeitar de acesso indevido.": {
    es: "El acceso es personal. Eres responsable de mantener tu contraseña en secreto y de lo que se haga con tu cuenta. Las cuentas de administrador exigen verificación en dos pasos. Avisa al operador de inmediato si sospechas de un acceso indebido.",
  },
  "4. Uso aceitável": { es: "4. Uso aceptable" },
  "Ao usar este sistema, você concorda em não:": { es: "Al usar este sistema, te comprometes a no:" },
  "enviar mensagens não solicitadas em massa, nem burlar pedidos de descadastro;": {
    es: "enviar mensajes masivos no solicitados ni eludir las solicitudes de baja;",
  },
  "usar os dados de clientes para finalidade diferente da que os originou;": {
    es: "usar los datos de clientes para un fin diferente del que los originó;",
  },
  "tentar acessar dados de outra organização hospedada nesta instalação;": {
    es: "intentar acceder a datos de otra organización alojada en esta instalación;",
  },
  "violar os termos dos serviços conectados, como as regras da plataforma de mensagens.": {
    es: "violar los términos de los servicios conectados, como las reglas de la plataforma de mensajería.",
  },
  "O sistema respeita pedidos de parada enviados pelos clientes: quem pedir para não receber mais mensagens é bloqueado automaticamente para envios.": {
    es: "El sistema respeta cuando un cliente pide dejar de recibir mensajes: esa persona queda bloqueada automáticamente para los envíos.",
  },
  "5. Conteúdo e dados": { es: "5. Contenido y datos" },
  "Os dados inseridos aqui — contatos, conversas, negócios, arquivos — pertencem ao operador e às pessoas a que se referem. O tratamento desses dados é descrito na": {
    es: "Los datos ingresados aquí — contactos, conversaciones, negocios, archivos — pertenecen al operador y a las personas a las que se refieren. El tratamiento de esos datos se describe en la",
  },
  "Respostas geradas por inteligência artificial podem conter erros. Elas não substituem conferência humana em decisões que envolvam preço, prazo, saúde, crédito ou obrigação legal.": {
    es: "Las respuestas generadas por inteligencia artificial pueden contener errores. No sustituyen la verificación humana en decisiones que involucren precio, plazo, salud, crédito u obligación legal.",
  },
  "6. Disponibilidade e garantias": { es: "6. Disponibilidad y garantías" },
  "Este sistema roda em servidor do operador e depende de serviços de terceiros para funcionar. O software é distribuído “como está”, sem garantia de funcionamento ininterrupto ou de adequação a uma finalidade específica. Interrupções, falhas de terceiros e perda de dados por causas fora do controle do operador não geram obrigação de indenizar, salvo quando a lei determinar.": {
    es: "Este sistema se ejecuta en el servidor del operador y depende de servicios de terceros para funcionar. El software se distribuye “tal cual”, sin garantía de funcionamiento ininterrumpido ni de idoneidad para un fin específico. Las interrupciones, las fallas de terceros y la pérdida de datos por causas ajenas al control del operador no generan obligación de indemnizar, salvo que la ley lo disponga.",
  },
  "7. Encerramento": { es: "7. Terminación" },
  "O operador pode suspender ou encerrar o seu acesso em caso de descumprimento destes termos. Você pode pedir o encerramento da sua conta a qualquer momento. O encerramento do acesso não apaga automaticamente os registros de atendimento, que seguem as regras de retenção descritas na Política de Privacidade.": {
    es: "El operador puede suspender o cancelar tu acceso si se incumplen estos términos. Puedes solicitar el cierre de tu cuenta en cualquier momento. Cerrar el acceso no borra automáticamente los registros de atención, que siguen las reglas de retención descritas en la Política de Privacidad.",
  },
  "8. Mudanças": { es: "8. Cambios" },
  "O operador pode atualizar estes termos. Mudanças relevantes devem ser comunicadas antes de passarem a valer.": {
    es: "El operador puede actualizar estos términos. Los cambios relevantes deben comunicarse antes de entrar en vigor.",
  },
  "9. Contato": { es: "9. Contacto" },
  "Falar com o operador": { es: "Hablar con el operador" },
  "pelos canais de atendimento da própria organização": {
    es: "por los canales de atención de la propia organización",
  },

  "Muitas tentativas": { es: "Demasiados intentos" },
  "Aguarde alguns minutos e abra o link do convite de novo.": {
    es: "Espera unos minutos y vuelve a abrir el enlace de la invitación.",
  },
  "Convite inválido ou expirado": { es: "Invitación inválida o vencida" },
  "Este link não é válido ou já passou da janela de 24h. Peça um novo convite ao admin do tenant.": {
    es: "Este enlace no es válido o ya pasaron las 24h de vigencia. Pide una nueva invitación al admin del tenant.",
  },
  "Você foi convidado": { es: "Te invitaron" },
  "Para aceitar o convite como": { es: "Para aceptar la invitación como" },
  "faça login com o email": { es: "inicia sesión con el correo" },
  "Fazer login": { es: "Iniciar sesión" },
  "Ainda não tenho conta": { es: "Todavía no tengo cuenta" },
  "Email não corresponde": { es: "El correo no coincide" },
  "Você está logado como": { es: "Estás conectado como" },
  "mas o convite foi enviado para": { es: "pero la invitación se envió a" },
  "Saia e faça login com o email correto.": { es: "Cierra sesión y vuelve a iniciarla con el correo correcto." },
  "Aceitar convite": { es: "Aceptar invitación" },
  "Você foi convidado para entrar como": { es: "Te invitaron a entrar como" },
  "Confirme abaixo para ativar seu acesso.": { es: "Confirma abajo para activar tu acceso." },

  // ─── LGPD: solicitações (fila, ficha, SLA, aprovação, prévia, auditoria) ───
  "Solicitações LGPD": { es: "Solicitudes LGPD" },
  "Anonimizações e solicitações de dados de titulares. Apenas admins.": {
    es: "Anonimizaciones y solicitudes de datos de titulares. Solo admins.",
  },
  "agora": { es: "ahora" },
  "min atrás": { es: "min atrás" },
  "h atrás": { es: "h atrás" },
  "d atrás": { es: "d atrás" },
  "d atrasado": { es: "d de atraso" },
  "atrasado hoje": { es: "atrasado hoy" },
  "Status: todos": { es: "Estado: todos" },
  "Revisão pendente": { es: "Revisión pendiente" },
  "Tipo: todos": { es: "Tipo: todos" },
  "Anonimização cliente": { es: "Anonimización de cliente" },
  "Solicitação dados": { es: "Solicitud de datos" },
  "Anonimização tenant": { es: "Anonimización de tenant" },
  "SLA: todos": { es: "SLA: todos" },
  "Alerta": { es: "Alerta" },
  "solicitação": { es: "solicitud" },
  "solicitações": { es: "solicitudes" },
  "Sujeito": { es: "Titular" },
  "Vence": { es: "Vence" },
  "Erro ao carregar solicitações.": { es: "Error al cargar solicitudes." },
  "Nenhuma solicitação LGPD": { es: "Ninguna solicitud LGPD" },
  "Solicitações de dados e anonimizações aparecerão aqui.": {
    es: "Las solicitudes de datos y anonimizaciones aparecerán aquí.",
  },
  "Anterior": { es: "Anterior" },
  "Próxima": { es: "Siguiente" },
  "solicitação crítica": { es: "solicitud crítica" },
  "solicitações críticas": { es: "solicitudes críticas" },
  "SLA vencido ou inferior a 2 dias. Ação imediata requerida.": {
    es: "SLA vencido o con menos de 2 días. Requiere acción inmediata.",
  },
  "solicitação em alerta": { es: "solicitud en alerta" },
  "solicitações em alerta": { es: "solicitudes en alerta" },
  "mais de 50% do prazo consumido.": { es: "más del 50% del plazo consumido." },
  "Solicitações": { es: "Solicitudes" },
  "Solicitação de dados": { es: "Solicitud de datos" },
  "Recebido em": { es: "Recibido el" },
  "às": { es: "a las" },
  "Vence em": { es: "Vence el" },
  "Relatório de exportação disponível (expira em 72h).": {
    es: "Informe de exportación disponible (expira en 72h).",
  },
  "Baixar PDF": { es: "Descargar PDF" },
  "Linha do tempo SLA": { es: "Línea de tiempo SLA" },
  "SLA não definido.": { es: "SLA no definido." },
  "ID completo": { es: "ID completo" },
  "Concluído em": { es: "Concluido el" },
  "Aprovar export": { es: "Aprobar exportación" },
  "Aprovar exportação de dados": { es: "Aprobar exportación de datos" },
  "Ao confirmar, esta solicitação será colocada em fila para exportação dos dados do titular. A ação não pode ser desfeita.": {
    es: "Al confirmar, esta solicitud se pondrá en cola para exportar los datos del titular. La acción no se puede deshacer.",
  },
  "Aprovar anonimização": { es: "Aprobar anonimización" },
  "Aprovar anonimização de contato": { es: "Aprobar anonimización de contacto" },
  "Ao confirmar, todos os dados pessoais do titular serão anonimizados (irreversível). O histórico de timestamps é preservado.": {
    es: "Al confirmar, se anonimizarán todos los datos personales del titular (irreversible). Se conserva el historial de marcas de tiempo.",
  },
  "Aprovar anonimização (tenant)": { es: "Aprobar anonimización (tenant)" },
  "Aprovar anonimização de tenant": { es: "Aprobar anonimización de tenant" },
  "Ao confirmar, todos os dados pessoais do tenant serão anonimizados (irreversível). Esta ação afeta todos os contatos do tenant.": {
    es: "Al confirmar, se anonimizarán todos los datos personales del tenant (irreversible). Esta acción afecta a todos los contactos del tenant.",
  },
  "Aprovação registrada — request mudou para processing": {
    es: "Aprobación registrada — la solicitud pasó a processing",
  },
  "Falha ao aprovar a solicitação. Tente novamente.": {
    es: "No se pudo aprobar la solicitud. Intenta de nuevo.",
  },
  "Justificativa": { es: "Justificación" },
  "mínimo 10 caracteres": { es: "mínimo 10 caracteres" },
  "Descreva o motivo da aprovação manual desta solicitação…": {
    es: "Describe el motivo de la aprobación manual de esta solicitud…",
  },
  "Aprovando…": { es: "Aprobando…" },
  "Confirmar aprovação": { es: "Confirmar aprobación" },
  "Pré-visualizar dados": { es: "Previsualizar datos" },
  "Prévia de dados do titular": { es: "Vista previa de datos del titular" },
  "Falha ao carregar prévia.": { es: "No se pudo cargar la vista previa." },
  "Nenhum dado local encontrado para este titular.": {
    es: "No se encontró ningún dato local para este titular.",
  },
  "presente (valor ocultado)": { es: "presente (valor oculto)" },
  "Mensagens (total)": { es: "Mensajes (total)" },
  "Atividades": { es: "Actividades" },
  "Entradas de auditoria": { es: "Entradas de auditoría" },
  "Consentimentos": { es: "Consentimientos" },
  "Ocultar amostra": { es: "Ocultar muestra" },
  "Expandir amostra (10 itens por categoria)": { es: "Expandir muestra (10 elementos por categoría)" },
  "Mensagens (recentes)": { es: "Mensajes (recientes)" },
  "Gerado em": { es: "Generado el" },
  "mascarada": { es: "enmascarada" },
  "não exibido": { es: "no mostrado" },
  "Carregando auditoria…": { es: "Cargando auditoría…" },
  "Revisão intermediária": { es: "Revisión intermedia" },
  "Entrega ao titular": { es: "Entrega al titular" },
  "Processamento": { es: "Procesamiento" },
  "Anonimização concluída": { es: "Anonimización concluida" },
  "d restantes": { es: "d restantes" },
  "vence hoje": { es: "vence hoy" },
  "d em atraso": { es: "d de atraso" },

  // ─── Team: membros, convites, atendentes e roteamento ───
  "Gestão de membros, roles e atendimento do tenant.": {
    es: "Gestión de miembros, roles y atención del tenant.",
  },
  "Convidar membros": { es: "Invitar miembros" },
  "Membros": { es: "Miembros" },
  "A gestão de atendimento está disponível para gerentes e administradores.": {
    es: "La gestión de atención está disponible para gerentes y administradores.",
  },
  "Cole até 20 emails (um por linha) e escolha a role compartilhada.": {
    es: "Pega hasta 20 correos (uno por línea) y elige el rol compartido.",
  },
  "Adicione ao menos um email.": { es: "Agrega al menos un correo." },
  "Máximo 20 emails por convite.": { es: "Máximo 20 correos por invitación." },
  "convite(s) enviado(s)": { es: "invitación(es) enviada(s)" },
  "falha(s).": { es: "falla(s)." },
  "Enviando…": { es: "Enviando…" },
  "Enviar convites": { es: "Enviar invitaciones" },
  "Enviados": { es: "Enviados" },
  "Email enviado.": { es: "Correo enviado." },
  "Resend não configurado — link copiável abaixo (DEV).": {
    es: "Resend no configurado — enlace copiable abajo (DEV).",
  },
  "Falhas": { es: "Fallas" },
  "Resultados aparecerão aqui após o envio.": { es: "Los resultados aparecerán aquí después del envío." },
  "Erro ao carregar membros.": { es: "Error al cargar miembros." },
  "Nenhum membro ativo.": { es: "No hay miembros activos." },
  "Membro": { es: "Miembro" },
  "Papel de": { es: "Rol de" },
  "Aceito": { es: "Aceptado" },
  "Revogar acesso": { es: "Revocar acceso" },
  "você": { es: "tú" },
  "perderá acesso ao tenant. Esta ação pode ser desfeita reconvidando o membro.": {
    es: "perderá el acceso al tenant. Puedes deshacerlo volviendo a invitar al miembro.",
  },
  "Acesso revogado.": { es: "Acceso revocado." },
  "Manual (atendente puxa da fila)": { es: "Manual (el asesor toma de la cola)" },
  "Rodízio (distribui automático)": { es: "Rotación (distribución automática)" },
  "Horário de": { es: "Horario de" },
  "Sem janelas = disponível 24/7. Adicione janelas para restringir o roteamento a horários específicos.": {
    es: "Sin ventanas = disponible 24/7. Agrega ventanas para restringir el enrutamiento a horarios específicos.",
  },
  "Nenhuma janela — disponível 24/7.": { es: "Sin ventanas, disponible 24/7." },
  "Dia da semana": { es: "Día de la semana" },
  "Remover janela": { es: "Eliminar ventana" },
  "Adicionar janela": { es: "Agregar ventana" },
  "Erro ao carregar a configuração de roteamento.": {
    es: "Error al cargar la configuración de enrutamiento.",
  },
  "Modo de roteamento": { es: "Modo de enrutamiento" },
  "Como as conversas novas são distribuídas entre os atendentes da organização.": {
    es: "Cómo se distribuyen las conversaciones nuevas entre los asesores de la organización.",
  },
  "Modo": { es: "Modo" },
  "Balanceamento por carga (em breve)": { es: "Balanceo de carga (próximamente)" },
  "Tentativas máx.": { es: "Intentos máx." },
  "Backoff (s)": { es: "Backoff (s)" },
  "Atendentes": { es: "Asesores" },
  "Status, carga atual e capacidade de cada atendente da organização.": {
    es: "Estado, carga actual y capacidad de cada asesor de la organización.",
  },
  "Erro ao carregar atendentes.": { es: "Error al cargar asesores." },
  "Nenhum atendente na organização. Convide membros com papel de atendente ou superior.": {
    es: "No hay asesores en la organización. Invita a miembros con rol de asesor o superior.",
  },
  "Carga": { es: "Carga" },
  "Capacidade": { es: "Capacidad" },
  "Horário": { es: "Horario" },
  "Disponível": { es: "Disponible" },
  "Capacidade de": { es: "Capacidad de" },
  "Editar horário de": { es: "Editar horario de" },
  "Disponibilidade de": { es: "Disponibilidad de" },

  // ─── Pipelines/Kanban: lista de funis, board, card, dossiê, diálogos ───
  "Não consegui completar essa ação. Tente de novo.": {
    es: "No pude completar esa acción. Intenta de nuevo.",
  },
  "Nome do funil — ex.: Consultas, Obras, Matrículas": {
    es: "Nombre del embudo — ej.: Consultas, Obras, Matrículas",
  },
  "Nome do novo funil": { es: "Nombre del nuevo embudo" },
  "Criar funil": { es: "Crear embudo" },
  "Criar meu primeiro funil": { es: "Crear mi primer embudo" },
  "Novo funil": { es: "Nuevo embudo" },
  "Subir": { es: "Subir" },
  "na lista": { es: "en la lista" },
  "Descer": { es: "Bajar" },
  "Novo nome de": { es: "Nuevo nombre de" },
  "Padrão": { es: "Predeterminado" },
  "Tornar padrão": { es: "Hacer predeterminado" },
  "Clientes": { es: "Clientes" },
  "Funil de clientes": { es: "Embudo de clientes" },
  "Deixar de ser funil de clientes": { es: "Dejar de ser embudo de clientes" },
  "Quem já tem atendimento marcado entra pelo funil de clientes. Sem um funil marcado, entra pelo padrão.": { es: "Quien ya tiene una cita entra por el embudo de clientes. Si no hay un embudo marcado, entra por el predeterminado." },
  "Cliente desde": { es: "Cliente desde" },
  // Clientes pela agenda (migration 0262): o interruptor em Tipos de agendamento e a porta no rodapé de Funis.
  "Acompanhamento somente leitura ou encerrado.": { es: "Seguimiento de solo lectura o cerrado." },
  "Confirme a verificação em duas etapas.": { es: "Confirma la verificación en dos pasos." },
  "Outra mudança estava em andamento. Tente de novo.": { es: "Otro cambio estaba en curso. Intenta de nuevo." },
  "Clientes pela agenda": { es: "Clientes por la agenda" },
  "Quem tem horário marcado vira cliente": { es: "Quien tiene una cita pasa a ser cliente" },
  "Com isto ligado, todo contato com horário marcado ganha a etiqueta “cliente” e a ficha passa a mostrar “Cliente desde”. Ao ligar, quem já teve horário marcado também ganha. Horário cancelado e falta não contam: se não sobrar nenhum horário que conte, sai a etiqueta que o sistema pôs — a que a equipe pôs à mão fica. Se alguém da equipe tirar a etiqueta, ela não volta.": { es: "Con esta opción activada, todo contacto con una cita recibe la etiqueta “cliente” y su ficha muestra “Cliente desde”. Al activarla, quienes ya tuvieron una cita también la reciben. Las citas canceladas y las ausencias no cuentan: si a un contacto no le queda ninguna cita que cuente, se quita la etiqueta que puso el sistema (la que el equipo puso a mano se queda). Si alguien del equipo quita la etiqueta, no se vuelve a agregar." },
  "Desligado: ninguém ganha a etiqueta, a ficha não mostra “Cliente desde” e todo contato novo entra pelo funil padrão. As etiquetas que já existem ficam como estão.": { es: "Desactivado: nadie recibe la etiqueta, la ficha no muestra “Cliente desde” y todo contacto nuevo entra por el embudo predeterminado. Las etiquetas que ya existen se quedan como están." },
  "Ligado: quem marcar horário ganha a etiqueta “cliente” na hora.": { es: "Activado: quien agende una cita recibe la etiqueta “cliente” al instante." },
  "As automações “Quando um contato ganhar uma tag” disparam uma vez por contato: na primeira vez que o sistema acrescenta a etiqueta. Não disparam para quem já era cliente ao ligar, para quem já tinha a etiqueta posta à mão, nem de novo para quem cancela e marca outra vez.": { es: "Las automatizaciones “Cuando un contacto reciba una etiqueta” se activan una vez por contacto: la primera vez que el sistema agrega la etiqueta. No se activan para quien ya era cliente al activarla, para quien ya tenía la etiqueta puesta a mano, ni de nuevo para quien cancela y vuelve a agendar." },
  "Ligar clientes pela agenda?": { es: "¿Activar clientes por la agenda?" },
  "Todos os contatos que já tiveram horário marcado (sem contar cancelados e faltas) ganham a etiqueta “cliente” agora. Se a regra já esteve ligada, quem ficou sem horário que conte perde a etiqueta que o sistema tinha posto. Desligar depois não tira a etiqueta de ninguém.": { es: "Todos los contactos que ya tuvieron una cita (sin contar canceladas ni ausencias) reciben la etiqueta “cliente” ahora. Si la regla ya estuvo activada, quien se quedó sin una cita que cuente pierde la etiqueta que había puesto el sistema. Desactivarlo después no le quita la etiqueta a nadie." },
  "{n} contatos ganharam a etiqueta “cliente”.": { es: "{n} contactos recibieron la etiqueta “cliente”." },
  "1 contato ganhou a etiqueta “cliente”.": { es: "1 contacto recibió la etiqueta “cliente”." },
  "Nenhum contato tinha horário marcado ainda. Quem marcar daqui em diante ganha a etiqueta.": { es: "Todavía no hay contactos con citas. Quien agende a partir de ahora recibirá la etiqueta." },
  "Nenhum contato novo ganhou a etiqueta: {c} contatos já eram clientes.": { es: "Ningún contacto nuevo recibió la etiqueta: {c} contactos ya eran clientes." },
  "Nenhum contato novo ganhou a etiqueta: 1 contato já era cliente.": { es: "Ningún contacto nuevo recibió la etiqueta: 1 contacto ya era cliente." },
  "Nenhum contato ganhou a etiqueta.": { es: "Ningún contacto recibió la etiqueta." },
  "Nenhum contato virou cliente: os horários que existem estão cancelados ou marcados como falta.": { es: "Ningún contacto pasó a ser cliente: las citas que existen están canceladas o marcadas como ausencia." },
  "{m} contatos perderam a etiqueta “cliente”: enquanto a regra estava desligada, os horários deles foram cancelados, marcados como falta ou apagados.": { es: "{m} contactos perdieron la etiqueta “cliente”: mientras la regla estaba desactivada, sus citas se cancelaron, se marcaron como ausencia o se eliminaron." },
  "1 contato perdeu a etiqueta “cliente”: enquanto a regra estava desligada, os horários dele foram cancelados, marcados como falta ou apagados.": { es: "1 contacto perdió la etiqueta “cliente”: mientras la regla estaba desactivada, sus citas se cancelaron, se marcaron como ausencia o se eliminaron." },
  "Para separar quem já é cliente, ligue “Clientes pela agenda” em Configurações › Tipos de agendamento. Enquanto estiver desligado, todo contato novo entra pelo funil padrão.": { es: "Para separar a los clientes actuales, activa “Clientes por la agenda” en Configuración › Tipos de cita. Mientras esté desactivado, todo contacto nuevo entra por el embudo predeterminado." },
  "Abrir Tipos de agendamento": { es: "Abrir Tipos de cita" },
  "Ele sai desta lista e para de receber negócio novo. O histórico continua guardado, e nada é apagado.": {
    es: "Sale de esta lista y deja de recibir negocios nuevos. El historial se conserva y no se borra nada.",
  },
  "Excluir de vez": { es: "Eliminar definitivamente" },
  // A gaveta do arquivo (#979) — a porta de volta do funil arquivado.
  "Funis arquivados": { es: "Embudos archivados" },
  "Tirar do arquivo": { es: "Desarchivar" },
  "Funil arquivado não aparece na lista nem recebe negócio novo. Traga de volta para usar outra vez, ou exclua de vez para liberar o nome.": {
    es: "El embudo archivado no aparece en la lista ni recibe negocios nuevos. Desarchívalo para usarlo otra vez, o elimínalo definitivamente para liberar el nombre.",
  },
  "Isso não tem volta: o funil e as etapas dele somem. Se ele já recebeu negócio, a exclusão é recusada e ele continua arquivado.": {
    es: "Esta acción no se puede deshacer: el embudo y sus etapas desaparecen. Si ya recibió negocios, no se puede eliminar y sigue archivado.",
  },
  "Novo Lead": { es: "Nuevo Lead" },
  "Não consegui carregar este funil:": { es: "No pude cargar este embudo:" },
  "sem responsável.": { es: "sin responsable." },
  "atribuído.": { es: "asignado." },
  "atribuídos.": { es: "asignados." },
  "selecionado": { es: "seleccionado" },
  "selecionados": { es: "seleccionados" },
  "Mover para…": { es: "Mover a…" },
  "Atribuir a…": { es: "Asignar a…" },
  "Responsável…": { es: "Responsable…" },
  "Eu": { es: "Yo" },
  "Remover responsável": { es: "Quitar responsable" },
  "nova tag": { es: "nueva etiqueta" },
  "Esta ação remove os leads selecionados. Não pode ser desfeita.": {
    es: "Esta acción elimina los leads seleccionados. No se puede deshacer.",
  },
  // Seleção em lote no quadro (migration 0209). A frase perdeu o substantivo
  // "leads" de propósito: o funil renomeia o que está nos cards
  // (`crm_pipelines.vocabulary`), e uma frase que crava "leads" contradiz a
  // própria tela em quem chamou de Cliente ou Pedido.
  "Esta ação remove o que está selecionado. Não pode ser desfeita.": {
    es: "Esta acción elimina lo que está seleccionado. No se puede deshacer.",
  },
  // Excluir UM card pelo menu do card: diz o que vai junto (o histórico de
  // atividades, por cascade) e o que fica. "card" pelo mesmo motivo acima.
  "O card sai do funil com o histórico de atividades. O contato e as conversas continuam. Esta ação não pode ser desfeita.": {
    es: "La tarjeta sale del embudo con el historial de actividades. El contacto y las conversaciones se mantienen. Esta acción no se puede deshacer.",
  },
  "Selecionar": { es: "Seleccionar" },
  "Selecionar todos em": { es: "Seleccionar todos en" },
  "Desmarcar todos em": { es: "Desmarcar todos en" },
  "Abrir esta conversa no Inbox": { es: "Abrir esta conversación en Inbox" },
  "conversa sem mensagens": { es: "conversación sin mensajes" },
  "Valor inválido": { es: "Valor inválido" },
  "Lead atualizado": { es: "Lead actualizado" },
  "Editar lead": { es: "Editar lead" },
  "Atualize os campos. Mover de etapa ou marcar ganho/perdido tem opções próprias.": {
    es: "Actualiza los campos. Para mover de etapa o marcar como ganado o perdido hay opciones aparte.",
  },
  "Valor (R$)": { es: "Valor (R$)" },
  "Tag: todas": { es: "Etiqueta: todas" },
  "Buscar por título…": { es: "Buscar por título…" },
  "Falha ao carregar o board.": { es: "No se pudo cargar el tablero." },
  "Nenhum lead nesta pipeline ainda.": { es: "Todavía no hay leads en este embudo." },
  "Ações do lead": { es: "Acciones del lead" },
  "Marcar como ganho": { es: "Marcar como ganado" },
  "Marcar como perdido": { es: "Marcar como perdido" },
  "Probabilidade recalculada automaticamente": { es: "Probabilidad recalculada automáticamente" },
  "Dados do negócio": { es: "Datos del negocio" },
  "Carregando a linha do tempo…": { es: "Cargando la línea de tiempo…" },
  "Não consegui carregar a linha do tempo. Tente de novo em instantes.": {
    es: "No pude cargar la línea de tiempo. Intenta de nuevo en unos instantes.",
  },
  "Nada aconteceu com este negócio ainda.": { es: "Todavía no ha pasado nada con este negocio." },
  "Informe o motivo. Essa informação ajuda a melhorar o funil.": {
    es: "Indica el motivo. Esta información ayuda a mejorar el embudo.",
  },
  "Detalhe (opcional)": { es: "Detalle (opcional)" },
  // Sem esta linha, "Outro" com funil configurado é beco sem saída: a tela
  // oferece a opção, recusa todo texto que não seja um motivo já cadastrado, e
  // não diz ONDE se cadastra um motivo novo.
  "Para usar um motivo que não está aqui, cadastre em Configurações › Funis.": {
    es: "Para usar un motivo que no está aquí, agrégalo en Configuración › Embudos.",
  },
  "Ex: Cliente desistiu por X motivo": { es: "Ej: El cliente desistió por X motivo" },
  "Confirmar": { es: "Confirmar" },
  "Lead criado": { es: "Lead creado" },
  "Crie um lead manualmente neste pipeline.": { es: "Crea un lead manualmente en este pipeline." },
  "Ex: Pedido Maria — combo presente": { es: "Ej: Pedido María — combo regalo" },
  "Contexto, observações, links…": { es: "Contexto, observaciones, enlaces…" },
  "Selecione a etapa": { es: "Selecciona la etapa" },
  "Criar lead": { es: "Crear lead" },
  "Propõe:": { es: "Propone:" },
  "Aprovar:": { es: "Aprobar:" },
  "Ignorar:": { es: "Ignorar:" },
  "vencendo": { es: "por vencer" },
  "Este negócio parou de responder": { es: "Este negocio dejó de responder" },
  "Retomar contato?": { es: "¿Retomar contacto?" },
  "A sugestão vence em": { es: "La sugerencia vence en" },
  "Retomar contato com este negócio": { es: "Retomar contacto con este negocio" },
  "Encerrar: não retomar este negócio": { es: "Cerrar: no retomar este negocio" },
  "Encerrar": { es: "Cerrar" },
  "Probabilidade": { es: "Probabilidad" },
  "Ver o porquê.": { es: "Ver el porqué." },
  "ver a mensagem": { es: "ver el mensaje" },
  "registro que sustenta": { es: "registro que sustenta" },
  "Sem evidências registradas.": { es: "Sin evidencias registradas." },
  "Sem resposta há": { es: "Sin respuesta hace" },
  "Cliente solicitou cancelamento": { es: "El cliente pidió cancelar" },
  "Preço": { es: "Precio" },
  "Sem resposta do cliente": { es: "Sin respuesta del cliente" },
  "Produto indisponível": { es: "Producto no disponible" },
  "Cancelado pela loja": { es: "Cancelado por la tienda" },
  "Cancelado pelo cliente": { es: "Cancelado por el cliente" },
  "Falha no pagamento": { es: "Falla en el pago" },
  "Outro motivo": { es: "Otro motivo" },
  "Ganhos": { es: "Ganados" },
  "Perdidos": { es: "Perdidos" },

  // ─── Empty state: Agenda (merge upstream, novo módulo de Calendário) ───
  "Sua agenda está livre esta semana": { es: "Tu agenda está libre esta semana" },
  "Agendamentos aparecem aqui quando alguém marca pela tela, quando o agente marca por você, ou quando chegam da agenda do Google conectada.": {
    es: "Aquí verás las citas que se agenden desde esta pantalla, las que programe el agente por ti y las que lleguen desde tu Google Calendar conectado.",
  },

  // ─── Auth: login, cadastro, recuperação de senha, MFA, códigos de recuperação ───
  "Entrar": { es: "Entrar" },
  "Criar conta": { es: "Crear cuenta" },
  "Senha": { es: "Contraseña" },
  "Confirmar senha": { es: "Confirmar contraseña" },
  "Código inválido. Tente novamente.": { es: "Código inválido. Intenta de nuevo." },
  "Verificando...": { es: "Verificando..." },
  "Verificar": { es: "Verificar" },
  "Dados inválidos. Confira os campos.": { es: "Datos inválidos. Revisa los campos." },
  "Muitas tentativas. Aguarde alguns minutos.": {
    es: "Demasiados intentos. Espera unos minutos.",
  },
  "Não tem conta?": { es: "¿No tienes cuenta?" },
  "Recuperar senha": { es: "Recuperar contraseña" },
  "Informe seu e-mail e enviaremos um link de redefinição": {
    es: "Indica tu correo y te enviaremos un enlace para restablecer tu contraseña",
  },
  "Lembrou a senha?": { es: "¿Recordaste la contraseña?" },
  "Digite o código de 6 dígitos do seu autenticador.": {
    es: "Escribe el código de 6 dígitos de tu autenticador.",
  },
  "Senha redefinida com sucesso. Entre com a nova senha.": {
    es: "Contraseña restablecida con éxito. Entra con la nueva contraseña.",
  },
  "Link inválido ou expirado. Peça um novo em Recuperar senha ou refaça o cadastro.": {
    es: "Enlace inválido o vencido. Pide uno nuevo en Recuperar contraseña o vuelve a registrarte.",
  },
  "Sua conta foi confirmada, mas o convite não vale mais — ele expirou ou foi emitido para outro e-mail. Peça um novo a quem te convidou. Não criamos uma empresa nova para você, porque não era isso que você estava fazendo.": {
    es: "Confirmamos tu cuenta, pero la invitación ya no es válida: venció o se emitió para otro correo. Pide una nueva a quien te invitó. No creamos una empresa nueva para ti, porque no era lo que intentabas hacer.",
  },
  ", no kit de instalação).": { es: ", en el kit de instalación)." },
  "Sua conta foi confirmada, mas houve um erro ao preparar seu ambiente. Tente entrar novamente em instantes.": {
    es: "Confirmamos tu cuenta, pero hubo un error al preparar tu entorno. Intenta entrar de nuevo en unos instantes.",
  },
  "Esqueci minha senha": { es: "Olvidé mi contraseña" },
  "Recuperar acesso": { es: "Recuperar acceso" },
  "Use um código de recuperação para reconfigurar sua autenticação em duas etapas.": {
    es: "Usa un código de recuperación para reconfigurar tu autenticación en dos pasos.",
  },
  "Voltar ao login": { es: "Volver al inicio de sesión" },
  "Definir nova senha": { es: "Definir nueva contraseña" },
  "Escolha uma nova senha para sua conta": { es: "Elige una nueva contraseña para tu cuenta" },
  "Crie sua senha para entrar na empresa que te convidou": {
    es: "Crea tu contraseña para entrar a la empresa que te invitó",
  },
  "Comece a usar o": { es: "Comienza a usar" },
  "em minutos": { es: "en minutos" },
  "Esse convite expirou ou não é mais válido. Peça um novo a quem te convidou — criar uma conta agora abriria uma empresa nova, e não é isso que você quer.": {
    es: "Esa invitación venció o ya no es válida. Pide una nueva a quien te invitó. Crear una cuenta ahora abriría una empresa nueva, y eso no es lo que quieres.",
  },
  // ── Revogação reversível (2026-09-10) ─────────────────────────────────────
  // ("Revogado" já existe mais acima — a chave é o texto, então repetir é erro
  //  de compilação, e é assim que o dicionário evita duas traduções da mesma
  //  frase divergirem.)
  "Devolver acesso": { es: "Devolver el acceso" },
  "Acesso devolvido.": { es: "Acceso devuelto." },
  // ("Seu nome" já existe mais acima — a chave é o próprio texto.)
  "Informe seu nome": { es: "Escribe tu nombre" },
  "Você já tem uma conta com este e-mail": {
    es: "Ya tienes una cuenta con este correo",
  },
  "Entre com ela para aceitar o convite — não é preciso criar outra.": {
    es: "Entra con ella para aceptar la invitación. No hace falta crear otra.",
  },
  "Entrar e aceitar o convite": { es: "Entrar y aceptar la invitación" },
  "Recebeu um convite novo? Abra o link que chegou no seu e-mail — ele funciona mesmo com esta tela aberta, e devolve o seu acesso.": {
    es: "¿Recibiste una invitación nueva? Abre el enlace que llegó a tu correo. Funciona incluso con esta pantalla abierta y te devuelve el acceso.",
  },
  // ── Cadastro apenas por convite (migration 0253) ──────────────────────────
  "Cadastro apenas por convite": { es: "Registro solo por invitación" },
  "Esta instalação não aceita cadastro aberto. Se você foi convidado, use o link que chegou no seu e-mail — ele já vem com o convite.": {
    es: "Esta instalación no permite el registro abierto. Si te invitaron, usa el enlace que llegó a tu correo. Ya incluye la invitación.",
  },
  "Esse convite expirou ou não é mais válido. Peça um novo a quem te convidou — esta instalação não aceita cadastro sem convite.": {
    es: "Esa invitación venció o ya no es válida. Pide una nueva a quien te invitó. Esta instalación no permite registrarse sin invitación.",
  },
  "Esta instalação aceita cadastro apenas por convite. Se você foi convidado, use o link que chegou no seu e-mail.": {
    es: "Esta instalación solo permite el registro por invitación. Si te invitaron, usa el enlace que llegó a tu correo.",
  },
  "Esta instalação aceita cadastro apenas por convite. Peça um convite a quem administra o sistema.": {
    es: "Esta instalación solo permite el registro por invitación. Pide una invitación a quien administra el sistema.",
  },
  "Sua conta foi confirmada, mas esta instalação aceita cadastro apenas por convite — então não criamos uma empresa para você. Peça um convite a quem administra o sistema; o link dele já traz tudo o que falta.": {
    es: "Confirmamos tu cuenta, pero esta instalación solo permite el registro por invitación, así que no creamos una empresa para ti. Pide una invitación a quien administra el sistema: el enlace de la invitación ya incluye todo lo que falta.",
  },
  "Cadastro": { es: "Registro" },
  "Quem pode criar conta": { es: "Quién puede crear una cuenta" },
  "Quem pode criar uma conta nesta instalação.": {
    es: "Quién puede crear una cuenta en esta instalación.",
  },
  "Vale para a instalação inteira, não para uma empresa só. Quem já tem conta continua entrando normalmente.": {
    es: "Se aplica a toda la instalación, no solo a una empresa. Quien ya tiene cuenta sigue entrando con normalidad.",
  },
  "Ligado: só entra quem recebeu um convite. Quem abrir a tela de cadastro sem convite vê um aviso e é levado ao login.": {
    es: "Activado: solo puede entrar quien recibió una invitación. Quien abra la pantalla de registro sin invitación verá un aviso y se le redirigirá al inicio de sesión.",
  },
  "Desligado: qualquer pessoa pode criar uma conta e abrir a própria empresa. É como o sistema sempre funcionou.": {
    es: "Desactivado: cualquier persona puede crear una cuenta y abrir su propia empresa. Así ha funcionado siempre el sistema.",
  },
  "Com isto ligado, a única porta de entrada é o convite — inclusive para você, se um dia precisar de uma conta nova. Convide pela tela de Equipe antes de precisar.": {
    es: "Con esto activado, la única puerta de entrada es la invitación, incluso para ti si algún día necesitas una cuenta nueva. Invita desde la pantalla de Equipo antes de que haga falta.",
  },
  "Não deu para salvar. Tente de novo em instantes.": {
    es: "No se pudo guardar. Inténtalo de nuevo en unos instantes.",
  },
  // ── Cadastro com aprovação (migration 0383, recorte do PR #714) ──────────
  "Pedido enviado": { es: "Solicitud enviada" },
  "Pedido não aprovado": { es: "Solicitud no aprobada" },
  "Seu pedido para abrir a empresa está com quem administra esta instalação. Quando ele for aprovado, é só entrar de novo.": {
    es: "Tu solicitud para abrir la empresa está en manos de quien administra esta instalación. Cuando la aprueben, solo tienes que volver a entrar.",
  },
  "Quem administra esta instalação não aprovou o pedido. Se você recebeu um convite, use o link que chegou no seu e-mail.": {
    es: "Quien administra esta instalación no aprobó la solicitud. Si recibiste una invitación, usa el enlace que llegó a tu correo.",
  },
  "Sua conta foi confirmada. Nesta instalação, a empresa só é criada depois da aprovação de quem administra. Confira o nome da empresa e envie o pedido.": {
    es: "Confirmamos tu cuenta. En esta instalación, la empresa solo se crea después de que quien administra la apruebe. Revisa el nombre de la empresa y envía la solicitud.",
  },
  "Enviar pedido": { es: "Enviar solicitud" },
  "Nesta instalação, a empresa só é criada depois da aprovação de quem administra.": {
    es: "En esta instalación, la empresa solo se crea después de que quien administra la apruebe.",
  },
  "Desligado: quem chega sem convite pode criar conta, e a empresa espera a sua aprovação.": {
    es: "Desactivado: quien llega sin invitación puede crear una cuenta, y la empresa espera tu aprobación.",
  },
  "Cadastro com aprovação": { es: "Registro con aprobación" },
  "Ligado: quem cria conta sem convite pede a empresa, e ela só é criada quando você aprova o pedido nesta tela.": {
    es: "Activado: quien crea una cuenta sin invitación solicita la empresa, y solo se crea cuando apruebas la solicitud en esta pantalla.",
  },
  "Desligado: quem cria conta abre a própria empresa na hora. Ligue se você hospeda várias empresas e quer decidir quem entra.": {
    es: "Desactivado: quien crea una cuenta abre su propia empresa al instante. Actívalo si alojas varias empresas y quieres decidir quién entra.",
  },
  "Este pedido já foi decidido.": { es: "Esta solicitud ya fue resuelta." },
  "A conta deste pedido não existe mais ou ainda não confirmou o e-mail.": {
    es: "La cuenta de esta solicitud ya no existe o todavía no confirmó el correo.",
  },
  "Pedidos aguardando aprovação": { es: "Solicitudes pendientes de aprobación" },
  "Aprovar cria a empresa e torna quem pediu administrador dela.": {
    es: "Aprobar crea la empresa y convierte en administrador a quien la solicitó.",
  },
  "Nenhum pedido aguardando.": { es: "No hay solicitudes pendientes." },
  "Recusar": { es: "Rechazar" },
  "Já tem conta?": { es: "¿Ya tienes cuenta?" },
  "Email ou senha incorretos.": { es: "Correo o contraseña incorrectos." },
  "Erro inesperado. Tente novamente.": { es: "Error inesperado. Intenta de nuevo." },
  "Entrando...": { es: "Entrando..." },
  "Configurando autenticação em duas etapas...": {
    es: "Configurando autenticación en dos pasos...",
  },
  "Não foi possível iniciar a configuração.": { es: "No se pudo iniciar la configuración." },
  "Falha ao confirmar. Tente novamente.": { es: "No se pudo confirmar. Intenta de nuevo." },
  "Configure a verificação em duas etapas": { es: "Configura la verificación en dos pasos" },
  "Esta empresa exige a verificação em duas etapas de quem administra. ": {
    es: "Esta empresa exige verificación en dos pasos a quienes administran. ",
  },
  "A cada login, além da senha, o sistema vai pedir um código de 6 dígitos. ": {
    es: "En cada inicio de sesión, además de la contraseña, el sistema pedirá un código de 6 dígitos. ",
  },
  "Use um aplicativo autenticador (Google Authenticator, 1Password, Authy, Bitwarden) para gerar os códigos.": {
    es: "Usa una aplicación autenticadora (Google Authenticator, 1Password, Authy, Bitwarden) para generar los códigos.",
  },
  "Iniciar configuração": { es: "Iniciar configuración" },
  "Escaneie o QR code": { es: "Escanea el código QR" },
  "Abra seu app autenticador, adicione uma nova conta e digite o código de 6 dígitos abaixo.": {
    es: "Abre tu app autenticadora, agrega una nueva cuenta y escribe el código de 6 dígitos abajo.",
  },
  "Gerando QR code...": { es: "Generando código QR..." },
  "QR code para configurar autenticador": { es: "Código QR para configurar el autenticador" },
  "Não consegue escanear? Digite o código manual": {
    es: "¿No puedes escanear? Escribe el código manualmente",
  },
  "Digite o código de 6 dígitos": { es: "Escribe el código de 6 dígitos" },
  "Muitas tentativas. Aguarde": { es: "Demasiados intentos. Espera" },
  "e tente novamente.": { es: "e intenta de nuevo." },
  "Muitas tentativas. Tente novamente em": { es: "Demasiados intentos. Intenta de nuevo en" },
  "Perdi acesso ao autenticador": { es: "Perdí el acceso al autenticador" },
  "Códigos copiados para a área de transferência.": {
    es: "Códigos copiados al portapapeles.",
  },
  "Não foi possível copiar. Selecione e copie manualmente.": {
    es: "No se pudo copiar. Selecciona y copia manualmente.",
  },
  "Arquivo baixado.": { es: "Archivo descargado." },
  "Salve esses 10 códigos em um local seguro. Cada um pode ser usado": {
    es: "Guarda estos 10 códigos en un lugar seguro. Cada uno puede usarse",
  },
  "para entrar caso você perca acesso ao autenticador.": {
    es: "para entrar si pierdes el acceso al autenticador.",
  },
  "Eles": { es: "Los códigos" },
  "não serão mostrados novamente": { es: "no se mostrarán de nuevo" },
  "Copiar todos": { es: "Copiar todos" },
  "Baixar .txt": { es: "Descargar .txt" },
  "Salvei meus códigos em local seguro.": { es: "Guardé mis códigos en un lugar seguro." },
  "Código inválido ou já utilizado.": { es: "Código inválido o ya utilizado." },
  "Serviço de recuperação indisponível. Contate o administrador.": {
    es: "Servicio de recuperación no disponible. Contacta al administrador.",
  },
  "Código de recuperação": { es: "Código de recuperación" },
  "Use um dos 10 códigos que você salvou ao configurar a verificação em duas etapas.": {
    es: "Usa uno de los 10 códigos que guardaste al configurar la verificación en dos pasos.",
  },
  "Validando…": { es: "Validando…" },
  "Sua conta tem verificação em duas etapas. Digite o código de 6 dígitos do seu app autenticador para concluir.": {
    es: "Tu cuenta tiene verificación en dos pasos. Escribe el código de 6 dígitos de tu app autenticadora para concluir.",
  },
  "Código de verificação inválido. Tente de novo.": {
    es: "Código de verificación inválido. Intenta de nuevo.",
  },
  "Sessão de redefinição expirada. Peça um novo link em Recuperar senha.": {
    es: "Sesión de restablecimiento vencida. Pide un nuevo enlace en Recuperar contraseña.",
  },
  "A nova senha precisa ser diferente da atual.": {
    es: "La nueva contraseña debe ser diferente de la actual.",
  },
  "Não foi possível redefinir a senha. Tente novamente.": {
    es: "No se pudo restablecer la contraseña. Intenta de nuevo.",
  },
  "Nova senha": { es: "Nueva contraseña" },
  "Confirmar nova senha": { es: "Confirmar nueva contraseña" },
  "Mostrar nova senha": { es: "Mostrar nueva contraseña" },
  "Ocultar nova senha": { es: "Ocultar nueva contraseña" },
  "Mostrar confirmação da senha": { es: "Mostrar confirmación de la contraseña" },
  "Ocultar confirmação da senha": { es: "Ocultar confirmación de la contraseña" },
  // Indicador de força (components/auth/ResetPasswordForm.tsx): rótulo e
  // requisitos vêm de listas, t(label) dinâmico, invisível ao scanner de t().
  "Força da senha": { es: "Seguridad de la contraseña" },
  "Muito fraca": { es: "Muy débil" },
  "Fraca": { es: "Débil" },
  "Razoável": { es: "Aceptable" },
  "Boa": { es: "Buena" },
  "Forte": { es: "Fuerte" },
  "8 ou mais caracteres": { es: "8 o más caracteres" },
  "Uma letra": { es: "Una letra" },
  "Um número": { es: "Un número" },
  "Um símbolo": { es: "Un símbolo" },
  "Código de verificação (2 etapas)": { es: "Código de verificación (2 pasos)" },
  "Não foi possível criar a conta. Tente novamente.": {
    es: "No se pudo crear la cuenta. Intenta de nuevo.",
  },
  "Confirme seu e-mail": { es: "Confirma tu correo" },
  "Enviamos um link de confirmação para": { es: "Enviamos un enlace de confirmación a" },
  "Abra o e-mail e clique no link para ativar sua conta.": {
    es: "Abre el correo y haz clic en el enlace para activar tu cuenta.",
  },
  "Nome da empresa": { es: "Nombre de la empresa" },
  "Criando conta...": { es: "Creando cuenta..." },
  "Código de 6 dígitos": { es: "Código de 6 dígitos" },
  "Dígito": { es: "Dígito" },
  "Email inválido. Confira o campo.": { es: "Correo inválido. Revisa el campo." },
  "Não foi possível enviar o e-mail. Tente novamente.": {
    es: "No se pudo enviar el correo. Intenta de nuevo.",
  },
  "Verifique seu e-mail": { es: "Revisa tu correo" },
  "Se existir uma conta com esse e-mail, enviamos um link para redefinir a senha.": {
    es: "Si existe una cuenta con ese correo, enviamos un enlace para restablecer la contraseña.",
  },
  "Enviar link de redefinição": { es: "Enviar enlace de restablecimiento" },

  // Mensagens de validação do Zod (lib/auth/schemas.ts) — acessadas via
  // `errors.campo.message` (não literal, invisível ao scanner de t()).
  "Email inválido": { es: "Correo inválido" },
  "Senha deve ter pelo menos 8 caracteres": { es: "La contraseña debe tener al menos 8 caracteres" },
  "Senha deve ter pelo menos uma letra": { es: "La contraseña debe tener al menos una letra" },
  "Senha deve ter pelo menos um número": { es: "La contraseña debe tener al menos un número" },
  "Senha deve ter pelo menos um símbolo": { es: "La contraseña debe tener al menos un símbolo" },
  "As senhas não coincidem": { es: "Las contraseñas no coinciden" },

  // ═══ Agenda, Desempenho, Radar e Respostas rápidas ═══
  //
  // Telas que nasceram DEPOIS do primeiro passe de tradução (PR #352) e por
  // isso apareciam inteiras em português para quem escolhia espanhol. Foram
  // achadas pela varredura de AST de `tests/unit/i18n-espanhol-cobre-a-tela`,
  // não por alguém abrir tela a tela — que é como as duas primeiras passaram.
  //
  // Terminologia herdada do passe anterior, de propósito: atendente→agente,
  // funil→embudo, agendamento→cita, negócio→negocio, demanda→demanda.
  "O que está marcado, com quem, e quem atende — seu e da equipe.": { es: "Qué citas hay, con quién y quién las atiende: las tuyas y las del equipo." },
  "Cadastre um tipo de agendamento para começar": { es: "Registra un tipo de cita para empezar" },
  "Período anterior": { es: "Período anterior" },
  "Próximo período": { es: "Período siguiente" },
  "Tipo de agendamento": { es: "Tipo de cita" },
  "Por que está cancelando?": { es: "¿Por qué estás cancelando?" },
  "O paciente pediu para remarcar por telefone": { es: "El paciente pidió reprogramar por teléfono" },
  "Sincronizar com o Google ainda não está disponível": { es: "Sincronizar con Google todavía no está disponible" },
  "Esta instalação não tem as credenciais do Google cadastradas — não é nada que você tenha feito. Quem instalou o sistema precisa configurar": { es: "Esta instalación no tiene registradas las credenciales de Google, y no se debe a nada que hayas hecho. Quien instaló el sistema necesita configurar" },
  "E, no console do Google, registrar este endereço de retorno —": { es: "Y, en la consola de Google, registrar esta URL de redirección —" },
  "exatamente assim": { es: "exactamente así" },
  "Até lá a agenda funciona normalmente, só não troca compromissos com o Google.": { es: "Mientras tanto, la agenda funciona con normalidad, pero no intercambia citas con Google." },
  "Conecte sua agenda do Google para ver aqui o que já está marcado lá — e enviar para lá o que for marcado aqui.": { es: "Conecta tu Google Calendar para ver aquí las citas que ya tienes en Google y enviarle las que se programen aquí." },
  "Filtrar o histórico": { es: "Filtrar el historial" },
  "Nada marcado daqui para a frente.": { es: "No hay nada programado de aquí en adelante." },
  "Ninguém esperando confirmação.": { es: "Nadie esperando confirmación." },
  "Ainda não há atendimentos concluídos.": { es: "Todavía no hay atenciones concluidas." },
  "Nenhum cancelamento.": { es: "Ninguna cancelación." },
  "Marcado.": { es: "Cita programada." },
  "min · com": { es: "min · con" },
  "Sem lembrete automático —": { es: "Sin recordatorio automático —" },
  "pediu para não receber mensagens.": { es: "pidió no recibir mensajes." },
  "Horários no fuso": { es: "Horarios en la zona horaria" },
  "Mês anterior": { es: "Mes anterior" },
  "Próximo mês": { es: "Mes siguiente" },
  "Você ainda não publicou seus horários de atendimento": { es: "Todavía no publicaste tus horarios de atención" },
  "Sem eles ninguém consegue marcar — nem você, nem o agente. Configure a sua disponibilidade e os horários aparecem aqui.": { es: "Sin ellos nadie puede agendar una cita, ni tú ni el agente. Configura tu disponibilidad y los horarios aparecerán aquí." },
  "Estamos supondo o fuso": { es: "Estamos suponiendo la zona horaria" },
  "— ninguém escolheu ainda. O agente oferece horário usando ele.": { es: "— nadie ha elegido una todavía. El agente ofrece horarios con esa zona horaria." },
  "O lembrete não será enviado — combine por telefone.": { es: "El recordatorio no se enviará. Coordina por teléfono." },
  "Não consegui carregar a agenda": { es: "No pude cargar la agenda" },
  "Onde acontece": { es: "Dónde se realiza" },
  "Quem atende (sem isto, não há horário para oferecer)": { es: "Quién atiende (sin esto, no hay horarios para ofrecer)" },
  "Definir depois": { es: "Definir después" },
  "Nenhum tipo de agendamento ainda. Crie o primeiro para que a Agenda tenha o que oferecer.": { es: "Todavía no hay tipos de cita. Crea el primero para que la Agenda tenga qué ofrecer." },
  "sem responsável — não aparece para marcar": { es: "sin responsable — no aparece al agendar una cita" },
  "Duração": { es: "Duración" },
  "Quem atende": { es: "Quién atiende" },
  "O que se pode marcar, quanto dura e quem atende. É isto que a tela de marcar e o agente de IA oferecem ao cliente.": { es: "Qué citas se pueden agendar, cuánto duran y quién las atiende. Es lo que la pantalla de agenda y el agente de IA ofrecen al cliente." },
  "Avisar o cliente antes do compromisso, pelo WhatsApp": { es: "Avisar al cliente antes de la cita, por WhatsApp" },
  "Lançamentos do período": { es: "Movimientos del período" },
  "Data": { es: "Fecha" },
  "Já pago": { es: "Ya pagado" },
  "Lançar": { es: "Registrar" },
  "Nenhum lançamento no período.": { es: "No hay movimientos en el período." },
  "de comanda": { es: "de orden de servicio" },
  "pago": { es: "pagado" },
  "Pagar": { es: "Pagar" },
  "Remover lançamento": { es: "Quitar movimiento" },
  "Comissão": { es: "Comisión" },
  "Quanto cada pessoa recebe por atendimento. Sem regra, a comissão é zero.": {
    es: "Cuánto recibe cada persona por atención. Sin regla, la comisión es cero.",
  },
  "A regra mais específica vence: pessoa e serviço vence pessoa, que vence serviço. Não é o maior percentual que ganha.": {
    es: "Gana la regla más específica: persona y servicio antes que persona, y persona antes que servicio. No gana el porcentaje más alto.",
  },
  "Pessoa": { es: "Persona" },
  "Qualquer pessoa": { es: "Cualquier persona" },
  "Qualquer serviço": { es: "Cualquier servicio" },
  "Percentual": { es: "Porcentaje" },
  "Adicionar regra": { es: "Agregar regla" },
  "Escolha ao menos uma pessoa ou um serviço.": {
    es: "Elige al menos una persona o un servicio.",
  },
  "Nenhuma regra de comissão. Todo item entra com zero.": {
    es: "No hay reglas de comisión. Todo ítem entra con cero.",
  },
  "Remover regra": { es: "Quitar regla" },
  "alguém": { es: "alguien" },
  "um serviço": { es: "un servicio" },
  "Pontos de fidelidade": { es: "Puntos de fidelidad" },
  "ponto(s)": { es: "punto(s)" },
  "Serviços que mais faturaram": { es: "Servicios que más ingresos generaron" },
  "Nenhum item no período.": { es: "No hay ítems en el período." },
  "Clientes que mais gastaram": { es: "Clientes que más gastaron" },
  "Nenhum cliente no período.": { es: "No hay clientes en el período." },
  "Todo mês": { es: "Todos los meses" },
  "Aluguel, internet, contador. O sistema abre a conta no dia certo.": {
    es: "Alquiler, internet, contador. El sistema crea la cuenta el día que corresponde.",
  },
  "Nasce como conta a pagar, nunca como paga: o sistema sabe que vence, não sabe se você pagou.": {
    es: "Se crea como cuenta por pagar, nunca como pagada: el sistema sabe cuándo vence, pero no si ya pagaste.",
  },
  "Nome do lançamento": { es: "Nombre del movimiento" },
  "Ex.: Aluguel": { es: "Ej.: Alquiler" },
  "Escolha a conta": { es: "Elige la cuenta" },
  "Dia do mês": { es: "Día del mes" },
  "Nos meses mais curtos, cai no último dia do mês.": {
    es: "En los meses más cortos, cae en el último día del mes.",
  },
  "Nenhum lançamento recorrente.": { es: "No hay movimientos recurrentes." },
  "Remover lançamento recorrente": { es: "Quitar movimiento recurrente" },
  "Preço padrão": { es: "Precio estándar" },
  "digite na hora": { es: "escribe en el momento" },
  "Opcional. Vira o valor sugerido na comanda, e pode ser mudado lá.": {
    es: "Opcional. Aparece como valor sugerido en la orden de servicio, donde puedes cambiarlo.",
  },
  "Atendimentos sem comanda": { es: "Atenciones sin orden de servicio" },
  "Já aconteceram e ninguém faturou. Marque o que quer cobrar.": {
    es: "Ya se realizaron y nadie las ha cerrado. Marca las que quieras cobrar.",
  },
  "sem preço no serviço": { es: "sin precio en el servicio" },
  "Faturar": { es: "Cerrar y cobrar" },
  "Faturamento": { es: "Facturación" },
  "Quanto entrou, de que forma, e quanto cada pessoa tem a receber.": {
    es: "Cuánto entró, de qué forma y cuánto le corresponde a cada persona.",
  },
  "Não foi possível carregar o período.": { es: "No se pudo cargar el período." },
  "Entrou": { es: "Entró" },
  "Saiu": { es: "Salió" },
  "Saldo": { es: "Saldo" },
  "Ticket médio": { es: "Ticket promedio" },
  "comanda(s) finalizada(s)": { es: "orden(es) de servicio finalizada(s)" },
  "estornada(s)": { es: "anulada(s)" },
  "faturado": { es: "facturado" },
  "O faturado soma comandas; o que entrou soma lançamentos pagos. Os dois não precisam bater.": {
    es: "Lo facturado suma órdenes de servicio y lo que entró suma movimientos pagados. Las dos cifras no tienen por qué coincidir.",
  },
  "Por forma de pagamento": { es: "Por forma de pago" },
  "Nenhuma comanda no período.": { es: "Ninguna orden de servicio en el período." },
  "Comissão por pessoa": { es: "Comisión por persona" },
  "Nenhuma comissão no período.": { es: "Ninguna comisión en el período." },
  "Comandas": { es: "Órdenes de servicio" },
  "Comanda": { es: "Orden de servicio" },
  "Finalizada": { es: "Finalizada" },
  "Regra de comissão": { es: "Regla de comisión" },
  "Lançamento recorrente": { es: "Movimiento recurrente" },
  "O que foi feito, por quem, e quanto o cliente paga.": {
    es: "Qué se hizo, quién lo hizo y cuánto paga el cliente.",
  },
  "Nova comanda": { es: "Nueva orden de servicio" },
  "Nenhuma comanda ainda.": { es: "Todavía no hay órdenes de servicio." },
  "Escolha uma comanda à esquerda.": { es: "Elige una orden de servicio a la izquierda." },
  "estornada": { es: "anulada" },
  "comissão": { es: "comisión" },
  "Remover item": { es: "Quitar ítem" },
  "Total": { es: "Total" },
  "Serviço": { es: "Servicio" },
  "Avulso": { es: "Suelto" },
  "Incluir": { es: "Agregar" },
  "Forma de pagamento": { es: "Forma de pago" },
  "Escolha": { es: "Elige" },
  "Finalizar": { es: "Finalizar" },
  "Cancelar comanda": { es: "Cancelar orden de servicio" },
  "Esta forma de pagamento ainda não tem conta de destino. Defina em Configurações › Financeiro.": {
    es: "Esta forma de pago todavía no tiene cuenta de destino. Defínela en Configuración › Finanzas.",
  },
  "Motivo do estorno": { es: "Motivo de la anulación" },
  "Estornar": { es: "Anular" },
  "Quantos minutos antes": { es: "Cuántos minutos antes" },
  "E de novo, quantos minutos antes": { es: "Y de nuevo, cuántos minutos antes" },
  "Opcional. Até 3, separados por vírgula. Ex.: 180 avisa de novo 3 horas antes.": {
    es: "Opcional. Hasta 3, separados por coma. Ej.: 180 avisa de nuevo 3 horas antes.",
  },
  "avisa o cliente": { es: "avisa al cliente" },
  "antes": { es: "antes" },
  "Mensagem do lembrete": { es: "Mensaje del recordatorio" },
  "Oi {{nome}}! Passando pra lembrar: {{titulo}}, {{dia}} às {{hora}}.": {
    es: "¡Hola {{nome}}! Te recuerdo: {{titulo}}, {{dia}} a las {{hora}}.",
  },
  "Deixe em branco para o texto padrão. Variáveis: {{nome}}, {{titulo}}, {{dia}}, {{hora}}, {{endereco}}.": {
    es: "Déjalo en blanco para el texto predeterminado. Variables: {{nome}}, {{titulo}}, {{dia}}, {{hora}}, {{endereco}}.",
  },
  "Quanto antes": { es: "Cuánto antes" },
  "Unidade": { es: "Unidad" },
  "minutos": { es: "minutos" },
  "Mensagem deste lembrete": { es: "Mensaje de este recordatorio" },
  "Adicionar lembrete": { es: "Agregar recordatorio" },
  "Deixe a mensagem em branco para o texto padrão. Variáveis: {{nome}}, {{titulo}}, {{dia}}, {{hora}}, {{endereco}}.": {
    es: "Deja el mensaje en blanco para el texto predeterminado. Variables: {{nome}}, {{titulo}}, {{dia}}, {{hora}}, {{endereco}}.",
  },
  "texto próprio": { es: "texto propio" },
  "A mensagem do lembrete cabe em 1000 caracteres.": {
    es: "El mensaje del recordatorio puede tener hasta 1000 caracteres.",
  },
  "No máximo 20 lembretes adicionais por tipo.": {
    es: "Como máximo 20 recordatorios adicionales por tipo.",
  },
  "O lembrete precisa sair pelo menos 15 minutos antes do compromisso.": { es: "El recordatorio debe salir al menos 15 minutos antes de la cita." },
  "O lembrete não pode sair mais de 7 dias (10080 minutos) antes.": { es: "El recordatorio no puede salir con más de 7 días (10080 minutos) de anticipación." },
  "Ação contém": { es: "La acción contiene" },
  "Ator": { es: "Actor" },
  "Nenhum log no período.": { es: "Ningún registro en el período." },
  "Histórico append-only de mutações na organização. Manager+.": { es: "Historial append-only de cambios en la organización. Manager+." },
  "O que isso custou": { es: "Lo que esto costó" },
  "Uma conversa conta como perdida no silêncio após": { es: "Una conversación cuenta como perdida por silencio tras" },
  "sem resposta": { es: "sin respuesta" },
  "(padrão do sistema)": { es: "(predeterminado del sistema)" },
  "Contar como perdida no silêncio após": { es: "Contar como perdida por silencio tras" },
  "Horas de silêncio até considerar a conversa perdida": { es: "Horas de silencio hasta considerar la conversación perdida" },
  "horas sem resposta.": { es: "horas sin respuesta." },
  "Use um número inteiro entre 1 e 2160.": { es: "Usa un número entero entre 1 y 2160." },
  "Não foi possível salvar. Tente de novo.": { es: "No se pudo guardar. Inténtalo de nuevo." },
  "Carregando o índice de atrito…": { es: "Cargando el índice de fricción…" },
  "Erro ao carregar o índice de atrito.": { es: "Error al cargar el índice de fricción." },
  "Atrito": { es: "Fricción" },
  "O que o resultado custou para os dois lados.": { es: "Lo que costó el resultado a ambas partes." },
  "Nenhuma demanda encerrada no período — os números abaixo ainda não têm base.": { es: "Ningún caso cerrado en el período. Las cifras de abajo todavía no tienen base." },
  "Base:": { es: "Base:" },
  "demanda encerrada": { es: "caso cerrado" },
  "demandas encerradas": { es: "casos cerrados" },
  "nos últimos 30 dias, e": { es: "en los últimos 30 días, y" },
  "ainda abertas.": { es: "todavía abiertas." },
  "\"—\" significa que não houve dado suficiente para medir, e não que o valor seja zero.": { es: "\"—\" significa que no hubo datos suficientes para medir, no que el valor sea cero." },
  "Erro ao carregar métricas.": { es: "Error al cargar las métricas." },
  "Todos os atendentes": { es: "Todos los asesores" },
  "(você)": { es: "(tú)" },
  "Nenhuma etapa configurada.": { es: "Ninguna etapa configurada." },
  "Performance por atendente": { es: "Rendimiento por asesor" },
  "Sua performance": { es: "Tu rendimiento" },
  "Sem atividade no período (ganhos/perdidos, conversas ou respostas).": { es: "Sin actividad en el período (ganados/perdidos, conversaciones o respuestas)." },
  "1ª resposta (média)": { es: "1ª respuesta (promedio)" },
  "Atrito, funil e performance por atendente nos últimos 30 dias.": { es: "Fricción, embudo y rendimiento por asesor en los últimos 30 días." },
  "Atrito, seu funil e sua performance nos últimos 30 dias.": { es: "Fricción, tu embudo y tu rendimiento en los últimos 30 días." },
  "Nenhuma demanda em risco": { es: "Ningún caso en riesgo" },
  "Toda demanda aberta teve atividade recente ou já tem um retorno agendado.": { es: "Todos los casos abiertos tuvieron actividad reciente o ya tienen un seguimiento programado." },
  "demanda aberta sem próximo passo": { es: "caso abierto sin siguiente paso" },
  "demandas abertas sem próximo passo": { es: "casos abiertos sin siguiente paso" },
  "Ninguém marcou o que acontece a seguir. Cada uma é alguém esperando sem que nada esteja combinado.": { es: "Nadie definió qué sigue. Cada caso es alguien esperando sin que haya nada acordado." },
  "aberta há": { es: "abierto hace" },
  "crítico": { es: "crítico" },
  "em risco": { es: "en riesgo" },
  "em voo": { es: "en seguimiento" },
  "Radar de risco": { es: "Radar de riesgo" },
  "Demandas abertas que esfriaram e precisam de você. Se o assistente já agendou um retorno, aparece como “em voo”; sem próximo passo, é risco de perder o cliente.": { es: "Casos abiertos que se enfriaron y necesitan tu atención. Si el asistente ya programó un seguimiento, aparecen como “En seguimiento”. Los que no tienen un siguiente paso corren el riesgo de perder al cliente." },
  "Scripts salvos para responder mais rápido no atendimento.": { es: "Plantillas guardadas para responder más rápido durante la atención." },
  "Saudação inicial": { es: "Saludo inicial" },
  "Use": { es: "Usa" },
  "para personalizar.": { es: "para personalizar." },
  "Atalho (opcional)": { es: "Atajo (opcional)" },
  "Compartilhar com a equipe": { es: "Compartir con el equipo" },
  "Nenhum template ainda.": { es: "Todavía no hay plantillas." },
  "Pessoal": { es: "Personal" },
  "Compartilhado": { es: "Compartido" },
  "Excluir este template?": { es: "¿Eliminar esta plantilla?" },
  "Essa ação não pode ser desfeita.": { es: "Esta acción no se puede deshacer." },
  "Scripts salvos para responder mais rápido; pessoais ou compartilhados com a equipe.": { es: "Plantillas guardadas para responder más rápido, personales o compartidas con el equipo." },
  "está desconectado": { es: "está desconectado" },
  "conexões": { es: "conexiones" },
  "de WhatsApp estão desconectadas": { es: "de WhatsApp están desconectadas" },
  "nenhuma mensagem entra nem sai.": { es: "ningún mensaje entra ni sale." },
  "Escanear o QR": { es: "Escanear el QR" },
  "Ver conexões": { es: "Ver conexiones" },
  "Tente novamente em instantes. Se persistir, contate o suporte com o ID abaixo.": { es: "Inténtalo de nuevo en unos momentos. Si el problema continúa, contacta a soporte con el ID de abajo." },
  "Nada encontrado para": { es: "No se encontró nada para" },
  "Seguir o idioma da empresa": { es: "Seguir el idioma de la empresa" },
  "Não foi possível trocar o idioma. Tente de novo.": {
    es: "No se pudo cambiar el idioma. Inténtalo de nuevo.",
  },
  "[{ \"key\": \"size\", \"label\": \"Tamanho\", \"type\": \"text\" }]": { es: "[{ \"key\": \"size\", \"label\": \"Tamaño\", \"type\": \"text\" }]" },

  // ─── Índice de Atrito: os rótulos nascem em lib/metrics/atrito.ts ───
  //
  // Aquele arquivo é lógica pura e não conhece idioma; quem traduz é o ponto
  // de renderização (`AtritoPanel`). Eles chegavam à tela em português com a
  // interface em espanhol — achado pela spec e2e, não pelo guarda estático:
  // `{par.titulo}` é uma expressão, e o guarda só enxerga literal.
  "Atrito máximo: a pessoa pediu para sair.": { es: "Fricción máxima: la persona pidió darse de baja." },
  "Confiança perdida na automação.": { es: "Confianza perdida en la automatización." },
  "Contenção": { es: "Contención" },
  "Conversão": { es: "Conversión" },
  "Custo humano": { es: "Costo humano" },
  "Demandas abertas sem próximo passo": { es: "Casos abiertos sin siguiente paso" },
  "Demandas encerradas": { es: "Casos cerrados" },
  "Demandas que precisaram subir de nível": { es: "Casos que tuvieron que escalarse" },
  "Descadastros no período": { es: "Bajas en el período" },
  "Espera na fila humana (mediana)": { es: "Espera en la cola humana (mediana)" },
  "Espera na fila humana (p90)": { es: "Espera en la cola humana (p90)" },
  "Insistência do agente (média de retornos)": { es: "Insistencia del agente (promedio de seguimientos)" },
  "Insistência no pior caso": { es: "Insistencia en el peor caso" },
  "Intervenções humanas por demanda": { es: "Intervenciones humanas por caso" },
  "Mensagens enviadas por automação": { es: "Mensajes enviados por automatización" },
  "Mensagens enviadas por integração": { es: "Mensajes enviados por integración" },
  "Envios feitos por um sistema de fora com token de servidor. Como a automação, não entram no número do agente — e é por isso que ele cai onde há integração.": { es: "Envíos que hace un sistema externo con un token de servidor. Igual que los de la automatización, no cuentan en la cifra del agente, y por eso esa cifra baja donde hay integraciones." },
  "Mensagens enviadas pelo agente": { es: "Mensajes enviados por el agente" },
  "Negócios ganhos": { es: "Negocios ganados" },
  "O cliente que mais recebeu retornos. A média esconde o exagero pontual.": { es: "El cliente que más seguimientos recibió. El promedio oculta los excesos aislados." },
  "O time respondeu pelo celular, contornando a ferramenta.": { es: "El equipo respondió desde el celular, sin pasar por la herramienta." },
  "Passagens para humano": { es: "Transferencias a humano" },
  "Perguntas que a pessoa teve de repetir": { es: "Preguntas que la persona tuvo que repetir" },
  "Quanto o sistema precisou ser contido de si mesmo antes de falar.": { es: "Cuánto tuvo que contenerse el sistema antes de hablar." },
  "Regra de automação, texto fixo do follow-up e lembrete de agenda: saiu sozinho e ninguém escreveu. Não entra no número do agente — é por isso que ele cai onde há automação.": { es: "Regla de automatización, texto fijo de seguimiento o recordatorio de agenda: se envió solo y nadie lo escribió. No cuenta en la cifra del agente, y por eso baja donde hay automatización." },
  "Respostas dadas pelo agente": { es: "Respuestas dadas por el agente" },
  "Respostas humanas fora do sistema": { es: "Respuestas humanas fuera del sistema" },
  "Turnos até o desfecho (mediana)": { es: "Turnos hasta el desenlace (mediana)" },
  "Vetos por execução": { es: "Vetos por ejecución" },
  "do atendente": { es: "del asesor" },
  "aberto": { es: "abierto" },
  "abertos": { es: "abiertos" },

  // ─── O que a main de 1.8.0 trouxe: acervo de conhecimento, push, agenda ───
  //
  // Telas que nasceram nos 88 commits entre a 1.7.0 e a 1.8.0, achadas pelo
  // guarda depois do merge. Nenhuma foi conferida a olho: a lista veio da
  // varredura de AST, e é ela que diz quando acabou.
  "Google Agenda desta instalação": { es: "Google Calendar de esta instalación" },
  "Com estas duas informações, quem atende consegue conectar a agenda pessoal do Google e ver os compromissos do CRM lá. Elas valem para a instalação inteira — cada pessoa conecta a conta dela depois, sozinha.": { es: "Con estos dos datos, quien atiende puede conectar su agenda personal de Google y ver ahí las citas del CRM. Aplican a toda la instalación. Después, cada persona conecta su propia cuenta." },
  "Endereço de retorno": { es: "URL de redirección" },
  "Já existe uma chave cadastrada. Deixe em branco para mantê-la, ou digite uma nova para substituir.": { es: "Ya hay una clave registrada. Déjalo en blanco para mantenerla, o escribe una nueva para reemplazarla." },
  "Ela é guardada cifrada e nunca volta a aparecer nesta tela.": { es: "Se guarda cifrada y nunca vuelve a aparecer en esta pantalla." },
  "Esta instalação já tem as credenciais no arquivo de configuração do servidor. O que você salvar aqui passa a valer no lugar delas; apagar o que está aqui faz o sistema voltar a usar as do arquivo.": { es: "Esta instalación ya tiene credenciales en el archivo de configuración del servidor. Lo que guardes aquí las reemplaza. Si borras lo que hay aquí, el sistema vuelve a usar las del archivo." },
  "Ao trocar uma credencial já em uso:": { es: "Al cambiar una credencial ya en uso:" },
  "quem já conectou a agenda vai precisar conectar de novo. O Google invalida as autorizações antigas quando o aplicativo muda — não há como evitar, e ninguém perde compromisso por isso.": { es: "quien ya conectó su agenda tendrá que conectarla de nuevo. Google invalida las autorizaciones anteriores cuando cambia la aplicación. No hay forma de evitarlo, pero nadie pierde citas por eso." },
  "Nunca configurado por aqui.": { es: "Todavía no se ha configurado aquí." },
  "Credenciais do Google salvas.": { es: "Credenciales de Google guardadas." },
  "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o segredo não foi gravado": {
    es: "cifrado no disponible en esta instalación (falta el GUC app.nuvemshop_oauth_key): no se guardó el secreto",
  },
  "Falta cadastrar o aplicativo do Google desta instalação. Leva um minuto e você faz por aqui mesmo.": { es: "Falta registrar la aplicación de Google de esta instalación. Toma un minuto y lo haces aquí mismo." },

  // ─── O App da Meta da instalação (/admin/meta, migration 0257) ───
  "API Oficial da Meta desta instalação": { es: "API Oficial de Meta de esta instalación" },
  "É com estas duas informações que o sistema confere que cada mensagem recebida pelo número oficial veio mesmo da Meta. Elas valem para a instalação inteira — cada empresa conecta o próprio número depois, em Conexões.": { es: "Con estos dos datos, el sistema comprueba que cada mensaje que llega al número oficial viene realmente de Meta. Se aplican a toda la instalación. Cada empresa conecta después su propio número, en Conexiones." },
  "Não deu para ler a configuração salva agora, então o que aparece abaixo pode não ser o que está valendo. Recarregue a página antes de trocar qualquer coisa.": { es: "En este momento no se pudo leer la configuración guardada, así que lo que aparece abajo puede no ser la que está vigente. Recarga la página antes de cambiar cualquier cosa." },
  "Chave secreta do aplicativo": { es: "Clave secreta de la aplicación" },
  "••••••••  (já cadastrada)": { es: "••••••••  (ya registrada)" },
  "32 letras e números": { es: "32 letras y números" },
  "Fica no painel da Meta, em Configurações do app › Básico. Ela é guardada cifrada e nunca volta a aparecer nesta tela.": { es: "Está en el panel de Meta, en Configuración de la app › Básica. Se guarda cifrada y nunca vuelve a aparecer en esta pantalla." },
  "Esta instalação já tem a chave e o token no arquivo de configuração do servidor. O que você salvar aqui passa a valer no lugar deles — e, a partir daí, é o token desta tela que precisa estar colado no painel da Meta.": { es: "Esta instalación ya tiene la clave y el token en el archivo de configuración del servidor. Lo que guardes aquí los reemplaza, y desde ese momento el token de esta pantalla es el que debe estar pegado en el panel de Meta." },
  "Última alteração em": { es: "Último cambio el" },
  "Já existe um token gerado.": { es: "Ya hay un token generado." },
  "Ainda não existe. Ele é criado pelo sistema na primeira vez que você salva a chave secreta — ninguém precisa inventar nada.": { es: "Todavía no existe. El sistema lo crea la primera vez que guardas la clave secreta, así que no tienes que inventar nada." },
  "Seu token de verificação": { es: "Tu token de verificación" },
  "Copie agora.": { es: "Cópialo ahora." },
  "Por segurança, ele não aparece de novo depois que você sair desta página. Se perder, é só gerar outro aqui.": { es: "Por seguridad, no vuelve a aparecer después de que salgas de esta página. Si lo pierdes, basta con generar otro aquí." },
  "No painel da Meta, em WhatsApp › Configuração › Webhook, este token vai no campo “Verificar token”. O outro campo, “URL de callback”, é de cada número: ele aparece em Conexões › API Oficial (Meta), depois que o número é conectado. Abra Conexões em outra aba, para não perder o token desta página.": { es: "En el panel de Meta, en WhatsApp › Configuración › Webhook, este token va en el campo “Verificar token”. El otro campo, “URL de devolución de llamada”, es de cada número: aparece en Conexiones › API Oficial (Meta), después de conectar el número. Abre Conexiones en otra pestaña, para no perder el token de esta página." },
  "Abrir Conexões em outra aba": { es: "Abrir Conexiones en otra pestaña" },
  "Abrir API Oficial (Meta) na administração": { es: "Abrir API Oficial (Meta) en la administración" },
  "Gerar token": { es: "Generar token" },
  "Gerar novo token": { es: "Generar nuevo token" },
  "Gerar um novo token de verificação?": { es: "¿Generar un nuevo token de verificación?" },
  "O token atual deixa de valer na hora. As mensagens que já chegam continuam chegando, porque elas são conferidas pela chave secreta. O que muda: a Meta só consegue confirmar o endereço do webhook de novo depois que você colar o token novo no painel dela.": { es: "El token actual deja de funcionar de inmediato. Los mensajes seguirán llegando con normalidad, porque se validan con la clave secreta. Lo que cambia es que Meta solo podrá volver a confirmar la dirección del webhook cuando pegues el token nuevo en su panel." },
  "A chave parece incompleta. Copie de novo do painel da Meta — ela tem 32 caracteres.": { es: "La clave parece incompleta. Cópiala de nuevo desde el panel de Meta: tiene 32 caracteres." },
  "Cadastre a chave secreta do aplicativo primeiro. Sem ela o token não vale.": { es: "Registra primero la clave secreta de la aplicación. Sin ella, el token no es válido." },
  "Nada mudou. Digite uma chave nova para substituir a atual.": { es: "Nada cambió. Escribe una clave nueva para reemplazar la actual." },
  "Não consegui conferir o que já está gravado, então nada foi alterado. Tente de novo em instantes.": { es: "No pude comprobar lo que ya está guardado, así que no se cambió nada. Inténtalo de nuevo en unos instantes." },
  "Não deu para salvar, e nada foi gravado.": { es: "No se pudo guardar. No se modificó nada." },
  "Chave secreta salva.": { es: "Clave secreta guardada." },
  "Token de verificação gerado.": { es: "Token de verificación generado." },
  "Não deu para copiar. Selecione o texto e copie à mão.": { es: "No se pudo copiar. Selecciona el texto y cópialo a mano." },
  "Já cadastrado na administração da instalação. Ele aparece uma vez só, quando é gerado — se não foi guardado, quem administra a instalação gera outro em Admin › API Oficial (Meta).": { es: "Ya está registrado en la administración de la instalación. Se muestra una sola vez, cuando se genera. Si no se guardó, quien administra la instalación puede generar otro en Admin › API Oficial (Meta)." },
  "Ainda não configurado. Quem administra a instalação cadastra em Admin › API Oficial (Meta), e o token aparece lá pronto para copiar.": { es: "Todavía no está configurado. Quien administra la instalación lo registra en Admin › API Oficial (Meta) y ahí aparece el token, listo para copiar." },
  "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o verify token não foi gravado": { es: "el cifrado no está disponible en esta instalación (falta el GUC app.nuvemshop_oauth_key); no se guardó el verify token" },
  "O que ele consulta antes de responder": { es: "Qué consulta antes de responder" },
  "Marque o material do seu negócio que este assistente pode ler. Ele procura ali antes de responder, em vez de improvisar — e cita de onde tirou.": { es: "Marca el material de tu negocio que este asistente puede leer. Lo busca ahí antes de responder, en vez de improvisar, y cita de dónde sacó la información." },
  "Você ainda não cadastrou nenhum material.": { es: "Todavía no registraste ningún material." },
  "Comece pelo que ele mais vai precisar": { es: "Empieza por lo que más va a necesitar" },
  "— as perguntas que se repetem, e a política que você mais explica.": { es: "— las preguntas que se repiten y la política que más explicas." },
  "ainda não preparado": { es: "todavía sin preparar" },
  "Sem nenhum material marcado, ele conversa normalmente — mas responde só com o que o modelo já sabe, e a ferramenta de busca nem entra na conversa dele.": { es: "Si no marcas ningún material, conversa con normalidad, pero responde solo con lo que el modelo ya sabe y ni siquiera tiene disponible la herramienta de búsqueda." },
  "Você tem": { es: "Tienes" },
  "material": { es: "material" },
  "materiais": { es: "materiales" },
  "no acervo e este assistente não lê nenhum. Ele vai responder de improviso sobre assuntos que já estão escritos.": { es: "en el acervo y este asistente no lee ninguno. Va a responder de improviso sobre temas que ya están escritos." },
  "O fluxo começa quando uma regra em Webhooks usa a ação «Iniciar fluxo de mensagem» apontando para este fluxo publicado.": { es: "El flujo empieza cuando una regla de Webhooks usa la acción «Iniciar flujo de mensaje» con este flujo publicado como destino." },
  "Sai exatamente assim, sem IA. No laço,": { es: "Se envía exactamente así, sin IA. En el ciclo," },
  "{{volta}}": { es: "{{volta}}" },
  "{{voltas}}": { es: "{{voltas}}" },
  "viram o número da volta.": { es: "se convierten en el número de la vuelta." },
  "Contém": { es: "Contiene" },
  "É igual a": { es: "Es igual a" },
  "Não gravar": { es: "No guardar" },
  "Regras de texto": { es: "Reglas de texto" },
  "Gravar a resposta em": { es: "Guardar la respuesta en" },
  "Nome do contato": { es: "Nombre del contacto" },
  "Chave do campo personalizado": { es: "Clave del campo personalizado" },
  "Texto enviado ao contato": { es: "Texto enviado al contacto" },
  "Chave secreta do cliente": { es: "Clave secreta del cliente" },
  "Chave livre (use": { es: "Clave libre (usa" },
  "no laço)": { es: "en el ciclo)" },
  "Crie os campos em Configurações → Funis. A resposta só grava quando o contato responde (não no timeout).": { es: "Crea los campos en Configuración → Embudos. La respuesta solo se guarda cuando el contacto responde, no cuando se agota el tiempo de espera." },
  "No máximo quantas voltas": { es: "Máximo de vueltas" },
  "A última resposta vira o número de voltas (ex.: 4 filhos). O teto evita um loop sem fim.": { es: "La última respuesta define el número de vueltas (ej.: 4 hijos). El tope evita un ciclo sin fin." },
  "(adaptativo)": { es: "(adaptativo)" },
  "classe · espera": { es: "clase · espera" },
  "classes · espera": { es: "clases · espera" },
  "regra · espera": { es: "regla · espera" },
  "regras · espera": { es: "reglas · espera" },
  volta: { es: "vuelta" },
  "grava resposta": { es: "guarda la respuesta" },
  "pula se já existir": { es: "se omite si ya existe" },
  "confirma se já existir": { es: "confirma si ya existe" },
  "até": { es: "hasta" },
  "voltas": { es: "vueltas" },
  "Inscrições e versões deste fluxo são apagadas junto. Não é possível desfazer.": { es: "Las inscripciones y versiones de este flujo también se borran. No se puede deshacer." },
  "Follow-ups reengajam contatos após silêncio, mudança de etapa, uma regra em Webhooks ou a resposta do contato — sem depender de alguém lembrar de mandar mensagem.": { es: "Los seguimientos reactivan la conversación con los contactos tras un silencio, un cambio de etapa, una regla en Webhooks o una respuesta del contacto, sin depender de que alguien se acuerde de escribir." },
  "Fluxos automáticos de reengajamento — silêncio, etapa, webhook ou resposta do contato, sem intervenção em cada mensagem.": { es: "Flujos automáticos para reactivar contactos: silencio, etapa, webhook o respuesta del contacto, sin intervenir en cada mensaje." },
  "Nenhum material ainda.": { es: "Todavía no hay materiales." },
  "O agente ainda não conhece o seu negócio": { es: "El agente todavía no conoce tu negocio" },
  "Comece pelo que ele mais vai precisar: as perguntas que se repetem, e a política que você mais explica. Ele passa a consultar isso antes de responder, em vez de improvisar.": { es: "Empieza por lo que más va a necesitar: las preguntas que se repiten y la política que más explicas. Empezará a consultarlo antes de responder, en vez de improvisar." },
  "Material arquivado não é consultado por nenhum assistente, e não é apagado — o histórico do que o agente já soube continua existindo.": { es: "Ningún asistente consulta el material archivado, pero tampoco se borra: el historial de lo que el agente ya supo se conserva." },
  "O material do seu negócio que os assistentes consultam antes de responder. Cada assistente escolhe, na tela dele, o que pode ler daqui.": { es: "El material de tu negocio que los asistentes consultan antes de responder. Cada asistente elige, en su pantalla, qué puede leer de aquí." },
  " — edição bloqueada.": { es: " — edición bloqueada." },
  "O navegador bloqueou as notificações. Libere-as nas configurações do site e recarregue.": { es: "El navegador bloqueó las notificaciones. Habilítalas en la configuración del sitio y recarga." },
  "Email ainda não está disponível. In-app (toast) e Push (Chrome) já funcionam para as cinco categorias, inclusive com a aba fechada.": { es: "El email todavía no está disponible. In-app (toast) y Push (Chrome) ya funcionan para las cinco categorías, incluso con la pestaña cerrada." },
  "Nesta instalação, os avisos só aparecem com o site aberto.": { es: "En esta instalación, los avisos solo aparecen con el sitio abierto." },
  "Ligar o Push abaixo já faz o aviso aparecer na bandeja do sistema enquanto você está com o site aberto numa aba. Para receber também com a aba fechada, quem administra o servidor precisa gerar um par de chaves uma única vez e reiniciar:": { es: "Si activas el Push de abajo, el aviso ya aparece en la bandeja del sistema mientras tengas el sitio abierto en una pestaña. Para recibirlo también con la pestaña cerrada, quien administra el servidor debe generar un par de claves (una sola vez) y reiniciar:" },
  "VAPID_PUBLIC_KEY": { es: "VAPID_PUBLIC_KEY" },
  "VAPID_PRIVATE_KEY": { es: "VAPID_PRIVATE_KEY" },
  ". Email ainda não está disponível.": { es: ". El email todavía no está disponible." },
  "sem responsável — definir quem atende": { es: "sin responsable — definir quién atiende" },
  "Campos do lead neste funil": { es: "Campos del lead en este embudo" },
  "Aparecem no dossiê do negócio. No follow-up, você escolhe em qual campo gravar a resposta.": { es: "Aparecen en el expediente del negocio. En el seguimiento, eliges en qué campo guardar la respuesta." },
  "Rótulo (Endereço)": { es: "Etiqueta (Dirección)" },
  "Opções, separadas por vírgula": { es: "Opciones, separadas por comas" },
  "Sem janelas, o roteamento aceita conversa a qualquer hora — mas a Agenda não oferece NENHUM horário para marcar. Adicione janelas para publicar seus horários de atendimento.": { es: "Sin franjas, el enrutamiento acepta conversaciones a cualquier hora, pero la Agenda no ofrece NINGÚN horario para agendar citas. Agrega franjas para publicar tus horarios de atención." },
  "Nenhuma janela publicada — ninguém consegue marcar com esta pessoa.": { es: "Ninguna franja publicada: nadie puede agendar una cita con esta persona." },
  "Atendentes e horários de atendimento": { es: "Asesores y horarios de atención" },
  "Status, carga e capacidade de cada atendente — e a jornada semanal que decide os horários oferecidos na Agenda. Sem ela ninguém consegue marcar.": { es: "Estado, carga y capacidad de cada asesor, además de la jornada semanal que define los horarios que se ofrecen en la Agenda. Sin ella, nadie puede agendar citas." },
  "Só gerentes e administradores editam os horários de atendimento da equipe. Para publicar os seus, peça a um gerente que abra esta aba e use o botão &ldquo;Editar horário&rdquo; ao lado do seu nome.": { es: "Solo los gerentes y administradores pueden editar los horarios de atención del equipo. Para publicar los tuyos, pide a un gerente que abra esta pestaña y use el botón “Editar horario” junto a tu nombre." },
  " — não publicado": { es: " — no publicado" },
  "Escolha um fluxo publicado": { es: "Elige un flujo publicado" },
  "Nenhum fluxo ativo. Publique um follow-up em Follow-ups para usá-lo aqui.": { es: "Ningún flujo activo. Publica un seguimiento en Seguimientos para usarlo aquí." },
  "Só entram fluxos publicados e ativos.": { es: "Solo se muestran los flujos publicados y activos." },
  "Sem eles ninguém consegue marcar — nem você, nem o agente.": { es: "Sin ellos nadie puede agendar citas, ni tú ni el agente." },
  "Configurar meus horários de atendimento": { es: "Configurar mis horarios de atención" },
  "Não consegui carregar os horários": { es: "No pude cargar los horarios" },
  "Os dias ficam bloqueados até eu conseguir — é mais seguro que oferecer um horário que talvez não exista. Numa instalação nova, isso costuma ser a jornada de atendimento que ainda não foi publicada.": { es: "Los días quedan bloqueados hasta que lo consiga; es más seguro que ofrecer un horario que quizá no exista. En una instalación nueva, esto suele ocurrir porque la jornada de atención aún no se ha publicado." },
  "Nenhum horário livre em": { es: "Ningún horario libre en" },
  "Não há horário livre publicado neste mês.": { es: "No hay horario libre publicado en este mes." },
  "Conferindo a chave com a OpenAI — leva alguns segundos.": { es: "Verificando la clave con OpenAI. Tarda unos segundos." },
  "Pronto para preparar material.": { es: "Listo para preparar material." },
  "Falta uma chave da OpenAI para o agente aprender o seu material": { es: "Falta una clave de OpenAI para que el agente aprenda tu material" },
  "Preparar um documento para o agente encontrá-lo usa a OpenAI, mesmo que o resto do seu assistente rode em outro provedor. Sem ela você consegue cadastrar o material, mas ele fica esperando — e o agente segue sem saber o que está nele.": { es: "Para preparar un documento y que el agente pueda encontrarlo se usa OpenAI, aunque el resto de tu asistente funcione con otro proveedor. Sin una clave, puedes registrar el material, pero queda en espera y el agente no sabrá qué contiene." },
  "Como você quer chamar esta chave": { es: "Cómo quieres llamar a esta clave" },
  "Você pega em": { es: "La consigues en" },
  ". Ela é guardada cifrada e nunca aparece de volta na tela.": { es: ". Se guarda cifrada y nunca vuelve a aparecer en la pantalla." },
  "Cadastrar a chave aqui": { es: "Registrar la clave aquí" },
  "ou veja todas em": { es: "o consúltalas todas en" },
  "O que você salvar aqui substitui o conteúdo atual, e o agente é preparado de novo.": { es: "Lo que guardes aquí reemplaza el contenido actual, y el agente se prepara de nuevo." },
  "## Pergunta:": { es: "## Pregunta:" },
  "## Resposta:": { es: "## Respuesta:" },
  "Salvar conteúdo": { es: "Guardar contenido" },
  "nenhum assistente ainda": { es: "ningún asistente todavía" },
  "Por que não entrou": { es: "Por qué no entró" },
  "Ele consulta este material antes de responder sobre o seu negócio.": { es: "Consulta este material antes de responder sobre tu negocio." },
  "Que tipo de material é": { es: "Qué tipo de material es" },
  "PDF, Markdown, CSV ou texto, até 20 MB. Um PDF só de imagens escaneadas não tem letra nenhuma para ler — envie uma versão com texto selecionável. Planilha Excel? Salve como CSV primeiro.": { es: "PDF, Markdown, CSV o texto, de hasta 20 MB. Un PDF que solo tiene imágenes escaneadas no contiene texto que se pueda leer: sube una versión con texto seleccionable. ¿Tienes una hoja de cálculo de Excel? Guárdala primero como CSV." },
  "…ou cole o texto aqui": { es: "…o pega el texto aquí" },
  "Sem uma chave da OpenAI, o material fica guardado e esperando — o agente só passa a conhecê-lo depois que a chave for cadastrada.": { es: "Sin una clave de OpenAI, el material queda guardado en espera. El agente solo lo conocerá cuando registres la clave." },
  "São estes os trechos que ele procura antes de responder. Quando ele erra sobre este assunto, é aqui que se vê o porquê.": { es: "Estos son los fragmentos que busca antes de responder. Cuando se equivoca sobre este tema, aquí se ve por qué." },
  "Não consegui ler os trechos agora.": { es: "No pude leer los fragmentos ahora." },
  "Este material ainda não foi preparado — não há trecho nenhum para o agente encontrar.": { es: "Este material todavía no se ha preparado, así que no hay ningún fragmento que el agente pueda encontrar." },
  "Mostrando os primeiros trechos de": { es: "Mostrando los primeros fragmentos de" },
  ". Uma tela não folheia mil pedaços — o restante está no acervo e o agente alcança todos.": { es: ". Una pantalla no da para hojear mil fragmentos: el resto está en el acervo y el agente tiene acceso a todos." },
  "Este funil não tem campos extras.": { es: "Este embudo no tiene campos extra." },
  "Campos atualizados": { es: "Campos actualizados" },

  // ─── Tabela de Contatos ───
  //
  // Achados pelo e2e no CI, e não localmente: aqui o banco estava sem
  // contato nenhum, então a tabela não renderizava cabeçalho nem linha. O
  // guarda estático também não os vê — "Nome", "Status", "Ativo" não têm
  // acento, e a régua dele é ortográfica.
  "Tags": { es: "Etiquetas" },

  // ─── Agenda interativa (PR #382, entrou pela main durante este PR) ───
  "Horários livres de": { es: "Horarios libres de" },
  "Você ainda não publicou seus horários de atendimento.": { es: "Todavía no publicaste tus horarios de atención." },
  "Sem eles ninguém consegue marcar clicando na grade — nem você, nem o agente.": { es: "Sin ellos, nadie puede programar citas haciendo clic en la cuadrícula, ni tú ni el agente." },
  // #896: a jornada de atendimento que ainda não foi publicada — DOIS textos, um
  // com ponto final (painel da grade) e outro sem (painel de marcação), e o
  // "Sem eles..." da tela de quem atende sem poder de gerente.
  "A jornada de atendimento ainda não foi publicada.": { es: "La jornada de atención aún no se ha publicado." },
  "A jornada de atendimento ainda não foi publicada": { es: "La jornada de atención aún no se ha publicado" },
  // #1107 (item 5): a frase da folga chega à tela por LITERAL
  // (PainelDeMarcacao.tsx) — `t(variável)` escapava do guarda que varre
  // `t("literal")`, e a frase ficava sem cobrança em espanhol.
  "Este dia está fora da jornada publicada (folga ou dia sem expediente).": { es: "Este día está fuera de la jornada publicada (día libre o sin horario de atención)." },
  "Sem eles ninguém consegue marcar — nem quem atende, nem o agente.": { es: "Sin ellos, nadie puede programar citas, ni quien atiende ni el agente." },
  "Não consegui carregar os horários.": { es: "No pude cargar los horarios." },
  "Os blocos ficam bloqueados até eu conseguir — é mais seguro que oferecer um horário que talvez não exista.": { es: "Los bloques seguirán bloqueados hasta que pueda cargarlos: es más seguro que ofrecer un horario que quizá no exista." },
  "Nenhum horário livre neste período.": { es: "No hay horarios libres en este período." },
  "Os blocos vazios continuam aqui, e o que estiver publicado fica clicável.": { es: "Los bloques vacíos siguen aquí y puedes hacer clic en lo que esté publicado." },
  "Remarcar": { es: "Reprogramar" },
  "para": { es: "para" },
  "? Quem foi atendido recebe o aviso da mudança.": { es: "? La persona atendida recibirá el aviso del cambio." },

  // ═══ As telas que só o passe do PR #352 alcançou ═══
  //
  // Contribuição de @JowaniOrantes: as 398 entradas abaixo são as que o
  // passe dele cobriu e este PR não tinha — Desempenho, auditoria do tenant,
  // Respostas rápidas, Radar, toasts de hook e as mensagens de erro da API.
  // Onde a mesma chave existia nos dois lados prevalece a tradução deste PR,
  // que é a que a spec de tela e o guarda de AST asseguram — as duas dizem a
  // mesma coisa em espanhol, então a escolha é de consistência, não de mérito.
  "Buscar…": { es: "Buscar…" },
  "Sobre as demandas encerradas no período.": { es: "Sobre los casos cerrados en el período." },
  "Quantas vezes o agente voltou ao cliente por conta própria. Medido sobre as": {
    es: "Cuántas veces el agente retomó el contacto con el cliente por iniciativa propia. Se mide sobre los",
  },
  "demandas que passaram por atendimento humano.": {
    es: "casos que pasaron por atención humana.",
  },
  "Conversas que morreram no silêncio (após": {
    es: "Conversaciones que se apagaron en silencio (después de",
  },
  "conversas em que falamos: a pessoa não respondeu e ninguém encerrou.": {
    es: "conversaciones en las que escribimos: la persona no respondió y nadie las cerró.",
  },
  "Piso:": { es: "Mínimo:" },
  "Conta só a repergunta quase literal — reformulada com outras palavras escapa desta medida.": {
    es: "Solo cuenta la pregunta repetida casi textual; si se reformula con otras palabras, no entra en esta medición.",
  },
  "Igual à mediana: há poucas esperas medidas no período para os dois se separarem.": {
    es: "Igual que la mediana: en el período hay muy pocas esperas medidas como para que los dos valores se distancien.",
  },
  "O p90 é a experiência de quem espera mais — a mediana a esconde.": {
    es: "El p90 refleja la experiencia de quienes esperan más, algo que la mediana oculta.",
  },
  "abertas agora. Cada uma é alguém esperando sem que nada esteja marcado para acontecer.": {
    es: "abiertas ahora. Cada una es alguien que espera sin que haya nada programado que vaya a suceder.",
  },
  "Esperas sem nenhuma resposta por mais de": {
    es: "Esperas sin ninguna respuesta por más de",
  },
  "falas do cliente. Quem sabe que vai esperar, espera; quem não sabe, desiste.": {
    es: "mensajes del cliente. Quien sabe que va a esperar, espera; quien no, desiste.",
  },
  "Tipo de recurso": { es: "Tipo de recurso" },
  "Novo template": { es: "Nueva plantilla" },
  "Editar template": { es: "Editar plantilla" },
  "Excluir template": { es: "Eliminar plantilla" },
  "Template excluído.": { es: "Plantilla eliminada." },
  "Template atualizado.": { es: "Plantilla actualizada." },
  "Template criado.": { es: "Plantilla creada." },
  "Oi {{primeiro_nome}}, tudo bem?": { es: "Hola {{primeiro_nome}}, ¿todo bien?" },
  "Criar template": { es: "Crear plantilla" },
  "Nova execução iniciada.": { es: "Nueva ejecución iniciada." },
  "Execução concluída.": { es: "Ejecución concluida." },
  "Orçamento atualizado": { es: "Presupuesto actualizado" },
  "Conversa transferida.": { es: "Conversación transferida." },
  "Atendente atualizado.": { es: "Asesor actualizado." },
  "Roteamento atualizado.": { es: "Enrutamiento actualizado." },
  "Papel atualizado.": { es: "Rol actualizado." },

  // ─── Feedback: catálogo genérico de erros de API (ApiErrorToast) ───
  "Requisição inválida. Recarregue e tente de novo.": {
    es: "Solicitud inválida. Recarga e intenta de nuevo.",
  },
  "Falha ao paginar. Volte ao início.": { es: "No se pudo paginar. Vuelve al inicio." },
  "Dados inválidos. Confira os campos destacados.": {
    es: "Datos inválidos. Revisa los campos destacados.",
  },
  "Sessão expirada. Faça login novamente.": { es: "Tu sesión expiró. Inicia sesión de nuevo." },
  "Você não tem permissão para esta ação.": { es: "No tienes permiso para esta acción." },
  "Recurso não encontrado ou já removido.": { es: "Recurso no encontrado o ya eliminado." },
  "Organização não encontrada.": { es: "Organización no encontrada." },
  "Operação já processada.": { es: "Operación ya procesada." },
  "Outro atendente já assumiu.": { es: "Otro asesor ya lo asumió." },
  "Este caso já foi respondido ou fechado.": { es: "Este caso ya se respondió o se cerró." },
  "Calma — muitas tentativas. Espere alguns segundos.": {
    es: "Calma, son demasiados intentos. Espera unos segundos.",
  },
  "Esta ação não pode ser desfeita: o contato já foi anonimizado.": {
    es: "Esta acción no se puede deshacer: el contacto ya fue anonimizado.",
  },
  "Erro interno. Tente de novo em instantes.": { es: "Error interno. Intenta de nuevo en unos momentos." },

  // ─── Segment error boundary genérico ───
  "Algo deu errado": { es: "Algo salió mal" },
  "Copiado!": { es: "¡Copiado!" },
  "Copiar ID": { es: "Copiar ID" },

  // ─── Impersonate banner (platform admin atuando como tenant) ───
  "Falha ao encerrar impersonate": { es: "No se pudo terminar el modo Impersonate" },
  "Erro de rede ao encerrar impersonate": { es: "Error de red al terminar el modo Impersonate" },
  "Modo Impersonate — atuando como": { es: "Modo Impersonate — actuando como" },
  "Encerrar impersonate e voltar ao admin": { es: "Terminar el modo Impersonate y volver al admin" },
  "Encerrando…": { es: "Terminando…" },

  // ─── Radar de risco ───
  "parado há": { es: "parado hace" },
  "Agente:": { es: "Agente:" },
  "sem nome": { es: "sin nombre" },
  "Com atendente": { es: "Con asesor" },
  "Assistente na conversa": { es: "Asistente en la conversación" },
  "Sem dono": { es: "Sin responsable" },
  "Você assumiu a demanda": { es: "Tomaste el caso" },
  "Assistente retorna": { es: "El asistente dará seguimiento" },

  // ─── Merge PR #365 (Web Push, relógio HTTP e follow-up reativo) — i18n ───
  "Automação (Webhooks)": { es: "Automatización (Webhooks)" },
  "Adicionar campo": { es: "Agregar campo" },
  "Campos do funil": { es: "Campos del embudo" },
  "Chave do campo": { es: "Clave del campo" },
  "Contato excluído.": { es: "Contacto eliminado." },
  "Disparado por uma automação em Webhooks": { es: "Activado por una automatización en Webhooks" },
  "Email ainda não está disponível. In-app (toast) e Push (Chrome) já funcionam para as cinco categorias.": {
    es: "Email aún no está disponible. In-app (toast) y Push (Chrome) ya funcionan para las cinco categorías.",
  },
  "Excluindo…": { es: "Eliminando…" },
  "Excluir contato": { es: "Eliminar contacto" },
  "Excluir contato?": { es: "¿Eliminar contacto?" },
  "Fluxo de follow-up": { es: "Flujo de follow-up" },
  "Fluxo excluído.": { es: "Flujo eliminado." },
  "Iniciar conversa com": { es: "Iniciar conversación con" },
  "Iniciar conversa no Inbox": { es: "Iniciar conversación en el Inbox" },
  "Isso remove": { es: "Esto elimina" },
  "Novo campo": { es: "Nuevo campo" },
  "Opções do campo": { es: "Opciones del campo" },
  "Remover campo": { es: "Quitar campo" },
  "Rótulo do campo": { es: "Etiqueta del campo" },
  "Tipo do campo": { es: "Tipo del campo" },
  "chave (endereco)": { es: "clave (direccion)" },
  "e a conversa associada, se houver. Esta ação não pode ser desfeita.": {
    es: "y la conversación asociada, si la hay. Esta acción no se puede deshacer.",
  },

  // ─── Mensagens literais de `fail()` em app/api/v1/** ───
  //
  // Estas são o texto de erro que a ROTA escreve (não o `msg` de `COPY` do
  // ApiErrorToast, que já tem sua própria seção acima). Sem entrada aqui, a
  // frase da API chegava em português na tela de um usuário em espanhol —
  // `toastFor` caía direto em `err.message` sem passar por `t()`, e telas que
  // leem `err.message` fora do toast (ex.: diálogos com estado de erro
  // próprio) faziam o mesmo. A chave é o texto exato que `fail(code, texto,
  // status)` manda; strings com interpolação (template literal) não entram
  // aqui — não há como uma chave literal casar com um texto que muda por
  // requisição, e ficam em português por ora, mesmo comportamento de
  // degradação do resto deste arquivo.
  "account_id e api_key são obrigatórios": { es: "account_id y api_key son obligatorios" },
  "Agente não encontrado.": { es: "Agente no encontrado." },
  "Agente não encontrado nesta organização.": { es: "Agente no encontrado en esta organización." },
  "Agent não encontrado.": { es: "Agent no encontrado." },
  "Agent não encontrado nesta organização.": { es: "Agent no encontrado en esta organización." },
  "Agent não tem versão para duplicar.": { es: "El agent no tiene versión para duplicar." },
  "A imagem precisa ter até 5 MB.": { es: "La imagen no debe superar los 5 MB." },
  "Apenas versões 'draft' podem ser editadas.": { es: "Solo se pueden editar las versiones 'draft'." },
  "Arquivo acima de 50MB.": { es: "El archivo supera los 50MB." },
  "Arquivo excede o limite de 20MB.": { es: "El archivo supera el límite de 20MB." },
  "Atendente não encontrado na organização.": { es: "Asesor no encontrado en la organización." },
  "Atualização não encontrada.": { es: "Actualización no encontrada." },
  "Audit entry not found": { es: "Entrada de auditoría no encontrada" },
  "Auth indisponível": { es: "Autenticación no disponible" },
  "Auth required.": { es: "Se requiere autenticación." },
  "Aviso não encontrado nesta organização.": { es: "Aviso no encontrado en esta organización." },
  "Body vazio.": { es: "Cuerpo vacío." },
  "Caminho inválido.": { es: "Ruta inválida." },
  "Campo 'agent_id' deve ser UUID válido.": { es: "El campo 'agent_id' debe ser un UUID válido." },
  "Campo 'file' ausente ou inválido.": { es: "Campo 'file' ausente o inválido." },
  "Campo 'file' (multipart) obrigatório.": { es: "Campo 'file' (multipart) obligatorio." },
  "Campo 'name' inválido (2-120 chars).": { es: "Campo 'name' inválido (2-120 caracteres)." },
  "Canal não encontrado.": { es: "Canal no encontrado." },
  "Caso não encontrado.": { es: "Caso no encontrado." },
  "chave não encontrada nesta organização": { es: "clave no encontrada en esta organización" },
  "Conexão não encontrada nesta organização.": { es: "Conexión no encontrada en esta organización." },
  "Conexão sem identificador utilizável.": { es: "Conexión sin identificador utilizable." },
  "Conflito de versionamento — tente novamente.": { es: "Conflicto de versiones. Intenta de nuevo." },
  "Contato não encontrado.": { es: "Contacto no encontrado." },
  "content é obrigatório.": { es: "content es obligatorio." },
  "Conversa do caso sem contato associado.": { es: "La conversación del caso no tiene contacto asociado." },
  "Conversa não encontrada.": { es: "Conversación no encontrada." },
  "Conversa sem contato/canal.": { es: "Conversación sin contacto/canal." },
  "corpo inválido": { es: "cuerpo inválido" },
  "Corpo inválido.": { es: "Cuerpo inválido." },
  "Corpo inválido para desconectar.": { es: "Cuerpo inválido para desconectar." },
  "Corpo não é JSON válido.": { es: "El cuerpo no es un JSON válido." },
  "Credential desativada.": { es: "Credential desactivada." },
  "Credential não encontrada.": { es: "Credential no encontrada." },
  "cron secret ausente ou inválido": { es: "cron secret ausente o inválido" },
  "CSV vazio ou sem linhas de dados.": { es: "CSV vacío o sin filas de datos." },
  "decision é obrigatório (accept | dismiss).": { es: "decision es obligatorio (accept | dismiss)." },
  "decision e proposal_id são obrigatórios.": { es: "decision y proposal_id son obligatorios." },
  "Demanda não encontrada, ou já encerrada.": { es: "Caso no encontrado o ya cerrado." },
  "Destino não é um atendente desta organização.": { es: "El destino no es un asesor de esta organización." },
  "Dê um nome à etapa — é o que aparece no topo da coluna.": {
    es: "Ponle un nombre a la etapa. Es lo que aparece arriba de la columna.",
  },
  "Dê um nome ao funil — é o que aparece na lista e no topo do quadro.": {
    es: "Ponle un nombre al embudo. Es lo que aparece en la lista y arriba del tablero.",
  },
  "Dê um nome ao funil — é o que aparece na lista.": { es: "Ponle un nombre al embudo. Es lo que aparece en la lista." },
  "Duas intenções não podem ter o mesmo nome no router.": {
    es: "Dos intenciones no pueden tener el mismo nombre en el router.",
  },
  "Enrollment já está encerrado.": { es: "El enrollment ya está cerrado." },
  "Enrollment não encontrado.": { es: "Enrollment no encontrado." },
  "Entrada de memória não encontrada nesta organização.": { es: "Entrada de memoria no encontrada en esta organización." },
  "Envie o mapeamento completo dos sete passos do atendimento.": {
    es: "Envía el mapeo completo de los siete pasos de la atención.",
  },
  "Envie o arquivo como multipart/form-data no campo 'file'.": {
    es: "Envía el archivo como multipart/form-data en el campo 'file'.",
  },
  "Erro ao agregar o uso de IA.": { es: "Error al consolidar el uso de IA." },
  "Erro ao arquivar fonte.": { es: "Error al archivar la fuente." },
  "Erro ao atualizar agent.": { es: "Error al actualizar el agent." },
  "Erro ao atualizar credential.": { es: "Error al actualizar la credential." },
  "Erro ao atualizar fonte.": { es: "Error al actualizar la fuente." },
  "Erro ao atualizar orçamento.": { es: "Error al actualizar el presupuesto." },
  "Erro ao atualizar router.": { es: "Error al actualizar el router." },
  "Erro ao atualizar version.": { es: "Error al actualizar la version." },
  "Erro ao buscar agent.": { es: "Error al buscar el agent." },
  "Erro ao buscar membros do router.": { es: "Error al buscar los miembros del router." },
  "Erro ao buscar mensagem.": { es: "Error al buscar el mensaje." },
  "Erro ao buscar router.": { es: "Error al buscar el router." },
  "Erro ao buscar version.": { es: "Error al buscar la version." },
  "Erro ao carregar agent.": { es: "Error al cargar el agent." },
  "Erro ao carregar a versão da memória.": { es: "Error al cargar la versión de la memoria." },
  "Erro ao carregar catálogo de skills.": { es: "Error al cargar el catálogo de skills." },
  "Erro ao carregar descrição das skills.": { es: "Error al cargar la descripción de las skills." },
  "Erro ao carregar entradas da memória.": { es: "Error al cargar las entradas de la memoria." },
  "Erro ao carregar o agente.": { es: "Error al cargar el agente." },
  "Erro ao carregar router.": { es: "Error al cargar el router." },
  "Erro ao carregar skills instaladas.": { es: "Error al cargar las skills instaladas." },
  "Erro ao carregar versões da memória.": { es: "Error al cargar las versiones de la memoria." },
  "Erro ao consultar credential.": { es: "Error al consultar la credential." },
  "Erro ao contar membros dos routers.": { es: "Error al contar los miembros de los routers." },
  "Erro ao criar agent.": { es: "Error al crear el agent." },
  "Erro ao criar credential.": { es: "Error al crear la credential." },
  "Erro ao criar entrada de memória.": { es: "Error al crear la entrada de memoria." },
  "Erro ao criar fonte de conhecimento.": { es: "Error al crear la fuente de conocimiento." },
  "Erro ao criar nota.": { es: "Error al crear la nota." },
  "Erro ao criar orçamento.": { es: "Error al crear el presupuesto." },
  "Erro ao criar router.": { es: "Error al crear el router." },
  "Erro ao criar template.": { es: "Error al crear la plantilla." },
  "Erro ao criar versão inicial.": { es: "Error al crear la versión inicial." },
  "Erro ao criar version.": { es: "Error al crear la version." },
  "Erro ao deletar credential.": { es: "Error al eliminar la credential." },
  "Erro ao desativar agent.": { es: "Error al desactivar el agent." },
  "Erro ao desinstalar a skill.": { es: "Error al desinstalar la skill." },
  "Erro ao excluir nota.": { es: "Error al eliminar la nota." },
  "Erro ao excluir template.": { es: "Error al eliminar la plantilla." },
  "Erro ao fazer upload do arquivo.": { es: "Error al subir el archivo." },
  "Erro ao gravar membros do router.": { es: "Error al guardar los miembros del router." },
  "Erro ao importar o pacote de skill.": { es: "Error al importar el paquete de skill." },
  "Erro ao iniciar test run.": { es: "Error al iniciar el test run." },
  "Erro ao inserir novos itens FAQ.": { es: "Error al insertar nuevos ítems de FAQ." },
  "Erro ao instalar a skill.": { es: "Error al instalar la skill." },
  "Erro ao ler o orçamento.": { es: "Error al leer el presupuesto." },
  "Erro ao ler o uso das capacidades.": { es: "Error al leer el uso de las capacidades." },
  "Erro ao limpar membros do router.": { es: "Error al limpiar los miembros del router." },
  "Erro ao listar agents.": { es: "Error al listar agents." },
  "Erro ao listar credentials.": { es: "Error al listar credentials." },
  "Erro ao listar fontes de conhecimento.": { es: "Error al listar las fuentes de conocimiento." },
  "Erro ao listar modelos.": { es: "Error al listar los modelos." },
  "Erro ao listar notas.": { es: "Error al listar las notas." },
  "Erro ao listar routers.": { es: "Error al listar los routers." },
  "Erro ao listar runs.": { es: "Error al listar los runs." },
  "Erro ao listar templates.": { es: "Error al listar las plantillas." },
  "Erro ao listar versions.": { es: "Error al listar las versions." },
  "Erro ao pausar agent.": { es: "Error al pausar el agent." },
  "Erro ao preparar o link da imagem.": { es: "Error al preparar el enlace de la imagen." },
  "Erro ao processar o arquivo.": { es: "Error al procesar el archivo." },
  "Erro ao publicar.": { es: "Error al publicar." },
  "Erro ao registrar fonte de conhecimento.": { es: "Error al registrar la fuente de conocimiento." },
  "Erro ao remover itens antigos.": { es: "Error al eliminar ítems antiguos." },
  "Erro ao remover router.": { es: "Error al eliminar el router." },
  "Erro ao subir a imagem.": { es: "Error al subir la imagen." },
  "Erro ao subir o arquivo.": { es: "Error al subir el archivo." },
  "Erro ao subir o logo.": { es: "Error al subir el logo." },
  "Erro ao validar agent_id.": { es: "Error al validar agent_id." },
  "Erro ao validar conversa.": { es: "Error al validar la conversación." },
  "Erro ao verificar fonte.": { es: "Error al verificar la fuente." },
  "Erro ao verificar o número de WhatsApp.": { es: "Error al verificar el número de WhatsApp." },
  "Erro ao verificar uso da credential.": { es: "Error al verificar el uso de la credential." },
  "Esta atualização já terminou.": { es: "Esta actualización ya terminó." },
  "Este canal não gerencia definições.": { es: "Este canal no gestiona definiciones." },
  "Este caso já foi respondido por outra pessoa.": { es: "Este caso ya fue respondido por otra persona." },
  "Este número já tem um roteador ativo.": { es: "Este número ya tiene un router activo." },
  "Este retorno já aconteceu ou já foi cancelado.": { es: "Este seguimiento ya ocurrió o se canceló." },
  "Faça login.": { es: "Inicia sesión." },
  "Faça login para continuar.": { es: "Inicia sesión para continuar." },
  "Falha ao atualizar o aviso.": { es: "No se pudo actualizar el aviso." },
  "Falha ao carregar as propostas.": { es: "No se pudieron cargar las propuestas." },
  "Falha ao carregar conexões/knobs.": { es: "No se pudieron cargar las conexiones/knobs." },
  "Falha ao carregar o caso.": { es: "No se pudo cargar el caso." },
  "Falha ao carregar o radar.": { es: "No se pudo cargar el radar." },
  "Falha ao carregar os avisos.": { es: "No se pudieron cargar los avisos." },
  "Falha ao carregar os casos.": { es: "No se pudieron cargar los casos." },
  "Falha ao decifrar credential.": { es: "No se pudo descifrar la credential." },
  "Falha ao listar funis.": { es: "No se pudieron listar los embudos." },
  "Falha ao processar multipart/form-data.": { es: "No se pudo procesar multipart/form-data." },
  "Falha ao salvar os knobs.": { es: "No se pudieron guardar los knobs." },
  "Falha ao salvar o teto diário.": { es: "No se pudo guardar el tope diario." },
  "Faltam nome, idioma ou conteúdo.": { es: "Faltan nombre, idioma o contenido." },
  "Fluxo não encontrado.": { es: "Flujo no encontrado." },
  "Fluxo não tem rascunho pronto para publicar.": { es: "El flujo no tiene un borrador listo para publicar." },
  "Fluxo reprovado na validação de publish.": { es: "El flujo no pasó la validación de publicación." },
  "Follow-up não encontrado.": { es: "Follow-up no encontrado." },
  "Fonte de conhecimento não encontrada.": { es: "Fuente de conocimiento no encontrada." },
  "Fonte não encontrada.": { es: "Fuente no encontrada." },
  "Funil não encontrado.": { es: "Embudo no encontrado." },
  "Informe o novo horário.": { es: "Indica el nuevo horario." },
  "Já existe um fluxo com este nome.": { es: "Ya existe un flujo con este nombre." },
  "Já existe um contato com este telefone.": { es: "Ya existe un contacto con este teléfono." },
  "Janela inválida.": { es: "Ventana inválida." },
  "Janela inválida: 'from' deve ser anterior a 'to'.": { es: "Ventana inválida: 'from' debe ser anterior a 'to'." },
  "Lead não encontrado.": { es: "Lead no encontrado." },
  "Membro está revogado.": { es: "El acceso del miembro está revocado." },
  "Membro não encontrado.": { es: "Miembro no encontrado." },
  "Mensagem sem mídia.": { es: "Mensaje sin contenido multimedia." },
  "Mídia indisponível no momento.": { es: "Contenido multimedia no disponible en este momento." },
  "Muitas trocas de logo seguidas. Tente em alguns minutos.": {
    es: "Demasiados cambios de logo seguidos. Intenta de nuevo en unos minutos.",
  },
  "nada foi gravado — verifique as permissões da organização": {
    es: "no se guardó nada; revisa los permisos de la organización",
  },
  "Não consegui checar o pedido de atualização.": { es: "No pude verificar la solicitud de actualización." },
  "Não consegui finalizar a atualização.": { es: "No pude finalizar la actualización." },
  "Não consegui gravar o estado.": { es: "No pude guardar el estado." },
  "Não consegui gravar o passo.": { es: "No pude guardar el paso." },
  "Não consegui ler a atualização.": { es: "No pude leer la actualización." },
  "Não consegui ler o estado da atualização.": { es: "No pude leer el estado de la actualización." },
  "Não consegui liberar a atualização travada.": { es: "No pude liberar la actualización bloqueada." },
  "Não consegui registrar o pedido de atualização.": { es: "No pude registrar la solicitud de actualización." },
  "Não entendi o que mudar nesta etapa.": { es: "No entendí qué cambiar en esta etapa." },
  "Não entendi o que mudar neste funil.": { es: "No entendí qué cambiar en este embudo." },
  "Não é possível revogar o próprio acesso.": { es: "No puedes revocar tu propio acceso." },
  "Não foi possível gravar o dado.": { es: "No fue posible guardar el dato." },
  "Não há agenda do Google conectada para esta pessoa.": { es: "Esta persona no tiene un Google Calendar conectado." },
  "Não há proposta pendente para este negócio.": { es: "No hay una propuesta pendiente para este negocio." },
  "Negócio não encontrado.": { es: "Negocio no encontrado." },
  "Nenhuma conexão de parceiro ativa.": { es: "No hay ninguna conexión de partner activa." },
  "nenhuma organização ativa": { es: "no hay ninguna organización activa" },
  "Nenhuma organização ativa.": { es: "No hay ninguna organización activa." },
  "Nenhum campo mapeável (nome/telefone/email).": { es: "No hay campos mapeables (nombre/teléfono/email)." },
  "Nenhum campo para alterar.": { es: "No hay ningún campo para modificar." },
  "Nome de skill inválido.": { es: "Nombre de skill inválido." },
  "Nota não encontrada.": { es: "Nota no encontrada." },
  "Número de WhatsApp não encontrado nesta organização.": { es: "Número de WhatsApp no encontrado en esta organización." },
  "O arquivo enviado é grande demais (máx. 5 MB por skill).": {
    es: "El archivo enviado es demasiado grande (máx. 5 MB por skill).",
  },
  "O evento original deste run foi removido.": { es: "El evento original de este run fue eliminado." },
  "O fim do período precisa ser depois do começo.": { es: "El fin del período debe ser posterior al inicio." },
  "O logo precisa ser PNG ou JPG.": { es: "El logo debe ser PNG o JPG." },
  "Outro atendente assumiu esta conversa agora.": { es: "Otro asesor acaba de asumir esta conversación." },
  "Parâmetro 'escopo' inválido.": { es: "Parámetro 'escopo' inválido." },
  "Parâmetros inválidos.": { es: "Parámetros inválidos." },
  "payload fora do contrato do canal": { es: "payload fuera del contrato del canal" },
  "Permissão insuficiente. Requer role >= manager.": { es: "Permiso insuficiente. Requiere role >= manager." },
  "phone_number_id, waba_id e token são obrigatórios": { es: "phone_number_id, waba_id y token son obligatorios" },
  "Pipeline não encontrado.": { es: "Pipeline no encontrado." },
  "provar a chave requer papel de administrador": { es: "probar la clave requiere rol de administrador" },
  "Provider desconhecido.": { es: "Provider desconocido." },
  "Rascunho da IA indisponível (config).": { es: "Borrador de la IA no disponible (config)." },
  "Regra do run não encontrada.": { es: "Regla del run no encontrada." },
  "Regra não encontrada.": { es: "Regla no encontrada." },
  "requer papel de administrador": { es: "requiere rol de administrador" },
  "requer papel de gerente ou superior": { es: "requiere rol de gerente o superior" },
  "Resposta ao caso indisponível (config).": { es: "Respuesta al caso no disponible (config)." },
  "Retorno não encontrado.": { es: "Seguimiento no encontrado." },
  "Router não encontrado.": { es: "Router no encontrado." },
  "Run não encontrado.": { es: "Run no encontrado." },
  "sem organização ativa": { es: "sin organización activa" },
  "Sem organização ativa": { es: "Sin organización activa" },
  "Sem organização ativa.": { es: "Sin organización activa." },
  "Sessão de canal não encontrada.": { es: "Sesión de canal no encontrada." },
  "Sessão expirada": { es: "Sesión expirada" },
  "Sessão sem token.": { es: "Sesión sin token." },
  "Skill não encontrada no catálogo de plataforma.": { es: "Skill no encontrada en el catálogo de la plataforma." },
  "Suba o Docker (docker compose up -d waha) e tente novamente.": {
    es: "Levanta el Docker (docker compose up -d waha) e intenta de nuevo.",
  },
  "Skill não está instalada nesta organização.": { es: "La skill no está instalada en esta organización." },
  "Solicitação não encontrada.": { es: "Solicitud no encontrada." },
  "Só manager+ cria template compartilhado.": { es: "Solo manager+ puede crear una plantilla compartida." },
  "Só o autor ou manager+ pode apagar esta nota.": { es: "Solo el autor o manager+ puede eliminar esta nota." },
  "Só o dono do servidor pode atualizar o sistema.": { es: "Solo el dueño del servidor puede actualizar el sistema." },
  "Stage não encontrado.": { es: "Stage no encontrado." },
  // ⚠️ FICA SEM TRADUÇÃO DE PROPÓSITO: a recusa 503 de
  // `app/api/v1/onboarding/whatsapp/session/route.ts` (contêiner do provedor de
  // WhatsApp fora do ar). A chave teria de repetir o texto da rota LETRA POR
  // LETRA, e esse texto NOMEIA o provedor — o que faz `pnpm lint:channels`
  // reprovar este arquivo pelo invariante 1 da doutrina `restricao-de-canal`.
  //
  // Medido duas vezes: a entrada derrubou o gate, e o comentário que eu escrevi
  // para explicar a ausência derrubou de novo, por citar o nome ao explicá-lo —
  // exatamente a armadilha que a própria catraca documenta. Daí esta redação
  // perifrástica, que não é estilo: é a única que passa.
  //
  // A rota está na lista de exceções da catraca; `lib/i18n/` não está, e ganhar
  // UMA frase traduzida não paga furar um invariante de arquitetura. Sem
  // entrada, a frase aparece em português — a degradação que este arquivo
  // inteiro já assume.
  "Sugestão não encontrada.": { es: "Sugerencia no encontrada." },
  "Telefone inválido.": { es: "Teléfono inválido." },
  "Template não encontrado.": { es: "Plantilla no encontrada." },
  "Tipo de agendamento não encontrado.": { es: "Tipo de cita no encontrado." },
  // ─── app/api/v1/agenda/agendamentos/_handler.ts + lib/agenda/consulta.ts ───
  "O tipo deste agendamento não existe mais.": { es: "El tipo de esta cita ya no existe." },
  "Agendamento não encontrado.": { es: "Cita no encontrada." },
  "Este agendamento foi cancelado. Marque um novo em vez de reabrir este.": {
    es: "Esta cita se canceló. Agenda una nueva en lugar de reabrirla.",
  },
  "Este compromisso ainda não começou — não dá para registrar se a pessoa veio ou faltou. Se ela avisou que não vem, desmarque em vez de registrar falta.": {
    es: "Esta cita todavía no empieza, así que no se puede registrar si la persona asistió o faltó. Si avisó que no va a ir, cancélala en lugar de registrar una falta.",
  },
  "Este responsável ainda não publicou horários de atendimento.": {
    es: "Este responsable todavía no publicó horarios de atención.",
  },
  "Este horário não está disponível. Consulte os horários livres e escolha outro.": {
    es: "Este horario no está disponible. Consulta los horarios libres y elige otro.",
  },
  "Este horário já está ocupado na agenda de quem atende — por outro compromisso ou pelo Google Agenda.": {
    es: "Este horario ya está ocupado en la agenda de quien atiende, ya sea por otro compromiso o por Google Calendar.",
  },
  "listagem sem recorte: informe contato, lead, dia, período (de+ate) ou responsável.": {
    es: "listado sin filtro: indica contacto, lead, día, período (de+ate) o responsable.",
  },
  "O período não pode passar de 62 dias.": { es: "El período no puede pasar de 62 días." },
  "title e body são obrigatórios.": { es: "title y body son obligatorios." },
  "Token não encontrado.": { es: "Token no encontrado." },
  "tool_ids contém ids inexistentes no catálogo MCP.": { es: "tool_ids contiene ids inexistentes en el catálogo MCP." },
  "Validação de publish falhou.": { es: "Falló la validación de publicación." },
  "Versão não encontrada nesta organização.": { es: "Versión no encontrada en esta organización." },
  "Version não encontrada.": { es: "Version no encontrada." },
  "Você já está na versão mais recente.": { es: "Ya estás en la versión más reciente." },
  "Você não está atribuído a essa conversa.": { es: "No estás asignado a esta conversación." },
  "Web Push ainda não está no banco desta instalação.": { es: "Web Push aún no está en la base de datos de esta instalación." },
  "Web Push não configurado nesta instalação.": { es: "Web Push no configurado en esta instalación." },

  // ─── Merge da main 1.8.0 — textos que a reescrita trouxe ───
  //
  // Não são telas novas: são as MESMAS telas que este ramo já traduzia, cujo
  // texto a main reescreveu (acervo de conhecimento da 0181, o rótulo de
  // jornada que deixou de mentir "24/7", e a página de Notificações que passou
  // a dizer o que falta no `.env`). Traduzir de novo aqui é o preço de um ramo
  // longo — e o defeito conhecido é o oposto: deixar passar, e a tela volta ao
  // português sem que nada fique vermelho.
  //
  // Ausentes de propósito, porque a palavra é a MESMA nos dois idiomas e
  // `traduzir()` devolve a chave: "nunca", "Preparado", "Consultado por",
  // "Preparando…". Entrada que repete a chave é ruído que envelhece.
  "Vou preparar este material de novo — leva alguns instantes.": {
    es: "Voy a preparar este material de nuevo. Tardará unos instantes.",
  },
  "Material arquivado. O agente para de consultá-lo.": {
    es: "Material archivado. El agente deja de consultarlo.",
  },
  "Só gerentes e administradores editam os horários de atendimento da equipe. Para publicar os seus, peça a um gerente que abra esta aba e use o botão “Editar horário” ao lado do seu nome.":
    {
      es: "Solo los gerentes y administradores pueden editar los horarios de atención del equipo. Para publicar los tuyos, pide a un gerente que abra esta pestaña y use el botón “Editar horario” junto a tu nombre.",
    },
  "O resultado vai no arquivo": { es: "El resultado va en el archivo" },
  "Email ainda não está disponível.": { es: "El email todavía no está disponible." },
  "Trechos que o agente encontra": { es: "Fragmentos que el agente encuentra" },
  "Regra que você ensinou": { es: "Regla que enseñaste" },
  "Melhoria que você aprovou": { es: "Mejora que aprobaste" },
  "Habilidade instalada": { es: "Habilidad instalada" },
  "Preparar de novo": { es: "Preparar de nuevo" },
  "Ver o que ele aprendeu": { es: "Ver lo que aprendió" },
  "O que o agente sabe": { es: "Lo que el agente sabe" },
  "Não publicado": { es: "No publicado" },
  "Conexão do WhatsApp caiu — precisa escanear o QR de novo": {
    es: "Se cayó la conexión de WhatsApp: escanea el QR de nuevo",
  },
  "Uma tarefa do assistente falhou e parou de tentar": {
    es: "Una tarea del asistente falló y dejó de intentarlo",
  },
  "Um evento recebido não pôde ser processado": { es: "Un evento recibido no se pudo procesar" },
  "O orçamento de IA foi atingido": { es: "Se alcanzó el presupuesto de IA" },
  "O assistente passou um atendimento para um humano": {
    es: "El asistente transfirió una conversación a una persona",
  },
  "Proposta de melhoria do assistente aguardando sua revisão": {
    es: "Propuesta de mejora del asistente pendiente de tu revisión",
  },
  "O avaliador de qualidade precisa de recalibragem": {
    es: "El evaluador de calidad necesita recalibración",
  },
  "Um fluxo de follow-up parou de tentar": { es: "Un flujo de follow-up dejó de intentarlo" },
  "O lead não respondeu no prazo que você definiu": {
    es: "El lead no respondió en el plazo que definiste",
  },
  "Próxima ação sem negócio definido — precisa da sua escolha": {
    es: "Próxima acción sin negocio definido — necesita que elijas",
  },
  "Negócios que já estavam parados — precisam de uma decisão": {
    es: "Negocios que ya estaban estancados: necesitan una decisión",
  },
  "A sugestão de retomar contato venceu — decida": {
    es: "La sugerencia de retomar contacto venció — decide",
  },
  "Um atendimento saiu sem as ferramentas que você ligou": {
    es: "Una conversación salió sin las capacidades que activaste",
  },
  "Uma resposta ficou presa e não chegou ao cliente": {
    es: "Una respuesta quedó atascada y no llegó al cliente",
  },
  "O agente não conseguiu ler uma foto ou áudio que o cliente enviou": {
    es: "El agente no pudo leer una foto o un audio que envió el cliente",
  },
  "Um modelo de mensagem mudou de situação na revisão": {
    es: "Una plantilla de mensaje cambió de estado en la revisión",
  },
  "Seu número de WhatsApp precisa de atenção": { es: "Tu número de WhatsApp necesita atención" },
  "O assistente prometeu algo a um cliente e ninguém ficou responsável": {
    es: "El asistente le prometió algo a un cliente y nadie quedó a cargo",
  },
  "Uma informação que o assistente ouviu de um cliente venceu sem ninguém conferir": {
    es: "Una información que el asistente escuchó de un cliente venció sin que nadie la revisara",
  },
  "O gasto de IA passou do aviso que você definiu": {
    es: "El gasto de IA superó el aviso que definiste",
  },
  "Um material que você enviou não entrou na base de conhecimento": {
    es: "Un material que enviaste no entró en la base de conocimiento",
  },
  "Aviso do assistente": { es: "Aviso del asistente" },
  // `informativo` e `crítico` saem iguais nos dois idiomas — sem linha, por isso.
  "atenção": { es: "atención" },
  // ─── lib/ai/agent-inbox-copy.ts (copyDaPromessaSemDono) ───
  "O assistente prometeu algo ao cliente e ninguém ficou responsável": {
    es: "El asistente prometió algo al cliente y nadie quedó a cargo",
  },
  "Nesta conversa o assistente combinou algo com o cliente. Ele ainda não tem nenhuma capacidade marcada para registrar isso no sistema, então nada foi agendado nem anotado. Abra a conversa para ver o que foi combinado — e, na tela do assistente, marque o que ele pode fazer.": {
    es: "En esta conversación el asistente acordó algo con el cliente. Como aún no tiene ninguna capacidad marcada para registrarlo en el sistema, no se programó ni se anotó nada. Abre la conversación para ver qué se acordó y, en la pantalla del asistente, marca lo que puede hacer.",
  },
  "Nesta conversa o assistente combinou algo com o cliente e não registrou nenhum próximo passo para isso — não há retorno agendado. Abra a conversa, veja o que foi combinado e decida quem faz.": {
    es: "En esta conversación el asistente acordó algo con el cliente y no dejó registrado ningún siguiente paso, ni hay un seguimiento programado. Abre la conversación, revisa qué se acordó y decide quién se encarga.",
  },
  "Nesta conversa o assistente combinou algo com o cliente, e a parte que organiza o sistema não rodou neste atendimento. Nada foi agendado. Abra a conversa para ver o que foi combinado e decida quem faz.": {
    es: "En esta conversación el asistente acordó algo con el cliente, pero la parte que organiza el sistema no se ejecutó en esta atención. No se programó nada. Abre la conversación para ver qué se acordó y decide quién se encarga.",
  },

  // ─── Estado do material do acervo (components/ai/SourceStatusBadge.tsx) ───
  //
  // A 1.8.0 reescreveu os seis rótulos e criou dois estados novos
  // (`indexando`, `sem_credencial`). O `t(label)` do componente sobreviveu ao
  // merge intacto — o que não sobreviveu foi a correspondência com o
  // dicionário, porque as CHAVES mudaram. Mesma classe da seção acima.
  "O agente já sabe": { es: "El agente ya lo sabe" },
  "Esperando a chave": { es: "Esperando la clave" },
  "Entrou pela metade": { es: "Entró a medias" },
  "Ainda não preparado": { es: "Todavía sin preparar" },
  // `Arquivado` não entra aqui: já existe lá em cima, sem aspas na chave.

  // ─── Navegação do painel de plataforma (components/admin/AdminSidebar.tsx) ───
  //
  // O único rótulo novo da 1.8.0 que NÃO é o empréstimo do inglês que esta
  // barra adota por convenção (Dashboard, Tenants, Audit…): é o nome próprio do
  // produto do Google, que muda de idioma — "Google Agenda" em pt-BR é
  // "Google Calendar" em espanhol.
  "Google Agenda": { es: "Google Calendar" },

  // ─── Acervo de conhecimento da 1.8.0 (PR #354) — telas novas do merge ───
  //
  // As cinco telas que a 1.8.0 trouxe (`NovoMaterialDialog`,
  // `ChaveDeConhecimento`, `EditarFaqDialog`, `TrechosDoMaterialDialog` e
  // `BasesDoAgente`) chegaram sem uma chamada de `t()` — 857 linhas de tela
  // nova em português. Junto vão os dois catálogos fechados que elas leem:
  // `TIPOS_DE_FONTE` (lib/ai/rag/tipos-de-fonte.ts) e `EXPLICACAO_DA_ORIGEM`
  // (lib/ai/embeddings/chave.ts), traduzidos no ponto de render, sem tocar
  // nos módulos — mesma fronteira dos outros vocabulários deste arquivo.
  //
  // Fora daqui de propósito: os avisos de `chave.ts` que interpolam contagem
  // ou nome de modelo (chave literal não casa com texto que muda por
  // requisição) e os dois EXEMPLOS do campo de conteúdo, presos ao regex de
  // língua fixa de `lib/ai/rag/ingest/faq.ts`.
  "trecho": { es: "fragmento" },
  "trechos": { es: "fragmentos" },
  "está marcado mas ainda não foi preparado — o agente não vai achar nada nele.": { es: "está marcado, pero todavía no se ha preparado. El agente no encontrará nada en él." },
  "materiais marcados ainda não foram preparados — o agente não vai achar nada neles.": { es: "materiales marcados todavía no se han preparado. El agente no encontrará nada en ellos." },
  "Ver o acervo": { es: "Ver el acervo" },
  "Chave da OpenAI": { es: "Clave de OpenAI" },
  "Cole a chave inteira antes de salvar.": { es: "Pega la clave completa antes de guardar." },
  "Chave salva. Estamos conferindo com a OpenAI — leva alguns segundos.": { es: "Clave guardada. La estamos verificando con OpenAI. Tardará unos segundos." },
  "Usando a chave": { es: "Usando la clave" },
  "Ela é guardada cifrada e nunca aparece de volta na tela.": { es: "Se guarda cifrada y nunca vuelve a aparecer en pantalla." },
  "Salvar chave": { es: "Guardar clave" },
  "Não achei nenhum par pergunta/resposta. Use uma linha": { es: "No encontré ningún par pregunta/respuesta. Usa una línea" },
  "por item.": { es: "por elemento." },
  "Conteúdo salvo. Estou preparando de novo — leva alguns instantes.": { es: "Contenido guardado. Lo estoy preparando de nuevo. Tardará unos instantes." },
  "Dê um nome ao material — é assim que você o encontra depois.": { es: "Ponle un nombre al material — así lo encuentras después." },
  "Envie um arquivo ou cole o conteúdo.": { es: "Envía un archivo o pega el contenido." },
  "Não consegui guardar o arquivo.": { es: "No pude guardar el archivo." },
  "Material cadastrado. Estou preparando — em instantes o agente já sabe.": { es: "Material registrado. Lo estoy preparando; en unos instantes el agente ya lo sabrá." },
  "Material cadastrado. Ele fica esperando a chave da OpenAI para ser preparado.": { es: "Material registrado. Queda a la espera de la clave de OpenAI para prepararse." },
  "Ensinar algo novo ao agente": { es: "Enseñarle algo nuevo al agente" },
  "Nome do material": { es: "Nombre del material" },
  "Perguntas frequentes da loja": { es: "Preguntas frecuentes de la tienda" },
  "Política de troca": { es: "Política de cambios" },
  "Arquivo (opcional)": { es: "Archivo (opcional)" },
  "Adicionar ao acervo": { es: "Agregar al acervo" },
  "O que o agente aprendeu de": { es: "Lo que el agente aprendió de" },
  "Trecho": { es: "Fragmento" },
  "Uma tela não folheia mil pedaços — o restante está no acervo e o agente alcança todos.": { es: "Una pantalla no puede mostrar mil fragmentos. El resto está en el acervo y el agente accede a todos." },
  "Perguntas e respostas": { es: "Preguntas y respuestas" },
  "As dúvidas que se repetem, com a resposta pronta. É o formato que o agente cita melhor, porque cada resposta chega inteira.": { es: "Las dudas que se repiten, con la respuesta lista. Es el formato que el agente cita mejor, porque cada respuesta llega entera." },
  "Um texto do seu negócio — política de troca, tabela de preços, manual, contrato. Envie o arquivo (PDF, Markdown, CSV ou texto) ou cole o conteúdo.": { es: "Un texto de tu negocio — política de cambios, lista de precios, manual, contrato. Envía el archivo (PDF, Markdown, CSV o texto) o pega el contenido." },
  "Conversas anteriores": { es: "Conversaciones anteriores" },
  "Atendimentos já resolvidos que alguém marcou como aproveitáveis, com os dados pessoais removidos.": { es: "Conversaciones ya resueltas que alguien marcó como aprovechables, con los datos personales eliminados." },
  "Entra sozinha: conversas resolvidas que alguém marcar como aproveitáveis pela IA são anonimizadas e indexadas em lote.": { es: "Entra sola: las conversaciones resueltas que alguien marque como aprovechables por la IA se anonimizan y se indexan en lote." },
  "Catálogo de produtos": { es: "Catálogo de productos" },

  // ─── Moeda da organização (Configurações › Organização, migration 0206) ───
  //
  // O RÓTULO das opções do seletor não tem chave de propósito: é código ISO +
  // símbolo ("MXN · $"), que não se traduz. A primeira versão usava nomes
  // ("Peso mexicano") por chave DINÂMICA, que o guarda do AST não enxerga —
  // passariam no CI e cairiam no português na tela em espanhol.
  "Moeda": { es: "Moneda" },
  "País": { es: "País" },
  "De onde saem o documento do contato, a lei citada no documento de acesso e o prazo em dias úteis. Só aparecem países com a lei revisada — a lista é curta de propósito.": {
    es: "De aquí salen el documento del contacto, la ley citada en el documento de acceso y el plazo en días hábiles. Solo aparecen países con la ley revisada: la lista es corta a propósito.",
  },
  "Vale para todo preço do catálogo. Produto já cadastrado guarda a moeda com que nasceu.": {
    es: "Se aplica a todos los precios del catálogo. Un producto ya registrado conserva la moneda con la que se creó.",
  },
  "Os produtos sincronizados da sua loja, com preço, descrição e disponibilidade.": { es: "Los productos sincronizados de tu tienda, con precio, descripción y disponibilidad." },
  "Entra sozinho: os produtos vêm da sincronização com a sua loja, não de conteúdo digitado aqui.": { es: "Entra solo: los productos vienen de la sincronización con tu tienda, no de contenido escrito aquí." },
  "Escolhida por você no painel de Provedores.": { es: "La elegiste en el panel de Proveedores." },
  "Usando a chave OpenAI cadastrada em Credenciais.": { es: "Usando la clave de OpenAI registrada en Credenciales." },
  "Usando o gateway de IA configurado nesta instalação.": { es: "Usando el gateway de IA configurado en esta instalación." },
  "Usando a chave que veio na instalação.": { es: "Usando la clave que vino con la instalación." },
  "A chave escolhida no painel de Provedores para este ponto não está utilizável (desativada, apagada ou ainda não validada). Seguindo com a próxima chave disponível.": { es: "La clave que elegiste en el panel de Proveedores para este punto no se puede usar (está desactivada, eliminada o aún sin validar). Se usará la siguiente clave disponible." },

  // ─── Acervo: a listagem (app/app/ai/knowledge/sources/_client.tsx) ───
  //
  // Este arquivo escapou das DUAS varreduras do merge: não é arquivo NOVO (a
  // 1.8.0 o modificou), e não estava entre os que 'os dois lados tocaram'
  // porque o nosso lado nunca o tocou — ele já vinha sem i18n de antes. Um
  // arquivo com ZERO chamadas de `t()` também é invisível para o conferidor de
  // chaves, que só sabe achar `t()` cuja chave falta. Achado por QA visual: o
  // cartão da chave aparecia em espanhol e a lista logo abaixo, em português.
  "no acervo.": { es: "en el acervo." },
  "Adicionar material": { es: "Agregar material" },
  "arquivado": { es: "archivado" },
  "arquivados": { es: "archivados" },

  // ═══ A Agenda, do PR #379 ═══
  //
  // Contribuição de @JowaniOrantes: as 71 entradas do módulo de Agenda —
  // grade, marcação, histórico, filtro de pessoas e o cartão da conexão com o
  // Google. Vocabulário herdado dos passes anteriores de propósito:
  // agendamento→cita, atendente→agente, marcar→agendar.
  "MMMM 'de' yyyy": { es: "MMMM 'de' yyyy" },
  "d 'de' MMM": { es: "d 'de' MMM" },
  "d 'de' MMMM": { es: "d 'de' MMMM" },
  "EEEE, d 'de' MMMM": { es: "EEEE, d 'de' MMMM" },
  "EEEE, d 'de' MMM": { es: "EEEE, d 'de' MMM" },
  "Cancelando…": { es: "Cancelando…" },
  "Agenda conectada:": { es: "Agenda conectada:" },
  "Conectar Google": { es: "Conectar Google" },
  "atendido por": { es: "atendido por" },

  // ─── Agenda (módulo inteiro: grade, marcação, histórico, tipos, Google) ───
  //
  // A Agenda nasceu depois do inventário de telas que guiou a tradução do resto
  // do produto, então nunca teve uma linha aqui: ~3.500 linhas de tela em
  // português, com o item já visível na barra lateral.
  //
  // Os CATÁLOGOS fechados que ela lê (`ROTULO_DA_SITUACAO` em lib/agenda/tipos.ts,
  // `DESFECHOS` do retorno do OAuth, as categorias de tipo de agendamento) são
  // traduzidos no ponto de render — os módulos não mudam, mesma fronteira dos
  // outros vocabulários deste arquivo.
  //
  // VOZ: tuteo, o padrão deste arquivo — as entradas do composer que estavam em
  // voseo já foram corrigidas antes deste bloco.
  //
  // VOCABULÁRIO: "agendamento" → "cita", que é o que este dicionário já usava
  // (11 ocorrências contra 1). A exceção é o estado vazio da Agenda, que diz
  // "Los agendamientos" — entrada que NÃO é deste bloco e por isso fica como
  // está; trocá-la é decisão de quem a escreveu, e vai anotada no PR.
  "Novo agendamento": { es: "Nueva cita" },
  "Remarcar agendamento": { es: "Reagendar cita" },
  "Cancelar agendamento": { es: "Cancelar cita" },
  "Este agendamento não está mais na lista.": { es: "Esta cita ya no está en la lista." },
  "Agendamento": { es: "Cita" },
  "d 'de' MMMM 'às' HH:mm": { es: "d 'de' MMMM 'a las' HH:mm" },
  "EEEE, d 'de' MMMM 'às' HH:mm": { es: "EEEE, d 'de' MMMM 'a las' HH:mm" },
  "Conectar de novo": { es: "Conectar de nuevo" },
  "Fechar aviso": { es: "Cerrar aviso" },
  // A conjunção da lista de credenciais que faltam ("client_id e client_secret").
  "as credenciais": { es: "las credenciales" },
  "Cadastrar as credenciais do Google": { es: "Registrar las credenciales de Google" },
  "Agenda do Google conectada.": { es: "Agenda de Google conectada." },
  "Os compromissos que já estão lá aparecem aqui, e o que você marcar vai para lá.": { es: "Las citas que ya están allá aparecen aquí, y las que programes aquí también se guardan allá." },
  "Você cancelou a conexão.": { es: "Cancelaste la conexión." },
  "Nada mudou. Quando quiser, é só conectar de novo.": { es: "No cambió nada. Cuando quieras, solo conecta de nuevo." },
  "Esta instalação ainda não tem a conexão com o Google configurada": { es: "Esta instalación todavía no tiene configurada la conexión con Google" },
  "Não consegui guardar a conexão com segurança": { es: "No pude guardar la conexión de forma segura" },
  "A conexão demorou demais e expirou": { es: "La conexión tardó demasiado y expiró" },
  "Isso acontece quando a página fica aberta muito tempo. Conectar de novo resolve.": { es: "Esto pasa cuando la página queda abierta mucho tiempo. Conectar de nuevo lo resuelve." },
  "O Google devolveu uma resposta incompleta": { es: "Google devolvió una respuesta incompleta" },
  "Não deu para concluir a conexão. Tentar de novo costuma resolver.": { es: "No se pudo concluir la conexión. Intentar de nuevo suele resolverlo." },
  "O Google não confirmou a conexão": { es: "Google no confirmó la conexión" },
  "Não consegui ler os dados da conta do Google": { es: "No pude leer los datos de la cuenta de Google" },
  "A conexão foi autorizada, mas o Google não respondeu quem é a conta. Tente de novo.": { es: "La conexión se autorizó, pero Google no indicó a qué cuenta corresponde. Inténtalo de nuevo." },
  "A conexão funcionou, mas não consegui salvar": { es: "La conexión funcionó, pero no pude guardarla" },
  "Faltou permissão para ler e escrever na sua agenda": { es: "Faltó permiso para leer y escribir en tu agenda" },
  "Na tela do Google, algumas permissões ficaram desmarcadas. Sem elas eu não consigo ver seus horários ocupados nem enviar os agendamentos. Conecte de novo e mantenha as caixas marcadas.": { es: "En la pantalla de Google, algunos permisos quedaron sin marcar. Sin ellos no puedo ver tus horarios ocupados ni enviar las citas. Conecta de nuevo y deja las casillas marcadas." },
  "Não consegui conectar sua agenda do Google": { es: "No pude conectar tu agenda de Google" },
  "O resto da agenda continua funcionando normalmente. Tentar de novo costuma resolver.": { es: "El resto de la agenda sigue funcionando normalmente. Intentar de nuevo suele resolverlo." },
  "Tipo de agendamento criado.": { es: "Tipo de cita creado." },
  "Retorno": { es: "Seguimiento" },
  "Criar tipo": { es: "Crear tipo" },
  "Novo tipo de agendamento": { es: "Nuevo tipo de cita" },
  "desativado": { es: "desactivado" },
  "Procedimento": { es: "Procedimiento" },
  "Vistoria": { es: "Inspección" },
  "Reunião": { es: "Reunión" },
  "Demonstração": { es: "Demostración" },
  "Outro": { es: "Otro" },
  "Consulta": { es: "Consulta" },
  "Visita": { es: "Visita" },
  "Call": { es: "Call" },
  "Presencial": { es: "Presencial" },
  "Link de vídeo": { es: "Enlace de video" },
  "Mostrar todos (agora só": { es: "Mostrar todos (ahora solo" },
  "Ver só a agenda de": { es: "Ver solo la agenda de" },
  "com": { es: "con" },
  "ocupado na agenda do Google": { es: "ocupado en la agenda de Google" },
  "Dia": { es: "Día" },
  "Mês": { es: "Mes" },
  "Próximos": { es: "Próximas" },
  "Aguardando confirmação": { es: "Esperando confirmación" },
  "Passados": { es: "Pasadas" },
  "Cancelados": { es: "Canceladas" },
  "Disponível quando a agenda estiver conectada": { es: "Disponible cuando la agenda esté conectada" },
  "Realizado": { es: "Realizada" },
  "Faltou": { es: "No asistió" },
  "Confirmado": { es: "Confirmada" },
  "Não compareceu": { es: "No se presentó" },
  "fora deste mês": { es: "fuera de este mes" },
  "você ainda não publicou seus horários": { es: "todavía no publicaste tus horarios" },
  "não consegui carregar os horários": { es: "no pude cargar los horarios" },
  "nenhum horário livre neste dia": { es: "ningún horario libre en este día" },
  // O encaixe no painel de marcação (#858): a pessoa digita um horário fora da grade.
  "Outro horário": { es: "Otro horario" },
  "Usar": { es: "Usar" },
  "nenhum horário publicado neste dia": { es: "ningún horario publicado en este día" },
  "Nenhum horário publicado neste dia.": { es: "Ningún horario publicado en este día." },
  "Vale fora dos horários publicados. A agenda só recusa se o horário já estiver ocupado.": {
    es: "Puedes elegir un horario fuera de los publicados. La agenda solo lo rechaza si ya está ocupado.",
  },
  "Não foi marcado. Tente de novo.": { es: "No se programó la cita. Inténtalo de nuevo." },
  "Marcar outro": { es: "Agendar otra cita" },
  "Ver na agenda": { es: "Ver en la agenda" },
  "horários": { es: "horarios" },
  "Carregando a agenda": { es: "Cargando la agenda" },

  // ═══ O que a reconciliação dos três PRs deixou a descoberto ═══
  //
  // Cinco chamadas `t()` que os merges trouxeram sem a chave correspondente —
  // o texto era embrulhado e caía no português —, mais a saída do onboarding
  // que a `main` acrescentou depois do último passe de tradução. Foi o guarda
  // de AST que apontou as seis, uma a uma; nenhuma apareceria abrindo tela.
  "Preparado": { es: "Preparado" },
  "Consultado por": { es: "Consultado por" },
  "Preparando…": { es: "Preparando…" },
  "Guardando…": { es: "Guardando…" },
  "tokens": { es: "tokens" },
  "Voltar para": { es: "Volver a" },
  "Ir para outra organização": { es: "Ir a otra organización" },

  // ─── Catálogo de produtos (app/app/products) ───
  //
  // O catálogo é a resposta do agente para "quanto custa". Quem opera uma loja
  // em espanhol vê a mesma tela; um preço explicado em português numa tela
  // espanhola é a primeira coisa que faz alguém desconfiar do sistema.
  "Produtos": { es: "Productos" },
  "O catálogo da loja. É daqui que o atendente de IA tira o preço quando alguém pergunta.": {
    es: "El catálogo de la tienda. El asistente de IA toma de aquí el precio cuando alguien pregunta.",
  },
  "Nenhum produto cadastrado ainda": { es: "Aún no hay productos registrados" },
  "Enquanto o catálogo estiver vazio, o atendente responde que não encontrou o produto — mesmo que a loja tenha.": {
    es: "Mientras el catálogo esté vacío, el asistente responderá que no encontró el producto, aunque la tienda lo tenga.",
  },
  "Buscar por nome, código ou marca": { es: "Buscar por nombre, código o marca" },
  "Novo produto": { es: "Nuevo producto" },
  "Importar planilha": { es: "Importar hoja de cálculo" },
  "Baixar planilha modelo": { es: "Descargar plantilla" },
  "Produto cadastrado": { es: "Producto registrado" },
  "Produto desativado": { es: "Producto desactivado" },
  "Produto reativado": { es: "Producto reactivado" },
  "Não consegui ler essa planilha.": { es: "No pude leer esa hoja de cálculo." },
  "Não consegui enviar o arquivo.": { es: "No pude enviar el archivo." },
  "Preço inválido. Escreva assim: 5.499,00": { es: "Precio inválido. Escríbelo así: 5.499,00" },
  "Custo inválido.": { es: "Costo inválido." },
  "novos": { es: "nuevos" },
  "atualizados": { es: "actualizados" },
  "linhas na planilha": { es: "filas en la hoja" },
  "Não usei estas colunas:": { es: "No usé estas columnas:" },
  "Linhas que não entraram:": { es: "Filas que no se importaron:" },
  "…e mais": { es: "…y más" },
  "Código": { es: "Código" },
  "Preço de venda": { es: "Precio de venta" },
  "(opcional)": { es: "(opcional)" },
  "Serve para o atendente saber até onde pode negociar. Não aparece para o cliente.": {
    es: "Sirve para que el asistente sepa hasta dónde puede negociar. No se muestra al cliente.",
  },
  "Controlar estoque deste produto": { es: "Controlar el inventario de este producto" },
  "Quantidade": { es: "Cantidad" },
  "Sem controle de estoque, este produto sempre aparece como disponível para o atendente — é o certo para item sob encomenda ou fracionado.": {
    es: "Sin control de inventario, este producto siempre aparece como disponible para el asistente. Es lo indicado para artículos por encargo o fraccionados.",
  },
  "Salvar produto": { es: "Guardar producto" },
  "em estoque": { es: "en inventario" },
  "sem controle de estoque": { es: "sin control de inventario" },

  // Chamada de voz WhatsApp (WaCalls, spec 18)
  // "Chamar", não "Ligar" — a chave já existe com outro sentido (ativar/toggle,
  // linha ~3725: "Ligar" -> "Activar"). Mesma palavra em PT, contextos
  // diferentes; o dicionário é chaveado pelo texto, não por significado, então
  // a colisão vira TS1117 (chave duplicada) se as duas usarem a mesma string.
  "Chamar": { es: "Llamar" },
  "Em ligação": { es: "En llamada" },
  "Chamada de voz recebida": { es: "Llamada de voz recibida" },
  "Recusar chamada": { es: "Rechazar llamada" },
  "Atender chamada": { es: "Atender llamada" },
  "Chamando…": { es: "Llamando…" },
  // "Conectando…" já existe (linha ~3708, saúde do canal) com a MESMA
  // tradução — reaproveitado, não duplicado aqui.
  "Chamada em andamento": { es: "Llamada en curso" },
  "Reativar microfone": { es: "Reactivar micrófono" },
  "Silenciar microfone": { es: "Silenciar micrófono" },
  "Encerrar chamada": { es: "Finalizar llamada" },
  // Estado do TRANSPORTE de áudio, não da ligação — ver
  // `hooks/voice/useVoiceCallSession.ts` (`EstadoDaMidia`).
  "Abrindo o áudio…": { es: "Abriendo el audio…" },
  "Sem áudio: o canal de voz não abriu": { es: "Sin audio: el canal de voz no se abrió" },
  "O áudio desta ligação está em outra aba": { es: "El audio de esta llamada está en otra pestaña" },
  "Ouvir aqui": { es: "Escuchar aquí" },
  "O áudio caiu": { es: "El audio se cayó" },
  "Não consegui abrir o áudio. Confira o microfone.": { es: "No pude abrir el audio. Revisa el micrófono." },
  "Reconectar o áudio": { es: "Reconectar el audio" },
  "Chamada de voz": { es: "Llamada de voz" },
  "Chamada de voz sem resposta": { es: "Llamada de voz sin respuesta" },
  "A chamada de voz não está configurada.": { es: "La llamada de voz no está configurada." },
  "Falta o endereço do serviço (": { es: "Falta la dirección del servicio (" },
  ") nas variáveis de ambiente desta instalação.": {
    es: ") en las variables de entorno de esta instalación.",
  },
  "Chamada de voz por WhatsApp": { es: "Llamada de voz por WhatsApp" },
  "Um segundo aparelho vinculado ao mesmo número já conectado, só para ligar e atender chamadas. Escaneie uma vez para ativar.":
    {
      es: "Un segundo dispositivo vinculado al mismo número ya conectado, solo para hacer y recibir llamadas. Escanea una vez para activarlo.",
    },
  "Não pareado": { es: "No emparejado" },
  "Aparelho pareado": { es: "Dispositivo emparejado" },
  "QR Code para parear chamada de voz": { es: "Código QR para emparejar llamada de voz" },
  "Parear chamada de voz": { es: "Emparejar llamada de voz" },
  "Risco aceito: um segundo aparelho vinculado ao mesmo número pode ser sinalizado pelo WhatsApp.":
    {
      es: "Riesgo aceptado: WhatsApp podría señalar un segundo dispositivo vinculado al mismo número.",
    },
  "Pronto para ligar — o botão de chamar aparece nos contatos com telefone.": {
    es: "Listo para llamar. El botón de llamada aparece en los contactos que tienen teléfono.",
  },
  "Chamada de voz pareada!": { es: "¡Llamada de voz emparejada!" },
  // Central de avisos: o RÓTULO DO KIND e a ORIENTAÇÃO passam por `t()`; o
  // título e o corpo do aviso NÃO — são linha de `agent_inbox_items`, escrita
  // pelo worker com dado de gente dentro (o telefone de quem ligou), e o
  // dicionário é chaveado pela frase inteira. Mesma regra de todo kind irmão:
  // nenhum título de aviso está aqui.
  "Alguém ligou e ninguém atendeu": { es: "Alguien llamó y nadie atendió" },
  "Retorne a ligação quando puder — quem ligou não foi atendido.": {
    es: "Devuelve la llamada cuando puedas: nadie atendió a quien llamó.",
  },
  "Ligar de volta": { es: "Devolver la llamada" },
  // Diálogo de exclusão de canal (`frasesDoImpacto`): singular e plural.
  "chamada de voz": { es: "llamada de voz" },
  "chamadas de voz": { es: "llamadas de voz" },
  "Não foi possível iniciar o pareamento.": { es: "No se pudo iniciar el emparejamiento." },
  "O código de pareamento venceu. Clique em parear para gerar outro.": {
    es: "El código de emparejamiento venció. Haz clic en Emparejar para generar otro.",
  },
  "Não foi possível receber o código de pareamento. Tente novamente.": {
    es: "No se pudo obtener el código de emparejamiento. Inténtalo de nuevo.",
  },

  // Mensajes de error de importación de planilha (lib/catalogo/planilha.ts)
  "A planilha está vazia.": { es: "La hoja de cálculo está vacía." },
  // Uma frase por combinação do que falta: a recusa NOMEIA a coluna ausente, e
  // pedir a coluna que a pessoa já tem é o que faz ela desistir da importação.
  "A planilha precisa de uma coluna de nome e de preço. Encontrei: ": {
    es: "La hoja necesita una columna de nombre y otra de precio. Encontré: ",
  },
  "A planilha precisa de uma coluna de nome. Encontrei: ": {
    es: "La hoja necesita una columna de nombre. Encontré: ",
  },
  "A planilha precisa de uma coluna de preço. Encontrei: ": {
    es: "La hoja necesita una columna de precio. Encontré: ",
  },
  "sem nome do produto": { es: "sin nombre de producto" },
  "preço não reconhecido (": { es: "precio no reconocido (" },
  " — escreva assim: 5.499,00": { es: " — escríbelo así: 5.499,00" },
  "custo não reconhecido (": { es: "costo no reconocido (" },
  'código repetido na planilha ("{codigo}") — já está na linha {linha}': {
    es: 'código repetido en la hoja ("{codigo}") — ya está en la fila {linha}',
  },
  'código repetido na planilha ("{codigo}") — já está na linha {linha}, escrito "{anterior}". Maiúsculas e minúsculas não mudam o código.': {
    es: 'código repetido en la hoja ("{codigo}") — ya está en la fila {linha}, escrito "{anterior}". Mayúsculas y minúsculas no cambian el código.',
  },
  ": este código já está no catálogo escrito ": { es: ": este código ya está en el catálogo escrito " },
  ". Maiúsculas e minúsculas não mudam o código — escreva igual ao do catálogo para atualizar o produto.": {
    es: ". Mayúsculas y minúsculas no cambian el código — escríbelo igual que en el catálogo para actualizar el producto.",
  },
  "nenhuma coluna": { es: "ninguna columna" },

  // ─── Análise → Meta Ads e Configurações → Meta Ads (0214) ───
  //
  // ⚠️ Boa parte deste bloco o teste `i18n-espanhol-cobre-a-tela` NÃO cobre, e
  // isso é uma propriedade dele, não uma falha: ele varre o AST atrás de
  // `t("literal")`, e aqui metade das strings chega por variável — `t(rotulo)`,
  // `t(ESTADO_LEGIVEL[valor])`, `t(MENSAGEM_POR_CODIGO[code])`. São justamente
  // as que preenchem a tabela e as que explicam a falha. Esquecê-las deixaria a
  // tela em espanhol com cabeçalho traduzido e conteúdo em português, com o CI
  // verde. Ao mexer nos mapas daqueles arquivos, volte aqui.
  "Meta Ads": { es: "Meta Ads" },
  "O desempenho das campanhas que estão trazendo gente para cá. Os números vêm da plataforma no momento em que você clica em Atualizar — nada fica guardado aqui.":
    { es: "El rendimiento de las campañas que traen gente hasta aquí. Los números se obtienen de la plataforma cuando haces clic en Actualizar. Aquí no se guarda nada." },
  "Nenhuma conta de anúncios conectada.": { es: "Ninguna cuenta publicitaria conectada." },
  "Conecte um token de acesso com permissão de leitura de anúncios para ver as campanhas aqui.":
    { es: "Conecta un token de acceso con permiso de lectura de anuncios para ver las campañas aquí." },
  "Peça a quem administra a organização para conectar a conta de anúncios em Configurações.":
    { es: "Pide a quien administra la organización que conecte la cuenta publicitaria en Configuración." },
  "Conectar conta de anúncios": { es: "Conectar cuenta publicitaria" },

  // Seletores e rodapé da tela
  "Conta de anúncios": { es: "Cuenta publicitaria" },
  "Últimos 14 dias": { es: "Últimos 14 días" },
  "Carregando campanhas…": { es: "Cargando campañas…" },
  "lido em": { es: "consultado el" },
  a: { es: "a" },
  // `Código` NÃO se repete aqui: o bloco do catálogo de produtos já o traz,
  // com o mesmo valor. Chave repetida num literal de objeto é erro de tipo.
  Requisição: { es: "Solicitud" },
  "Não consegui carregar os dados agora.": { es: "No pude cargar los datos ahora." },

  // Colunas da tabela
  Campanha: { es: "Campaña" },
  Veiculação: { es: "Entrega" },
  "Custo por Resultado": { es: "Costo por Resultado" },
  "Valor Gasto": { es: "Importe Gastado" },
  Impressões: { es: "Impresiones" },
  Alcance: { es: "Alcance" },
  CPM: { es: "CPM" },
  CTR: { es: "CTR" },
  Frequência: { es: "Frecuencia" },
  CPC: { es: "CPC" },
  // Coluna derivada nova (issue #920). O rótulo fica em inglês, como "Hook
  // Rate", "CPC" e "CTR": é o nome que o operador vê no Gerenciador de
  // Anúncios, e traduzir só aqui faria a mesma coluna ter dois nomes entre a
  // tela e o print que ele manda para o cliente. A fórmula vai no `title`.
  "Connect rate": { es: "Connect rate" },
  "Visualizações da página ÷ cliques no link": {
    es: "Visualizaciones de la página ÷ clics en el enlace",
  },
  "Hook Rate": { es: "Hook Rate" },
  "(reproduções)": { es: "(reproducciones)" },
  "Reproduções de vídeo ÷ impressões": { es: "Reproducciones de video ÷ impresiones" },
  ThruPlays: { es: "ThruPlays" },
  "Nenhuma campanha neste período. Ou a conta ainda não tem campanhas, ou elas foram criadas depois da data escolhida.":
    { es: "No hay campañas en este período. Puede que la cuenta aún no tenga campañas o que se hayan creado después de la fecha elegida." },

  // `effective_status` da campanha — chega por variável (ESTADO_LEGIVEL)
  Excluída: { es: "Eliminada" },
  "Em processamento": { es: "En procesamiento" },
  "Com problemas": { es: "Con problemas" },
  "Campanha pausada": { es: "Campaña pausada" },
  "Conjunto pausado": { es: "Conjunto pausado" },
  Reprovada: { es: "Rechazada" },
  "Em análise": { es: "En revisión" },
  "Pré-aprovada": { es: "Preaprobada" },
  "Aguardando dados de cobrança": { es: "En espera de datos de facturación" },

  // `account_status` da conta — chega por variável (STATUS_DA_CONTA)
  desativada: { es: "desactivada" },
  "pendência de cobrança": { es: "pendiente de pago" },
  "em análise de risco": { es: "en revisión de riesgo" },
  "aguardando pagamento": { es: "en espera de pago" },
  "em período de carência": { es: "en período de gracia" },
  "encerramento pendente": { es: "cierre pendiente" },
  encerrada: { es: "cerrada" },

  // Rótulos de "Resultado" — chegam por variável (ROTULO_POR_INDICADOR)
  "Conversas iniciadas": { es: "Conversaciones iniciadas" },
  "Primeiras respostas": { es: "Primeras respuestas" },
  Cadastros: { es: "Registros" },
  Compras: { es: "Compras" },
  "Registros concluídos": { es: "Registros completados" },
  "Adições ao carrinho": { es: "Agregados al carrito" },
  "Checkouts iniciados": { es: "Pagos iniciados" },
  "Cadastros de formulário": { es: "Registros de formulario" },
  "Cliques no link": { es: "Clics en el enlace" },
  "Visualizações da página": { es: "Visualizaciones de la página" },
  Engajamentos: { es: "Interacciones" },
  "Engajamentos da página": { es: "Interacciones de la página" },
  "Visualizações de vídeo": { es: "Reproducciones de video" },
  "Instalações do app": { es: "Instalaciones de la app" },

  // Falhas da plataforma — chegam por variável (MENSAGEM_POR_CODIGO)
  "A plataforma recusou o token de acesso — ele expirou ou foi revogado. Gere um novo em Configurações › Meta Ads.":
    { es: "La plataforma rechazó el token de acceso porque expiró o fue revocado. Genera uno nuevo en Configuración › Meta Ads." },
  "O token não tem permissão de leitura de anúncios (ads_read), ou não alcança esta conta. Refaça o token no Meta for Developers marcando essa permissão.":
    { es: "El token no tiene permiso de lectura de anuncios (ads_read) o no tiene acceso a esta cuenta. Vuelve a generarlo en Meta for Developers y marca ese permiso." },
  "A plataforma limitou as chamadas por excesso de consultas. Espere alguns minutos antes de atualizar de novo.":
    { es: "La plataforma limitó las llamadas por exceso de consultas. Espera unos minutos antes de actualizar de nuevo." },
  "A plataforma recusou um campo desta consulta. Isso é um problema do sistema, não da sua conta — avise quem mantém a instalação.":
    { es: "La plataforma rechazó un campo de esta consulta. Es un problema del sistema, no de tu cuenta. Avisa a quien mantiene la instalación." },
  "A chave de criptografia da instalação não está disponível, então o token guardado não pode ser lido. Isso é configuração do servidor.":
    { es: "La clave de cifrado de la instalación no está disponible, así que el token guardado no se puede leer. Es configuración del servidor." },
  "Não consegui falar com a plataforma agora. Tente atualizar em instantes.":
    { es: "No pude comunicarme con la plataforma ahora. Intenta actualizar en unos instantes." },
  "Seu papel não permite ver os dados de anúncios.":
    { es: "Tu rol no permite ver los datos de anuncios." },

  // Configurações → Meta Ads
  "Conecte um token de acesso para o sistema ler o desempenho das suas campanhas e mostrá-lo em Análise › Meta Ads. É uma conexão só de leitura: nada é criado, pausado ou alterado na sua conta de anúncios.":
    { es: "Conecta un token de acceso para que el sistema lea el rendimiento de tus campañas y lo muestre en Análisis › Meta Ads. Es una conexión solo de lectura: nada se crea, pausa ni modifica en tu cuenta publicitaria." },
  "O token precisa da permissão ads_read. Gere-o no Meta for Developers, na sua conta de aplicativo, e cole abaixo — ele fica guardado criptografado e nunca é mostrado de volta.":
    { es: "El token necesita el permiso ads_read. Genéralo en Meta for Developers, en tu aplicación, y pégalo abajo. Se guarda cifrado y nunca se vuelve a mostrar." },
  "Para trocar apenas a conta padrão, deixe o campo do token em branco — o token guardado é mantido.":
    { es: "Para cambiar solo la cuenta predeterminada, deja el campo del token en blanco. Se conserva el token guardado." },
  "Guardado — preencha só para trocar": { es: "Guardado — completa solo para cambiarlo" },
  "Já existe um token guardado. Deixe em branco para mantê-lo, ou cole um novo para substituir.":
    { es: "Ya existe un token guardado. Déjalo en blanco para mantenerlo, o pega uno nuevo para reemplazarlo." },
  "Precisa da permissão ads_read.": { es: "Necesita el permiso ads_read." },
  "Conta padrão (opcional)": { es: "Cuenta predeterminada (opcional)" },
  "A conta que a tela de Meta Ads abre por padrão. Em branco, ela abre a primeira conta ativa que o token alcançar.":
    { es: "La cuenta que se abre de forma predeterminada en la pantalla de Meta Ads. Si lo dejas en blanco, se abre la primera cuenta activa a la que tenga acceso el token." },
  "Cole o token para poder salvar.": { es: "Pega el token para poder guardar." },
  "Conta desconectada.": { es: "Cuenta desconectada." },
  "Desconectar apaga o token guardado. A tela de Meta Ads volta a pedir uma conexão, e nenhum dado histórico é perdido — nada é armazenado aqui.":
    { es: "Al desconectar, se borra el token guardado. La pantalla de Meta Ads volverá a pedir una conexión. No se pierde ningún dato histórico, porque aquí no se almacena nada." },
  "Não consegui desconectar agora.": { es: "No pude desconectar ahora." },

  // ─── ERRO_EM_PORTUGUES compartida por meta-ads/_form.tsx e conversoes/_form.tsx ───
  "Você não está em nenhuma organização ativa.": {
    es: "No estás en ninguna organización activa.",
  },
  "Só um administrador da organização pode mudar esta conexão.": {
    es: "Solo un administrador de la organización puede cambiar esta conexión.",
  },
  "Confirme o segundo fator para salvar esta mudança.": {
    es: "Confirma el segundo factor para guardar este cambio.",
  },
  "Esta instalação está sem a chave mestra de criptografia, e o token não foi gravado. Quem instalou o sistema precisa configurá-la — refazer o cadastro aqui não resolve.":
    {
      es: "Esta instalación no tiene la clave maestra de cifrado, así que el token no se guardó. Quien instaló el sistema debe configurarla; volver a registrar la conexión aquí no lo resuelve.",
    },
  "Não consegui gravar agora. Tente de novo em instantes.": {
    es: "No pude guardar ahora. Inténtalo de nuevo en unos instantes.",
  },

  // ─── Configurações → Conversões (0213) e o convidado da agenda (0212) ───
  //
  // Estas duas telas entraram na mesma leva do painel de Meta Ads e ficaram sem
  // espanhol: o `i18n-espanhol-cobre-a-tela` as pegou com 27 chamadas caindo no
  // português. Ao acrescentar campo em qualquer uma delas, volte aqui.
  //
  // ⚠️ `Conversões` também é o rótulo no menu lateral (`lib/navigation/registry.ts`),
  // e é a MESMA chave: mudar a tradução aqui muda os dois lugares.
  "Conversões": { es: "Conversiones" },
  "Quando um negócio que veio de anúncio é marcado como ganho, o valor da venda volta para a plataforma que trouxe o cliente. É esse retorno que ensina o anúncio a procurar mais gente parecida com quem comprou.":
    { es: "Cuando un negocio que llegó por un anuncio se marca como ganado, el valor de la venta se envía de vuelta a la plataforma que trajo al cliente. Así el anuncio aprende a buscar más personas parecidas a quienes compraron." },
  "O envio está pausado. As vendas continuam sendo registradas aqui, mas não vão para a plataforma enquanto isto estiver desligado.":
    { es: "El envío está en pausa. Las ventas se siguen registrando aquí, pero no se envían a la plataforma mientras esta opción esté desactivada." },
  "Modo de teste ligado: as vendas vão marcadas como teste e não contam para a otimização. Apague o código de teste quando terminar de conferir.":
    { es: "Modo de prueba activado: las ventas se envían marcadas como prueba y no cuentan para la optimización. Borra el código de prueba cuando termines de revisar." },
  "Vendas que não foram reportadas": { es: "Ventas sin reportar" },
  "reportadas com sucesso": { es: "reportadas con éxito" },
  "Nenhuma pendência. Ou tudo que veio de anúncio foi reportado, ou ainda não fechou nenhuma venda com origem em anúncio.":
    { es: "No hay pendientes. Todo lo que llegó de anuncios ya se reportó, o todavía no se ha cerrado ninguna venta que venga de un anuncio." },
  "Negócio": { es: "Negocio" },
  "O que houve": { es: "Qué pasó" },
  "(sem título)": { es: "(sin título)" },

  // Formulário da conexão de conversões
  "Conexão salva.": { es: "Conexión guardada." },
  "Identificador do destino de conversões": { es: "Identificador del destino de conversiones" },
  "Só números. Você encontra no gerenciador de anúncios, na fonte de dados que recebe as conversões.":
    { es: "Solo números. Lo encuentras en el administrador de anuncios, en la fuente de datos que recibe las conversiones." },
  "Gravado. Deixe em branco para manter.": { es: "Guardado. Déjalo en blanco para mantenerlo." },
  "Cole o token gerado na plataforma": { es: "Pega el token generado en la plataforma" },
  "Guardado criptografado. Ele nunca volta para esta tela depois de salvo.":
    { es: "Se guarda cifrado. Una vez guardado, nunca se vuelve a mostrar en esta pantalla." },
  "Código de teste (opcional)": { es: "Código de prueba (opcional)" },
  "Enquanto preenchido, as vendas vão marcadas como teste e não contam para a otimização. Apague quando terminar de conferir.":
    { es: "Mientras este campo tenga contenido, las ventas se envían marcadas como prueba y no cuentan para la optimización. Bórralo cuando termines de revisar." },
  "Reportar vendas automaticamente": { es: "Reportar ventas automáticamente" },
  "Desligar pausa o envio e mantém a credencial gravada.":
    { es: "Desactivarlo pausa el envío y conserva la credencial guardada." },
  "Salvar conexão": { es: "Guardar conexión" },
  "Preencha o identificador e o token para poder salvar.":
    { es: "Completa el identificador y el token para poder guardar." },

  // ─── Configurações → Conversões: card do Google Ads (migration 0307) ───
  "Google Ads": { es: "Google Ads" },
  "Autorize o acesso à conta de anúncios do Google. Depois de autorizar, você informa aqui qual conta e qual ação de conversão recebem as vendas.":
    { es: "Autoriza el acceso a la cuenta publicitaria de Google. Luego indica aquí qué cuenta y qué acción de conversión recibirán las ventas." },
  "Conectar com Google": { es: "Conectar con Google" },
  "Conta de anúncios (Customer ID)": { es: "Cuenta publicitaria (Customer ID)" },
  "10 dígitos. Com ou sem hífen — tanto faz, a gente limpa.":
    { es: "10 dígitos. Con o sin guiones, da igual: lo limpiamos por ti." },
  "Conta de gerente (opcional)": { es: "Cuenta de administrador (opcional)" },
  "Preencha só se você acessa a conta acima através de uma conta MCC/gerente.":
    { es: "Completa este campo solo si accedes a la cuenta anterior mediante una cuenta de administrador (MCC)." },
  "Ação de conversão": { es: "Acción de conversión" },
  "O ID da ação de conversão dentro da conta acima, que vai receber os envios de venda.":
    { es: "El ID de la acción de conversión, dentro de la cuenta anterior, que recibirá las ventas enviadas." },
  "Enviar vendas para o Google Ads": { es: "Enviar ventas a Google Ads" },
  "Google Ads autorizado. Agora informe a conta e a ação de conversão abaixo.":
    { es: "Google Ads autorizado. Ahora indica la cuenta y la acción de conversión abajo." },
  "Enviar vendas para o Google Ads ainda não está disponível nesta instalação — não é nada que você tenha feito. Quem instalou o sistema precisa configurar":
    { es: "Enviar ventas a Google Ads todavía no está disponible en esta instalación, y no se debe a nada que hayas hecho. Quien instaló el sistema debe configurar" },

  // Convidado do compromisso (agenda)
  "E-mail do convidado": { es: "Correo del invitado" },
  "opcional": { es: "opcional" },
  "cliente@empresa.com": { es: "cliente@empresa.com" },
  "Endereço inválido — confira antes de marcar.":
    { es: "Dirección de correo no válida. Revísala antes de programar la cita." },
  "O cliente com e-mail na ficha já recebe o convite. Preencha só se quiser chamar mais alguém.":
    {
      es: "Si el cliente tiene correo en su ficha, ya recibe la invitación. Completa este campo solo si quieres invitar a alguien más.",
    },
  "Rua, número, sala": { es: "Calle, número, sala" },
  "Onde o atendimento acontece. Digite para filtrar ou salvar para a próxima vez.":
    { es: "Dónde ocurre la atención. Escribe para filtrar o guardar para la próxima vez." },
  "Salvar para os próximos agendamentos": { es: "Guardar para las próximas citas" },
  "Não foi possível salvar o endereço. Tente novamente.":
    { es: "No se pudo guardar la dirección. Inténtalo de nuevo." },
  "Não foi possível carregar os endereços. Tente novamente.":
    { es: "No se pudieron cargar las direcciones. Inténtalo de nuevo." },
  "Observação": { es: "Observación" },
  "O que a equipe precisa lembrar neste horário": {
    es: "Lo que el equipo necesita recordar en este horario",
  },
  "Aparece na descrição do compromisso.": { es: "Aparece en la descripción de la cita." },

  // ─── Tarefas (extraídas do PR #418) ───
  "Tarefas": { es: "Tareas" },
  "O que ficou combinado, com prazo. Tarefa presa a um negócio aparece na linha do tempo dele.": {
    es: "Lo que quedó acordado, con plazo. Una tarea vinculada a un negocio aparece en su línea de tiempo.",
  },
  "O que ficou combinado, com prazo — e o que já venceu sem ninguém fazer.": {
    es: "Lo que quedó acordado, con plazo, y lo que ya venció sin que nadie lo hiciera.",
  },
  "Em aberto": { es: "Abiertas" },
  "Lista": { es: "Lista" },
  "Calendário": { es: "Calendario" },
  "Não foi possível carregar as tarefas.": { es: "No se pudieron cargar las tareas." },
  "Nova tarefa": { es: "Nueva tarea" },
  "Editar tarefa": { es: "Editar tarea" },
  "Atrasadas": { es: "Atrasadas" },
  "Esta semana": { es: "Esta semana" },
  "Mais tarde": { es: "Más tarde" },
  "Sem prazo": { es: "Sin plazo" },
  "Encerradas": { es: "Cerradas" },
  "Nenhuma tarefa por aqui": { es: "No hay tareas por aquí" },
  "Enquanto isto estiver vazio, o que foi combinado vive só na memória de alguém.": {
    es: "Mientras esto esté vacío, lo que se acordó vive solo en la memoria de alguien.",
  },
  "Marcar como concluída": { es: "Marcar como completada" },
  "Reabrir a tarefa": { es: "Reabrir la tarea" },
  "Editar a tarefa": { es: "Editar la tarea" },
  "Apagar a tarefa": { es: "Eliminar la tarea" },
  "O que precisa ser feito": { es: "Qué hay que hacer" },
  "Ex.: ligar de volta para fechar a proposta": { es: "Ej.: llamar de vuelta para cerrar la propuesta" },
  "O que você vai querer lembrar quando chegar a hora": {
    es: "Lo que vas a querer recordar cuando llegue el momento",
  },
  "Prazo": { es: "Plazo" },
  "Situação": { es: "Estado" },
  "Em andamento": { es: "En curso" },
  "Escreva um título para a tarefa.": { es: "Escribe un título para la tarea." },
  "Não foi possível salvar a tarefa.": { es: "No se pudo guardar la tarea." },

  // ─── app/api/v1/tasks/**/route.ts (mensagens que chegam cruas ao formulário — sem showApiError) ───
  "Tarefa não encontrada.": { es: "Tarea no encontrada." },
  "O negócio ou contato vinculado não existe.": {
    es: "El negocio o contacto vinculado no existe.",
  },
  "Erro ao salvar a tarefa.": { es: "Error al guardar la tarea." },
  "Erro ao listar as tarefas.": { es: "Error al listar las tareas." },
  "Erro ao apagar a tarefa.": { es: "Error al eliminar la tarea." },

  "Baixa": { es: "Baja" },
  "Média": { es: "Media" },
  "Alta": { es: "Alta" },
  "mais": { es: "más" },
  // ─── Configurações › Organização — zona de perigo (extraído do PR #556) ───
  "Zona de perigo": { es: "Zona de peligro" },
  "Apaga de vez as mensagens, conversas, negócios, contatos, agendamentos e pedidos desta organização. Serve para recomeçar os testes do zero antes de atender de verdade.":
    {
      es: "Borra definitivamente los mensajes, conversaciones, negocios, contactos, citas y pedidos de esta organización. Sirve para volver a empezar las pruebas desde cero antes de atender de verdad.",
    },
  "Continuam de pé: as pessoas da equipe, as configurações, os funis e etapas, os agentes de IA e os canais de WhatsApp já conectados.":
    {
      es: "Siguen en pie: las personas del equipo, las configuraciones, los embudos y etapas, los agentes de IA y los canales de WhatsApp ya conectados.",
    },
  "Apagar todos os dados de atendimento": { es: "Borrar todos los datos de atención" },
  "Apagar todos os dados de atendimento?": { es: "¿Borrar todos los datos de atención?" },
  "Esta ação é irreversível. Mensagens, conversas, negócios, contatos, agendamentos e pedidos de":
    {
      es: "Esta acción es irreversible. Mensajes, conversaciones, negocios, contactos, citas y pedidos de",
    },
  "serão apagados de vez.": { es: "serán borrados definitivamente." },
  Digite: { es: "Escribe" },
  "para confirmar": { es: "para confirmar" },
  "Apagando…": { es: "Borrando…" },
  "Apagar de vez": { es: "Borrar definitivamente" },
  "Dados apagados": { es: "Datos borrados" },
  mensagens: { es: "mensajes" },
  conversas: { es: "conversaciones" },
  "Só quem administra esta empresa pode apagar os dados.": {
    es: "Solo quien administra esta empresa puede borrar los datos.",
  },
  "O nome digitado não confere com o nome da organização.": {
    es: "El nombre escrito no coincide con el nombre de la organización.",
  },
  "Digite o nome da organização para confirmar.": {
    es: "Escribe el nombre de la organización para confirmar.",
  },
  "Não consegui apagar os dados agora.": { es: "No pude borrar los datos ahora." },
  "Sua sessão expirou. Entre de novo para continuar.": {
    es: "Tu sesión expiró. Inicia sesión de nuevo para continuar.",
  },
  "Não consegui identificar sua empresa. Recarregue a página.": {
    es: "No pude identificar tu empresa. Recarga la página.",
  },
  "Confirme o código do seu aplicativo de duas etapas e tente de novo.": {
    es: "Revisa el código de tu app de verificación en dos pasos e inténtalo de nuevo.",
  },
  "Só quem administra esta empresa pode mudar a marca.": {
    es: "Solo quien administra esta empresa puede cambiar la marca.",
  },
  "A alteração não chegou ao banco — nada foi mudado. Tente de novo.": {
    es: "El cambio no llegó a la base de datos y no se modificó nada. Inténtalo de nuevo.",
  },
  "Não consegui salvar a marca agora.": { es: "No pude guardar la marca ahora." },

  // ─── Importar leads de planilha (extraído do PR #418) ───
  "Importar leads de uma planilha": { es: "Importar leads desde una hoja de cálculo" },
  "Um arquivo CSV com uma linha por lead. Os leads entram na primeira etapa aberta do funil escolhido.": {
    es: "Un archivo CSV con una fila por lead. Los leads entran en la primera etapa abierta del embudo elegido.",
  },
  "Funil de destino": { es: "Embudo de destino" },
  // As duas mensagens de recusa da ROTA de importação. Nasceram no #597, que
  // consertou a validação que este PR tinha acabado de traduzir — a frase velha
  // ("…o funil e a etapa de destino") deixou de ser emitida por qualquer caminho.
  "Escolha o funil de destino.": { es: "Elige el embudo de destino." },
  "Este funil não tem etapas abertas.": { es: "Este embudo no tiene etapas abiertas." },
  "Escolher o arquivo CSV": { es: "Elegir el archivo CSV" },
  "leads criados": { es: "leads creados" },
  "contatos novos": { es: "contactos nuevos" },
  "Colunas que não reconheci:": { es: "Columnas que no reconocí:" },
  // Mensagens de erro de lib/leads/planilha.ts e app/api/v1/leads/import/route.ts
  "A planilha precisa de uma coluna com o nome do negócio ou do contato. Encontrei: ": {
    es: "La hoja de cálculo necesita una columna con el nombre del negocio o del contacto. Encontré: ",
  },
  "sem nome do negócio nem do contato": { es: "sin nombre del negocio ni del contacto" },
  "valor não reconhecido (": { es: "valor no reconocido (" },
  " — escreva assim: 1.200,00": { es: " — escríbelo así: 1.200,00" },
  "telefone não reconhecido (": { es: "teléfono no reconocido (" },
  " — o negócio entrou sem contato": { es: " — el negocio entró sin contacto" },
  "Envie o arquivo como multipart/form-data.": {
    es: "Envía el archivo como multipart/form-data.",
  },
  "Envie o arquivo no campo 'file'.": { es: "Envía el archivo en el campo 'file'." },
  "Escolha o funil e a etapa de destino.": { es: "Elige el embudo y la etapa de destino." },
  "Arquivo maior que ": { es: "Archivo mayor que " },
  "A planilha tem": { es: "La hoja de cálculo tiene" },
  "linhas; o limite é": { es: "filas; el límite es" },
  "por importação.": { es: "por importación." },
  "o contato não pôde ser criado — o negócio entrou sem ele": {
    es: "no se pudo crear el contacto — el negocio entró sin él",
  },
  "linha recusada pelo banco": { es: "fila rechazada por la base de datos" },
  // Mensagens de erro de app/api/v1/products/import/route.ts
  "Formato não suportado — envie um arquivo .csv. No Excel use 'Salvar como' → 'CSV UTF-8'.": {
    es: "Formato no compatible — envía un archivo .csv. En Excel usa 'Guardar como' → 'CSV UTF-8'.",
  },
  "produtos por importação — divida a planilha.": {
    es: "productos por importación — divide la hoja de cálculo.",
  },
  // Mensagens de erro de lib/contacts/csv.ts e app/api/v1/contacts/import/route.ts
  "cabeçalho sem coluna de telefone nem e-mail": {
    es: "encabezado sin columna de teléfono ni e-mail",
  },
  "e-mail inválido: ": { es: "e-mail inválido: " },
  "telefone inválido: ": { es: "teléfono inválido: " },
  " (use DDI+DDD+número, ex.: +5511999998888)": {
    es: " (usa código de país+código de área+número, ej.: +5511999998888)",
  },
  "linha sem telefone nem e-mail": { es: "fila sin teléfono ni e-mail" },
  "Cabeçalho inválido:": { es: "Encabezado inválido:" },
  "linhas por importação — divida a planilha.": {
    es: "filas por importación — divide la hoja de cálculo.",
  },
  "CPF inválido: ": { es: "CPF inválido: " },
  "dados inválidos": { es: "datos inválidos" },
  // ─── Fase A: mensagens de erro de rotas de API (codemod + revisão manual) ───
  "A decisão não pôde ser registrada. Nada foi enviado ao cliente.": { es: "No se pudo registrar la decisión. No se envió nada al cliente." },
  "A etapa escolhida para o gatilho não existe mais neste funil — escolha outra.": { es: "La etapa elegida para el disparador ya no existe en este embudo — elige otra." },
  "A proposta mudou desde que você a leu. Confira a nova antes de decidir.": { es: "La propuesta cambió desde que la leíste. Revisa la nueva antes de decidir." },
  "A régua do abandono precisa ser um número inteiro de horas entre 1 e 2160.": { es: "La regla de abandono debe ser un número entero de horas entre 1 y 2160." },
  "Alguém assumiu esta conversa agora — recarregue e tente de novo.": { es: "Alguien acaba de asumir esta conversación. Recarga e inténtalo de nuevo." },
  "Antes de fazer a IA parar no limite, salve \"Me avisar\" — assim o aviso já ": { es: "Antes de hacer que la IA se detenga en el límite, guarda \"Avisarme\": así el aviso ya " },
  "Assistente não encontrado nesta organização.": { es: "Asistente no encontrado en esta organización." },
  "Assumiu a conversa e pausou o atendimento automático": { es: "Asumió la conversación y pausó la atención automática" },
  "Assumiu o atendimento desta conversa": { es: "Asumió la atención de esta conversación" },
  "Atendimento devolvido, mas o sinal de retomada do acompanhamento falhou — tente de novo.": { es: "Se devolvió la atención, pero falló la señal para reanudar el seguimiento. Inténtalo de nuevo." },
  "Atendimento devolvido ao agente com o registro do que a equipe decidiu": {
    es: "Atención devuelta al agente con el registro de lo que el equipo decidió",
  },
  "Atendimento devolvido ao agente": { es: "Atención devuelta al agente" },
  "Body JSON inválido.": { es: "Body JSON inválido." },
  "Body inválido.": { es: "Body inválido." },
  "Cole o conteúdo do material antes de criar.": { es: "Pega el contenido del material antes de crear." },
  "Consulta inválida.": { es: "Consulta inválida." },
  // Tela de credentials — editar/rotacionar a chave (PATCH). O texto da RECUSA
  // do DELETE não entra aqui: ele interpola a contagem e os nomes dos agentes,
  // então é montado em runtime e não tem chave fixa para traduzir.
  "Editar credencial": { es: "Editar credencial" },
  "Nova chave (opcional)": { es: "Clave nueva (opcional)" },
  "Em branco mantém a chave atual": { es: "Déjalo en blanco para mantener la clave actual" },
  "Chave salva. Validando…": { es: "Clave guardada. Validando…" },
  "Chave trocada. A validação segue em segundo plano.": {
    es: "Clave cambiada. La validación sigue en segundo plano.",
  },
  "Credencial atualizada.": { es: "Credencial actualizada." },
  "Trocar a chave aqui mantém os agentes ligados nela: no próximo atendimento eles já usam a chave nova. Deixe a chave em branco para mudar só o nome.": {
    es: "Al cambiar la clave aquí, los agentes que la usan se mantienen conectados: en su próxima conversación ya usarán la clave nueva. Deja la clave en blanco para cambiar solo el nombre.",
  },
  "versão(ões) de agente": { es: "versión(es) de agente" },
  "Para trocar a chave, use editar. Para excluir, nenhuma versão pode estar usando a chave — e versão já publicada ou substituída não aceita mais apontar para outra chave, então a exclusão fica travada enquanto esse histórico existir.": {
    es: "Para cambiar la clave, usa Editar. Para eliminarla, ninguna versión debe estar usándola. Una versión ya publicada o reemplazada no puede apuntar a otra clave, así que la eliminación queda bloqueada mientras exista ese historial.",
  },
  "Esta ação não pode ser desfeita.": { es: "Esta acción no se puede deshacer." },
  "Cursor inválido.": { es: "Cursor inválido." },
  "Dê um nome ao material (2 a 120 caracteres).": { es: "Ponle un nombre al material (de 2 a 120 caracteres)." },
  "Erro ao ativar a versão da memória.": { es: "Error al activar la versión de la memoria." },
  "Erro ao duplicar versão.": { es: "Error al duplicar versión." },
  "Erro ao gravar o conteúdo do material.": { es: "Error al grabar el contenido del material." },
  "Erro ao guardar o conteúdo do material.": { es: "Error al guardar el contenido del material." },
  "Erro ao listar execuções.": { es: "Error al listar ejecuciones." },
  "Erro ao publicar versão da memória.": { es: "Error al publicar versión de la memoria." },
  "Escolha a etapa do funil que dispara este fluxo antes de publicar.": { es: "Elige la etapa del embudo que dispara este flujo antes de publicar." },
  "Esta automação não tem mais nenhuma ação de webhook — não há o que reenviar.": { es: "Esta automatización ya no tiene ninguna acción de webhook — no hay nada que reenviar." },
  "Esta conversa está encerrada — não há atendimento automático a pausar.": { es: "Esta conversación está cerrada — no hay atención automática que pausar." },
  "Esta sugestão já foi decidida.": { es: "Ya se tomó una decisión sobre esta sugerencia." },
  "Esta sugestão venceu pelo prazo.": { es: "Esta sugerencia venció al cumplirse el plazo." },
  "Este canal é o oficial (API da plataforma): ele não tem sessão de WhatsApp para reiniciar. Se parou de entregar, atualize a credencial na tela do canal oficial.": { es: "Este es el canal oficial (API de la plataforma) y no tiene una sesión de WhatsApp que reiniciar. Si dejó de entregar mensajes, actualiza la credencial en la pantalla del canal oficial." },
  "Este negócio não tem contato, então não há proposta do agente.": { es: "Este negocio no tiene contacto, así que no hay propuesta del agente." },
  "Este número foi excluído da Central de Conexões — reconectar não o traz de volta. Conecte um número para voltar a atender.": { es: "Este número se eliminó de la Central de Conexiones y reconectarlo no lo recupera. Conecta un número para volver a atender." },
  "Falha ao processar o envio do arquivo.": { es: "Error al procesar el envío del archivo." },
  "O arquivo não está mais guardado. Envie de novo.": { es: "El archivo ya no está guardado. Envíalo de nuevo." },
  "Esta chave de idempotência já foi usada com outro conteúdo.": { es: "Esta clave de idempotencia ya se usó con otro contenido." },
  "Um canal está em modo de teste — a IA não responde ninguém nele": { es: "Un canal está en modo de prueba — la IA no responde a nadie en él" },
  "A mesma requisição ainda está em curso. Tente de novo em instantes.": { es: "La misma solicitud todavía está en curso. Inténtalo de nuevo en unos instantes." },
  "Filtros inválidos.": { es: "Filtros inválidos." },
  "Header Idempotency-Key é obrigatório.": { es: "El header Idempotency-Key es obligatorio." },
  "JSON inválido.": { es: "JSON inválido." },
  "Já existe um produto com esse código.": { es: "Ya existe un producto con ese código." },
  "Já existe uma credential com este label e provider.": { es: "Ya existe una credential con este label y provider." },
  "Já existe uma atualização em andamento.": { es: "Ya hay una actualización en curso." },
  "Lead foi modificado por outro usuário. Recarregue e tente novamente.": { es: "Otro usuario modificó el lead. Recarga e inténtalo de nuevo." },
  "Liberou a conversa de volta para a fila": { es: "Devolvió la conversación a la cola" },
  "Material não encontrado.": { es: "Material no encontrado." },
  "Move cross-pipeline não é permitido. Use POST /api/v1/leads/[id]/clone para levar o negócio a outro funil.": { es: "No se permite mover entre embudos. Usa POST /api/v1/leads/[id]/clone para llevar el negocio a otro embudo." },
  "Nada para alterar.": { es: "No hay nada que modificar." },
  "Nenhum arquivo foi enviado.": { es: "No se envió ningún archivo." },
  "Nenhum lead acessível na operação.": { es: "No hay ningún lead accesible en la operación." },
  "Não achei nenhum par pergunta/resposta no texto. Use uma linha ## Pergunta: e uma ## Resposta: por item.": { es: "No encontré ningún par pregunta/respuesta en el texto. Usa una línea ## Pregunta: y otra ## Respuesta: por elemento." },
  "Não foi possível gravar.": { es: "No se pudo guardar." },
  "Não foi possível guardar o segredo com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave.": { es: "No se pudo guardar el secreto de forma segura: la clave de cifrado de esta instalación no está activa. Quien administra el servidor puede resolverlo ejecutando update.sh, que genera y activa la clave." },
  "Não foi possível guardar o segredo com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave. Enquanto isso, você pode criar a fonte sem segredo.": { es: "No se pudo guardar el secreto de forma segura: la clave de cifrado de esta instalación no está activa. Quien administra el servidor puede resolverlo ejecutando update.sh, que genera y activa la clave. Mientras tanto, puedes crear la fuente sin secreto." },
  "Não foi possível guardar o segredo do webhook com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave.": { es: "No se pudo guardar el secreto del webhook de forma segura: la clave de cifrado de esta instalación no está activa. Quien administra el servidor puede resolverlo ejecutando update.sh, que genera y activa la clave." },
  "Não foi possível guardar o segredo do webhook com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave. Enquanto isso, você pode criar a ação sem segredo.": { es: "No se pudo guardar el secreto del webhook de forma segura: la clave de cifrado de esta instalación no está activa. Quien administra el servidor puede resolverlo ejecutando update.sh, que genera y activa la clave. Mientras tanto, puedes crear la acción sin secreto." },
  "Não foi possível validar o responsável agora. Tente novamente em instantes.": { es: "No se pudo validar al responsable en este momento. Inténtalo de nuevo en unos instantes." },
  "Esse funil não está mais na sua lista. Recarregue a página e tente de novo.": {
    es: "Ese embudo ya no está en tu lista. Recarga la página e intenta de nuevo.",
  },
  "Não sei ler esse tipo de arquivo. Envie PDF, Markdown (.md), CSV (.csv) ou texto (.txt).": { es: "No puedo leer este tipo de archivo. Envía PDF, Markdown (.md), CSV (.csv) o texto (.txt)." },
  "Não leio Excel diretamente — no Excel use \"Salvar como\" → \"CSV UTF-8 (delimitado por vírgulas)\" e envie o CSV.": { es: "No puedo leer archivos de Excel directamente. En Excel usa \"Guardar como\" → \"CSV UTF-8 (delimitado por comas)\" y envía el CSV." },
  "não consegui extrair texto deste PDF. Se ele for só imagens escaneadas, não há letra nenhuma para ler — envie uma versão com texto selecionável.": {
    es: "no pude extraer texto de este PDF. Si solo contiene imágenes escaneadas, no hay texto que leer. Envía una versión con texto seleccionable.",
  },
  "o arquivo não tem texto nenhum para indexar": { es: "el archivo no tiene ningún texto para indexar" },
  "não consegui ler este arquivo como texto: os bytes não formam Markdown nem texto puro. Salve o material em UTF-8 (ou ANSI) e envie de novo — se o arquivo não for de texto, envie PDF.": {
    es: "no pude leer este archivo como texto: los bytes no forman Markdown ni texto plano. Guarda el material en UTF-8 (o ANSI) y envíalo de nuevo. Si el archivo no es de texto, envía un PDF.",
  },
  "Não é possível desativar o agent default da organização.": { es: "No es posible desactivar el agent default de la organización." },
  "Não é possível revogar o último admin do tenant.": { es: "No es posible revocar al último admin del tenant." },
  "O WhatsApp (WAHA) não está configurado neste ambiente (faltam WAHA_API_BASE_URL e/ou WAHA_API_KEY) — sem ele o número não pode ser desconectado do aparelho.": { es: "WhatsApp (WAHA) no está configurado en este entorno (faltan WAHA_API_BASE_URL y/o WAHA_API_KEY). Sin él, no se puede desconectar el número del dispositivo." },
  "O WhatsApp (WAHA) não está configurado neste ambiente: faltam WAHA_API_BASE_URL e/ou WAHA_API_KEY. Configure-as e tente de novo.": { es: "WhatsApp (WAHA) no está configurado en este entorno: faltan WAHA_API_BASE_URL y/o WAHA_API_KEY. Configúralas e inténtalo de nuevo." },
  "O cabeçalho aceita imagem JPG ou PNG.": { es: "El encabezado acepta imagen JPG o PNG." },
  "O caso não está aguardando resposta do atendente (awaiting_human).": { es: "El caso no está esperando respuesta del asesor (awaiting_human)." },
  "O funil que você escolheu como vizinho não está mais na lista. Recarregue a página.": { es: "El embudo que elegiste como vecino ya no está en la lista. Recarga la página." },
  "O modelo em uso não sabe usar as ferramentas do CRM — o agente conversa, mas não registra nada no funil.": { es: "El modelo en uso no puede usar las herramientas del CRM: el agente conversa, pero no registra nada en el embudo." },
  "O próximo passo precisa ter de 3 a 500 caracteres.": { es: "El próximo paso debe tener de 3 a 500 caracteres." },
  "O router precisa estar ativo (is_active=true) para ser testado.": { es: "El router debe estar activo (is_active=true) para poder probarlo." },
  "Os funis desta lista estão empatados na ordenação. Recarregue a página e mova o funil para outro lugar.": { es: "Hay embudos con la misma posición en esta lista. Recarga la página y mueve el embudo a otra posición." },
  "Payload inválido.": { es: "Payload inválido." },
  "Produto não encontrado.": { es: "Producto no encontrado." },
  "Query inválida.": { es: "Query inválida." },
  "Responsável não é um atendente ativo desta organização.": { es: "El responsable no es un asesor activo de esta organización." },
  "Retomada de contato descartada — decisão registrada": { es: "Reanudación de contacto descartada — decisión registrada" },
  "Salve este token agora — ele não será mostrado novamente.": { es: "Guarda este token ahora — no se mostrará de nuevo." },
  "Só o próprio atendente ou um manager pode alterar esta disponibilidade.": { es: "Solo el propio asesor o un manager puede modificar esta disponibilidad." },
  "Transferiu a conversa para outro atendente": { es: "Transfirió la conversación a otro asesor" },
  "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado": { es: "cifrado no disponible en esta instalación (falta el GUC app.nuvemshop_oauth_key) — no se guardó el token" },
  "cifra indisponível nesta instalação — a chave não foi gravada": { es: "cifrado no disponible en esta instalación — no se guardó la clave" },
  "cursor inválido.": { es: "cursor inválido." },
  "draft_graph ausente — monte o fluxo antes de publicar.": { es: "falta draft_graph — arma el flujo antes de publicar." },
  "encerrada pelo prazo": { es: "cerrada por vencimiento del plazo" },
  "está de pé quando a parada começar a valer, 72 horas depois de você armá-la.": { es: "está activo cuando la parada entre en vigor, 72 horas después de que la actives." },
  "falha ao ler": { es: "error al leer" },
  "filtros inválidos": { es: "filtros inválidos" },
  "pointer_id inválido.": { es: "pointer_id inválido." },
  "priority inválido (0..1000).": { es: "priority inválido (0..1000)." },
  "status inválido.": { es: "status inválido." },

  // ─── Fase B: handlers compartidos REST/MCP (contacts/_handler.ts) ───
  "Contato anonimizado — edição bloqueada (LGPD).": {
    es: "Contacto anonimizado — edición bloqueada (LGPD).",
  },
  "Nenhum campo para atualizar.": { es: "Ningún campo para actualizar." },
  "Contato não encontrado após update.": { es: "Contacto no encontrado después de la actualización." },
  "Não foi possível excluir: o contato ainda tem registros vinculados.": {
    es: "No se pudo eliminar el contacto: todavía tiene registros vinculados.",
  },

  // ─── Fase B: handlers compartidos REST/MCP (leads/_handler.ts) ───
  "Um lead tem um dono: informe owner_user_id OU owner_agent_id.": {
    es: "Un lead tiene un dueño: indica owner_user_id O owner_agent_id.",
  },
  "Falha ao criar lead.": { es: "No se pudo crear el lead." },
  "Stage não pertence ao pipeline informado.": {
    es: "El stage no pertenece al pipeline indicado.",
  },
  "Lead foi modificado concorrentemente.": { es: "El lead se modificó de forma simultánea." },
  "leads por bulk.": { es: "leads por lote." },
  "Esta sugestão já foi": { es: "Esta sugerencia ya fue" },
  "decidida": { es: "decidida" },
  "Informe o motivo da perda.": { es: "Indica el motivo de la pérdida." },
  "Informe o motivo da perda: use “Marcar como perdido” no menu do card, que pede o motivo.": {
    es: "Indica el motivo de la pérdida: usa “Marcar como perdido” en el menú del card, que pide el motivo.",
  },
  "Esse motivo de perda não está na lista deste funil — escolha um dos motivos configurados.": {
    es: "Ese motivo de pérdida no está en la lista de este embudo. Elige uno de los motivos configurados.",
  },
  "Pipeline não tem stage de fechamento como ganho.": {
    es: "El pipeline no tiene un stage de cierre para negocios ganados.",
  },
  "Pipeline não tem stage de fechamento como perda.": {
    es: "El pipeline no tiene un stage de cierre para negocios perdidos.",
  },
  "Perdido —": { es: "Perdido —" },
  "(negócio removido)": { es: "(negocio eliminado)" },
  // Troca de funil (POST /api/v1/leads/[id]/clone): o rótulo da linha do negócio
  // novo e as duas razões que não dependem do nome do funil.
  "Veio de outro funil": { es: "Vino de otro embudo" },
  "Levado para outro funil": { es: "Movido a otro embudo" },
  // As recusas da troca de funil (lib/leads/clonar-para-funil.ts e a rota).
  "O negócio já está neste funil. Para trocar de etapa use /api/v1/leads/[id]/move.": {
    es: "El negocio ya está en este embudo. Para cambiar de etapa, usa /api/v1/leads/[id]/move.",
  },
  "Só um negócio aberto pode ser levado para outro funil.": {
    es: "Solo un negocio abierto puede moverse a otro embudo.",
  },
  "A etapa não pertence ao funil de destino.": {
    es: "La etapa no pertenece al embudo de destino.",
  },
  "A etapa de destino é de fechamento: escolha uma etapa aberta do funil.": {
    es: "La etapa de destino es de cierre: elige una etapa abierta del embudo.",
  },
  "O funil de destino não tem etapa aberta para receber o negócio.": {
    es: "El embudo de destino no tiene etapa abierta para recibir el negocio.",
  },
  "Funil de destino não encontrado.": { es: "Embudo de destino no encontrado." },
  "O funil de origem não tem etapa de perda para encerrar o negócio.": {
    es: "El embudo de origen no tiene etapa de pérdida para cerrar el negocio.",
  },

  // ─── Fase B: vocabulario de dominio persistido (reason de crm_lead_activities) ───
  //
  // Estas frases nunca chegam por t() estático — o backend as gera como
  // `reason` de atividade, o valor é PERSISTIDO no banco, e o frontend
  // (LeadTimeline.tsx, TimelineView.tsx, CRMSidePanel.tsx) as traduz na
  // LEITURA com `t(item.reason)`. A chave aqui tem de bater byte a byte com
  // o texto que o backend grava — nunca traduza só um pedaço.
  "Não enviei: o contato pediu para parar de receber mensagens": {
    es: "No envié: el contacto pidió dejar de recibir mensajes",
  },
  "Não enviei: fora da janela de horário permitida": {
    es: "No envié: fuera del horario permitido",
  },
  "Não enviei: limite de ritmo de envio atingido": {
    es: "No envié: límite de ritmo de envío alcanzado",
  },
  "Não enviei: orçamento de IA esgotado": { es: "No envié: presupuesto de IA agotado" },
  "Não enviei: número ainda em aquecimento": { es: "No envié: número todavía en calentamiento" },
  "Não enviei: a mensagem prometia algo que não posso garantir": {
    es: "No envié: el mensaje prometía algo que no puedo garantizar",
  },
  "Não enviei: a mensagem usava termos internos do sistema que o cliente não deve ler": {
    es: "No envié: el mensaje usaba términos internos del sistema que el cliente no debe leer",
  },
  "A sugestão de retomar contato venceu sem decisão": {
    es: "La sugerencia de retomar contacto venció sin decisión",
  },
  "primeiro checkpoint sem compromisso, objeção ou próxima ação": {
    es: "primer checkpoint sin compromiso, objeción o próxima acción",
  },
  "só reescreveu o resumo — não muda o que fazer a seguir": {
    es: "solo reescribió el resumen, sin cambiar lo que hay que hacer a continuación",
  },
  "Sem resposta além do prazo deste estágio": { es: "Sin respuesta tras vencer el plazo de esta etapa" },
  "Parado há muito tempo — sem resposta": { es: "Detenido desde hace mucho tiempo, sin respuesta" },
  "Voltou a ter movimento": { es: "Volvió a tener movimiento" },
  "Essa etapa não faz parte deste funil. Recarregue a página e tente de novo.": {
    es: "Esa etapa no forma parte de este embudo. Recarga la página e intenta de nuevo.",
  },
  "Etapa não encontrada.": { es: "Etapa no encontrada." },
  "Uma pessoa devolveu o negócio para onde ele estava antes do assistente": {
    es: "Una persona regresó el negocio a donde estaba antes de que actuara el asistente",
  },
  "Uma pessoa levou o negócio para outra etapa, diferente da que o assistente escolheu": {
    es: "Una persona movió el negocio a otra etapa, distinta de la que eligió el asistente",
  },

  // ─── Conversations + Messages: handlers compartidos REST/MCP ───
  "Contato bloqueou o atendimento.": { es: "El contacto bloqueó la atención." },
  "Contato anonimizado não pode ser compartilhado.": {
    es: "No se puede compartir un contacto anonimizado.",
  },
  "Contato sem telefone para envio como cartão.": {
    es: "El contacto no tiene teléfono para enviarlo como tarjeta.",
  },
  "Telefone inválido para envio como cartão.": { es: "Teléfono inválido para enviarlo como tarjeta." },
  "Informe metadata.shared_contact_id ou metadata.shared_contact com telefone.": {
    es: "Indica metadata.shared_contact_id o metadata.shared_contact con teléfono.",
  },
  "A mensagem citada não é desta conversa.": {
    es: "El mensaje citado no es de esta conversación.",
  },
  "Este número foi excluído da Central de Conexões.": {
    es: "Este número fue eliminado de la Central de Conexiones.",
  },
  "Contato sem telefone para envio WhatsApp.": {
    es: "El contacto no tiene teléfono para enviarle mensajes por WhatsApp.",
  },
  "No active organization.": { es: "No hay organización activa." },
  "Nenhum agente publicado para sugerir resposta.": {
    es: "No hay ningún agente publicado para sugerir respuestas.",
  },
  "Contato bloqueado/anonimizado.": { es: "Contacto bloqueado/anonimizado." },
  "A IA não gerou um rascunho.": { es: "La IA no generó un borrador." },
  "Erro ao gerar rascunho.": { es: "Error al generar el borrador." },
  "Não é possível rebaixar o último admin do tenant.": {
    es: "No es posible degradar al último admin del tenant.",
  },
  "Já é membro desta organização.": { es: "Ya es miembro de esta organización." },

  // ─── lib/mcp/tools/pacotes.ts (níveis de risco de uma capacidade) ───
  "Só consulta": { es: "Solo consulta" },
  "Altera dados": { es: "Modifica datos" },
  "Efeito que não dá para desfazer": { es: "Efecto que no se puede deshacer" },
  "O agente apenas lê a informação. Nada muda no sistema.": {
    es: "El agente solo lee la información. Nada cambia en el sistema.",
  },
  "O agente muda alguma coisa no sistema. Você consegue ver o que mudou e desfazer pela tela.": {
    es: "El agente cambia algo en el sistema. Puedes ver qué cambió y deshacerlo desde la pantalla.",
  },
  "O agente faz algo que sai do sistema ou não volta atrás — como falar com o cliente de verdade. Precisa ser ligado por você, uma a uma.": {
    es: "El agente hace algo que sale del sistema o que no tiene vuelta atrás, como hablar con un cliente de verdad. Debes activarlas tú, una por una.",
  },

  // ─── lib/mcp/tools/catalogo/*.ts (capacidades do agente — rotulo/explicacao/oQueToca) ───
  "Abre a ficha completa de um cliente: dados de contato, histórico e por onde ele chegou até a empresa.": {
    es: "Abre la ficha completa de un cliente: datos de contacto, historial y cómo llegó a la empresa.",
  },
  "Abre os detalhes de uma conversa: quem está atendendo, marcadores aplicados e há quanto tempo o cliente espera.": {
    es: "Abre los detalles de una conversación: quién está atendiendo, etiquetas aplicadas y cuánto tiempo lleva esperando el cliente.",
  },
  "Abre os detalhes de uma oportunidade de venda: etapa atual, responsável, marcadores e valor do negócio.": {
    es: "Abre los detalles de una oportunidad de venta: etapa actual, responsable, etiquetas y valor del negocio.",
  },
  "Abre um chamado e mostra tudo que aconteceu nele, inclusive a decisão que a pessoa tomou e o texto que ela escreveu ao decidir.": {
    es: "Abre un caso y muestra todo lo que pasó en él, incluida la decisión que la persona tomó y el texto que escribió al decidir.",
  },
  "Abre um endereço novo para o site da empresa mandar contatos direto para um funil. A partir daí ele passa a receber gente de fora sozinho.": {
    es: "Abre una dirección nueva para que el sitio de la empresa envíe contactos directo a un embudo. A partir de ahí, recibe contactos externos de forma automática.",
  },
  "Acrescenta uma coluna nova no fim do funil, quando o jeito de trabalhar da empresa tem um passo que ainda não está no quadro.": {
    es: "Agrega una columna nueva al final del embudo cuando la forma de trabajar de la empresa incluye un paso que todavía no aparece en el tablero.",
  },
  "Adiciona ou remove marcadores numa conversa, cliente ou oportunidade, para organizar e filtrar a operação depois.": {
    es: "Agrega o quita etiquetas en una conversación, cliente u oportunidad, para organizar y filtrar la operación después.",
  },
  "Agenda da equipe": { es: "Agenda del equipo" },
  "Agendar um retorno para o cliente": { es: "Programar un seguimiento para el cliente" },
  "Altera dados de uma oportunidade de venda: valor do negócio, responsável e informações colhidas na conversa.": {
    es: "Modifica datos de una oportunidad de venta: valor del negocio, responsable e información obtenida en la conversación.",
  },
  "Anota o que aconteceu num horário que já passou: a pessoa foi atendida, ou não apareceu.": {
    es: "Anota lo ocurrido en una cita que ya pasó: si la persona fue atendida o no se presentó.",
  },
  "Anotar uma regra aprendida": { es: "Anotar una regla aprendida" },
  "Aplicar marcadores": { es: "Aplicar etiquetas" },
  "Aprendizado do assistente": { es: "Aprendizaje del asistente" },
  "Arquivar uma etapa do funil": { es: "Archivar una etapa del embudo" },
  "Banco de dados conectado": { es: "Base de datos conectada" },
  "Base de conhecimento": { es: "Base de conocimiento" },
  "Buscar dados no banco conectado": { es: "Buscar datos en la base conectada" },
  "Cadastro de clientes": { es: "Registro de clientes" },
  "Cancelar um retorno agendado": { es: "Cancelar un seguimiento programado" },
  "Catálogo da loja": { es: "Catálogo de la tienda" },
  "Chamados para uma pessoa": { es: "Casos para una persona" },
  "Chamar um atendente humano": { es: "Llamar a un asesor humano" },
  "Compras do cliente": { es: "Compras del cliente" },
  "Confirma o horário que estava esperando a resposta da pessoa, para a equipe saber que ela vem mesmo.": {
    es: "Confirma un horario que estaba a la espera de respuesta de la persona, para que el equipo sepa que sí va a asistir.",
  },
  "Confirmar um horário combinado": { es: "Confirmar un horario acordado" },
  "Consultar as regras da empresa": { es: "Consultar las reglas de la empresa" },
  "Consultar o que a empresa já sabe": { es: "Consultar lo que la empresa ya sabe" },
  "Cria uma sugestão de retomar o contato com um cliente que esfriou, para uma pessoa aprovar antes de qualquer envio.": {
    es: "Crea una sugerencia de retomar el contacto con un cliente que se enfrió, para que una persona la apruebe antes de cualquier envío.",
  },
  "Criar etapa no funil": { es: "Crear etapa en el embudo" },
  "Criar uma entrada automática de contatos": { es: "Crear una entrada automática de contactos" },
  "Deixa escrito no chamado o que mudou desde que ele foi aberto, para a pessoa que for atender não precisar começar do zero.": {
    es: "Deja escrito en el caso lo que cambió desde que se abrió, para que la persona que lo atienda no tenga que empezar de cero.",
  },
  "Desmarca um horário combinado e devolve esse horário para outra pessoa poder pegar, o que não dá para desfazer.": {
    es: "Cancela un horario acordado y lo libera para que otra persona pueda tomarlo. Esto no se puede deshacer.",
  },
  "Desmarca um retorno que ainda não aconteceu, para o agente não insistir com quem já respondeu.": {
    es: "Cancela un seguimiento que aún no se ha realizado, para que el agente no insista con quien ya respondió.",
  },
  "Desmarcar um compromisso": { es: "Cancelar un compromiso" },
  "Devolve a conversa para o atendimento automático depois que uma pessoa atendeu, levando junto o que ficou combinado com o cliente. Só uma pessoa pode acionar.": {
    es: "Devuelve la conversación a la atención automática una vez que una persona terminó de atender, junto con lo que se acordó con el cliente. Solo una persona puede hacerlo.",
  },
  "Direcionar conversa para alguém": { es: "Asignar conversación a alguien" },
  "Encerrar o negócio como ganho ou perdido": { es: "Cerrar el negocio como ganado o perdido" },
  "Encerrar um chamado com o desfecho": { es: "Cerrar un caso con el desenlace" },
  "Encontra um cliente pelo nome, telefone ou e-mail, para o agente saber com quem está falando antes de responder.": {
    es: "Busca un cliente por nombre, teléfono o correo, para que el agente sepa con quién habla antes de responder.",
  },
  "Entrada automática de contatos": { es: "Entrada automática de contactos" },
  "Envia uma mensagem de WhatsApp para o cliente. Ele recebe de verdade, no celular dele, e não dá para desfazer.": {
    es: "Envía un mensaje de WhatsApp al cliente. Lo recibe de verdad, en su celular, y no se puede deshacer.",
  },
  "Equipe de atendimento": { es: "Equipo de atención" },
  "Faz uma origem voltar a receber contatos, ou parar. Desligada, o formulário do seu site continua no ar e ninguém do outro lado é avisado.": {
    es: "Reactiva o detiene la recepción de contactos de una fuente. Si la desactivas, el formulario de tu sitio sigue en línea y nadie del otro lado recibe aviso.",
  },
  "Faz uma regra passar a rodar sozinha, sempre que o gatilho dela acontecer, ou parar de rodar. Ligada, ela pode falar com clientes de verdade.": {
    es: "Activa una regla para que se ejecute sola cada vez que ocurra su disparador, o la detiene. Mientras esté activa, puede hablar con clientes de verdad.",
  },
  "Fecha a oportunidade dizendo se ela foi ganha ou perdida e por quê, para o que já acabou parar de ser cobrado.": {
    es: "Cierra la oportunidad indicando si se ganó o se perdió y por qué, para que lo que ya terminó deje de aparecer como pendiente.",
  },
  "Fecha um chamado deixando registrado como ele terminou, para ele parar de ocupar a fila de quem atende. Não dá para reabrir por aqui.": {
    es: "Cierra un caso dejando registrado cómo terminó, para que deje de ocupar la fila de quien atiende. No se puede reabrir por aquí.",
  },
  "Funil de vendas": { es: "Embudo de ventas" },
  "Guarda um aprendizado que vale para todos os atendimentos, marcado como escrito pelo assistente para você distinguir do que anotou.": {
    es: "Guarda un aprendizaje que aplica a todas las atenciones, marcado como escrito por el asistente para que puedas distinguirlo de lo que anotaste tú.",
  },
  "Interrompe o atendimento automático e chama uma pessoa, entregando um resumo do que já aconteceu na conversa.": {
    es: "Interrumpe la atención automática y llama a una persona, con un resumen de lo que ya pasó en la conversación.",
  },
  "Lê o conteúdo de uma tabela do banco que você conectou, com filtros, para o assistente responder ao cliente com o dado real em vez de estimar.": {
    es: "Lee el contenido de una tabla de la base que conectaste, con filtros, para que el asistente responda al cliente con el dato real en lugar de estimar.",
  },
  "Ler o histórico da conversa": { es: "Leer el historial de la conversación" },
  "Ler um chamado e o que a pessoa decidiu": { es: "Leer un caso y lo que la persona decidió" },
  "Ligar ou desligar uma entrada de contatos": { es: "Activar o desactivar una entrada de contactos" },
  "Ligar ou desligar uma regra automática": { es: "Activar o desactivar una regla automática" },
  "Lista as oportunidades abertas que passaram do prazo sem movimento, das mais críticas para as menos urgentes — e, junto, as pessoas que estão esperando sem que nada esteja marcado para acontecer.": {
    es: "Lista las oportunidades abiertas que pasaron el plazo sin movimiento, de las más críticas a las menos urgentes. Incluye también a las personas que están esperando sin que haya nada programado.",
  },
  "Lista as oportunidades de venda de um funil, com a etapa em que cada uma está e quem é o responsável por ela.": {
    es: "Lista las oportunidades de venta de un embudo, con su etapa actual y su responsable.",
  },
  "Lista as pessoas do time e o que cada uma pode fazer aqui dentro, para o agente saber para quem passar um atendimento.": {
    es: "Lista a las personas del equipo y lo que cada una puede hacer en el sistema, para que el agente sepa a quién transferir una atención.",
  },
  "Lista os assuntos que já foram passados para uma pessoa resolver, com o estado de cada um, para o agente não pedir duas vezes a mesma coisa.": {
    es: "Lista los asuntos que ya se pasaron a una persona para que los resuelva, con el estado de cada uno, para que el agente no pida dos veces lo mismo.",
  },
  "Lista os compromissos com hora marcada de um cliente ou de um dia, com a situação de cada um: marcado, realizado ou desmarcado.": {
    es: "Lista los compromisos con fecha y hora de un cliente o de un día, con el estado de cada uno: programado, realizado o cancelado.",
  },
  "Lista os textos que a empresa já escreveu para responder as situações de sempre, com o atalho de cada um.": {
    es: "Lista los textos que la empresa ya escribió para responder a las situaciones de siempre, con el atajo de cada uno.",
  },
  "Listar conversas": { es: "Listar conversaciones" },
  "Lê as mensagens já trocadas com o cliente, para o agente responder sem pedir que ele repita o que já contou.": {
    es: "Lee los mensajes ya intercambiados con el cliente, para que el agente responda sin pedirle que repita lo que ya contó.",
  },
  "Lê as políticas e combinados que valem para todo atendimento, para o assistente seguir a regra da casa em vez de inventar uma.": {
    es: "Lee las políticas y acuerdos que aplican a toda atención, para que el asistente siga la regla de la casa en vez de inventar una.",
  },
  "Marca um horário para o agente voltar a falar com o cliente, para que a conversa não morra sem resposta.": {
    es: "Programa un seguimiento con hora fija para que el agente vuelva a hablar con el cliente y la conversación no se quede sin respuesta.",
  },
  "Marcar consulta ou sessão": { es: "Programar consulta o sesión" },
  "Mostra as colunas de um funil na ordem em que aparecem no quadro, para o agente saber onde pode colocar cada negócio.": {
    es: "Muestra las columnas de un embudo en el orden en que aparecen en el tablero, para que el agente sepa dónde puede poner cada negocio.",
  },
  "Mostra as conversas em andamento, quem está cuidando de cada uma e a posição de cada cliente na fila de espera.": {
    es: "Muestra las conversaciones en curso, quién está a cargo de cada una y la posición de cada cliente en la fila de espera.",
  },
  "Mostra as melhorias que o sistema sugeriu a partir dos atendimentos, com o motivo de cada uma. Aprovar continua sendo decisão sua.": {
    es: "Muestra las mejoras que el sistema sugirió a partir de las atenciones, con el motivo de cada una. Aprobar sigue siendo decisión tuya.",
  },
  "Mostra o que a empresa deixou configurado para acontecer sozinho, o que dispara cada regra e se ela está ligada.": {
    es: "Muestra lo que la empresa dejó configurado para que ocurra automáticamente, qué dispara cada regla y si está activada.",
  },
  "Mostra o que este cliente já comprou, quanto pagou e como está a entrega, para o assistente não prometer prazo no escuro nem repetir uma oferta já aceita.": {
    es: "Muestra lo que este cliente ya compró, cuánto pagó y cómo va la entrega, para que el asistente no prometa un plazo a ciegas ni repita una oferta ya aceptada.",
  },
  "Mostra o que rodou sozinho nos últimos tempos e o que deu errado, para descobrir o que parou de funcionar sem ninguém perceber.": {
    es: "Muestra lo que se ejecutó automáticamente hace poco y lo que salió mal, para descubrir qué dejó de funcionar sin que nadie lo notara.",
  },
  "Mostra os funis de venda existentes e suas etapas, para o agente saber onde pode colocar uma oportunidade.": {
    es: "Muestra los embudos de venta existentes y sus etapas, para que el agente sepa dónde puede poner una oportunidad.",
  },
  "Mostra os horários em que um atendente pode receber, já descontando as folgas dele, o que ele tem marcado e os compromissos da agenda pessoal.": {
    es: "Muestra los horarios en que un asesor puede atender, después de descontar sus días libres, las citas que ya tiene y los compromisos de su agenda personal.",
  },
  "Mostra os retornos combinados com o cliente: o que está marcado, o que já aconteceu e o que foi desmarcado.": {
    es: "Muestra los seguimientos acordados con el cliente: los programados, los que ya se realizaron y los cancelados.",
  },
  "Mostra os tipos de atendimento que dá para marcar, quanto cada um dura e como é feito, para o atendente de IA falar do que existe de verdade.": {
    es: "Muestra los tipos de cita disponibles, cuánto dura cada uno y cómo se realiza, para que el agente de IA hable de lo que existe de verdad.",
  },
  "Mostra os últimos contatos que entraram por uma origem e quais informações vieram, para descobrir por que algo não chegou como devia.": {
    es: "Muestra los últimos contactos que entraron por una fuente y qué información llegó, para descubrir por qué algo no llegó como debía.",
  },
  "Mostra por onde chegam sozinhos os contatos vindos do site ou de outro sistema, se cada uma está ligada e quando recebeu pela última vez.": {
    es: "Muestra por qué vías llegan automáticamente los contactos del sitio web o de otro sistema, si cada una está activada y cuándo recibió un contacto por última vez.",
  },
  "Mostra quais marcadores a empresa já usa e em quantas conversas, para o agente reaproveitar em vez de inventar outro parecido.": {
    es: "Muestra qué etiquetas usa la empresa y en cuántas conversaciones, para que el agente las reutilice en vez de inventar otra parecida.",
  },
  "Mostra quais materiais estão no acervo da empresa e se foram processados, para saber se faltou conteúdo ou se algo falhou.": {
    es: "Muestra qué materiales están en el acervo de la empresa y si fueron procesados, para saber si faltó contenido o si algo falló.",
  },
  "Mostra quais pessoas da equipe estão em atendimento neste momento, quantas conversas cada uma já tem e quem ainda tem espaço para receber mais uma.": {
    es: "Muestra qué personas del equipo están en atención en este momento, cuántas conversaciones tiene cada una y quién todavía tiene espacio para recibir una más.",
  },
  "Mostra quais tabelas e campos existem no banco de dados que você conectou, para o assistente saber onde procurar o dado antes de responder.": {
    es: "Muestra qué tablas y campos existen en la base de datos que conectaste, para que el asistente sepa dónde buscar el dato antes de responder.",
  },
  "Mostra quantas pessoas estão esperando atendimento agora e há quanto tempo, para priorizar quem espera mais.": {
    es: "Muestra cuántas personas están esperando atención ahora y cuánto tiempo llevan así, para priorizar a quien espera más.",
  },
  "Mostra quem pediu para exportar ou apagar os próprios dados e qual o prazo, para o assistente parar de insistir com quem pediu para sair.": {
    es: "Muestra quién pidió exportar o borrar sus propios datos y cuál es el plazo, para que el asistente deje de insistir con quien pidió salir.",
  },
  "Move a oportunidade para outra etapa do funil, registrando o avanço da negociação ou a perda do negócio.": {
    es: "Mueve la oportunidad a otra etapa del embudo, registrando el avance de la negociación o la pérdida del negocio.",
  },
  "Move um compromisso já marcado para outro horário, mantendo o mesmo cliente e o mesmo tipo de atendimento.": {
    es: "Mueve un compromiso ya marcado a otro horario, manteniendo el mismo cliente y el mismo tipo de atención.",
  },
  "Organização da operação": { es: "Organización de la operación" },
  "Passa a conversa para um atendente, transfere para outra pessoa ou devolve o cliente para a fila de espera.": {
    es: "Pasa la conversación a un asesor, la transfiere a otra persona o devuelve al cliente a la fila de espera.",
  },
  "Pega uma resposta pronta e troca as lacunas pelos dados do cliente, avisando se sobrou alguma sem preencher. Não envia nada.": {
    es: "Toma una respuesta predefinida y reemplaza los espacios en blanco por los datos del cliente, y avisa si quedó alguno sin llenar. No envía nada.",
  },
  "Preencher uma resposta pronta": { es: "Completar una respuesta predefinida" },
  "Privacidade e dados do cliente": { es: "Privacidad y datos del cliente" },
  "Procura a resposta nos materiais que você cadastrou, para o assistente responder com a informação da sua empresa em vez de inventar.": {
    es: "Busca la respuesta en los materiales que registraste, para que el asistente responda con la información de tu empresa en vez de inventar.",
  },
  "Procura um produto no catálogo da loja e devolve o preço exato e o que está disponível, para o assistente responder com o valor cadastrado em vez de estimar.": {
    es: "Busca un producto en el catálogo de la tienda y devuelve su precio exacto y la disponibilidad, para que el asistente responda con el valor registrado en vez de estimarlo.",
  },
  "Quando o cliente diz o e-mail, o nome ou o telefone dele na conversa, guarda essa informação para uma pessoa conferir antes de entrar na ficha.": {
    es: "Cuando el cliente da su correo electrónico, nombre o teléfono en la conversación, guarda esa información para que una persona la revise antes de pasarla a la ficha.",
  },
  "Registra uma nova oportunidade de venda no funil, para que o interesse demonstrado pelo cliente não se perca.": {
    es: "Registra una nueva oportunidad de venta en el embudo para que no se pierda el interés que mostró el cliente.",
  },
  "Registrar o que aconteceu num chamado": { es: "Registrar lo que pasó en un caso" },
  "Registrar se a pessoa veio ou faltou": { es: "Registrar si la persona asistió o faltó" },
  "Regras automáticas": { es: "Reglas automáticas" },
  "Regras da empresa": { es: "Reglas de la empresa" },
  "Remarcar um compromisso": { es: "Reprogramar un compromiso" },
  "Renomear ou reordenar uma etapa": { es: "Renombrar o reordenar una etapa" },
  "Reserva um horário do atendente para receber o cliente. A pessoa passa a contar com esse horário, então não é um registro interno.": {
    es: "Reserva un horario del asesor para recibir al cliente. La persona ya cuenta con ese horario, así que no se trata de un registro interno.",
  },
  "Respostas prontas": { es: "Respuestas rápidas" },
  "Retomar o atendimento automático": { es: "Retomar la atención automática" },
  "Retornos e acompanhamento": { es: "Seguimientos" },
  "Sugerir retomar contato com quem sumiu": { es: "Sugerir retomar el contacto con quien dejó de responder" },
  "Time de atendimento": { es: "Equipo de atención" },
  "Tira uma coluna do quadro e leva os negócios que estavam nela para outra coluna que você escolher. O histórico continua guardado.": {
    es: "Quita una columna del tablero y pasa sus negocios a otra columna que elijas. El historial se conserva.",
  },
  "Troca o nome de uma coluna do funil, muda o lugar dela na ordem ou define em qual delas o negócio é dado como fechado ou perdido.": {
    es: "Cambia el nombre de una columna del embudo, su posición en el orden, o define en cuál se marca un negocio como cerrado o perdido.",
  },
  "Ver a fila de atendimento": { es: "Ver la fila de atención" },
  "Ver as entradas automáticas de contatos": { es: "Ver las entradas automáticas de contactos" },
  "Ver as regras automáticas": { es: "Ver las reglas automáticas" },
  "Ver as respostas prontas": { es: "Ver las respuestas rápidas" },
  "Ver as tabelas do banco conectado": { es: "Ver las tablas de la base conectada" },
  "Ver horários livres na agenda": { es: "Ver horarios libres en la agenda" },
  "Ver o que a empresa atende": { es: "Ver lo que la empresa atiende" },
  "Ver o que as regras dispararam": { es: "Ver lo que las reglas dispararon" },
  "Ver o que chegou por uma entrada": { es: "Ver lo que llegó por una entrada" },
  "Ver os chamados em aberto": { es: "Ver los casos abiertos" },
  "Ver os compromissos marcados": { es: "Ver los compromisos marcados" },
  "Ver os marcadores em uso": { es: "Ver las etiquetas en uso" },
  "Ver os materiais cadastrados": { es: "Ver los materiales registrados" },
  "Ver os retornos de um cliente": { es: "Ver los seguimientos de un cliente" },
  "Ver pedidos de privacidade": { es: "Ver solicitudes de privacidad" },
  "Ver quem esfriou e quem ficou sem próximo passo": { es: "Ver quién se enfrió y quién se quedó sin siguiente paso" },
  "Ver quem pode assumir agora": { es: "Ver quién puede hacerse cargo ahora" },
  "Ver quem trabalha na empresa": { es: "Ver quién trabaja en la empresa" },
  "Ver uma conversa": { es: "Ver una conversación" },

  // ─── lib/ai/agents/uso-de-capacidades.ts (painel "Uso das capacidades") ───
  "Capacidade removida do sistema": { es: "Capacidad eliminada del sistema" },
  "Ligada há pouco tempo. Ainda não houve atendimento em que ela fosse útil — volte aqui depois de alguns dias.": {
    es: "Se activó hace poco. Aún no ha habido ninguna atención en la que fuera útil. Vuelve a revisar en unos días.",
  },
  "O agente usou esta capacidade sem ela estar ligada nesta configuração. Ou ela foi desligada depois de já ter sido usada, ou é o pedido de ajuda humana — esse o sistema oferece sozinho quando o repasse para uma pessoa está ativado.": {
    es: "El agente usó esta capacidad sin que estuviera activada en esta configuración. Puede ser que la desactivaran después de usarla, o que sea la solicitud de ayuda humana, que el sistema ofrece por sí solo cuando el traspaso a una persona está activado.",
  },
  "Só foi usada nos seus testes. Nenhum atendimento real precisou dela ainda.": {
    es: "Solo se usó en tus pruebas. Ninguna atención real la ha necesitado aún.",
  },

  // ─── lib/ai/guardrails/lista-de-conferencia.ts (Painel de Segurança) ───
  "Não prometer checar a agenda sem checar de verdade": {
    es: "No prometer revisar la agenda sin hacerlo de verdad",
  },
  "Se a pessoa respondeu STOP, SAIR ou pediu para não receber mais, nada é enviado a ela.": {
    es: "Si la persona respondió STOP, SALIR o pidió no recibir más, no se le envía nada.",
  },
  "Contato anonimizado a pedido não recebe mensagem, e prospecção sem base legal não sai.": {
    es: "Los contactos anonimizados a solicitud propia no reciben mensajes, y la prospección sin base legal no sale.",
  },
  "Espaça as mensagens para o seu número não parecer robô e ser bloqueado pelo WhatsApp.": {
    es: "Espacia los mensajes para que tu número no parezca un bot y WhatsApp no lo bloquee.",
  },
  "Fora da janela de 24 horas, só modelo aprovado sai — é o que o próprio WhatsApp permite.": {
    es: "Fuera de la ventana de 24 horas, solo se envían plantillas aprobadas, que es lo que permite el propio WhatsApp.",
  },
  "Evita mandar a mesma frase idêntica para muita gente, que é o padrão que denuncia disparo em massa.": {
    es: "Evita mandar exactamente la misma frase a mucha gente, el patrón que delata un envío masivo.",
  },
  "Barra a mensagem em que o assistente inventa desconto, valor ou data de entrega.": {
    es: "Bloquea el mensaje en el que el asistente inventa un descuento, un valor o una fecha de entrega.",
  },
  "Uma segunda leitura, feita por um modelo, para pegar a promessa escrita de um jeito que a regra fixa não reconhece.": {
    es: "Una segunda lectura, hecha por un modelo, para detectar promesas escritas de una manera que la regla fija no reconoce.",
  },
  "Impede o \"vou pedir para o responsável te ligar\" quando nenhum chamado foi aberto de verdade.": {
    es: "Impide el \"voy a pedirle al responsable que te llame\" cuando en realidad no se abrió ningún caso.",
  },
  "Barra nome de ferramenta, nome de tabela e código de erro na mensagem que o cliente lê.": {
    es: "Bloquea nombres de herramientas, nombres de tablas y códigos de error en el mensaje que lee el cliente.",
  },
  "Barra o \"vou verificar/confirmar o horário\" quando o assistente ainda não chamou a ferramenta de agenda nesta resposta — a promessa só sai depois de checar de verdade.": {
    es: "Bloquea el \"voy a verificar/confirmar el horario\" cuando el asistente aún no consultó la herramienta de agenda en esta respuesta. La promesa solo sale después de revisar de verdad.",
  },
  "Se o cliente pergunta se está falando com um robô, a resposta não pode enganar.": {
    es: "Si el cliente pregunta si está hablando con un robot, la respuesta no puede engañar.",
  },
  "Lê a mensagem que chega e reconhece quem está tentando fazer o assistente ignorar as suas instruções.": {
    es: "Lee el mensaje entrante y detecta cuando alguien intenta que el asistente ignore sus instrucciones.",
  },
  "Quem pediu para parar tem o direito de ser deixado em paz — e insistir é infração, não estratégia.": {
    es: "Quien pidió parar tiene derecho a que lo dejen en paz, e insistir es una infracción, no una estrategia.",
  },
  "É obrigação legal. Apagar dados é irreversível por desenho, e escrever para quem foi apagado desfaria isso.": {
    es: "Es una obligación legal. Borrar datos es irreversible por diseño, y escribirle a alguien cuyos datos se borraron lo desharía.",
  },
  "É o que impede seu número de ser bloqueado — e o número é o seu negócio.": {
    es: "Es lo que evita que bloqueen tu número, y tu número es tu negocio.",
  },
  "Quem impõe é o WhatsApp, não nós. Desligar aqui não libera nada: a mensagem seria recusada lá, ou cobrada.": {
    es: "Lo impone WhatsApp, no nosotros. Desactivarlo aquí no habilita nada: WhatsApp rechazaría el mensaje o lo cobraría.",
  },
  "Texto idêntico em massa é o gatilho de spam do WhatsApp — mesmo risco do ritmo de envio.": {
    es: "Enviar el mismo texto en masa es lo que hace que WhatsApp lo trate como spam. Es el mismo riesgo que el ritmo de envío.",
  },
  "Uma promessa escrita obriga o seu negócio. A conferência é uma regra fixa, não custa nada e não tem troca a oferecer.": {
    es: "Una promesa escrita compromete a tu negocio. La verificación es una regla fija: no cuesta nada y no tiene contrapartidas.",
  },
  "É promessa que só você pode cumprir, e o cliente fica esperando. Regra fixa, sem custo.": {
    es: "Es una promesa que solo tú puedes cumplir, y el cliente se queda esperando. Regla fija, sin costo.",
  },
  "É a conferência que derrubou o vazamento medido de 30% para zero. Desligar reabre exatamente o defeito que ela existe para fechar.": {
    es: "Es la verificación que bajó la fuga medida del 30% a cero. Desactivarla reabre justo el defecto que busca cerrar.",
  },
  "É a mesma promessa vazia do 'vou pedir pro responsável', só que sobre agenda: o cliente fica esperando uma confirmação que nunca foi checada. Regra fixa, sem custo.": {
    es: "Es la misma promesa vacía del 'voy a pedirle al responsable', solo que sobre la agenda: el cliente se queda esperando una confirmación que nunca se revisó. Regla fija, sin costo.",
  },
  "Esconder que é um assistente é enganar o cliente.": {
    es: "Ocultar que es un asistente es engañar al cliente.",
  },
  "+1 consulta ao modelo por mensagem enviada": { es: "+1 consulta al modelo por mensaje enviado" },
  "+1 consulta ao modelo por mensagem recebida": { es: "+1 consulta al modelo por mensaje recibido" },

  // ─── Relatório de atividades (/app/activities) ───
  //
  // "acontecimento"/"acontecimentos" são o PLURAL da mesma contagem e entram
  // como duas chaves porque a tela escolhe uma das duas — espanhol tem a mesma
  // distinção, então nenhuma das duas pode faltar.
  "O que aconteceu na operação no período — e quanto disso foi a equipe.": {
    es: "Lo que pasó en la operación en el período y qué parte fue del equipo.",
  },
  Últimos: { es: "Últimos" },
  "Erro ao carregar o relatório.": { es: "Error al cargar el informe." },
  acontecimento: { es: "evento" },
  acontecimentos: { es: "eventos" },
  "Nada aconteceu neste período": { es: "No pasó nada en este período" },
  "Nenhum acontecimento foi registrado na janela escolhida — nem por pessoas, nem pelos agentes. Aumente o período ou confira se o atendimento está de pé.":
    {
      es: "No se registró ningún evento en el período elegido, ni de personas ni de agentes. Amplía el período o revisa que la atención esté funcionando.",
    },
  "Ver conversas": { es: "Ver conversaciones" },
  "A equipe": { es: "El equipo" },
  "Os agentes": { es: "Los agentes" },
  "Quem fez": { es: "Quién lo hizo" },
  "O que foi feito": { es: "Qué se hizo" },
  "Linha do tempo da operação": { es: "Línea de tiempo de la operación" },
  "A lista mostra só os mais recentes.": { es: "La lista muestra solo los más recientes." },
  "No período houve": { es: "En el período hubo" },
  "acontecimentos.": { es: "eventos." },
  "Carregando organização…": { es: "Cargando organización…" },
  "Gerenciar organizações": { es: "Administrar organizaciones" },
  "Não foi possível trocar de organização. Seu acesso pode ter mudado. Tente novamente.": { es: "No se pudo cambiar de organización. Es posible que tu acceso haya cambiado. Inténtalo de nuevo." },
  "Não foi possível trocar de organização. Tente novamente.": { es: "No se pudo cambiar de organización. Inténtalo de nuevo." },
  "Confirmando…": { es: "Confirmando…" },
  "Não foi possível aceitar este convite. Ele pode ter vencido ou seu acesso foi revogado. Peça um novo link ao administrador.": { es: "No se pudo aceptar esta invitación. Tal vez caducó o se revocó tu acceso. Pide un nuevo enlace al administrador." },
  "Organização criada": { es: "Organización creada" },
  "Você já é administrador de": { es: "Ya eres administrador de" },
  "Convite enviado por e-mail.": { es: "Invitación enviada por correo electrónico." },
  "O envio por e-mail não foi confirmado. Copie o link e compartilhe com o responsável.": { es: "No se confirmó el envío por correo electrónico. Copia el enlace y compártelo con el responsable." },
  "Link do convite": { es: "Enlace de la invitación" },
  "Válido até": { es: "Válido hasta" },
  "Link copiado": { es: "Enlace copiado" },
  "Selecione e copie o link acima.": { es: "Selecciona y copia el enlace de arriba." },
  "Copiar convite": { es: "Copiar invitación" },
  "Se o convite vencer, abra Equipe na organização para gerar outro.": { es: "Si la invitación caduca, abre Equipo en la organización para generar otra." },
  "Voltar ao aplicativo": { es: "Volver a la aplicación" },
  "Ver organização": { es: "Ver organización" },
  "Você terá acesso como administrador e poderá concluir a configuração inicial.": { es: "Tendrás acceso como administrador y podrás completar la configuración inicial." },
  "Nova organização": { es: "Nueva organización" },
  "Dados da organização": { es: "Datos de la organización" },
  "Criar organização": { es: "Crear organización" },

  // Meet: estados, falhas e ações da agenda e mensagem transacional.
  "Google Meet": { es: "Google Meet" },
  "Abrir reunião": { es: "Abrir reunión" },
  "Conversa que receberá o link": { es: "Conversación que recibirá el enlace" },
  "Nenhum atendimento aberto para este contato": { es: "No hay ninguna atención abierta para este contacto" },
  "Link ainda não solicitado": { es: "Enlace aún no solicitado" },
  "Criando link do Google Meet": { es: "Creando enlace de Google Meet" },
  "Link do Google Meet pronto": { es: "Enlace de Google Meet listo" },
  "Não foi possível confirmar o link": { es: "No se pudo confirmar el enlace" },
  "Solicitação de link cancelada": { es: "Solicitud de enlace cancelada" },
  "Link não enviado ainda.": { es: "Enlace aún no enviado." },
  "O envio do link ainda não foi autorizado.": { es: "Aún no se autorizó el envío del enlace." },
  "Este atendimento está ocupado neste instante. Aguarde alguns segundos e tente de novo.": {
    es: "Esta atención está ocupada en este momento. Espera unos segundos e inténtalo de nuevo.",
  },
  "Envio autorizado: aguardando o link ficar pronto.": { es: "Envío autorizado: esperando a que el enlace esté listo." },
  "Link aguardando envio nesta conversa.": { es: "Enlace pendiente de envío en esta conversación." },
  "Link enviado na conversa autorizada.": { es: "Enlace enviado en la conversación autorizada." },
  "Entrega impedida. Confira o atendimento e o canal antes de autorizar novamente.": { es: "Entrega bloqueada. Revisa la atención y el canal antes de autorizar de nuevo." },
  "O atendimento mudou. Autorize uma nova entrega na conversa desejada.": { es: "La atención cambió. Autoriza una nueva entrega en la conversación que quieras." },
  "O envio falhou. Confira o canal e tente novamente.": { es: "El envío falló. Revisa el canal e inténtalo de nuevo." },
  "Não foi possível copiar. Use o link de abrir reunião para acessar a sala.": { es: "No se pudo copiar. Usa el enlace para abrir la reunión y acceder a la sala." },
  "Tentar criar link novamente": { es: "Intentar crear el enlace de nuevo" },
  "Verificar link novamente": { es: "Verificar el enlace de nuevo" },
  "Link já enviado": { es: "Enlace ya enviado" },
  "Envio já autorizado": { es: "Envío ya autorizado" },
  "Enviar link ao cliente": { es: "Enviar enlace al cliente" },
  "Enviar quando ficar pronto": { es: "Enviar cuando esté listo" },
  "O Google não conseguiu criar o link. Tente criar novamente.": { es: "Google no pudo crear el enlace. Intenta crearlo de nuevo." },
  "Esta agenda não permite Google Meet. Confira as configurações da conta.": { es: "Este calendario no permite Google Meet. Revisa la configuración de la cuenta." },
  "O link ainda não foi confirmado. Tente verificar novamente.": { es: "El enlace aún no se ha confirmado. Intenta verificarlo de nuevo." },
  "O Google não devolveu um link de vídeo válido. Verifique novamente.": { es: "Google no devolvió un enlace de video válido. Verifícalo de nuevo." },
  "O contato bloqueou mensagens. O envio permanece impedido; respeite essa escolha.": { es: "El contacto bloqueó los mensajes. El envío sigue bloqueado; respeta su decisión." },
  "Os dados do contato não permitem o envio. Confira a situação e a base legal no cadastro.": { es: "Los datos del contacto no permiten el envío. Revisa su situación y la base legal en su ficha." },
  "O canal foi arquivado ou mudou. Escolha um atendimento em um canal disponível.": { es: "El canal fue archivado o cambió. Elige una atención en un canal disponible." },
  "O acesso do solicitante ou o atendimento mudou. Confira o responsável e escolha um atendimento disponível.": { es: "Cambió el acceso del solicitante o la atención. Revisa quién es el responsable y elige una atención disponible." },
  "O contato está em atendimento humano. O responsável pode autorizar este link pelo botão de envio, sem ativar a IA.": { es: "Una persona está atendiendo a este contacto. El responsable puede autorizar este enlace con el botón de envío, sin activar la IA." },
  "A IA está silenciada neste atendimento. O responsável pode autorizar somente este link pelo botão de envio.": { es: "La IA está silenciada en esta atención. El responsable puede autorizar solo este enlace con el botón de envío." },
  "Este atendimento está atribuído a uma pessoa. O responsável pode autorizar somente este link pelo botão de envio.": { es: "Esta atención está asignada a una persona. El responsable puede autorizar solo este enlace con el botón de envío." },
  "O contato não está autorizado para atendimento automático. O responsável pode autorizar somente este link pelo botão de envio.": { es: "El contacto no está autorizado para la atención automática. El responsable puede autorizar solo este enlace con el botón de envío." },
  "A autorização de atendimento automático expirou. O responsável pode autorizar somente este link pelo botão de envio.": { es: "La autorización de atención automática venció. El responsable puede autorizar solo este enlace con el botón de envío." },
  "O envio atingiu uma janela ou limite do canal. Aguarde a liberação antes de tentar novamente.": { es: "El envío alcanzó una ventana o un límite del canal. Espera a que se habilite antes de intentarlo de nuevo." },
  "Uma regra de envio impediu a mensagem. Confira o aviso na Central antes de tentar novamente.": { es: "Una regla de envío bloqueó el mensaje. Revisa el aviso en la Central antes de intentarlo de nuevo." },
  "Sua reunião está marcada para": { es: "Tu reunión está programada para" },
  "Link do Google Meet:": { es: "Enlace de Google Meet:" },


  // ─── app/api/v1/cron/agenda-reminder (o lembrete que sai no WhatsApp) ───
  //
  // Não é tela: é mensagem que sai para o telefone de um cliente. Sem estas
  // entradas, uma instalação em espanhol mandaria a frase em português com a
  // data em espanhol — a mesma metade-traduzida que o guarda de data proíbe,
  // só que irreversível, porque a mensagem já saiu. `às` já existia acima.
  "Oi,": { es: "¡Hola," },
  "Oi!": { es: "¡Hola!" },
  "Passando pra lembrar do seu compromisso:": { es: "Te recuerdo tu cita:" },
  "Endereço": { es: "Dirección" },

  // ─── lib/ai/pontos/resolver.ts (avisos do painel de Provedores de IA) ───
  "Este ponto usa o modelo definido na versão publicada do agente; a escolha do painel não se aplica.": {
    es: "Este punto usa el modelo definido en la versión publicada del agente. La selección del panel no aplica.",
  },

  // ─── app/app/settings/voip-trunk (Trunk SIP, migration 0349) ───
  "Trunk SIP": { es: "Trunk SIP" },
  "Credenciais de registro do seu provedor SIP (Asterisk/AudioSocket). Depois de salvar, aplique o bloco abaixo em": {
    es: "Credenciales de registro de tu proveedor SIP (Asterisk/AudioSocket). Después de guardar, aplica el bloque de abajo en",
  },
  "na VPS — a aplicação ainda é manual.": { es: "en la VPS. Por ahora se aplica de forma manual." },
  "Provedor SIP": { es: "Proveedor SIP" },
  Host: { es: "Host" },
  "configurada, termina em": { es: "configurada, termina en" },
  "Deixe em branco para manter a atual": { es: "Déjalo en blanco para mantener la actual" },
  "From-domain (opcional)": { es: "From-domain (opcional)" },
  "IP público da VPS, se o provedor exigir": { es: "IP público de la VPS, si el proveedor lo exige" },
  "Cole em asterisk/pjsip.conf": { es: "Pega esto en asterisk/pjsip.conf" },
  "Só aparece agora, logo após salvar — a senha não é guardada em claro, então este bloco completo não pode ser reconstruído depois.": {
    es: "Solo se muestra ahora, justo después de guardar. La contraseña no se guarda en texto plano, así que este bloque completo no se puede reconstruir después.",
  },

  // ─── components/ai/AgentEditor.tsx (aba Voz do agente) ───
  Voz: { es: "Voz" },
  "Este agente fala pela Realtime API da OpenAI -- o modelo de voz se escolhe na aba Voz, não aqui.": {
    es: "Este agente habla con la Realtime API de OpenAI. El modelo de voz se elige en la pestaña Voz, no aquí.",
  },
  "Modelo de voz": { es: "Modelo de voz" },
  "Voz do modelo": { es: "Voz del modelo" },
  "Velocidade da fala (0,25–1,5)": { es: "Velocidad del habla (0,25–1,5)" },
  "1,0 é a velocidade padrão do modelo — abaixo disso fala mais devagar, acima fala mais rápido. Vale a partir da próxima ligação.": {
    es: "1,0 es la velocidad predeterminada del modelo. Por debajo habla más despacio y por encima, más rápido. Se aplica desde la próxima llamada.",
  },

  // ─── components/connections/TelefoniaClient.tsx (números de voz / DID) ───
  "Números que recebem ligações. Cada número aponta pra um agente de voz e um modo de atendimento.": {
    es: "Números que reciben llamadas. Cada número apunta a un agente de voz y un modo de atención.",
  },
  "Novo número": { es: "Nuevo número" },
  "Nenhum número cadastrado ainda.": { es: "Aún no hay números registrados." },
  "Cadastre o número (DID) que vai receber ligações. O troncal de voz já está configurado pela plataforma.": {
    es: "Registra el número (DID) que recibirá las llamadas. La plataforma ya configuró el troncal de voz.",
  },
  "Número (E.164)": { es: "Número (E.164)" },
  "Rótulo (opcional)": { es: "Etiqueta (opcional)" },
  "Ex.: Linha principal": { es: "Ej.: Línea principal" },
  "Modo de atendimento": { es: "Modo de atención" },
  // Os três valores de ROUTING_LABELS (components/connections/TelefoniaClient.tsx):
  // a chave chega por índice, então cada valor possível precisa da própria linha.
  "IA responde": { es: "La IA responde" },
  "Time humano": { es: "Equipo humano" },
  "IA, depois time humano": { es: "La IA y después el equipo humano" },
  "Agente de voz": { es: "Agente de voz" },
  "Nenhum agente": { es: "Ningún agente" },
  "Nenhum agente de voz publicado ainda — crie um em IA › Agentes.": {
    es: "Aún no hay agentes de voz publicados. Crea uno en IA › Agentes.",
  },
  "Sem rótulo": { es: "Sin etiqueta" },

  // ─── app/app/calls/_client.tsx (histórico de chamadas SIP) ───
  "Nova ligação": { es: "Nueva llamada" },
  "A IA liga pra esse número e conduz a chamada — falar você mesmo ainda não está disponível.": {
    es: "La IA llama a este número y conduce la llamada. Aún no es posible hablar tú mismo.",
  },
  "Número": { es: "Número" },
  "Ligar com IA": { es: "Llamar con IA" },
  "Chamadas": { es: "Llamadas" },
  "Histórico de ligações (voz por IA) com transcrição.": {
    es: "Historial de llamadas (voz por IA) con transcripción.",
  },
  "Direção": { es: "Dirección" },
  "Quem é": { es: "Quién es" },
  "Atendido por": { es: "Atendido por" },
  "Humano": { es: "Humano" },
  "Nenhuma chamada ainda.": { es: "Aún no hay llamadas." },
  "Chamada com": { es: "Llamada con" },
  "(sem áudio detectado)": { es: "(sin audio detectado)" },
  "Sem transcrição pra esta chamada.": { es: "Sin transcripción para esta llamada." },
  "Chamando": { es: "Llamando" },
  "Não atendida": { es: "No atendida" },
  "Ocupado": { es: "Ocupado" },
  // ─── app/app/team/_components/TeamInvitesClient.tsx (lista de convites) ───
  "Convites": { es: "Invitaciones" },
  "Convites enviados e seu status. Um convite aceito vira membro na lista acima.": {
    es: "Invitaciones enviadas y su estado. Al aceptarla, la persona aparece como miembro en la lista de arriba.",
  },
  "Nenhum convite enviado.": { es: "No hay invitaciones enviadas." },
  "Erro ao carregar convites.": { es: "Error al cargar las invitaciones." },
  "E-mail enviado": { es: "Correo enviado" },
  "Enviado em": { es: "Enviado el" },
  "Convidado por": { es: "Invitado por" },
  "Expirado": { es: "Expirada" },
  "Não saiu": { es: "No se envió" },
  "reenviado": { es: "reenviado" },
  "Revogar convite": { es: "Revocar invitación" },
  "não poderá mais usar este convite para entrar. Você pode enviar um novo depois.": {
    es: "ya no podrá usar esta invitación para entrar. Puedes enviar una nueva después.",
  },
  "Link do convite copiado.": { es: "Enlace de la invitación copiado." },
  "Não foi possível copiar. Copie da barra do navegador.": {
    es: "No se pudo copiar. Cópialo desde la barra del navegador.",
  },
  "Convite reenviado.": { es: "Invitación reenviada." },
  "Convite revogado.": { es: "Invitación revocada." },

  // ─── issue #651 — tabelas de rótulo que só o guarda ampliado alcança ───
  //
  // `chavesUsadas()` passou a resolver `t(X[k])`/`t(X.k)` quando `X` é tabela
  // `const` de módulo. Estas 8 chaves saíam em português com o guarda antigo
  // verde — medido rodando o guarda ampliado contra `main` antes de adicionar
  // qualquer entrada aqui: as 8 abaixo, e só elas, reprovavam.
  // ─── app/app/lgpd/requests/RequestsTable.tsx (SLA_LABELS) ───
  "OK": { es: "OK" },
  // ─── lib/kanban/score-band.ts (SCORE_BAND_LABELS) ───
  "Frio": { es: "Frío" },
  "Morno": { es: "Tibio" },
  "Quente": { es: "Caliente" },
  // ─── components/ai/GuardrailsEditor.tsx (KIND_LABELS) ───
  //
  // As 4 chaves abaixo já nascem em INGLÊS, não em português — bug à parte de
  // #651: a convenção do projeto é "a chave é o texto em português", e aqui
  // não é. Fora do escopo deste PR (é a fonte que precisa mudar, não a
  // tradução), sinalizado no PR para abrir issue própria.
  "Regex output block": { es: "Bloqueo de salida por regex" },
  "RAG must hit": { es: "RAG debe coincidir" },
  "Regex input block": { es: "Bloqueo de entrada por regex" },
  "Contact flag": { es: "Marca de contacto" },
  "Falha ao avançar:": { es: "Error al avanzar:" },
  "Nuvemshop": { es: "Nuvemshop" },
  "Billing": { es: "Facturación" },
  "API Tokens": { es: "Tokens de API" },
  "As colunas de cada funil, o vocabulário do negócio e os motivos de perda.": { es: "Las columnas de cada embudo, el vocabulario del negocio y los motivos de pérdida." },
  "As conversas de WhatsApp, com você e a IA atendendo lado a lado.": { es: "Las conversaciones de WhatsApp, donde tú y la IA atienden lado a lado." },
  "As pessoas do outro lado da conversa e seu histórico.": { es: "Las personas del otro lado de la conversación y su historial." },
  "Avise outros sistemas quando algo acontecer aqui dentro.": { es: "Avisa a otros sistemas cuando algo pase aquí." },
  "Conectar a conta de anúncios para ler o desempenho das campanhas.": { es: "Conectar la cuenta de anuncios para leer el rendimiento de las campañas." },
  "Conecte a loja para trazer pedidos e clientes para dentro do CRM.": { es: "Conecta la tienda para traer pedidos y clientes al CRM." },
  "Devolver ao anúncio as vendas que ele trouxe, e marcar a origem de quem chega pelo site.": { es: "Devolver al anuncio las ventas que trajo, y marcar el origen de quien llega por el sitio." },
  "Funil e performance por atendente nos últimos 30 dias.": { es: "Embudo y rendimiento por asesor en los últimos 30 días." },
  "O catálogo da loja, com o preço que o atendente de IA responde.": { es: "El catálogo de la tienda, con el precio que responde el agente de IA." },
  "O que se pode marcar, quanto dura, onde acontece e quem atende.": { es: "Qué se puede programar, cuánto dura, dónde se realiza y quién atiende." },
  "Quanto custou cada resultado das campanhas que trazem gente para cá.": { es: "Cuánto costó cada resultado de las campañas que traen gente aquí." },
  "Quem esfriou e ainda está aberto — o que corre risco de morrer sem resposta.": { es: "Quiénes se enfriaron y siguen abiertos: lo que corre el riesgo de perderse sin respuesta." },
  "Quem fez o quê, quando — o histórico que não se apaga.": { es: "Quién hizo qué y cuándo: el historial que no se borra." },
  "Relatório do que a equipe e os agentes fizeram no período: quanto, quem e de que tipo.": { es: "Informe de lo que el equipo y los agentes hicieron en el período: cuánto, quién y de qué tipo." },
  "Scripts salvos para responder mais rápido, seus ou da equipe.": { es: "Scripts guardados para responder más rápido, tuyos o del equipo." },
  "Se o agente está melhorando, onde ele erra e o que falta ensinar.": { es: "Si el agente está mejorando, dónde se equivoca y qué falta enseñar." },
  "Seus funis de venda — clique em um para abrir o quadro de clientes.": { es: "Tus embudos de venta. Haz clic en uno para abrir el tablero de clientes." },
  "Seus números de WhatsApp: por QR ou canal oficial da Meta, com saúde, reconexão e templates.": { es: "Tus números de WhatsApp: por QR o canal oficial de Meta, con salud, reconexión y plantillas." },
  "Agendamento criado.": { es: "Cita creada." },
  "Agendamento remarcado.": { es: "Cita reprogramada." },
  "Agendamento cancelado.": { es: "Cita cancelada." },
  "Horário confirmado.": { es: "Horario confirmado." },
  "Confirmar horário": { es: "Confirmar horario" },
  "Marcado como realizado.": { es: "Cita marcada como realizada." },
  "Marcado como falta — o horário volta a ficar livre.": { es: "Cita marcada como inasistencia. El horario vuelve a estar disponible." },
  "Mídia": { es: "Multimedia" },
  "Tenant suspenso com sucesso": { es: "Tenant suspendido correctamente" },
  "Erro ao suspender tenant": { es: "Error al suspender el tenant" },
  "Tenant reativado com sucesso": { es: "Tenant reactivado correctamente" },
  "Erro ao reativar tenant": { es: "Error al reactivar el tenant" },
  "Incidente resolvido com sucesso": { es: "Incidente resuelto correctamente" },
  "Erro ao resolver incidente": { es: "Error al resolver el incidente" },
  "Redes sociais": { es: "Redes sociales" },
  "Conecte suas contas e receba mensagens no atendimento.": { es: "Conecta tus cuentas y recibe mensajes en atención." },
  "A autorização não foi concluída. Tente conectar novamente e aceite as permissões necessárias.": { es: "La autorización no se completó. Intenta conectar de nuevo y acepta los permisos necesarios." },
  "Autorização concluída. Confira a conta na lista e ative o atendimento, quando disponível.": { es: "Autorización completada. Revisa la cuenta en la lista y activa la atención cuando esté disponible." },
  "Vincular o provedor": { es: "Vincular el proveedor" },
  "A chave fica cifrada no servidor e não é exibida novamente.": { es: "La clave se guarda cifrada en el servidor y no se vuelve a mostrar." },
  "Buscar perfis": { es: "Buscar perfiles" },
  "Perfil da empresa": { es: "Perfil de la empresa" },
  "Conectar uma rede": { es: "Conectar una red" },
  "Abrindo…": { es: "Abriendo…" },
  "Autorizar conta": { es: "Autorizar cuenta" },
  "Você autoriza na própria rede e retorna ao CRM. Cada perfil comporta uma conta por rede; use a mesma conta ao reconectar.": { es: "Autorizas directamente en la red y vuelves al CRM. Cada perfil admite una cuenta por red. Al reconectar, usa la misma cuenta." },
  "Vinculada": { es: "Vinculada" },
  "Verificar conexão": { es: "Verificar conexión" },
  "Receber no atendimento": { es: "Recibir en atención" },
  "Recebimento configurado. Novas mensagens entram na caixa de entrada.": { es: "Recepción configurada. Los nuevos mensajes llegan a la bandeja de entrada." },
  "O recebimento precisa de atenção. Confira a conexão antes de atender.": { es: "La recepción necesita atención. Verifica la conexión antes de atender." },
  "Ative para receber novas conversas. A IA começa pausada para evitar respostas duplicadas com outras automações.": { es: "Activa para recibir nuevas conversaciones. La IA empieza pausada para evitar respuestas duplicadas con otras automatizaciones." },
  "Conta disponível no provedor. O atendimento por mensagens desta rede ainda não está integrado ao CRM.": { es: "Cuenta disponible en el proveedor. La atención por mensajes de esta red todavía no está integrada en el CRM." },
  "Nenhuma conta conectada neste perfil. Autorize uma rede para começar.": { es: "No hay cuentas conectadas en este perfil. Autoriza una red para empezar." },
  "Alterar credencial": { es: "Cambiar credencial" },
  "IA pausada": { es: "IA pausada" },
  "As mensagens chegam para atendimento humano. A IA está pausada neste canal.": { es: "Los mensajes llegan para atención humana. La IA está pausada en este canal." },
  "Acesso da IA nesta rede": { es: "Acceso de la IA en esta red" },
  "Pause a IA para manter o atendimento humano ou libere as respostas automáticas neste canal.": { es: "Pausa la IA para mantener la atención humana o habilita las respuestas automáticas en este canal." },
  "As mensagens continuam chegando à caixa de entrada para sua equipe responder. Confira outras automações da conta antes de liberar a IA aqui.": { es: "Los mensajes siguen llegando a la bandeja de entrada para que tu equipo responda. Revisa otras automatizaciones de la cuenta antes de habilitar la IA aquí." },
  "Pausar respostas da IA": { es: "Pausar respuestas de la IA" },
  "Manter IA pausada": { es: "Mantener IA pausada" },
  "Não foi possível carregar as redes sociais.": { es: "No se pudieron cargar las redes sociales." },
  "Reconfigurar integração": { es: "Reconfigurar integración" },

  // Extensões declarativas — interface e mensagens literais da API.
  "Extensões": { es: "Extensiones" },
  "Instaladas": { es: "Instaladas" },
  "Orientações instaladas": { es: "Orientaciones instaladas" },
  "Guias adicionados depois da instalação, sem acesso aos dados do CRM.": { es: "Guías agregadas después de la instalación, sin acceso a los datos del CRM." },
  "Gerenciar extensões": { es: "Administrar extensiones" },
  "Não foi possível conferir as orientações instaladas": { es: "No se pudieron verificar las orientaciones instaladas" },
  "Abra Extensões para tentar novamente e ver o estado registrado no servidor.": { es: "Abre Extensiones para intentarlo de nuevo y ver el estado registrado en el servidor." },
  "Abre Tarefas; não lê seus dados.": { es: "Abre Tareas; no lee tus datos." },
  "Abre {portas}; não lê seus dados.": { es: "Abre {portas}; no lee tus datos." },
  "Não abre nenhuma tela e não lê seus dados.": { es: "No abre ninguna pantalla y no lee tus datos." },
  "Publicado por": { es: "Publicado por" },
  "O que ela abre": { es: "Qué abre" },
  "Etiquetas": { es: "Etiquetas" },
  "Não recebe acesso aos dados do CRM.": { es: "No recibe acceso a los datos del CRM." },
  "Texto disponível em português.": { es: "Texto disponible en portugués." },
  "Parte deste conteúdo está disponível apenas em português.": { es: "Parte de este contenido está disponible solo en portugués." },
  "Adicione guias ao CRM sem entregar dados ou executar código de terceiros. Cada ação volta ao servidor antes de abrir Tarefas.": { es: "Agrega guías al CRM sin entregar datos ni ejecutar código de terceros. Cada acción pasa por el servidor antes de abrir Tareas." },
  "Buscar por nome ou descrição": { es: "Buscar por nombre o descripción" },
  "Buscar extensões": { es: "Buscar extensiones" },
  "Filtrar por categoria": { es: "Filtrar por categoría" },
  "Todas as categorias": { es: "Todas las categorías" },
  "Produtividade": { es: "Productividad" },
  "Vendas": { es: "Ventas" },
  "Não foi possível confirmar o estado atual": { es: "No se pudo confirmar el estado actual" },
  "A conexão caiu sem confirmação. O pedido foi preservado pelo recibo; verifique o estado antes de tentar outra vez.": { es: "La conexión se cortó sin confirmación. La solicitud quedó guardada en el recibo. Verifica el estado antes de intentarlo de nuevo." },
  "Pedidos aguardando confirmação": { es: "Solicitudes pendientes de confirmación" },
  "Os identificadores abaixo foram preservados neste navegador para evitar pedidos duplicados.": { es: "Los identificadores siguientes se conservaron en este navegador para evitar solicitudes duplicadas." },
  "Verificar recibo": { es: "Verificar recibo" },
  "O servidor não encontrou esse recibo. Você pode enviar o pedido novamente.": { es: "El servidor no encontró ese recibo. Puedes enviar la solicitud de nuevo." },
  "Seções de extensões": { es: "Secciones de extensiones" },
  "Responsável pela instalação": { es: "Responsable de la instalación" },
  "Adicionar catálogo revisado": { es: "Agregar catálogo revisado" },
  "Escolha um arquivo de catálogo obtido diretamente de uma fonte em que você já confia. A origem e a revisão ficam registradas.": { es: "Elige un archivo de catálogo obtenido directamente de una fuente en la que ya confías. El origen y la revisión quedan registrados." },
  "Escolher arquivo JSON": { es: "Elegir archivo JSON" },
  "Registrando…": { es: "Registrando…" },
  "Revisar e registrar catálogo": { es: "Revisar y registrar catálogo" },
  "O que este passo comprova": { es: "Qué demuestra este paso" },
  "Registra quem admitiu, quando, a origem e a revisão do arquivo.": { es: "Registra quién lo admitió, cuándo, el origen y la revisión del archivo." },
  "Confere a integridade dos bytes antes de qualquer instalação.": { es: "Verifica la integridad de los bytes antes de cualquier instalación." },
  "O hash do arquivo não prova quem o publicou. Confirme a fonte antes de escolher.": { es: "El hash del archivo no demuestra quién lo publicó. Confirma la fuente antes de elegir." },
  "Catálogo admitido e disponível para instalação.": { es: "Catálogo admitido y disponible para la instalación." },
  "Nenhuma extensão instalada": { es: "No hay extensiones instaladas" },
  "Quando a plataforma instalar um pacote revisado, ele aparecerá aqui para a organização decidir se ativa.": { es: "Cuando la plataforma instale un paquete revisado, aparecerá aquí para que la organización decida si lo activa." },
  "Nenhuma extensão corresponde à busca": { es: "Ninguna extensión coincide con la búsqueda" },
  "Limpe a busca ou escolha outra categoria.": { es: "Borra la búsqueda o elige otra categoría." },
  "Nenhum catálogo revisado disponível": { es: "No hay catálogos revisados disponibles" },
  "Adicione acima um arquivo obtido de uma fonte em que você já confia.": { es: "Agrega arriba un archivo obtenido de una fuente en la que ya confías." },
  "Peça ao responsável pela instalação para admitir um catálogo revisado.": { es: "Pide al responsable de la instalación que admita un catálogo revisado." },
  "Esta versão não pode ser ativada": { es: "Esta versión no se puede activar" },
  "O servidor recusou a compatibilidade desta versão.": { es: "El servidor rechazó la compatibilidad de esta versión." },
  "Peça ao responsável pela instalação uma versão compatível.": { es: "Pide al responsable de la instalación una versión compatible." },
  "Ativa no CRM": { es: "Activa en el CRM" },
  "Os guias aparecem no hub do CRM.": { es: "Las guías aparecen en el centro del CRM." },
  "A configuração fica preservada enquanto estiver desativada.": { es: "La configuración se conserva mientras esté desactivada." },
  "Densidade dos cards": { es: "Densidad de las tarjetas" },
  "Confortável": { es: "Cómoda" },
  "Compacta": { es: "Compacta" },
  "Mostrar descrição nos cards": { es: "Mostrar descripción en las tarjetas" },
  "Abrir guia": { es: "Abrir guía" },
  "Ative para abrir o guia.": { es: "Actívala para abrir la guía." },
  "Salvar configuração": { es: "Guardar configuración" },
  "Configuração salva.": { es: "Configuración guardada." },
  "Saia do acompanhamento para configurar extensões.": { es: "Sal del modo de seguimiento para configurar extensiones." },
  "Este guia está pronto para uso.": { es: "Esta guía está lista para usar." },
  "Peça a um administrador da organização para ativar este guia.": { es: "Pide a un administrador de la organización que active esta guía." },
  "Identidade": { es: "Identidad" },
  "Origem revisada": { es: "Origen revisado" },
  "Permissão": { es: "Permiso" },
  "Esta versão já está instalada.": { es: "Esta versión ya está instalada." },
  "Instalar versão revisada": { es: "Instalar versión revisada" },
  "Somente o responsável pela instalação pode instalar este pacote.": { es: "Solo el responsable de la instalación puede instalar este paquete." },
  "Extensão instalada. Agora um administrador da organização pode ativá-la.": { es: "Extensión instalada. Ahora un administrador de la organización puede activarla." },
  "Preparação iniciada. O recibo continuará visível até a conclusão.": { es: "Preparación iniciada. El recibo seguirá visible hasta que termine." },
  "A instalação falhou. Veja o motivo no recibo e tente de novo.": { es: "La instalación falló. Revisa el motivo en el recibo e inténtalo de nuevo." },
  "Incompatível": { es: "Incompatible" },
  "O pacote gravado não pôde ser conferido por esta versão do CRM.": { es: "El paquete guardado no pudo verificarse con esta versión del CRM." },
  "Ela segue marcada como ativa e ocupa uma das vagas de extensões ativas até ser desativada.": { es: "Sigue marcada como activa y ocupa uno de los cupos de extensiones activas hasta que se desactive." },
  "Desativar nesta organização": { es: "Desactivar en esta organización" },
  "Atividade recente": { es: "Actividad reciente" },
  "Recibos lidos do servidor; outra aba verá os mesmos estados.": { es: "Los recibos se leen del servidor, así que otra pestaña verá los mismos estados." },
  "Admissão de catálogo": { es: "Admisión de catálogo" },
  "Instalação": { es: "Instalación" },
  "Operação da plataforma": { es: "Operación de la plataforma" },
  "Instalação de módulo": { es: "Instalación de módulo" },
  "Módulo {nome}": { es: "Módulo {nome}" },
  "Confira o catálogo admitido e tente a instalação novamente.": { es: "Revisa el catálogo admitido e intenta instalar de nuevo." },
  "Revise o arquivo ou a configuração indicada e tente novamente.": { es: "Revisa el archivo o la configuración indicada e inténtalo de nuevo." },
  "Verificar instalação": { es: "Verificar instalación" },
  "Cancelar preparação": { es: "Cancelar preparación" },
  "Preparação cancelada. Uma conclusão atrasada não poderá publicar a extensão.": { es: "Preparación cancelada. Una finalización tardía no podrá publicar la extensión." },
  "Carregando extensões…": { es: "Cargando extensiones…" },
  "Outra pessoa alterou esta extensão. Recarregamos o valor atual; revise antes de salvar novamente.": { es: "Otra persona cambió esta extensión. Recargamos el valor actual; revísalo antes de guardar de nuevo." },
  "Este guia não está disponível": { es: "Esta guía no está disponible" },
  "Não foi possível confirmar o estado atual desta extensão.": { es: "No se pudo confirmar el estado actual de esta extensión." },
  "Volte à gestão para conferir se ela está ativa e qual é o próximo passo.": { es: "Vuelve a la administración para verificar si está activa y cuál es el siguiente paso." },
  "Voltar às extensões": { es: "Volver a extensiones" },
  "Conferindo se o guia continua ativo…": { es: "Comprobando si la guía sigue activa…" },
  "A ação não foi aberta": { es: "La acción no se abrió" },
  "O estado foi conferido novamente. Revise o guia antes de tentar outra vez.": { es: "El estado se comprobó de nuevo. Revisa la guía antes de intentarlo otra vez." },
  "Conferindo acesso…": { es: "Comprobando acceso…" },
  "A ativação e a permissão serão verificadas novamente antes de abrir Tarefas.": { es: "La activación y el permiso se comprobarán de nuevo antes de abrir Tareas." },
  "O servidor devolveu um destino que esta extensão não pode abrir.": { es: "El servidor devolvió un destino que esta extensión no puede abrir." },
  "A conexão caiu antes de o servidor confirmar o resultado.": { es: "La conexión se interrumpió antes de que el servidor confirmara el resultado." },
  "O servidor respondeu em um formato inesperado. Recarregue e tente novamente.": { es: "El servidor respondió en un formato inesperado. Recarga e inténtalo de nuevo." },
  "Não foi possível concluir a operação.": { es: "No se pudo completar la operación." },
  "Só o administrador da instalação pode gerenciar os pacotes disponíveis.": { es: "Solo el administrador de la instalación puede gestionar los paquetes disponibles." },
  "Não foi possível confirmar a permissão de acesso.": { es: "No se pudo confirmar el permiso de acceso." },
  "Confira os dados do pedido e tente novamente.": { es: "Comprueba los datos de la solicitud e inténtalo de nuevo." },
  "Não foi possível confirmar o resultado. Consulte o histórico antes de repetir o pedido.": { es: "No se pudo confirmar el resultado. Consulta el historial antes de repetir la solicitud." },
  "Envie o documento sem compressão.": { es: "Envía el documento sin compresión." },
  "Extensão não encontrada.": { es: "Extensión no encontrada." },
  "Falta a identificação do pedido. Recarregue a página e tente novamente.": { es: "Falta la identificación de la solicitud. Recarga la página e inténtalo de nuevo." },
  "O documento está vazio.": { es: "El documento está vacío." },
  "A extensão não é compatível com esta instalação.": { es: "La extensión no es compatible con esta instalación." },
  "A origem do catálogo não é permitida.": { es: "El origen del catálogo no está permitido." },
  "Não foi possível baixar o pacote de extensão.": { es: "No se pudo descargar el paquete de extensión." },
  "O arquivo da extensão excede o limite permitido.": { es: "El archivo de la extensión supera el límite permitido." },
  "O pacote baixado não corresponde ao catálogo admitido.": { es: "El paquete descargado no corresponde al catálogo admitido." },
  "O pacote de extensão é inválido.": { es: "El paquete de extensión no es válido." },
  "A configuração mudou em outra sessão. Recarregue antes de continuar.": { es: "La configuración cambió en otra sesión. Recarga antes de continuar." },
  "A configuração mudou em outra sessão. Recarregue antes de salvar.": { es: "La configuración cambió en otra sesión. Recarga antes de guardar." },
  "Catálogo não encontrado. Recarregue a lista de extensões.": { es: "Catálogo no encontrado. Recarga la lista de extensiones." },
  "Esta extensão está desativada nesta organização. Consulte o administrador para ativá-la.": { es: "Esta extensión está desactivada en esta organización. Consulta al administrador para activarla." },
  "Esta extensão não é compatível com a API disponível nesta instalação.": { es: "Esta extensión no es compatible con la API disponible en esta instalación." },
  "Esta versão não está no catálogo admitido. Recarregue a lista.": { es: "Esta versión no está en el catálogo admitido. Recarga la lista." },
  "Este pedido já foi usado com outros dados. Recarregue a página.": { es: "Esta solicitud ya se usó con otros datos. Recarga la página." },
  "Este pedido mudou de estado. Consulte o histórico antes de continuar.": { es: "Esta solicitud cambió de estado. Consulta el historial antes de continuar." },
  "Já existe conteúdo diferente para esta versão. Peça uma nova versão ao mantenedor.": { es: "Ya existe contenido diferente para esta versión. Pide una nueva versión al mantenedor." },
  "Já existe uma preparação em andamento. Em Atividade recente, quem pediu pode retomá-la, e qualquer responsável pela instalação pode cancelá-la.": { es: "Ya hay una preparación en curso. En Actividad reciente, quien la pidió puede retomarla, y cualquier responsable de la instalación puede cancelarla." },
  "Não foi possível concluir a preparação. Confira o catálogo e faça um novo pedido.": { es: "No se pudo completar la preparación. Comprueba el catálogo y crea una nueva solicitud." },
  "Não foi possível ler o pacote instalado. Consulte o administrador da instalação.": { es: "No se pudo leer el paquete instalado. Consulta al administrador de la instalación." },
  "O arquivo recebido não corresponde à versão admitida. Peça ao mantenedor para conferir a publicação.": { es: "El archivo recibido no corresponde a la versión admitida. Pide al mantenedor que compruebe la publicación." },
  "O catálogo mudou durante a preparação. Recarregue a lista antes de instalar.": { es: "El catálogo cambió durante la preparación. Recarga la lista antes de instalar." },
  "O catálogo tem uma revisão anterior ou diferente da já admitida. Peça o arquivo atual ao mantenedor.": { es: "El catálogo tiene una revisión anterior o distinta de la ya admitida. Pide el archivo actual al mantenedor." },
  "O limite de catálogos desta instalação foi atingido.": { es: "Se alcanzó el límite de catálogos de esta instalación." },
  "O limite de extensões ativas foi atingido. Desative uma antes de ativar outra.": { es: "Se alcanzó el límite de extensiones activas. Desactiva una antes de activar otra." },
  "O limite de pacotes desta instalação foi atingido.": { es: "Se alcanzó el límite de paquetes de esta instalación." },
  "O pacote local precisa ser conferido pelo administrador da instalação.": { es: "El administrador de la instalación debe comprobar el paquete local." },
  "O sistema está sendo atualizado. Aguarde a conclusão para alterar extensões.": { es: "El sistema se está actualizando. Espera a que termine para modificar extensiones." },
  "Pedido não encontrado. Consulte o histórico da instalação.": { es: "Solicitud no encontrada. Consulta el historial de la instalación." },
  "Pedido não encontrado.": { es: "Solicitud no encontrada." },
  "Seu acesso mudou. Entre novamente para continuar.": { es: "Tu acceso cambió. Vuelve a entrar para continuar." },
  "A instalação já havia sido concluída; o recibo foi atualizado.": { es: "La instalación ya había terminado; el recibo se actualizó." },
  "A preparação já havia falhado; o recibo foi atualizado.": { es: "La preparación ya había fallado; el recibo se actualizó." },
  "Guias instalados para orientar o trabalho no CRM, com permissões e estado visíveis.": { es: "Guías instaladas para orientar el trabajo en el CRM, con permisos y estado visibles." },
  "Envie um documento JSON.": { es: "Envía un documento JSON." },
  "O envio foi interrompido. Tente novamente.": { es: "El envío se interrumpió. Inténtalo de nuevo." },
  "Não foi possível confirmar o cancelamento. Verifique o recibo antes de repetir a ação.": { es: "No se pudo confirmar la cancelación. Comprueba el recibo antes de repetir la acción." },
  "Admitindo…": { es: "Admitiendo…" },
  "Admitir catálogo": { es: "Admitir catálogo" },
  "Confere que o arquivo não mudou antes de qualquer instalação.": { es: "Comprueba que el archivo no haya cambiado antes de cualquier instalación." },
  "O arquivo não comprova quem o publicou. Confirme a fonte antes de escolher.": { es: "El archivo no demuestra quién lo publicó. Confirma la fuente antes de elegir." },
  "Adicione guias ao CRM sem entregar dados ou executar código de terceiros. Antes de abrir Tarefas, o acesso e a ativação são conferidos novamente.": { es: "Agrega guías al CRM sin entregar datos ni ejecutar código de terceros. Antes de abrir Tareas, se vuelven a comprobar el acceso y la activación." },
  "Os recibos abaixo foram preservados neste navegador para evitar pedidos duplicados.": { es: "Los recibos de abajo se guardaron en este navegador para evitar solicitudes duplicadas." },
  "Este histórico é compartilhado entre abas e mostra o resultado confirmado.": { es: "Este historial se comparte entre pestañas y muestra el resultado confirmado." },
  "Adicione guias que orientam o trabalho e só podem abrir Tarefas, sem receber dados do CRM. Escolha um catálogo revisado de uma fonte em que você confia.": { es: "Agrega guías que orientan el trabajo y solo pueden abrir Tareas, sin recibir datos del CRM. Elige un catálogo revisado de una fuente en la que confíes." },
  "O arquivo JSON pode ter até 512 KiB.": { es: "El archivo JSON puede tener hasta 512 KiB." },
  "Antes de admitir": { es: "Antes de admitir" },
  "A organização ativa mudou em outra aba. Recarregue a página antes de continuar.": { es: "La organización activa cambió en otra pestaña. Recarga la página antes de continuar." },
  "Falta o contexto da organização. Recarregue a página e tente novamente.": { es: "Falta el contexto de la organización. Recarga la página e inténtalo de nuevo." },
  "O arquivo pode ter até 512 KiB. Escolha um arquivo menor.": { es: "El archivo puede tener hasta 512 KiB. Elige un archivo más pequeño." },
  "Não foi possível ler este arquivo. Escolha o catálogo novamente e tente outra vez.": { es: "No se pudo leer este archivo. Elige el catálogo de nuevo e inténtalo otra vez." },
  "Não foi possível confirmar o resultado da verificação. Consulte o recibo antes de repetir a ação.": { es: "No se pudo confirmar el resultado de la comprobación. Consulta el recibo antes de repetir la acción." },
  "Este navegador não conseguiu guardar o recibo. Libere o armazenamento deste site antes de enviar o pedido.": { es: "Este navegador no pudo guardar el recibo. Habilita el almacenamiento de este sitio antes de enviar la solicitud." },
  "Atualize o estado das extensões antes de enviar um novo pedido.": { es: "Actualiza el estado de las extensiones antes de enviar una nueva solicitud." },
  "Aguarde enquanto os recibos deste navegador são conferidos.": { es: "Espera mientras se comprueban los recibos de este navegador." },
  "O estado exibido está desatualizado": { es: "El estado mostrado está desactualizado" },
  "Os pedidos estão bloqueados neste navegador": { es: "Las solicitudes están bloqueadas en este navegador" },
  "Libere o armazenamento do site e recarregue a página para continuar com segurança.": { es: "Habilita el almacenamiento del sitio y recarga la página para continuar de forma segura." },
  "Oriente o trabalho com novos guias": { es: "Orienta el trabajo con nuevas guías" },
  "Preparação cancelada. Este pedido não instalará a extensão.": { es: "Preparación cancelada. Esta solicitud no instalará la extensión." },
  "O servidor devolveu um recibo sem o contexto esperado. Recarregue a página antes de continuar.": { es: "El servidor devolvió un recibo sin el contexto esperado. Recarga la página antes de continuar." },
  // Atualizar, desfazer a última troca e remover da instalação.
  "Há uma preparação desta extensão em andamento. Acompanhe ou cancele o pedido em Atividade recente.": { es: "Hay una preparación de esta extensión en curso. Da seguimiento a la solicitud o cancélala en Actividad reciente." },
  "Há uma extensão em preparação. Abra Extensões: em Atividade recente, quem pediu pode retomar o pedido, e qualquer responsável pela instalação pode cancelá-lo antes de atualizar o sistema.": { es: "Hay una extensión en preparación. Abre Extensiones: en Actividad reciente, quien la pidió puede retomar la solicitud, y cualquier responsable de la instalación puede cancelarla antes de actualizar el sistema." },
  "O pedido foi cancelado antes de concluir. A versão instalada continua a mesma.": { es: "La solicitud se canceló antes de terminar. La versión instalada sigue siendo la misma." },
  "O pedido foi cancelado antes de concluir. Nada foi instalado.": { es: "La solicitud se canceló antes de terminar. No se instaló nada." },
  "Troca de versão cancelada. A versão instalada continua a mesma.": { es: "Cambio de versión cancelado. La versión instalada sigue siendo la misma." },
  "A atualização já havia sido concluída; o recibo foi atualizado.": { es: "La actualización ya había terminado; el recibo se actualizó." },
  "Atualização ou troca de versão": { es: "Actualización o cambio de versión" },
  "Pedido de outro responsável pela instalação: só quem pediu pode retomar. Você pode cancelar.": { es: "Solicitud de otro responsable de la instalación: solo quien la pidió puede retomarla. Puedes cancelarla." },
  "Versão trocada. As organizações que a usavam continuam com ela ativa.": { es: "Versión cambiada. Las organizaciones que la usaban la mantienen activa." },
  "A troca de versão já havia sido concluída; o recibo foi atualizado.": { es: "El cambio de versión ya había terminado; el recibo se actualizó." },
  "Desfazer a última troca": { es: "Deshacer el último cambio" },
  "Remoção da instalação": { es: "Retirada de la instalación" },
  "Estava ativa até ser removida da instalação em {data}. A versão reinstalada não pode ser ativada; peça ao responsável pela instalação uma versão compatível.": { es: "Estaba activa hasta que se quitó de la instalación el {data}. La versión reinstalada no se puede activar. Pide al responsable de la instalación una versión compatible." },
  "Há uma preparação desta extensão em andamento. Acompanhe ou cancele o pedido em Atividade recente antes de desfazer ou remover.": { es: "Hay una preparación de esta extensión en curso. Da seguimiento a la solicitud o cancélala en Actividad reciente antes de deshacer o quitar." },
  "Verificar troca de versão": { es: "Comprobar cambio de versión" },
  "Cancelar troca de versão": { es: "Cancelar cambio de versión" },
  "1 organização a usava e não volta a vê-la sozinha: o administrador dela precisa ativar de novo.": { es: "1 organización la usaba y no vuelve a verla por sí sola: su administrador tiene que activarla de nuevo." },
  "1 organização com ela ativa": { es: "1 organización con ella activa" },
  "1 organização com ela ativa deixa de ver os guias agora; a configuração dela fica guardada.": { es: "1 organización con ella activa deja de ver las guías ahora; su configuración queda guardada." },
  "1 organização desativada": { es: "1 organización desactivada" },
  "1 organização está com esta extensão ativa.": { es: "1 organización tiene esta extensión activa." },
  "1 organização tem esta extensão ativa e continua com ela ativa, com a configuração de hoje.": { es: "1 organización tiene esta extensión activa y seguirá teniéndola, con la configuración actual." },
  "A extensão mudou em outra sessão. Recarregamos o estado atual; revise antes de repetir.": { es: "La extensión cambió en otra sesión. Recargamos el estado actual; revísalo antes de repetir." },
  "A versão instalada continua a mesma. Confira o catálogo admitido e peça a troca de novo.": { es: "La versión instalada sigue siendo la misma. Comprueba el catálogo admitido y pide el cambio de nuevo." },
  "A versão {atual} sai de todas as organizações agora e a {anterior} volta a valer. Nada é baixado.": { es: "La versión {atual} se retira de todas las organizaciones ahora y vuelve a regir la {anterior}. No se descarga nada." },
  "A versão {versao} não está mais no catálogo admitido.": { es: "La versión {versao} ya no está en el catálogo admitido." },
  "A versão {versao} não é compatível com esta versão do CRM.": { es: "La versión {versao} no es compatible con esta versión del CRM." },
  "A versão {versao} é substituída em todas as organizações.": { es: "La versión {versao} se reemplaza en todas las organizaciones." },
  "A versão é baixada de novo do catálogo.": { es: "La versión se descarga de nuevo del catálogo." },
  "Atualização": { es: "Actualización" },
  "Atualização cancelada. A versão instalada continua a mesma.": { es: "Actualización cancelada. La versión instalada sigue siendo la misma." },
  "Atualizar para {versao}": { es: "Actualizar a {versao}" },
  "Atualizar {titulo} para a versão {versao}?": { es: "¿Actualizar {titulo} a la versión {versao}?" },
  "Cancelar atualização": { es: "Cancelar actualización" },
  "Depois você pode desfazer esta troca, mesmo com o catálogo fora do ar.": { es: "Después puedes deshacer este cambio, aunque el catálogo no esté disponible." },
  "Desfazer a troca": { es: "Deshacer el cambio" },
  "Desfazer a última troca (volta para {versao})": { es: "Deshacer el último cambio (vuelve a {versao})" },
  "Ela foi removida em {data}.": { es: "Se quitó el {data}." },
  "Em todas as organizações": { es: "En todas las organizaciones" },
  "Estava ativa até ser removida da instalação em {data}. Ative de novo para voltar a mostrar os guias.": { es: "Estaba activa hasta que se quitó de la instalación el {data}. Actívala de nuevo para volver a mostrar las guías." },
  "Estava ativa até ser removida da instalação em {data}. Peça a um administrador da organização para ativar de novo.": { es: "Estaba activa hasta que se quitó de la instalación el {data}. Pide a un administrador de la organización que la active de nuevo." },
  "Extensão atualizada. As organizações que a usavam continuam com ela ativa.": { es: "Extensión actualizada. Las organizaciones que la usaban la mantienen activa." },
  "Extensão reinstalada. Cada organização precisa ativá-la de novo.": { es: "Extensión reinstalada. Cada organización tiene que activarla de nuevo." },
  "Extensão removida de todas as organizações.": { es: "Extensión quitada de todas las organizaciones." },
  "Instalada hoje: versão {versao}.": { es: "Instalada hoy: versión {versao}." },
  "Já instalada a partir de outra origem ({origem}, versão {versao}).": { es: "Ya instalada desde otro origen ({origem}, versión {versao})." },
  "Nenhuma organização a usava quando foi removida.": { es: "Ninguna organización la usaba cuando se quitó." },
  "Nenhuma organização está com ela ativa agora.": { es: "Ninguna organización la tiene activa ahora." },
  "Nenhuma organização está com ela ativa agora; a configuração de cada uma fica guardada.": { es: "Ninguna organización la tiene activa ahora; la configuración de cada una queda guardada." },
  "Nenhuma organização está com esta extensão ativa.": { es: "Ninguna organización tiene esta extensión activa." },
  "Nesta organização": { es: "En esta organización" },
  "Não há desfazer: para reinstalar, o catálogo precisa estar no ar e listar a versão, e cada organização ativa de novo.": { es: "No se puede deshacer. Para reinstalar, el catálogo tiene que estar disponible e incluir la versión, y cada organización debe activarla de nuevo." },
  "O card indicado não existe na versão {versao} desta extensão.": { es: "La tarjeta indicada no existe en la versión {versao} de esta extensión." },
  "O responsável pela instalação removeu esta extensão em {data}. Os guias saíram de todas as organizações; a configuração desta organização ficou guardada.": { es: "El responsable de la instalación quitó esta extensión el {data}. Las guías ya no aparecen en ninguna organización, pero la configuración de esta organización quedó guardada." },
  "Reinstalar": { es: "Reinstalar" },
  "Reinstalar versão {versao}": { es: "Reinstalar versión {versao}" },
  "Reinstalar {titulo}?": { es: "¿Reinstalar {titulo}?" },
  "Remover da instalação": { es: "Quitar de la instalación" },
  "Remover de todas": { es: "Quitar de todas" },
  "Remover {titulo} de todas as organizações?": { es: "¿Quitar {titulo} de todas las organizaciones?" },
  "Removida": { es: "Quitada" },
  "Removida da instalação em {data}.": { es: "Quitada de la instalación el {data}." },
  "Remoção": { es: "Retirada" },
  "Troca de versão": { es: "Cambio de versión" },
  "Troca desfeita": { es: "Cambio deshecho" },
  "Troca desfeita: a versão {versao} voltou a valer em todas as organizações.": { es: "Cambio deshecho: la versión {versao} volvió a estar vigente en todas las organizaciones." },
  "Trocar": { es: "Cambiar" },
  "Trocar para {versao}": { es: "Cambiar a {versao}" },
  "Trocar {titulo} para a versão {versao}?": { es: "¿Cambiar {titulo} a la versión {versao}?" },
  "Verificar atualização": { es: "Comprobar actualización" },
  "Voltar {titulo} para a versão {versao}?": { es: "¿Volver a la versión {versao} de {titulo}?" },
  "nenhuma organização com ela ativa": { es: "ninguna organización con ella activa" },
  "nenhuma organização desativada": { es: "ninguna organización desactivada" },
  "{n} organizações a usavam, e nenhuma volta a vê-la sozinha: o administrador de cada uma precisa ativar de novo.": { es: "{n} organizaciones la usaban, y ninguna vuelve a verla por sí sola: el administrador de cada una tiene que activarla de nuevo." },
  "{n} organizações com ela ativa": { es: "{n} organizaciones con ella activa" },
  "{n} organizações com ela ativa deixam de ver os guias agora; a configuração de cada uma fica guardada.": { es: "{n} organizaciones con ella activa dejan de ver las guías ahora; la configuración de cada una queda guardada." },
  "{n} organizações desativadas": { es: "{n} organizaciones desactivadas" },
  "{n} organizações estão com esta extensão ativa.": { es: "{n} organizaciones tienen esta extensión activa." },
  "{n} organizações têm esta extensão ativa e continuam com ela ativa, com a configuração de hoje.": { es: "{n} organizaciones tienen esta extensión activa y seguirán teniéndola, con la configuración actual." },
  "A extensão mudou em outra sessão. Recarregue antes de continuar.": { es: "La extensión cambió en otra sesión. Recarga antes de continuar." },
  "Este card não existe na versão instalada. Recarregamos o guia.": { es: "Esta tarjeta no existe en la versión instalada. Recargamos la guía." },
  "Este pedido foi registrado por uma versão mais nova do sistema.": { es: "Una versión más reciente del sistema registró esta solicitud." },
  "Não há troca para desfazer nesta extensão.": { es: "No hay ningún cambio para deshacer en esta extensión." },
  "O responsável pela instalação removeu esta extensão de todas as organizações.": { es: "El responsable de la instalación quitó esta extensión de todas las organizaciones." },

  // ═══ Tags: a tela do vocabulário de etiquetas, da fatia S4 da #852 ═══
  //
  // A tela nasceu com dez chamadas `t()` e o espanhol ficou para trás: a lista
  // inteira caía no português em plena tela traduzida (o conferidor de chaves
  // só enxerga o que já está escrito, e a tela é nova). Vocabulário herdado do
  // resto do dicionário — `funil` é `embudo`, `Inbox` continua `Inbox`.
  "As etiquetas que os agentes, o Inbox e o funil usam nesta organização. Renomear ou juntar corrige também as regras de agente que escrevem a etiqueta, na mesma operação.": {
    es: "Las etiquetas que usan los agentes, el Inbox y el embudo en esta organización. Renombrar o unir corrige también las reglas de agente que escriben la etiqueta, en la misma operación.",
  },
  "Não foi possível carregar as etiquetas agora. Recarregue a página.": {
    es: "No se pudieron cargar las etiquetas ahora. Recarga la página.",
  },
  "Nenhuma etiqueta nesta organização ainda. Elas aparecem aqui conforme os agentes, o Inbox e o funil usarem.": {
    es: "Aún no hay ninguna etiqueta en esta organización. Aparecen aquí a medida que los agentes, el Inbox y el embudo las usen.",
  },
  "Etiquetas da organização e onde são usadas": {
    es: "Etiquetas de la organización y dónde se usan",
  },
  "Regras de agente": {
    es: "Reglas de agente",
  },
  "em uso, fora do vocabulário": {
    es: "en uso, fuera del vocabulario",
  },
  "Etiqueta de destino": {
    es: "Etiqueta de destino",
  },
  "Escolha a etiqueta que fica": {
    es: "Elige la etiqueta que queda",
  },
  "Novo nome": {
    es: "Nombre nuevo",
  },
  "Aplicando...": {
    es: "Aplicando...",
  },
  // ── Frases do painel de etiquetas que ANTES eram template literal ──────────
  // `traduzir()` casa a string EXATA: uma frase montada em runtime
  // (`t(`Renomear "${tag}" para:`)`) nunca casa chave nenhuma, e o painel inteiro
  // saía em português para quem escolheu espanhol — sem o guarda de i18n ver
  // nada, porque ele só registra `StringLiteral` e `NoSubstitutionTemplateLiteral`.
  // O dado agora entra FORA do `t()`, e o que sobra são estas chaves estáticas.
  "para:": { es: "a:" },
  "em outra etiqueta existente:": { es: "en otra etiqueta existente:" },
  // `"de"` NÃO entra aqui: a chave já existe mais acima no arquivo (linha ~896),
  // e repeti-la é TS1117 — o `as const` do dicionário reprova chave duplicada.
  "contato(s),": { es: "contacto(s)," },
  "lead(s) e": { es: "lead(s) y" },
  "conversa(s).": { es: "conversación(es)." },
  "Atenção:": { es: "Atención:" },
  "regra(s) de agente continuam escrevendo esta etiqueta. Excluir aqui não apaga a regra — o agente vai recriar a etiqueta no próximo atendimento.": {
    es: "regla(s) de agente siguen escribiendo esta etiqueta. Eliminarla aquí no borra la regla: el agente volverá a crear la etiqueta en la próxima atención.",
  },
  "Etiqueta removida de": { es: "Etiqueta eliminada de" },
  "Etiqueta atualizada em": { es: "Etiqueta actualizada en" },
  "registro(s).": { es: "registro(s)." },
  "registro(s) e em": { es: "registro(s) y en" },
  "regra(s) de agente.": { es: "regla(s) de agente." },
  // As frases de recusa do servidor. Três delas não tinham entrada: o argumento
  // de `t()` ali é uma expressão `??`, que o guarda também não resolve.
  "Confira a etiqueta e o novo nome.": { es: "Revisa la etiqueta y el nombre nuevo." },
  // ── A COR DA ETIQUETA (fatia S6 da #1271) ─────────────────────────────────
  //
  // Os oito tons têm NOME além de cor, e é de propósito: quem não distingue
  // matiz — ou está com o brilho no mínimo, ou usa leitor de tela — escolhe e
  // reconhece por "Âmbar"/"Roxo". A fileira de tons é a única escolha de cor do
  // produto, e sem estas entradas ela sairia MUDA para quem escolheu espanhol.
  //
  // `"Cor"` NÃO entra aqui: a chave já existe no arquivo (linha ~3312, do
  // seletor de cor da marca) e repeti-la é TS1117 no `as const` do dicionário.
  "Confira a etiqueta, o novo nome e a cor.": {
    es: "Revisa la etiqueta, el nombre nuevo y el color.",
  },
  "Cor da etiqueta": { es: "Color de la etiqueta" },
  "nas listas e nos filtros:": { es: "en las listas y en los filtros:" },
  "Sem cor": { es: "Sin color" },
  "Prévia:": { es: "Vista previa:" },
  "Cor da etiqueta atualizada.": { es: "Color de la etiqueta actualizado." },
  Amarelo: { es: "Amarillo" },
  Âmbar: { es: "Ámbar" },
  Vermelho: { es: "Rojo" },
  "Verde-água": { es: "Verde agua" },
  Azul: { es: "Azul" },
  Índigo: { es: "Índigo" },
  Roxo: { es: "Morado" },
  Cinza: { es: "Gris" },
  "Só um gerente ou administrador da organização pode mudar as etiquetas.": {
    es: "Solo un gerente o administrador de la organización puede cambiar las etiquetas.",
  },
  "Não foi possível concluir agora. Tente de novo.": {
    es: "No se pudo completar ahora. Inténtalo de nuevo.",
  },
  "Não foi possível falar com o servidor. Recarregue a página e confira antes de tentar de novo.": {
    es: "No se pudo contactar al servidor. Recarga la página y comprueba antes de intentarlo de nuevo.",
  },
  "Mostrando as 500 primeiras etiquetas em ordem alfabética. Se a que você procura não está aqui, arrume primeiro as que aparecem.": {
    es: "Se muestran las primeras 500 etiquetas en orden alfabético. Si no está la que buscas, limpia primero las que aparecen.",
  },
  // A recusa `mfa_required` do painel de etiquetas: a única frase do mapa de erros
  // que ficou sem entrada — medida pela tela em
  // `tests/unit/tags-vocabulario-painel-em-espanhol.test.tsx`.
  "Confirme o segundo fator para mudar as etiquetas.": {
    es: "Confirma el segundo factor para cambiar las etiquetas.",
  },
  "arquivado no acervo": { es: "archivado en el acervo" },
  "Um material marcado aqui foi arquivado no acervo — o agente não lê mais ele.": { es: "Un material marcado aquí fue archivado en el acervo — el agente ya no lo lee." },
  "Materiais marcados aqui foram arquivados no acervo — o agente não lê mais eles.": { es: "Materiales marcados aquí fueron archivados en el acervo — el agente ya no los lee." },
  "Desmarque para voltar a salvar.": { es: "Desmárcalo para volver a guardar." },
  // ── Erros do acervo de conhecimento que CHEGAM À TELA ──────────────────────
  // Eles saem de `lib/ai/rag/extractors/csv.ts` e de `lib/ai/rag/ingest/documento.ts`
  // e são renderizados por `t(err.message)` na rota de upload. O gate de espanhol
  // NÃO alcança `app/api/**` (a varredura ignora a pasta), então quem garante a
  // tradução aqui é esta entrada, não o CI — por isso ela vem com este comentário.
  "a planilha está vazia": { es: "la hoja de cálculo está vacía" },
  "a planilha só tem cabeçalho, sem linha de dado nenhuma": {
    es: "la hoja de cálculo solo tiene encabezado, sin ninguna fila de datos",
  },
  "nenhuma linha tem conteúdo para indexar": {
    es: "ninguna fila tiene contenido para indexar",
  },
  "não leio Excel diretamente — no Excel use \"Salvar como\" → \"CSV UTF-8 (delimitado por vírgulas)\" e envie o CSV.": {
    es: "no leo Excel directamente: en Excel, usa \"Guardar como\" → \"CSV UTF-8 (delimitado por comas)\" y envía el CSV.",
  },

  // ─── Modelos prontos de follow-up (galeria + aviso da Central) ───
  // O NOME do modelo não entra aqui de propósito: ele vira o `name` do
  // ponteiro no banco, e nome de registro sai como foi gravado, em qualquer
  // idioma — mesma regra do nome de funil e do rótulo de etapa.
  "Começar de um modelo": { es: "Empezar desde un modelo" },
  "Modelos prontos": { es: "Modelos listos" },
  "Fluxos com os textos já escritos, para as quatro vezes em que um paciente some no meio do caminho. Instalar não manda mensagem para ninguém: o fluxo nasce como rascunho para você revisar.": {
    es: "Flujos con los textos ya escritos para los cuatro momentos en que un paciente desaparece a mitad de camino. Instalar un flujo no envía mensajes a nadie: se crea como borrador para que lo revises.",
  },
  "Já instalado": { es: "Ya instalado" },
  "mensagens, se ninguém responder": { es: "mensajes, si nadie responde" },
  "acompanha por": { es: "da seguimiento durante" },
  "Dispara quando": { es: "Se dispara cuando" },
  "Etapa do funil que dispara": { es: "Etapa del embudo que dispara" },
  "Não consegui instalar o modelo. Tente de novo.": { es: "No pude instalar el modelo. Inténtalo de nuevo." },
  "Depois de instalar: revise os textos no construtor, clique em Publicar e ligue o fluxo no seu agente (Agentes › Follow-up). Sem um agente publicado armando o fluxo, o gatilho automático não dispara.": {
    es: "Después de instalar: revisa los textos en el constructor, haz clic en Publicar y conecta el flujo a tu agente (Agentes › Follow-up). Sin un agente publicado que arme el flujo, el disparador automático no funciona.",
  },
  // As jornadas e os resumos do catálogo (`lib/followup/modelos/`). Chegam à
  // tela por `t(modelo.resumo)` — chave dinâmica, que o varredor de AST não
  // enxerga —, então quem cobra a existência destas entradas é
  // `lib/followup/modelos/modelos.test.ts`.
  Exame: { es: "Examen" },
  Cirurgia: { es: "Cirugía" },
  "O paciente perguntou sobre consulta, a conversa parou antes de marcar e ninguém voltou nela.": {
    es: "El paciente preguntó por una consulta, la conversación se detuvo antes de agendar la cita y nadie la retomó.",
  },
  "Saiu o pedido de exame e o paciente ainda não marcou. O fluxo cobra por duas semanas e sai de cena.": {
    es: "Ya salió la orden del examen y el paciente todavía no agendó su cita. El flujo insiste durante dos semanas y después se retira.",
  },
  "Quem foi avaliado e não marcou não desistiu: está decidindo. O fluxo acompanha por quase três meses, sem pressionar.": {
    es: "Quien fue evaluado y no agendó cita no desistió: está decidiendo. El flujo da seguimiento durante casi tres meses, sin presionar.",
  },
  "A falta foi confirmada na agenda e o horário ficou vago. O fluxo oferece outra data em vez de deixar o paciente sumir.": {
    es: "Se confirmó en la agenda la inasistencia del paciente y el horario quedó libre. El flujo ofrece otra fecha en lugar de dejar que el paciente desaparezca.",
  },
  "Um dia inteiro sem o paciente responder, com a marcação em aberto.": {
    es: "Un día entero sin que el paciente responda, con la cita pendiente.",
  },
  "O negócio entrar na etapa do funil que você escolher.": {
    es: "Que el negocio entre en la etapa del embudo que elijas.",
  },
  "Alguém confirmar na agenda que o paciente não compareceu.": {
    es: "Que alguien confirme en la agenda que el paciente no asistió.",
  },
  // O aviso da Central quando nenhum agente arma o fluxo.
  "Um follow-up está publicado e não está disparando": {
    es: "Hay un follow-up publicado que no se dispara",
  },
  "Abrir o fluxo": { es: "Abrir el flujo" },
  "Ver o fluxo parado": { es: "Ver el flujo detenido" },
  "Abra o agente que atende esse número, ligue este fluxo em «follow-ups que arma» e publique a versão.": {
    es: "Abre el agente que atiende ese número, conecta este flujo en «follow-ups que arma» y publica la versión.",
  },

  // As chaves do gatilho de dias até a data do funil. Medidas pela tela em
  // `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`: sem elas o gatilho novo
  // sairia inteiro em português para quem escolheu espanhol.
  "Funil do campo": { es: "Embudo del campo" },
  "Campo de data": { es: "Campo de fecha" },
  "Escolha o campo": { es: "Elige el campo" },
  "Faltam N dias": { es: "Faltan N días" },
  "O aviso sai no dia em que faltarem N dias para a data, uma vez por negócio. Para avisar DEPOIS da data, use N negativo — -60 confirma a entrega 60 dias após o casamento.": {
    es: "El aviso se envía cuando faltan N días para la fecha, una sola vez por negocio. Para avisar DESPUÉS de la fecha, usa un N negativo: con -60 se confirma la entrega 60 días después de la boda.",
  },
  "Este funil ainda não tem campo de data. Cadastre um em Funis → Campos personalizados para poder escolhê-lo aqui.": {
    es: "Este embudo aún no tiene campo de fecha. Agrega uno en Embudos → Campos personalizados para poder elegirlo aquí.",
  },
  // Do PR #773 (@xxjjjj): o aria-label do alternador de tema e as frases da
  // agenda que passaram a sair por t(). As três de "este horário…" são as
  // razões dinâmicas de `razaoDoBloco` — o gate de espanhol não as enxerga.
  "Tema: light. Cmd+Shift+L para alternar.": { es: "Tema: claro. Cmd+Shift+L para cambiar." },
  "Tema: dark. Cmd+Shift+L para alternar.": { es: "Tema: oscuro. Cmd+Shift+L para cambiar." },
  "Tema: system. Cmd+Shift+L para alternar.": { es: "Tema: sistema. Cmd+Shift+L para cambiar." },
  "este horário já passou": { es: "este horario ya pasó" },
  "já há um compromisso neste horário": { es: "ya hay una cita en este horario" },
  "fora dos horários que você publicou": { es: "fuera de los horarios que publicaste" },
  "Marcar às {hora} de {data}": { es: "Agendar cita a las {hora}, {data}" },
  "{data} às {hora} — {motivo}": { es: "{data} a las {hora} — {motivo}" },
  "A remarcação não foi aceita — o compromisso voltou para {data}.": { es: "No se aceptó la reprogramación: la cita volvió a {data}." },
  "Não dá para remarcar para esse horário — {motivo}.": { es: "No se puede reprogramar para ese horario: {motivo}." },
  "o compromisso": { es: "la cita" },
  "Entendi": { es: "Entendido" },
  "e-mail do convidado inválido": { es: "correo del invitado no válido" },
  "Webhook registrado pela instalação": { es: "Webhook registrado por la instalación" },
  "O CRM apontou o webhook deste número para cá — não é preciso colar nada no painel da Meta. Os valores abaixo ficam para conferência.": {
    es: "El CRM ya configuró el webhook de este número para que apunte aquí, así que no hace falta pegar nada en el panel de Meta. Los valores de abajo son solo para que los verifiques.",
  },
  "Webhook pendente": { es: "Webhook pendiente" },
  "o registro ainda não foi feito": { es: "el registro todavía no se hizo" },

  // ── Conversar com o caso (migration 0281) ────────────────────────────────
  //
  // As três primeiras são do registro de pontos de IA. NENHUM gate as cobra: os
  // textos chegam à tela por variável (`t(info.rotulo)`), e `chavesUsadas()` só
  // resolve chave literal ou tabela do mesmo arquivo. A prova de que o buraco
  // já deixou passar é `agent_preview`, que até hoje não tem `es`.
  "Conversar sobre o caso com a equipe": { es: "Conversar sobre el caso con el equipo" },
  "Responde às perguntas de quem vai decidir um caso: lê o caso, o que a equipe já decidiu e a conversa com o cliente, e explica em português. Nunca fala com o cliente nem mexe no caso.":
    { es: "Responde las preguntas de quien va a decidir un caso: lee el caso, lo que el equipo ya decidió y la conversación con el cliente, y lo explica en español. Nunca habla con el cliente ni modifica el caso." },
  "Quem vai decidir o caso pergunta e não recebe resposta — decide sem o contexto, ou larga o caso na fila.":
    { es: "Quien va a decidir el caso pregunta y no recibe respuesta: decide sin contexto o deja el caso en la fila." },

  // As de baixo são mensagens de ERRO DE ROTA, e `PASTAS_IGNORADAS` do gate de
  // espanhol inclui `api`: elas ficam FORA da catraca e entram aqui por
  // disciplina. Escrito para que a próxima pessoa saiba que a ausência de um
  // gate aqui não é aprovação.
  "Não deu para abrir a conversa do caso agora.": { es: "No se pudo abrir la conversación del caso ahora." },
  "Conversa do caso indisponível (configuração).": { es: "Conversación del caso no disponible (configuración)." },
  "Muitas perguntas seguidas. Tente em um minuto.": { es: "Demasiadas preguntas seguidas. Inténtalo en un minuto." },
  "Este caso já recebeu muitas perguntas hoje.": { es: "Este caso ya recibió demasiadas preguntas hoy." },
  "Filtro inválido.": { es: "Filtro no válido." },
  "Este contato foi anonimizado a pedido dele. A IA não responde sobre casos de contato anonimizado.":
    { es: "Este contacto fue anonimizado por petición suya. La IA no responde sobre casos de contactos anonimizados." },
  "Nenhum provedor de IA está configurado. Peça a quem administra para configurar em IA › Provedores.":
    { es: "No hay ningún proveedor de IA configurado. Pide a un administrador que lo configure en IA › Proveedores." },
  "A IA parou porque o gasto do mês atingiu o limite definido. Ajuste em Uso de IA › Orçamento.":
    { es: "La IA se detuvo porque el gasto del mes alcanzó el límite definido. Ajústalo en Uso de IA › Presupuesto." },
  "O modelo escolhido para este uso não está disponível. Reveja a escolha em IA › Provedores.":
    { es: "El modelo elegido para este uso no está disponible. Revisa la elección en IA › Proveedores." },
  "Não deu para responder agora. Tente de novo; se continuar, mande este código para quem instalou o sistema.":
    { es: "No se pudo responder ahora. Inténtalo de nuevo; si continúa, envía este código a quien instaló el sistema." },

  // CaseChatPanel.tsx — o painel de "Conversar sobre o caso" (onda 5). Ao
  // contrário das frases da rota logo acima, ESTAS são cobradas por catraca:
  // o guarda varre `app/` e `components/`, então uma frase nova sem espanhol
  // reprova antes de chegar a quem lê em espanhol.
  "Conversar sobre o caso": { es: "Conversar sobre el caso" },
  "Conversa interna. O cliente não vê nada disto, e a IA aqui não envia mensagem nem muda o caso.":
    { es: "Conversación interna. El cliente no ve nada de esto y la IA no envía mensajes ni cambia el caso desde aquí." },
  "Este atendimento é de outra pessoa. Peça para ela, ou para quem administra, se precisar acompanhar.":
    { es: "Esta atención está a cargo de otra persona. Si necesitas darle seguimiento, pídeselo a ella o a un administrador." },
  "A IA que abriu este caso não está mais no ar.":
    { es: "La IA que abrió este caso ya no está activa." },
  "Quem responde aqui é o assistente padrão da organização — ele não tem as instruções daquele agente.":
    { es: "Quien responde aquí es el asistente predeterminado de la organización: no tiene las instrucciones de ese agente." },
  "o agente foi removido": { es: "el agente fue eliminado" },
  "o agente foi arquivado": { es: "el agente fue archivado" },
  "o agente está pausado": { es: "el agente está pausado" },
  "o agente não tem versão publicada": { es: "el agente no tiene versión publicada" },
  "O atendimento que originou este caso já foi encerrado e reaberto. A conversa abaixo pode não ser a que gerou o caso.":
    { es: "Se cerró y se reabrió la atención que originó este caso. Puede que la conversación de abajo no sea la que lo generó." },
  "Não deu para conferir se o atendimento mudou.":
    { es: "No se pudo comprobar si la atención cambió." },
  "Este contato pediu para não receber mensagens. Dá para entender o caso aqui, mas nada pode ser enviado a ele.":
    { es: "Este contacto pidió no recibir mensajes. Aquí puedes consultar el caso, pero no se le puede enviar nada." },
  "Pergunte antes de decidir.": { es: "Pregunta antes de decidir." },
  "Por que a IA não resolveu sozinha?": { es: "¿Por qué la IA no lo resolvió sola?" },
  "O que o cliente já tentou?": { es: "¿Qué ha intentado ya el cliente?" },
  "O que muda se eu concluir agora?": { es: "¿Qué cambia si lo concluyo ahora?" },
  "A IA está lendo o caso…": { es: "La IA está leyendo el caso…" },
  "Abrir IA › Provedores": { es: "Abrir IA › Proveedores" },
  "Sua pergunta para a IA": { es: "Tu pregunta para la IA" },
  "Pergunte à IA sobre este caso…": { es: "Pregúntale a la IA sobre este caso…" },
  "Ctrl + Enter envia. Enter quebra linha.": { es: "Ctrl + Enter envía. Enter inserta un salto de línea." },
  "Perguntar": { es: "Preguntar" },
  "Perguntando…": { es: "Preguntando…" },
  "Pergunta da equipe": { es: "Pregunta del equipo" },
  "Assistente da organização": { es: "Asistente de la organización" },
  "Mensagem apagada a pedido do contato.": { es: "Mensaje borrado a petición del contacto." },
  "Você fez muitas perguntas seguidas. Tente de novo em um minuto.":
    { es: "Hiciste demasiadas preguntas seguidas. Inténtalo de nuevo en un minuto." },
  "As perguntas dos colegas aparecem aqui em alguns segundos.":
    { es: "Las preguntas de tus colegas aparecen aquí en unos segundos." },
  // lib/escalacao/passagem.ts (migration 0291) — por que a conversa saiu do
  // automático, e por que o cliente não foi avisado. A frase existe para a
  // TELA: `requested_human` é vocabulário de constraint, não texto para uma
  // pessoa ler. Acrescentadas no fim do bloco, nunca reordenando o arquivo (ele
  // é disputado por quatro ondas e cinco PRs abertos).
  "O cliente pediu para falar com uma pessoa":
    { es: "El cliente pidió hablar con una persona" },
  "O cliente parece ter pedido para não receber mais mensagens":
    { es: "El cliente parece haber pedido no recibir más mensajes" },
  "O limite de gasto com IA foi atingido — o cliente não pediu uma pessoa":
    { es: "Se alcanzó el límite de gasto en IA — el cliente no pidió hablar con una persona" },
  "O cliente demonstrou irritação na conversa":
    { es: "El cliente mostró molestia en la conversación" },
  "O assistente não teve confiança suficiente para responder":
    { es: "El asistente no estaba lo bastante seguro para responder" },
  "O negócio chegou a uma etapa que pede uma pessoa":
    { es: "El negocio llegó a una etapa que requiere una persona" },
  "A conversa tocou em assunto jurídico":
    { es: "La conversación tocó un tema legal" },
  "A conversa tocou em reembolso":
    { es: "La conversación tocó el tema de reembolsos" },
  "Uma pessoa da equipe escalou um atendimento":
    { es: "Alguien del equipo escaló una atención" },
  "A mensagem ficou na fila porque o canal está fora do ar":
    { es: "El mensaje quedó en la cola porque el canal está fuera de servicio" },
  "O canal recusou a mensagem de aviso":
    { es: "El canal rechazó el mensaje de aviso" },
  "O contato não tem telefone cadastrado":
    { es: "El contacto no tiene teléfono registrado" },
  "O número ainda está em aquecimento e não envia mensagens":
    { es: "El número aún está en calentamiento y no envía mensajes" },
  "O canal desta conversa foi arquivado":
    { es: "El canal de esta conversación fue archivado" },
  "Estamos fora do horário em que este canal envia mensagens":
    { es: "Estamos fuera del horario en que este canal envía mensajes" },

  // ── O aviso de caso no WhatsApp do suporte (migration 0292) ──────────────
  // O texto sai SEM DOM, pelo dreno do event_log, e o idioma é o da
  // ORGANIZAÇÃO — ninguém está logado na hora. As chaves aqui são as frases
  // FIXAS do aviso; o que o modelo escreveu (título, resumo, bloqueio) nunca é
  // traduzido, porque traduzir o relato de um cliente é reescrevê-lo.
  "novo caso esperando você": { es: "nuevo caso esperando por ti" },
  Assunto: { es: "Asunto" },
  Abrir: { es: "Abrir" },
  "A IA prometeu algo e travou": { es: "La IA prometió algo y se trabó" },
  "(resumo escrito pela IA a partir da conversa)":
    { es: "(resumen escrito por la IA a partir de la conversación)" },
  "Responder aqui não chega ao cliente — abra o link para responder.":
    { es: "Las respuestas aquí no le llegan al cliente. Abre el enlace para responder." },
  "Dúvida": { es: "Duda" },
  Pagamento: { es: "Pago" },
  "Acesso ou cadastro": { es: "Acceso o registro" },

  // A linha do tempo do caso e a Central — os rótulos dos vocabulários novos.
  "Avisamos o suporte no WhatsApp": { es: "Avisamos al soporte por WhatsApp" },
  "A IA registrou o que aconteceu": { es: "La IA registró lo que pasó" },
  "Um aviso de atendimento não chegou ao WhatsApp da equipe":
    { es: "Un aviso de atención no llegó al WhatsApp del equipo" },
  "O aviso deste atendimento não saiu no WhatsApp. Abra o atendimento — ele continua esperando — e confira a conexão de avisos em Configurações.":
    {
      es: "El aviso de esta atención no salió por WhatsApp. La atención sigue esperando: ábrela y revisa la conexión de avisos en Configuración.",
    },

  // Por que o aviso não saiu — vocabulário fechado, uma frase de gente por
  // código (lib/escalacao/vocabulario-do-aviso.ts). O código cru nunca aparece.
  "A conexão de WhatsApp escolhida para os avisos está fora do ar.":
    { es: "La conexión de WhatsApp elegida para los avisos está fuera de servicio." },
  "A conexão de WhatsApp escolhida para os avisos foi removida.":
    { es: "La conexión de WhatsApp elegida para los avisos fue eliminada." },
  "A conexão escolhida só envia mensagens aprovadas — ela não serve para o aviso de caso.":
    { es: "La conexión elegida solo envía mensajes aprobados, así que no sirve para los avisos de casos." },
  "O serviço de WhatsApp desta instalação não está configurado.":
    { es: "El servicio de WhatsApp de esta instalación no está configurado." },
  "O número de aviso não foi aceito pelo WhatsApp.":
    { es: "WhatsApp no aceptó el número de aviso." },
  "O número que envia os avisos atingiu o limite diário do período de aquecimento.":
    { es: "El número que envía los avisos alcanzó el límite diario del período de calentamiento." },
  "Esta instalação ainda não tem um endereço público — o aviso não teria link para abrir.":
    { es: "Esta instalación aún no tiene una dirección pública, así que el aviso no tendría un enlace para abrir." },
  "O cliente deste atendimento pediu para ser esquecido.":
    { es: "El cliente de esta atención pidió ser olvidado." },
  "O aviso ficou mais de 24 horas sem conseguir sair e foi encerrado.":
    { es: "El aviso estuvo más de 24 horas sin poder salir y se cerró." },
  "O WhatsApp recusou o envio do aviso.": { es: "WhatsApp rechazó el envío del aviso." },
  "O aviso não saiu e a causa não pôde ser identificada.":
    { es: "El aviso no salió y no se pudo identificar la causa." },

  // A porta de descoberta no fim do wizard (lib/onboarding/o-que-mais-existe.ts).
  // O guarda de espanhol NÃO resolve `t(p.comoChamar)` — tabela em outro
  // módulo —, então estas entram por DISCIPLINA, como as das peças vizinhas.
  "Ser avisado no seu WhatsApp":
    { es: "Recibir avisos en tu WhatsApp" },
  "Você não fica com o sistema aberto o dia todo — mas fica com o WhatsApp.":
    { es: "No tienes el sistema abierto todo el día, pero sí tienes WhatsApp." },
  "Você escolhe um número da equipe para receber os avisos":
    { es: "Eliges un número del equipo para recibir los avisos" },
  "Quando ele trava e abre um pedido de ajuda, chega uma mensagem nesse número, na hora":
    { es: "Cuando se traba y abre una solicitud de ayuda, llega un mensaje a ese número al instante" },
  "A mensagem traz o assunto e um link que abre o atendimento — e nunca o telefone do cliente":
    { es: "El mensaje trae el asunto y un enlace que abre la atención, pero nunca el teléfono del cliente" },
  "Responder àquele número não chega ao cliente: ele é só da equipe":
    { es: "Las respuestas a ese número no llegan al cliente: es solo del equipo" },
  // A DESCRIÇÃO da entrada no catálogo de navegação. Ela é cobrada por um
  // guarda PRÓPRIO (`tests/unit/nav-hub.test.tsx`), que varre rótulo e
  // descrição de todo destino do grupo IA — e não pelo guarda de espanhol das
  // telas, que não entra em `lib/navigation/`. Foi ele que me pegou.
  "Receber no WhatsApp quando o assistente abrir um caso.":
    { es: "Recibir por WhatsApp cuando el asistente abra un caso." },
  // ── A TELA DO AVISO DE CASO NO WHATSAPP (onda 8) ──────────────────────
  // Acrescentado NO FIM do bloco, nunca reordenando o arquivo: ele é
  // disputado por várias frentes ao mesmo tempo, e reordenar produz um diff
  // que ninguém consegue revisar.
  "A conexão escolhida está fora do ar":
    { es: "La conexión elegida está fuera de servicio" },
  "A conexão que enviava os avisos foi removida":
    { es: "La conexión que enviaba los avisos fue eliminada" },
  "Abrir o atendimento":
    { es: "Abrir la atención" },
  "Ainda não há casos suficientes nos últimos 30 dias para comparar. A comparação aparece sozinha quando houver.":
    { es: "Todavía no hay suficientes casos en los últimos 30 días para comparar. La comparación aparecerá automáticamente cuando los haya." },
  "As respostas para este número são ignoradas de propósito":
    { es: "Las respuestas a este número se ignoran a propósito" },
  "Aviso de teste enviado. Confira o WhatsApp desse número.":
    { es: "Aviso de prueba enviado. Revisa el WhatsApp de ese número." },
  "Aviso no WhatsApp":
    { es: "Aviso por WhatsApp" },
  "Aviso salvo.":
    { es: "Aviso guardado." },
  "Casos em que o aviso chegou":
    { es: "Casos en los que el aviso llegó" },
  "Casos sem aviso":
    { es: "Casos sin aviso" },
  "Comece pelo código do país. Um celular do Brasil fica assim: +55, DDD e o número.":
    { es: "Empieza por el código del país. Un celular de Brasil se escribe así: +55, código de área y número." },
  "Como a conexão não existe mais, o aviso foi desligado sozinho. Escolha outra conexão abaixo e ligue de novo.":
    { es: "Como la conexión ya no existe, el aviso se desactivó solo. Elige otra conexión abajo y actívalo de nuevo." },
  "Como chamar esse número (opcional)":
    { es: "Cómo llamar a ese número (opcional)" },
  "Conecte um WhatsApp lendo o QR code na tela de Conexões. É por ele que os avisos vão sair.":
    { es: "Conecta un WhatsApp escaneando el código QR en la pantalla de Conexiones. Por ahí saldrán los avisos." },
  "Conexão que envia os avisos":
    { es: "Conexión que envía los avisos" },
  "Enquanto ninguém puder abrir um caso, nenhum aviso vai sair. Ligue a opção de abrir casos na configuração do assistente.":
    { es: "Mientras nadie pueda abrir casos, no se enviará ningún aviso. Activa la opción de abrir casos en la configuración del asistente." },
  "Enviado para":
    { es: "Enviado a" },
  "Enviar aviso de teste":
    { es: "Enviar aviso de prueba" },
  "Escolha um número conectado":
    { es: "Elige un número conectado" },
  "Escolha um número da equipe para receber uma mensagem toda vez que o assistente travar e precisar de uma pessoa.":
    { es: "Elige un número del equipo para recibir un mensaje cada vez que el asistente se trabe y necesite a una persona." },
  "Escolher outro número":
    { es: "Elegir otro número" },
  "Esse número ainda não está completo.":
    { es: "Ese número todavía no está completo." },
  "Esse número passa a ser só da equipe: o que ele mandar deixa de virar atendimento.":
    { es: "Ese número pasa a ser solo del equipo: lo que envíe deja de convertirse en atención." },
  "Este número ainda está em aquecimento":
    { es: "Este número todavía está en calentamiento" },
  "Este sistema ainda não tem um endereço na internet":
    { es: "Este sistema todavía no tiene una dirección en internet" },
  "Este é o mesmo número que fala com seus clientes":
    { es: "Este es el mismo número que habla con tus clientes" },
  "Nenhum assistente está autorizado a abrir casos":
    { es: "Ningún asistente está autorizado a abrir casos" },
  "Nenhum aviso saiu ainda. Quando o assistente abrir um caso, a tentativa aparece aqui — inclusive se ela falhar.":
    { es: "Aún no se ha enviado ningún aviso. Cuando el asistente abra un caso, el intento aparecerá aquí, incluso si falla." },
  "Não foi possível abrir esta tela agora. Atualize a página; se continuar, avise quem instalou o sistema.":
    { es: "No se pudo abrir esta pantalla ahora. Actualiza la página; si continúa, avisa a quien instaló el sistema." },
  "Não foi possível mandar o teste agora.":
    { es: "No se pudo enviar la prueba ahora." },
  "Não foi possível salvar o aviso. Tente de novo.":
    { es: "No se pudo guardar el aviso. Inténtalo de nuevo." },
  "Número que recebe os avisos":
    { es: "Número que recibe los avisos" },
  "O atendimento desta conta é conduzido por outro sistema":
    { es: "La atención de esta cuenta se gestiona desde otro sistema" },
  "O aviso de teste não saiu.":
    { es: "El aviso de prueba no salió." },
  "O aviso está adiantando o atendimento?":
    { es: "¿El aviso acelera la atención?" },
  "O aviso sai na hora, inclusive fora do horário comercial — sua equipe não é cliente.":
    { es: "El aviso sale al instante, incluso fuera del horario comercial: tu equipo no es cliente." },
  "O aviso sai quando o assistente abre o caso. Quando o cliente responde e o caso volta a esperar você, o aviso não se repete — acompanhe pela Central de alertas.":
    { es: "El aviso sale cuando el asistente abre el caso. Si el cliente responde y el caso vuelve a esperarte, el aviso no se repite. Dale seguimiento desde la Central de alertas." },
  "O endereço público do sistema ainda não foi configurado, então o link do aviso não abriria nada. Peça a quem instalou para definir o endereço do seu domínio.":
    { es: "Aún no se configuró la dirección pública del sistema, así que el enlace del aviso no abriría nada. Pide a quien lo instaló que defina la dirección de tu dominio." },
  "O que saiu, o que não saiu e por quê. Esta lista é o registro do sistema — ela não some quando alguém resolve um alerta.":
    { es: "Lo que salió, lo que no salió y por qué. Esta lista es el registro del sistema — no desaparece cuando alguien resuelve una alerta." },
  "O teste manda uma mensagem de verdade e conta no limite diário desse número. Salve antes de testar.":
    { es: "La prueba envía un mensaje real y cuenta para el límite diario de ese número. Guarda antes de probar." },
  "Os avisos ficam esperando até 24 horas e, se a conexão não voltar, viram alerta na Central.":
    { es: "Los avisos esperan hasta 24 horas y, si la conexión no se restablece, se convierten en una alerta en la Central." },
  "Os avisos vão contar no mesmo limite diário desse número. Funciona — mas um número só para avisos é mais seguro.":
    { es: "Los avisos contarán para el mismo límite diario de ese número. Funciona, pero un número exclusivo para avisos es más seguro." },
  "Plantão da Ana":
    { es: "Guardia de Ana" },
  "Quando o atendimento automático travar, chega aqui o tipo do assunto, o primeiro nome do cliente, o que ele precisa e um link para abrir o atendimento.":
    { es: "Cuando la atención automática se trabe, aquí llegan el tipo de asunto, el primer nombre del cliente, lo que necesita y un enlace para abrir la conversación." },
  "Quem conduz as conversas desta conta é um sistema de fora, e ele não abre casos aqui.":
    { es: "Un sistema externo lleva las conversaciones de esta cuenta y no abre casos aquí." },
  "Quem responder a esse número não vira atendimento, não vira contato e não chega ao CRM. É assim que o recurso funciona.":
    { es: "Quien responda a ese número no genera una conversación ni un contacto, y tampoco llega al CRM. Así funciona esta opción." },
  "Receber avisos no WhatsApp":
    { es: "Recibir avisos por WhatsApp" },
  "Se esta mensagem chegou, os avisos de caso estão configurados e funcionando.":
    { es: "Si te llegó este mensaje, los avisos de caso están configurados y funcionan." },
  "Seus assistentes só sugerem respostas":
    { es: "Tus asistentes solo sugieren respuestas" },
  "Seus números atuais não servem para avisar a equipe":
    { es: "Tus números actuales no sirven para avisar al equipo" },
  "Seus números atuais só enviam mensagem para quem falou com você nas últimas 24 horas — isso não serve para um aviso interno. Conecte um número pelo QR code para usar este recurso.":
    { es: "Tus números actuales solo envían mensajes a quien habló contigo en las últimas 24 horas, y eso no sirve para un aviso interno. Conecta un número por código QR para usar esta función." },
  "Só aparecem aqui os números que conseguem mandar uma mensagem a qualquer hora.":
    { es: "Aquí solo aparecen los números que pueden enviar un mensaje a cualquier hora." },
  "Tempo típico entre o assistente travar e alguém da equipe agir, nos últimos 30 dias. Os dois grupos contam a partir do mesmo momento.":
    { es: "Tiempo típico entre que el asistente se traba y alguien del equipo actúa, en los últimos 30 días. Los dos grupos cuentan desde el mismo momento." },
  "Um assistente em modo assistido não abre caso sozinho: ele escreve a sugestão e espera alguém. Nenhum aviso vai sair por ele.":
    { es: "Un asistente en modo asistido no abre casos por su cuenta: escribe la sugerencia y espera a alguien. Ningún aviso saldrá por él." },
  "Um número novo começa com poucas mensagens por dia e vai crescendo por cerca de um mês. É o que protege o número de ser bloqueado pelo WhatsApp.":
    { es: "Un número nuevo empieza con pocos mensajes al día y aumenta gradualmente durante cerca de un mes. Esto evita que WhatsApp bloquee el número." },
  "Usar mesmo assim":
    { es: "Usar de todos modos" },
  "Você ainda não conectou nenhum número":
    { es: "Aún no has conectado ningún número" },
  "a última em":
    { es: "la última el" },
  "casos já tiveram uma ação da equipe":
    { es: "casos ya tuvieron una acción del equipo" },
  "em aquecimento até":
    { es: "en calentamiento hasta" },
  "mensagens já foram ignoradas":
    { es: "mensajes ya fueron ignorados" },
  "mensagens neste número":
    { es: "mensajes en este número" },
  "teste de aviso":
    { es: "prueba de aviso" },
  "Últimos avisos enviados":
    { es: "Últimos avisos enviados" },
  "Ir para Conexões":
    { es: "Ir a Conexiones" },
  "Ir para os assistentes":
    { es: "Ir a los asistentes" },
  "Tentando enviar":
    { es: "Intentando enviar" },
  "Este número mandou uma mensagem agora há pouco. O WhatsApp exige um intervalo entre elas — tente de novo em alguns segundos.":
    { es: "Este número envió un mensaje hace un momento. WhatsApp exige un intervalo entre mensajes. Intenta de nuevo en unos segundos." },
  // O CORPO do aviso de passagem na Central. Ele é traduzido no SERVIDOR, no
  // instante do insert, e não por `t()` na tela — porque na tela ele é DADO (o
  // que a Central mostra é o corpo como ele veio, e há um teste que guarda
  // isso). Acrescentadas no fim do bloco, nunca reordenando o arquivo.
  "Abra a conversa para ver o contexto.":
    { es: "Abre la conversación para ver el contexto." },
  "O cliente JÁ FOI avisado de que uma pessoa vai assumir.":
    { es: "El cliente YA fue avisado de que una persona se hará cargo." },
  "O aviso ficou na fila (o canal está fora do ar) — o cliente ainda não recebeu.":
    { es: "El aviso quedó en la cola porque el canal está caído: el cliente aún no lo recibió." },
  "O cliente NÃO foi avisado": { es: "El cliente NO fue avisado" },
  "ele está esperando sem saber.": { es: "está esperando sin saberlo." },
  "motivo desconhecido": { es: "motivo desconocido" },
  // O CARTÃO da passagem, dentro da conversa (`components/inbox/PassagemCard.tsx`).
  // Os dois títulos são resolvidos por `montarCartoesDaPassagem` e chegam à tela
  // como variável — o gate de i18n só enxerga literal, então quem os cobra é
  // `tests/unit/cartao-da-passagem.test.ts`. Acrescentadas no FIM do bloco.
  "Por que a IA passou para você": { es: "Por qué la IA te pasó la conversación" },
  "O cliente pode ter pedido para parar de receber mensagens":
    { es: "El cliente puede haber pedido dejar de recibir mensajes" },
  "Este contato foi anonimizado a pedido dele. O contexto desta passagem foi apagado.":
    { es: "Este contacto fue anonimizado a petición suya. Se borró el contexto de este traspaso." },
  "O cliente quer": { es: "El cliente quiere" },
  "A IA já tentou": { es: "La IA ya intentó" },
  "Últimas palavras do cliente": { es: "Últimas palabras del cliente" },
  "Resumo da IA (confira)": { es: "Resumen de la IA (revísalo)" },
  "Escrito por quem passou": { es: "Escrito por quien hizo el traspaso" },
  "Sem resumo acumulado ainda — a conversa é recente. Role para cima para ver tudo o que foi dito.":
    { es: "Aún no hay un resumen acumulado porque la conversación es reciente. Desplázate hacia arriba para ver todo lo que se dijo." },
  "O cliente já foi avisado de que uma pessoa vai assumir.":
    { es: "El cliente ya fue avisado de que una persona se hará cargo." },
  "O cliente NÃO foi avisado — ele está esperando sem saber.":
    { es: "El cliente NO fue avisado — está esperando sin saberlo." },
  "Alguém da equipe já assumiu este atendimento.":
    { es: "Alguien del equipo ya asumió esta atención." },
  "Assumida por": { es: "Asumida por" },
  "Atendimento devolvido ao automático — ninguém assumiu.":
    { es: "Atención devuelta al automático — nadie la asumió." },
  "Assumindo...": { es: "Asumiendo..." },
  "Assumir e responder": { es: "Asumir y responder" },
  "Abrir o contato para confirmar o bloqueio":
    { es: "Abrir el contacto para confirmar el bloqueo" },
  "Confirme na ficha do contato se ele pediu para não receber mais mensagens.":
    { es: "Confirma en la ficha del contacto si pidió no recibir más mensajes." },
  "Outra pessoa está atendendo. Se precisar assumir, use Transferir no topo da conversa.":
    { es: "Otra persona está atendiendo. Si necesitas asumir, usa Transferir en la parte superior de la conversación." },
  "está atendendo. Se precisar assumir, use Transferir no topo da conversa.":
    { es: "está atendiendo. Si necesitas asumir, usa Transferir en la parte superior de la conversación." },
  // A cobrança da passagem esquecida (`app/api/v1/cron/case-stale-watcher`).
  // Traduzida no SERVIDOR, no insert, pela mesma razão do corpo do aviso acima.
  "Alguém pediu atendimento e ninguém assumiu":
    { es: "Alguien pidió atención y nadie la asumió" },
  "A IA passou esta conversa para uma pessoa e ninguém assumiu desde então. Abra a conversa: o contexto do que já foi dito está lá.":
    { es: "La IA pasó esta conversación a una persona y nadie la ha asumido desde entonces. Abre la conversación: ahí está el contexto de lo que ya se dijo." },
  "Este é o último aviso automático sobre esta conversa.":
    { es: "Este es el último aviso automático sobre esta conversación." },
  "Clientes que repetiram depois da passagem":
    { es: "Clientes que repitieron después del traspaso" },
  "passagens em que o cliente voltou a falar: ele teve de repetir o que já tinha dito.":
    { es: "traspasos en que el cliente volvió a hablar: tuvo que repetir lo que ya había dicho." },
  hora: { es: "hora" },
  "Abra a conversa: o cartão no fim do fio diz por que a IA passou, o que ela já tentou e se o cliente foi avisado.":
    { es: "Abre la conversación: la tarjeta al final del hilo dice por qué la IA la pasó, qué ya intentó y si el cliente fue avisado." },
  "Limiar de 0,7 e janela de 24h. Quem atende em `visibility_mode='own'` vê só as conversas dele.":
    { es: "Umbral de 0,7 y ventana de 24h. Quien atiende en `visibility_mode='own'` ve solo sus conversaciones." },
  // ─── issue #924 — a origem de quem chega pelo site ───
  // app/app/settings/conversoes/page.tsx (a explicação do link) e
  // app/app/contacts/_client.tsx (o filtro de origem que passou a ter "Site").
  "Site (landing page)": { es: "Sitio (landing page)" },
  "Quem chegou pelo site": { es: "Quién llegó por el sitio" },
  "Quando a pessoa vê a campanha numa página sua e toca num botão que abre o WhatsApp, o link desse botão pode levar a origem junto. O código abaixo vai no texto da mensagem, e a conversa entra no CRM já com a origem do site.": {
    es: "Cuando una persona ve la campaña en una página tuya y toca un botón que abre WhatsApp, el enlace del botón puede incluir el origen. El código de abajo va en el texto del mensaje, y la conversación entra al CRM ya con el origen del sitio.",
  },
  "Como montar o link do botão": { es: "Cómo armar el enlace del botón" },
  "Monte o texto que a pessoa vai enviar — uma saudação basta — e termine com o código.": {
    es: "Escribe el texto que enviará la persona (basta con un saludo) y termínalo con el código.",
  },
  "Troque o número pelo WhatsApp da empresa e o texto pelo seu, mantendo o código no fim:": {
    es: "Cambia el número por el WhatsApp de la empresa y el texto por el tuyo, pero deja el código al final:",
  },
  "Olá! Vim pelo site.": { es: "¡Hola! Vengo del sitio." },
  // ── O endereço de captura de UTM (o ref curto da landing page) ───────────
  // As macros da plataforma (`{{campaign.name}}` e irmãs) NÃO entram aqui: são
  // vocabulário da plataforma de anúncio, e traduzi-las quebraria a URL.
  "Endereço de captura (sem script na página)": {
    es: "Dirección de captura (sin script en la página)",
  },
  "Em vez do link do WhatsApp, o botão da sua página aponta para este endereço. Ele guarda a origem, cria um código curto e abre o WhatsApp com esse código no texto — o visitante não vê nada além do botão de sempre.": {
    es: "En lugar del enlace de WhatsApp, el botón de tu página apunta a esta dirección. Ella guarda el origen, crea un código corto y abre WhatsApp con ese código en el texto — el visitante no ve nada más que el botón de siempre.",
  },
  "Para qual WhatsApp mandar": { es: "A qué WhatsApp enviar" },
  "Formato internacional, com o código do país. Os números já conectados aparecem como sugestão.": {
    es: "Formato internacional, con el código del país. Los números ya conectados aparecen como sugerencia.",
  },
  "Texto que a pessoa vai enviar": { es: "Texto que la persona va a enviar" },
  "Precisa conter o campo do código — é onde o código curto entra antes de abrir o WhatsApp.": {
    es: "Tiene que contener el campo del código — es donde entra el código corto antes de abrir WhatsApp.",
  },
  "Endereço de captura ligado": { es: "Dirección de captura activada" },
  "Desligar faz o endereço parar de responder. Quem já usa o link do WhatsApp direto não é afetado.": {
    es: "Apagarla hace que la dirección deje de responder. Quien ya usa el enlace de WhatsApp directo no se ve afectado.",
  },
  "Cole este endereço no botão da sua página": {
    es: "Pega esta dirección en el botón de tu página",
  },
  "Os campos entre chaves são preenchidos pela própria plataforma de anúncio quando você os põe nos parâmetros de URL do anúncio. Se a sua página serve mais de uma campanha, o botão precisa repassar os parâmetros que a página recebeu — sem isso a conversa entra sem origem.": {
    es: "Los campos entre llaves los completa la propia plataforma de anuncios cuando los pones en los parámetros de URL del anuncio. Si tu página sirve a más de una campaña, el botón tiene que reenviar los parámetros que la página recibió — sin eso la conversación entra sin origen.",
  },
  "Copiar endereço": { es: "Copiar dirección" },
  "Salvar endereço de captura": { es: "Guardar dirección de captura" },
  "Informe o número e mantenha o campo do código no texto para poder salvar.": {
    es: "Informa el número y mantén el campo del código en el texto para poder guardar.",
  },
  "Endereço de captura salvo.": { es: "Dirección de captura guardada." },
  "Só um administrador da organização pode mudar este endereço.": {
    es: "Solo un administrador de la organización puede cambiar esta dirección.",
  },
  "Esta organização ainda não tem um apelido de URL, e o endereço de captura precisa de um. Fale com quem administra o servidor.": {
    es: "Esta organización todavía no tiene un alias de URL, y la dirección de captura necesita uno. Habla con quien administra el servidor.",
  },
  // Os NOMES das chaves saíram da frase: a tela os lê de `CHAVES_DE_UTM` e os
  // imprime fora do `t()`. Uma chave nova não mexe mais em tradução nenhuma.
  "Este exemplo foi gerado por esta tela. Os campos que o código aceita são:": {
    es: "Esta pantalla generó este ejemplo. Los campos que acepta el código son:",
  },
  "O código vale só na primeira mensagem do contato: quem recebe um link encaminhado não ganha a origem de quem encaminhou.": {
    es: "El código solo se aplica al primer mensaje del contacto: quien recibe un enlace reenviado no hereda el origen de quien lo reenvió.",
  },
  "Ele nunca sobrescreve uma origem já gravada, inclusive a de anúncio: quem chegou do Meta ou do Google antes mantém o anúncio.": {
    es: "El código nunca sobrescribe un origen ya guardado, ni siquiera el de un anuncio: quien antes llegó desde Meta o Google conserva el anuncio.",
  },
  "Só campos de campanha viajam no código, e nenhum dado pessoal: nome, telefone, e-mail e documento ficam de fora.": {
    es: "En el código solo van campos de campaña, nunca datos personales: nombre, teléfono, correo y documento quedan fuera.",
  },
  "O código inteiro tem um teto de": { es: "El código entero tiene un tope de" },
  "caracteres.": { es: "caracteres." },
  'A origem aparece na ficha do contato e no filtro "Site (landing page)" da lista de contatos.': {
    es: 'El origen aparece en la ficha del contacto y en el filtro "Sitio (landing page)" de la lista de contactos.',
  },

  // ─── Funil: dados do cliente (telefone, e-mail e links) no card e no dossiê ───
  "Este negócio não tem contato vinculado.": { es: "Este negocio no tiene contacto vinculado." },
  "Não consegui carregar o contato.": { es: "No pude cargar el contacto." },
  Dados: { es: "Datos" },
  Links: { es: "Enlaces" },
  "Abrir no WhatsApp": { es: "Abrir en WhatsApp" },
  "Ver ficha completa do contato": { es: "Ver la ficha completa del contacto" },
  "Confira os links marcados: só endereços http(s) valem.": {
    es: "Revisa los enlaces marcados: solo son válidas las direcciones http(s).",
  },
  "Links salvos.": { es: "Enlaces guardados." },
  "Endereço inválido.": { es: "Dirección inválida." },
  "Salvar links": { es: "Guardar enlaces" },
  // Rótulos dos tipos de link (`lib/leads/links-de-contato.ts`) — lidos por
  // lookup dinâmico, que o teste de cobertura não enxerga. As marcas
  // (Instagram, Facebook…) não mudam de idioma e ficam de fora.
  Site: { es: "Sitio web" },
  "Google Meu Negócio": { es: "Google Mi Negocio" },
  // ─── Agenda dos colegas (components/agenda/AgendaDosColegas.tsx) ───────────
  // A opção por organização da migration 0343 (issue #978). As frases de recusa
  // são as que `ClientePelaAgenda` já usa ("Sua sessão expirou…", "Nenhuma
  // empresa ativa.", "Confirme a verificação em duas etapas.", "Não consegui
  // salvar essa mudança agora."), reaproveitadas de propósito: mesma situação,
  // mesma frase. Só a do papel é nova, porque aqui o piso é gerente.
  "Agenda dos colegas": { es: "Agenda de los colegas" },
  "Atendentes podem mexer na agenda dos colegas": {
    es: "Los asesores pueden modificar la agenda de sus colegas",
  },
  "Com isto ligado, qualquer atendente cancela e remarca o compromisso de qualquer colega — é o comportamento de sempre. Desligado, cada atendente mexe só no compromisso de que é o responsável; gerentes e administradores seguem mexendo em tudo.": {
    es: "Con esta opción activada, cualquier asesor puede cancelar y reprogramar las citas de cualquier colega, como siempre ha sido. Si la desactivas, cada asesor solo puede modificar las citas de las que es responsable. Los gerentes y administradores pueden seguir modificándolo todo.",
  },
  "Ligado: qualquer atendente mexe na agenda de qualquer colega.": {
    es: "Activado: cualquier asesor puede modificar la agenda de cualquier colega.",
  },
  "Desligado: cada atendente mexe só na própria agenda. Gerentes e administradores continuam mexendo em tudo.": {
    es: "Desactivado: cada asesor solo puede modificar su propia agenda. Los gerentes y administradores pueden seguir modificándolo todo.",
  },
  "Isto não muda o que cada pessoa vê na agenda, só quem pode alterar o compromisso de quem.": {
    es: "Esto no cambia lo que cada persona ve en la agenda, solo define quién puede modificar las citas de quién.",
  },
  "Só um gerente ou administrador pode mudar essa regra.": {
    es: "Solo un gerente o administrador puede cambiar esta regla.",
  },

  // ─────────────────────────────────────────────────────────────────────────
  // /app/integracao-dados — o banco de dados externo do agente.
  // Recorte do PR #1130, de @vgamkt; o espanhol é o que ele escreveu.
  // ─────────────────────────────────────────────────────────────────────────
  "Nenhum banco externo conectado ainda": { es: "Aún no hay bases de datos externas conectadas" },
  "Quando o seu outro sistema escreve num PostgreSQL, conecte-o aqui e o agente passa a responder com esses dados — pedido, assinatura, matrícula, saldo.": {
    es: "Si tu otro sistema guarda sus datos en PostgreSQL, conéctalo aquí y el agente podrá responder con esa información: pedidos, suscripciones, matrículas, saldos.",
  },
  "Conectar banco de dados": { es: "Conectar base de datos" },
  "Nova conexão": { es: "Nueva conexión" },
  "1 conexão": { es: "1 conexión" },
  "Conectada": { es: "Conectada" },
  "Falha no último teste": { es: "Falla en la última prueba" },
  "Não testada": { es: "Sin probar" },
  "Conexão bem-sucedida.": { es: "Conexión exitosa." },
  "Conexão removida.": { es: "Conexión eliminada." },
  "Explorar": { es: "Explorar" },
  "Testar": { es: "Probar" },
  "Remover esta conexão?": { es: "¿Eliminar esta conexión?" },
  "A senha guardada é apagada e o agente deixa de enxergar esse banco. O banco de origem não é tocado — só a conexão daqui.": {
    es: "Se elimina la contraseña guardada y el agente deja de ver esa base. La base de origen no se modifica; solo se elimina la conexión desde aquí.",
  },
  "Editar conexão": { es: "Editar conexión" },
  "A senha é cifrada antes de gravar e nunca é mostrada de volta. A conexão é somente leitura e só aceita TLS por padrão.": {
    es: "La contraseña se cifra antes de guardarse y nunca se vuelve a mostrar. La conexión es de solo lectura y, por defecto, solo acepta TLS.",
  },
  "Nome da conexão": { es: "Nombre de la conexión" },
  "Ex: CRM de assinaturas": { es: "Ej.: CRM de suscripciones" },
  "Banco de dados": { es: "Base de datos" },
  "Guardada — preencha só para trocar": { es: "Guardada: escribe solo para cambiarla" },
  "Segurança da conexão (TLS)": { es: "Seguridad de la conexión (TLS)" },
  "Conexão ativa": { es: "Conexión activa" },
  "Desative para o agente parar de usar esta fonte sem apagar o cadastro.": {
    es: "Desactiva para que el agente deje de usar esta fuente sin borrar el registro.",
  },
  "Informe a senha do banco.": { es: "Escribe la contraseña de la base de datos." },
  "Conexão atualizada.": { es: "Conexión actualizada." },
  "Conexão criada. Use Testar para conferir o acesso.": {
    es: "Conexión creada. Usa Probar para verificar el acceso.",
  },
  "Tabelas": { es: "Tablas" },
  "Lendo o catálogo…": { es: "Leyendo el catálogo…" },
  "Não foi possível ler o catálogo.": { es: "No se pudo leer el catálogo." },
  "Este banco não tem tabelas visíveis.": { es: "Esta base no tiene tablas visibles." },
  "view": { es: "vista" },
  "Escolha uma tabela à esquerda para ver os dados.": {
    es: "Elige una tabla a la izquierda para ver los datos.",
  },
  "linhas (estimativa)": { es: "filas (estimación)" },
  "Linhas por página": { es: "Filas por página" },
  "pág.": { es: "pág." },
  "Página anterior": { es: "Página anterior" },
  "Próxima página": { es: "Página siguiente" },
  "Carregando dados…": { es: "Cargando datos…" },
  "Não foi possível consultar esta tabela agora.": {
    es: "No se pudo consultar esta tabla ahora.",
  },
  "Nenhuma linha retornada.": { es: "No se devolvió ninguna fila." },
  "Chave primária": { es: "Clave primaria" },
  "Ajustar largura da coluna": { es: "Ajustar ancho de la columna" },
  "Arraste para ajustar a largura": { es: "Arrastra para ajustar el ancho" },
  "Ajustar altura da linha": { es: "Ajustar alto de la fila" },
  "Arraste para ajustar a altura": { es: "Arrastra para ajustar el alto" },
  "Limites de leitura": { es: "Límites de lectura" },
  "Quanto o assistente e a grade podem ler desta fonte. Aumente se o seu processo precisar.": {
    es: "Cuánto pueden leer de esta fuente el asistente y la cuadrícula. Auméntalos si tu proceso lo requiere.",
  },
  "Linhas por consulta": { es: "Filas por consulta" },
  "Filtros por consulta": { es: "Filtros por consulta" },
  "Resposta para a IA (KB)": { es: "Respuesta para la IA (KB)" },
  "nada a mostrar": { es: "nada que mostrar" },
  "Dados externos": { es: "Datos externos" },
  "Conecte um banco de dados de outro sistema — o seu segundo CRM, um ERP, uma planilha em PostgreSQL — e o agente passa a consultá-lo em tempo real. A conexão é sempre somente leitura: nada que o agente faz altera o banco de origem.": {
    es: "Conecta la base de datos de otro sistema (tu segundo CRM, un ERP, una hoja de cálculo en PostgreSQL) y el agente podrá consultarla en tiempo real. La conexión es siempre de solo lectura: nada de lo que haga el agente modifica la base de origen.",
  },
  "somente leitura": { es: "solo lectura" },
  "Esta conexão está desativada. Ative-a na lista para consultar os dados.": {
    es: "Esta conexión está desactivada. Actívala en la lista para consultar los datos.",
  },
  // Frase inteira, e não "Ativada" seco: essa chave já existe neste arquivo,
  // de outra tela e no feminino (`Activada`) — reusá-la duplicaria a chave e
  // discordaria do gênero de `Recorrido`.
  "Esta jornada não está ativada": { es: "Este recorrido no está activado" },
  "Esta jornada está ativada": { es: "Este recorrido está activado" },
  "Ativada, com peças removidas": { es: "Activado, con piezas eliminadas" },
  "Ativar de novo não recria o que você apagou — só cria o que nunca existiu.": {
    es: "Activarlo de nuevo no recrea lo que usted borró — solo crea lo que nunca existió.",
  },
  "colunas": { es: "columnas" },
  "campos": { es: "campos" },
  "respostas rápidas": { es: "respuestas rápidas" },
  "tipos de compromisso": { es: "tipos de cita" },
  "cadências em rascunho": { es: "cadencias en borrador" },
  "criada agora": { es: "creada ahora" },
  "já existia, igual à da jornada": { es: "ya existía, igual a la del recorrido" },
  "já estava lá com esse nome — o pacote não mexeu nela": {
    es: "ya estaba ahí con ese nombre — el paquete no la tocó",
  },
  "foi criada antes e depois apagada": { es: "fue creada antes y luego eliminada" },
  "não deu para criar": { es: "no se pudo crear" },
  "Ativando…": { es: "Activando…" },
  "Ativar jornada": { es: "Activar recorrido" },
  "Só quem administra a empresa pode ativar uma jornada.": {
    es: "Solo quien administra la empresa puede activar un recorrido.",
  },
  "Jornada ativada": { es: "Recorrido activado" },
  "Não consegui ativar tudo": { es: "No pude activar todo" },

  // Empresas (0260)
  Empresas: { es: "Empresas" },
  "Clientes pessoa jurídica e os contatos de cada um.": {
    es: "Clientes persona jurídica y los contactos de cada uno.",
  },
  "Nova empresa": { es: "Nueva empresa" },
  "Buscar por nome, fantasia ou CNPJ…": { es: "Buscar por nombre, fantasía o CNPJ…" },
  "Erro ao carregar empresas.": { es: "Error al cargar empresas." },
  "Nenhuma empresa ainda.": { es: "Ninguna empresa todavía." },
  "Cadastre a primeira para agrupar os contatos de um mesmo cliente.": {
    es: "Registre la primera para agrupar los contactos de un mismo cliente.",
  },
  empresa: { es: "empresa" },
  "carregadas — há mais resultados": { es: "cargadas — hay más resultados" },
  "Nome fantasia": { es: "Nombre fantasía" },
  "Cadastre a empresa para agrupar os contatos deste cliente.": {
    es: "Registre la empresa para agrupar los contactos de este cliente.",
  },
  "Criar empresa": { es: "Crear empresa" },
  "Empresa criada": { es: "Empresa creada" },
  "Editar empresa": { es: "Editar empresa" },
  "Atualize os dados desta empresa.": { es: "Actualice los datos de esta empresa." },
  "Empresa atualizada": { es: "Empresa actualizada" },
  "Contatos da empresa": { es: "Contactos de la empresa" },
  "Vincular contato": { es: "Vincular contacto" },
  "Nenhum contato vinculado. Vincule quem fala por esta empresa.": {
    es: "Ningún contacto vinculado. Vincule a quien habla por esta empresa.",
  },
  "Número principal para cobrança": { es: "Número principal para cobro" },
  "Tornar principal": { es: "Hacer principal" },
  Desvincular: { es: "Desvincular" },
  "Busque um contato para vinculá-lo a esta empresa.": {
    es: "Busque un contacto para vincularlo a esta empresa.",
  },
  "já está em outra empresa": { es: "ya está en otra empresa" },
  Vincular: { es: "Vincular" },
  "Nenhum contato encontrado.": { es: "Ningún contacto encontrado." },
  "Erro ao carregar empresa.": { es: "Error al cargar empresa." },
  Observações: { es: "Observaciones" },
  "Já existe uma empresa com este CNPJ nesta organização.": {
    es: "Ya existe una empresa con este CNPJ en esta organización.",
  },
  "Contato ou empresa inválidos para este vínculo.": {
    es: "Contacto o empresa inválidos para este vínculo.",
  },
  "Empresa não encontrada.": { es: "Empresa no encontrada." },
  "O número principal precisa ser um contato desta empresa.": {
    es: "El número principal debe ser un contacto de esta empresa.",
  },
  Nenhuma: { es: "Ninguna" },
  "Nova empresa…": { es: "Nueva empresa…" },

  // Asaas (0261)
  Asaas: { es: "Asaas" },
  "Consulte cobranças, envie boleto e Pix, e deixe o assistente prorrogar vencido dentro do limite que você definir.": {
    es: "Consulta cobros, envía boleto y Pix, y deja que el asistente prorrogue vencidos dentro del límite que definas.",
  },
  "A conexão com o Asaas está com erro": { es: "La conexión con Asaas está con error" },
  "Motivo não registrado.": { es: "Motivo no registrado." },
  "Endereço do aviso do Asaas": { es: "Dirección del aviso de Asaas" },
  "Cole este endereço em Configurações → Webhooks no painel do Asaas (Webhook no painel do Asaas).": {
    es: "Pega esta dirección en Configuraciones → Webhooks en el panel de Asaas (Webhook en el panel de Asaas).",
  },
  "Informe a chave de API do Asaas para começar.": { es: "Ingresa la clave de API de Asaas para empezar." },
  "Troque a chave, o ambiente ou o fluxo de retorno.": { es: "Cambia la clave, el entorno o el flujo de retorno." },
  "Chave de API do Asaas": { es: "Clave de API de Asaas" },
  "Deixe em branco para manter a chave atual": { es: "Deja en blanco para mantener la clave actual" },
  Ambiente: { es: "Entorno" },
  "Sandbox (teste)": { es: "Sandbox (prueba)" },
  Produção: { es: "Producción" },
  "Fluxo de retorno para cobrança vencida": { es: "Flujo de retorno para cobro vencido" },
  "Fluxos de retorno para cobrança vencida": { es: "Flujos de retorno para cobro vencido" },
  "Fluxo removido ou desativado": { es: "Flujo eliminado o desactivado" },
  "Desmarque para poder salvar.": { es: "Desmárquelo para poder guardar." },
  "Um por número. Quem cobra é o agente publicado naquele número — a cobrança de um negócio não sai pela linha do outro.": {
    es: "Uno por número. Quien cobra es el agente publicado en ese número — el cobro de un negocio no sale por la línea del otro.",
  },
  "Nenhum fluxo com gatilho de sistema externo. Crie um em Follow-ups.": {
    es: "Ningún flujo con disparador de sistema externo. Cree uno en Seguimientos.",
  },
  "Este fluxo tem mensagem fixa; recomendamos mensagem do assistente.": {
    es: "Este flujo tiene mensaje fijo; recomendamos mensaje del asistente.",
  },
  "O agente que arma este fluxo tem as capacidades de cobrança.": {
    es: "El agente que activa este flujo tiene las capacidades de cobro.",
  },
  "Prorrogar por até (dias)": { es: "Prorrogar hasta (días)" },
  "Vezes por cobrança": { es: "Veces por cobro" },
  "Configuração da Asaas salva.": { es: "Configuración de Asaas guardada." },
  "Não foi possível copiar — selecione o texto acima.": { es: "No se pudo copiar — selecciona el texto de arriba." },
  "Copie e guarde agora — o segredo não será mostrado de novo.": {
    es: "Copia y guarda ahora — el secreto no se mostrará de nuevo.",
  },
  "Endereço do aviso (Webhook no painel do Asaas)": { es: "Dirección del aviso (Webhook en el panel de Asaas)" },
  "Segredo do aviso": { es: "Secreto del aviso" },
  "Copiar segredo": { es: "Copiar secreto" },
  "Já copiei": { es: "Ya copié" },
  "Segredo copiado.": { es: "Secreto copiado." },
  "Desativar a integração Asaas?": { es: "¿Desactivar la integración Asaas?" },
  "Esquecer chave": { es: "Olvidar clave" },
  "Nenhuma cobrança está em acompanhamento agora. A integração para de consultar e prorrogar boletos.": {
    es: "Ningún cobro está en seguimiento ahora. La integración deja de consultar y prorrogar boletos.",
  },
  "Isso vai cancelar 1 cobrança em acompanhamento pelo assistente. A cobrança em si continua no Asaas — só o acompanhamento automático para.": {
    es: "Esto va a cancelar 1 cobro en seguimiento por el asistente. El cobro en sí continúa en Asaas — solo el seguimiento automático se detiene.",
  },
  "Isso vai cancelar {n} cobranças em acompanhamento pelo assistente. A cobrança em si continua no Asaas — só o acompanhamento automático para.": {
    es: "Esto va a cancelar {n} cobros en seguimiento por el asistente. El cobro en sí continúa en Asaas — solo el seguimiento automático se detiene.",
  },
  "Integração Asaas ativada.": { es: "Integración Asaas activada." },
  "Integração Asaas desativada.": { es: "Integración Asaas desactivada." },
  "Chave esquecida — a integração foi removida.": { es: "Clave olvidada — la integración fue eliminada." },
  "Desative a integração antes de esquecer a chave.": { es: "Desactiva la integración antes de olvidar la clave." },

  // Asaas — orientação e rótulo dos avisos charge_* na Central (lib/ai/inbox-destino.ts, migration 0261)
  "Abra a integração Asaas, encontre a cobrança pelo nome do cliente e vincule-a a uma empresa ou a um contato.": {
    es: "Abre la integración Asaas, encuentra el cobro por el nombre del cliente y vincúlalo a una empresa o a un contacto.",
  },
  "Escolha o fluxo de retorno para cobrança vencida na integração Asaas, ou marque o número principal da empresa.": {
    es: "Elige el flujo de retorno para cobro vencido en la integración Asaas, o marca el número principal de la empresa.",
  },
  "Leia o motivo do Asaas e resolva no painel dele; o cliente já recebeu a resposta do assistente.": {
    es: "Lee el motivo de Asaas y resuélvelo en su panel; el cliente ya recibió la respuesta del asistente.",
  },
  "O Asaas pausa os avisos depois de falhas seguidas. O sistema religou; confira se a URL do webhook continua cadastrada.": {
    es: "Asaas pausa los avisos después de fallos seguidos. El sistema volvió a conectarlo; confirma que la URL del webhook siga registrada.",
  },
  "Abrir integração Asaas": { es: "Abrir integración Asaas" },
  "Configurar avisos de cobrança": { es: "Configurar avisos de cobro" },
  "Conferir webhook": { es: "Revisar webhook" },

  // Asaas — cartão da empresa, coluna da lista e vínculo pela Central (Task 9, migration 0261)
  "Abrir boleto/fatura": { es: "Abrir boleto/factura" },
  "Cliente do Asaas vinculado": { es: "Cliente de Asaas vinculado" },
  "Esta empresa ainda não está vinculada a um cliente do Asaas.": {
    es: "Esta empresa aún no está vinculada a un cliente de Asaas.",
  },
  "Não foi possível carregar a integração Asaas.": { es: "No fue posible cargar la integración Asaas." },
  "Não foi possível vincular. Tente novamente.": { es: "No fue posible vincular. Inténtalo de nuevo." },
  "Nenhuma pendência agora.": { es: "Ningún pendiente ahora." },
  Vencimento: { es: "Vencimiento" },
  "Vinculando…": { es: "Vinculando…" },
  "Vincular pelo CNPJ": { es: "Vincular por CNPJ" },
  Vinculado: { es: "Vinculado" },
  "Vincular cobrança": { es: "Vincular cobro" },
  "Encontre a empresa ou o contato dono desta cobrança no Asaas.": {
    es: "Encuentra la empresa o el contacto dueño de este cobro en Asaas.",
  },

  // Integração com o sistema de gestão (ERP) por MCP — migration 0263
  "Sistema de gestão (MCP)": { es: "Sistema de gestión (MCP)" },
  "Deixe o assistente consultar contrato, fatura e situação do cliente direto no seu sistema de gestão. Só consulta — nada é alterado lá.": {
    es: "Deja que el asistente consulte contrato, factura y situación del cliente directo en tu sistema de gestión. Solo consulta — nada se modifica allí.",
  },
  "A conexão com o sistema de gestão está com erro": { es: "La conexión con el sistema de gestión está con error" },
  "Informe o endereço do servidor MCP e a chave de acesso para começar.": {
    es: "Ingresa la dirección del servidor MCP y la clave de acceso para empezar.",
  },
  "Troque o endereço ou a chave. A chave em branco mantém a atual.": {
    es: "Cambia la dirección o la clave. La clave en blanco mantiene la actual.",
  },
  "Endereço do servidor MCP": { es: "Dirección del servidor MCP" },
  "Informe a chave de acesso do servidor.": { es: "Ingresa la clave de acceso del servidor." },
  "Endereço inválido — informe a URL completa do servidor MCP.": {
    es: "Dirección inválida — ingresa la URL completa del servidor MCP.",
  },
  "Não foi possível cifrar a chave agora. Tente de novo em instantes.": {
    es: "No fue posible cifrar la clave ahora. Inténtalo de nuevo en instantes.",
  },
  "Configuração salva. Teste a conexão para ver o que o servidor oferece.": {
    es: "Configuración guardada. Prueba la conexión para ver lo que el servidor ofrece.",
  },
  "O que o assistente ganhou": { es: "Lo que el asistente ganó" },
  "Ainda não testamos a conexão — teste para ver o que este servidor oferece.": {
    es: "Aún no probamos la conexión — pruébala para ver lo que este servidor ofrece.",
  },
  "O servidor expõe {n} ferramentas.": { es: "El servidor expone {n} herramientas." },
  "Último teste:": { es: "Última prueba:" },
  "Situação do cliente": { es: "Situación del cliente" },
  "Faturas do cliente": { es: "Facturas del cliente" },
  "Detalhe da fatura": { es: "Detalle de la factura" },
  Contrato: { es: "Contrato" },
  Instância: { es: "Instancia" },
  "Não encontrada no servidor": { es: "No encontrada en el servidor" },
  "O servidor respondeu, mas nenhuma das cinco consultas foi encontrada nele. Confira se é o servidor certo.": {
    es: "El servidor respondió, pero ninguna de las cinco consultas fue encontrada en él. Revisa si es el servidor correcto.",
  },
  "As consultas partem do CPF ou CNPJ do cadastro do cliente. Sem documento na ficha, o assistente pede o documento e abre um atendimento para alguém completar o cadastro.": {
    es: "Las consultas parten del CPF o CNPJ del registro del cliente. Sin documento en la ficha, el asistente pide el documento y abre una atención para que alguien complete el registro.",
  },
  "Marque as consultas nas ferramentas do agente para ele poder usá-las.": {
    es: "Marca las consultas en las herramientas del agente para que pueda usarlas.",
  },
  "Informe o endereço e a chave do servidor primeiro.": { es: "Ingresa primero la dirección y la clave del servidor." },
  "Não foi possível falar com o servidor.": { es: "No fue posible hablar con el servidor." },
  "O servidor respondeu com {n} ferramentas.": { es: "El servidor respondió con {n} herramientas." },
  "Consulta ao sistema de gestão ativada.": { es: "Consulta al sistema de gestión activada." },
  "Consulta ao sistema de gestão desativada.": { es: "Consulta al sistema de gestión desactivada." },
  "Não foi possível ativar.": { es: "No fue posible activar." },
  "Não foi possível desativar.": { es: "No fue posible desactivar." },
  "Não foi possível remover.": { es: "No fue posible eliminar." },
  "Desativar a consulta ao sistema de gestão?": { es: "¿Desactivar la consulta al sistema de gestión?" },
  "O assistente perde as cinco consultas na hora: pergunta sobre fatura, contrato ou bloqueio volta a virar atendimento humano.": {
    es: "El asistente pierde las cinco consultas al instante: una pregunta sobre factura, contrato o bloqueo vuelve a convertirse en atención humana.",
  },
  "Abrir integração com o sistema de gestão": { es: "Abrir integración con el sistema de gestión" },

  // ─── Campanhas (migration 0264) ───
  "Agendar": { es: "Programar" },
  "ainda não enviadas": { es: "aún no enviadas" },
  "Ainda não enviadas": { es: "Aún no enviadas" },
  "A lista ainda não foi montada. Use Preparar para ver quem entra.": {
    es: "La lista aún no fue armada. Use Preparar para ver quién entra.",
  },
  "Base legal": { es: "Base legal" },
  "Base legal do envio": { es: "Base legal del envío" },
  "Busque o contato pelo nome ou telefone": { es: "Busque el contacto por nombre o teléfono" },
  "Campanhas": { es: "Campañas" },
  "Cancelar campanha": { es: "Cancelar campaña" },
  "Cancelar é definitivo: quem ainda não recebeu não recebe mais, e a campanha não volta a rodar.": {
    es: "Cancelar es definitivo: quien aún no recibió ya no recibe, y la campaña no vuelve a ejecutarse.",
  },
  "Com alguma destas etiquetas": { es: "Con alguna de estas etiquetas" },
  "começa": { es: "empieza" },
  "Começar a enviar para": { es: "Empezar a enviar a" },
  "começou": { es: "empezó" },
  "consentimento": { es: "consentimiento" },
  "Consentimento — estas pessoas pediram para receber": {
    es: "Consentimiento — estas personas pidieron recibir",
  },
  "Contando…": { es: "Contando…" },
  "Contato do teste": { es: "Contacto de la prueba" },
  "contatos na lista": { es: "contactos en la lista" },
  "criada": { es: "creada" },
  "Em branco, vale o ritmo do número (Conexões › Proteção de envio). O que você puser aqui só pode deixar mais devagar.": {
    es: "En blanco, vale el ritmo del número (Conexiones › Protección de envío). Lo que ponga aquí solo puede hacerlo más lento.",
  },
  "Entregues": { es: "Entregadas" },
  "Enviadas": { es: "Enviadas" },
  "Enviar para este": { es: "Enviar a este" },
  "Enviar pelo número": { es: "Enviar por el número" },
  "Enviar só a partir das (hora)": { es: "Enviar solo a partir de las (hora)" },
  "Enviar teste": { es: "Enviar prueba" },
  "Erro ao carregar as campanhas.": { es: "Error al cargar las campañas." },
  "Escolha o público, escreva a mensagem e acompanhe quem recebeu.": {
    es: "Elija el público, escriba el mensaje y acompañe quién lo recibió.",
  },
  "Escolha pelo menos um critério — uma lista sem recorte ninguém confere antes de apertar.": {
    es: "Elija al menos un criterio — una lista sin recorte nadie la revisa antes de apretar.",
  },
  "Escolha um número": { es: "Elija un número" },
  "Escreva como você falaria com uma pessoa só.": { es: "Escriba como le hablaría a una sola persona." },
  "Ex.: LIA-2026-01": { es: "Ej.: LIA-2026-01" },
  "Ex.: Reativação de clientes parados": { es: "Ej.: Reactivación de clientes inactivos" },
  "falharam": { es: "fallaron" },
  "Falharam": { es: "Fallaron" },
  "ficam de fora": { es: "quedan fuera" },
  "Filtrar destinatários": { es: "Filtrar destinatarios" },
  "fora": { es: "fuera" },
  "Fora da lista": { es: "Fuera de la lista" },
  "Iniciar envio": { es: "Iniciar envío" },
  "interesse legítimo": { es: "interés legítimo" },
  "Interesse legítimo — com avaliação (LIA) registrada": {
    es: "Interés legítimo — con evaluación (LIA) registrada",
  },
  "Intervalo mínimo entre mensagens (segundos)": { es: "Intervalo mínimo entre mensajes (segundos)" },
  "Isto cria um rascunho. Nada é enviado antes de você preparar a lista e iniciar.": {
    es: "Esto crea un borrador. No se envía nada antes de que usted prepare la lista e inicie.",
  },
  "Lidas": { es: "Leídas" },
  "lista ainda não preparada": { es: "lista aún no preparada" },
  "Máximo de contatos nesta campanha": { es: "Máximo de contactos en esta campaña" },
  "Máximo por dia": { es: "Máximo por día" },
  "Na lista": { es: "En la lista" },
  "Não foi possível carregar a campanha.": { es: "No fue posible cargar la campaña." },
  "Nenhuma campanha ainda.": { es: "Ninguna campaña todavía." },
  "Nenhum número conectado. Conecte um em Conexões antes de criar a campanha.": {
    es: "Ningún número conectado. Conecte uno en Conexiones antes de crear la campaña.",
  },
  "Nome da campanha": { es: "Nombre de la campaña" },
  "Nova campanha": { es: "Nueva campaña" },
  "Parar de enviar às (hora)": { es: "Dejar de enviar a las (hora)" },
  "pediram para parar": { es: "pidieron parar" },
  "pessoas? O envio segue o ritmo do número e pode levar horas.": {
    es: "personas? El envío sigue el ritmo del número y puede llevar horas.",
  },
  "podem receber": { es: "pueden recibir" },
  "Preparar lista": { es: "Preparar lista" },
  "Progresso do envio": { es: "Progreso del envío" },
  "Público": { es: "Público" },
  "Quem está na lista": { es: "Quién está en la lista" },
  "Quem não tiver o dado que a mensagem usa fica de fora, com o motivo na lista — mensagem com buraco não sai.": {
    es: "Quien no tenga el dato que el mensaje usa queda fuera, con el motivo en la lista — un mensaje con hueco no sale.",
  },
  "Quem recebe pode perguntar por que recebeu, e a resposta precisa existir antes do envio.": {
    es: "Quien recibe puede preguntar por qué lo recibió, y la respuesta debe existir antes del envío.",
  },
  "Referência da avaliação (LIA)": { es: "Referencia de la evaluación (LIA)" },
  "Ritmo desta campanha": { es: "Ritmo de esta campaña" },
  "Sai pelo mesmo número e com o mesmo texto do envio real — inclusive o horário da saudação. Não entra nos números da campanha.": {
    es: "Sale por el mismo número y con el mismo texto del envío real — incluido el horario del saludo. No entra en los números de la campaña.",
  },
  "Sem falar com a gente há (dias)": { es: "Sin hablar con nosotros hace (días)" },
  "Sem nenhuma destas etiquetas": { es: "Sin ninguna de estas etiquetas" },
  "separe por vírgula": { es: "separe por coma" },
  "Último problema": { es: "Último problema" },
  "Uma campanha fala com uma lista de contatos que você escolhe, no ritmo do número — nunca em rajada.": {
    es: "Una campaña habla con una lista de contactos que usted elige, al ritmo del número — nunca en ráfaga.",
  },
  "Ver quantas pessoas": { es: "Ver cuántas personas" },
  "Você pode usar:": { es: "Puede usar:" },
  "Máximo por hora": { es: "Máximo por hora" },
  "Ritmo salvo.": { es: "Ritmo guardado." },
  "Salvar ritmo": { es: "Guardar ritmo" },
  "Editar campanha": { es: "Editar campaña" },
  "Enquanto é rascunho, tudo muda. Depois de preparada, só o ritmo.": {
    es: "Mientras es borrador, todo cambia. Una vez preparada, solo el ritmo.",
  },
  "Esta campanha já foi preparada: cada pessoa da lista tem o texto que vai receber guardado. Para mudar o texto ou o público, volte a campanha para rascunho — isso descarta a lista montada.": {
    es: "Esta campaña ya fue preparada: cada persona de la lista tiene guardado el texto que va a recibir. Para cambiar el texto o el público, vuelva la campaña a borrador — eso descarta la lista armada.",
  },
  "O ritmo você ajusta na própria tela da campanha, sem descartar nada.": {
    es: "El ritmo se ajusta en la propia pantalla de la campaña, sin descartar nada.",
  },
  "Voltar para a campanha": { es: "Volver a la campaña" },
  "funil removido": { es: "embudo eliminado" },
  "agente indisponível": { es: "agente no disponible" },
  "Agente publicado no número (padrão)": { es: "Agente publicado en el número (predeterminado)" },
  "Com negócio no funil": { es: "Con negocio en el embudo" },
  "Em branco, tudo segue como hoje: o card nasce no funil do número e quem atende é o agente publicado nele.": {
    es: "En blanco, todo sigue como hoy: la tarjeta nace en el embudo del número y quien atiende es el agente publicado en él.",
  },
  "Funil do número (padrão)": { es: "Embudo del número (predeterminado)" },
  "Na etapa": { es: "En la etapa" },
  "Primeira etapa do funil": { es: "Primera etapa del embudo" },
  "Qualquer etapa": { es: "Cualquier etapa" },
  "Qualquer um": { es: "Cualquiera" },
  "Quem atende a resposta": { es: "Quién atiende la respuesta" },
  "Quem responder": { es: "Quien responda" },
  "Vale só para conversas que nascem desta campanha: quem já falava com você continua com quem o atendia. Quem aborda precisa saber dizer de onde veio o contato — essa resposta tem de estar no material do agente escolhido.": {
    es: "Vale solo para conversaciones que nacen de esta campaña: quien ya hablaba con usted sigue con quien lo atendía. Quien aborda necesita saber decir de dónde vino el contacto — esa respuesta tiene que estar en el material del agente elegido.",
  },
  "Vira card no funil": { es: "Se convierte en tarjeta en el embudo" },
  "pessoa?": { es: "persona?" },
  "pessoas?": { es: "personas?" },
  "O envio segue o ritmo do número e pode levar horas.": {
    es: "El envío sigue el ritmo del número y puede llevar horas.",
  },
  "A cada envio, a campanha usa o número com mais folga no teto do dia — e o número que a pessoa já conhece, quando ela já conversou com algum deles.": {
    es: "En cada envío, la campaña usa el número con más margen en el tope del día — y el número que la persona ya conoce, cuando ya conversó con alguno de ellos.",
  },
  "A campanha reveza entre os números marcados, escolhendo a cada envio o que tem mais folga no teto do dia. Quem já conversa com você por um deles recebe por esse mesmo, para não chegar de um número desconhecido.": {
    es: "La campaña alterna entre los números marcados, eligiendo en cada envío el que tiene más margen en el tope del día. Quien ya conversa con usted por uno de ellos recibe por ese mismo, para no llegar desde un número desconocido.",
  },
  "Atenção: o intervalo e os tetos da CAMPANHA somam todos os números. Para o rodízio aumentar o volume, deixe o ritmo da campanha em branco e cada número usa o dele.": {
    es: "Atención: el intervalo y los topes de la CAMPAÑA suman todos los números. Para que la alternancia aumente el volumen, deje el ritmo de la campaña en blanco y cada número usa el suyo.",
  },
  "Falar também por estes números": {
    es: "Hablar también por estos números",
  },
  "Números desta campanha": {
    es: "Números de esta campaña",
  },
  "Apagar": { es: "Eliminar" },
  "A proteção do número — ritmo, janela e aquecimento que valem para tudo que sai por ele — fica em": {
    es: "La protección del número — ritmo, franja y calentamiento que valen para todo lo que sale por él — está en",
  },
  "Campo vazio significa herdar o número. Toda campanha nova nasce com estes valores e pode ficar mais devagar, nunca mais rápida.": {
    es: "Campo vacío significa heredar el número. Toda campaña nueva nace con estos valores y puede ir más lenta, nunca más rápida.",
  },
  "Conexões › Proteção de envio": { es: "Conexiones › Protección de envío" },
  "Configuração de campanhas": { es: "Configuración de campañas" },
  "Contar como resposta até (horas depois do envio)": {
    es: "Contar como respuesta hasta (horas después del envío)",
  },
  "Copy que você reusa entre campanhas. Mudar um texto aqui não muda mensagem que já foi preparada nem que já foi enviada.": {
    es: "Texto que usted reutiliza entre campañas. Cambiarlo aquí no cambia un mensaje ya preparado ni ya enviado.",
  },
  "Excluir das campanhas": { es: "Excluir de las campañas" },
  "Ex.: Primeiro contato — produtor": { es: "Ej.: Primer contacto — productor" },
  "Lista de exclusão": { es: "Lista de exclusión" },
  "Nenhum número excluído.": { es: "Ningún número excluido." },
  "Nenhum texto salvo ainda.": { es: "Ningún texto guardado todavía." },
  "Números que nenhuma campanha alcança. Diferente de quem pediu para parar: aqui o atendimento continua normal se a pessoa escrever — isto é uma decisão sua, não dela.": {
    es: "Números que ninguna campaña alcanza. Distinto de quien pidió parar: aquí la atención sigue normal si la persona escribe — esta es una decisión suya, no de ella.",
  },
  "O que vale para todas as campanhas, e não para uma só.": {
    es: "Lo que vale para todas las campañas, y no para una sola.",
  },
  "Padrões desta organização": { es: "Valores por defecto de esta organización" },
  "Padrões salvos.": { es: "Valores guardados." },
  "Salvar padrões": { es: "Guardar valores" },
  "Salvar texto": { es: "Guardar texto" },
  "Telefone com DDI e DDD": { es: "Teléfono con código de país y área" },
  "termina em": { es: "termina en" },
  "Texto": { es: "Texto" },
  "Textos salvos": { es: "Textos guardados" },
  // Descrições das variáveis de campanha (DESCRICAO_DA_VARIAVEL em
  // lib/campanhas/renderizador.ts) — a tela lista cada uma ao lado do nome.
  "Nome do contato, como está no cadastro":
    { es: "Nombre del contacto, tal como está en el registro" },
  "Só a primeira palavra do nome": { es: "Solo la primera palabra del nombre" },
  "Bom dia / Boa tarde / Boa noite, na hora do envio":
    { es: "Buenos días / Buenas tardes / Buenas noches, a la hora del envío" },
  "Tirar da lista": { es: "Quitar de la lista" },
  "Uma mensagem que chega depois desse prazo é conversa nova, não resposta à campanha. Isso muda o número de respostas que a tela mostra, inclusive das campanhas já enviadas.": {
    es: "Un mensaje que llega después de ese plazo es una conversación nueva, no una respuesta a la campaña. Eso cambia la cantidad de respuestas que muestra la pantalla, incluso de las campañas ya enviadas.",
  },
  "Fale com uma lista de contatos que você escolhe, no ritmo do número.": {
    es: "Envía mensajes a una lista de contactos que elijas, al ritmo del número.",
  },

  // ── Entrada com Google (issue #1388) ──────────────────────────────────────
  ou: { es: "o" },
  "Entrar com Google": { es: "Entrar con Google" },
  "Abrindo o Google...": { es: "Abriendo Google..." },
  "O Google não está habilitado nesta instalação. Entre com e-mail e senha, ou peça a quem administra para habilitá-lo.":
    {
      es: "Google no está habilitado en esta instalación. Entra con correo y contraseña, o pídele a quien administra que lo habilite.",
    },
  "Não foi possível falar com o Google agora. Tente novamente em instantes.": {
    es: "No se pudo hablar con Google ahora. Vuelve a intentarlo en unos instantes.",
  },
  "Não foi possível concluir a entrada com o Google. Tente novamente — se acontecer de novo, entre com e-mail e senha.":
    {
      es: "No se pudo completar la entrada con Google. Vuelve a intentarlo — si sucede otra vez, entra con correo y contraseña.",
    },
  "A entrada com o Google foi cancelada antes de terminar. Nada mudou na sua conta.": {
    es: "La entrada con Google se canceló antes de terminar. Nada cambió en tu cuenta.",
  },
  "O acesso desta conta foi retirado por quem administra o sistema — então não criamos uma empresa nova para você. Se o acesso deveria continuar, peça a quem administra para restaurá-lo; se você está entrando em outra equipe, peça um convite.": {
    es: "El acceso de esta cuenta fue retirado por quien administra el sistema — así que no creamos una empresa nueva para ti. Si el acceso debería continuar, pídele a quien administra que lo restaure; si estás entrando en otro equipo, pide una invitación.",
  },

  // ─── Painel "Para integrar" (dados não-secretos da conexão) ───
  "Para integrar": { es: "Para integrar" },
  "Copiar dados": { es: "Copiar datos" },
  "Onde obter o token": { es: "Dónde obtener el token" },
  "Não foi possível copiar.": { es: "No se pudo copiar." },
  "Endpoint da API": { es: "Endpoint de la API" },
  "Estes dados conectam outro sistema ao mesmo número. O token não aparece aqui — o ícone ao lado diz onde obtê-lo no painel do provedor.": {
    es: "Con estos datos puedes conectar otro sistema al mismo número. El token no se muestra aquí; el ícono de al lado indica dónde obtenerlo en el panel del proveedor.",
  },
  "O token de acesso é criado no painel da Meta: Configurações do Business → Usuários do sistema → gerar token permanente.": {
    es: "El token de acceso se crea en el panel de Meta: Configuración del negocio → Usuarios del sistema → generar token permanente.",
  },
  "A chave de API está no painel do provedor, na conta conectada — este CRM não a exibe de volta.": {
    es: "La clave de API está en el panel del proveedor, dentro de la cuenta conectada. Este CRM no la vuelve a mostrar.",
  },
  "O webhook de um número aponta para um só destino. Para os dois CRMs receberem ao mesmo tempo, um deles precisa reencaminhar as mensagens ao outro.": {
    es: "El webhook de un número apunta a un solo destino. Para que los dos CRM reciban al mismo tiempo, uno de ellos debe reenviar los mensajes al otro.",
  },
  "Um número tem um único webhook.": { es: "Un número tiene un único webhook." },
  "Para operar em dois CRMs ao mesmo tempo, configure o reencaminhamento de mensagens.": {
    es: "Para operar en dos CRM a la vez, configura el reenvío de mensajes.",
  },
  "No canal por QR a credencial é interna desta instalação e não serve para fora. Para ligar outro CRM ao mesmo número, conecte-o por uma sessão própria (novo QR).": {
    es: "En el canal por QR, la credencial es interna de esta instalación y no sirve fuera de ella. Para usar otro CRM con el mismo número, conéctalo con una sesión propia (nuevo QR).",
  },
  "Dois dispositivos vinculados recebem as mesmas mensagens — se os dois tiverem atendimento automático, o cliente pode receber resposta dupla.": {
    es: "Dos dispositivos vinculados reciben los mismos mensajes. Si ambos tienen atención automática, el cliente puede recibir dos respuestas.",
  },
  "Não compartilhe esta sessão.": { es: "No compartas esta sesión." },
  "Crie uma conexão separada por QR no outro sistema.": {
    es: "Crea una conexión separada por QR en el otro sistema.",

  },

  // ─── Catálogo de navegación (hub de Configuración, sidebar y ⌘K) ───
  // Vive en lib/navigation/catalogo.ts, fuera de lo que barre la catraca de
  // app/ y components/; lo cubre tests/unit/i18n-catalogo-de-navegacao-em-espanhol.
  "Busque empresas e conduza abordagens graduais com IA.": {
    es: "Busca empresas y contáctalas de forma gradual con ayuda de la IA.",
  },
  Dinheiro: { es: "Dinero" },
  "O vocabulário de etiquetas da empresa: onde cada uma é usada e como renomear, juntar ou excluir.": {
    es: "El vocabulario de etiquetas de la empresa: dónde se usa cada una y cómo renombrarla, unirla o eliminarla.",
  },
  "Credenciais do provedor SIP para chamadas de voz por IA.": {
    es: "Credenciales del proveedor SIP para las llamadas de voz con IA.",
  },
  "Conecte um banco de dados de outro sistema para o agente consultar em tempo real.": {
    es: "Conecta una base de datos de otro sistema para que el agente la consulte en tiempo real.",
  },
};

/**
 * Traduz, ou devolve o próprio texto.
 *
 * Nunca lança e nunca devolve vazio: um texto sem tradução aparece em
 * português, que é exatamente o comportamento de antes desta feature. Uma
 * tradução parcial não pode deixar a tela PIOR do que estava.
 */
export function traduzir(texto: string, idioma: Idioma): string {
  if (idioma === "pt-BR") return texto;
  return DICIONARIO[texto]?.[idioma] ?? texto;
}
