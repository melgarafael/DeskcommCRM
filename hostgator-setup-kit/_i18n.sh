#!/usr/bin/env bash
# Idioma da LINHA DE COMANDO do kit — o idioma em que install.sh/_common.sh
# falam com quem instala. É DISTINTO do idioma que o CRM instalado usa com os
# clientes da empresa (aquele mora em user_metadata.locale/organizations, e
# continua todo em português por padrão, escolhido pela pessoa na tela).
#
# Quem decide o idioma é `perguntar_idioma_cli` (só o install.sh a chama), e ela
# consulta, nesta ordem: DESKCOMM_IDIOMA_CLI no ambiente, a linha guardada no
# .env de uma execução anterior e, por último, a pergunta interativa. Este
# arquivo NÃO lê o ambiente ao ser carregado: `update.sh` e os demais scripts o
# recarregam DEPOIS de `load_env` (que traz DESKCOMM_IDIOMA_CLI do .env), e ler
# lá misturaria mensagens em espanhol de `_common.sh` com as em português do
# próprio script. Sem `perguntar_idioma_cli`, o idioma é pt-BR — o original de
# todo texto deste kit, e o que qualquer instalação existente continua vendo.
IDIOMA_CLI="${IDIOMA_CLI:-pt-BR}"

# Tabela pt-BR → es. A CHAVE é sempre o texto em português, byte a byte — o
# mesmo contrato de lib/i18n/dicionario.ts na aplicação web: a chave nunca
# muda, só o valor por idioma. Mensagem com valor que só existe em tempo de
# execução (nome de arquivo, URL, número, saída de outro comando) usa
# placeholders {1}, {2}… na chave E no valor; quem chama passa os valores como
# argumentos de t(), nunca embutidos na chave. Placeholder por posição, e não
# %s do printf, porque texto de erro real às vezes carrega um % de verdade
# (porcentagem, encoding de URL) — com {N} isso nunca precisa de escape.
# A tabela só é montada em bash >= 4.4. Em 4.2 (CentOS 7) a atribuição composta
# recusa toda chave que começa com "[" ou contém "[…]" ("bad array subscript"):
# a tabela sairia furada e com erros no terminal. Medido com bash:4.2 (falha),
# 4.4, 5.0, 5.1 e 5.2 (carregam); 4.3 não foi testado, e 4.4 é o piso medido.
# Sem tabela, t() devolve a própria chave em português — o comportamento que
# esse bash sempre teve — e perguntar_idioma_cli não oferece o espanhol.
# I18N_BASH_MINIMO (major*100+minor) existe para os testes simularem bash antigo.
_I18N_TABELA=0
if [ $((BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1])) -ge "${I18N_BASH_MINIMO:-404}" ]; then
_I18N_TABELA=1
declare -A _ES=(
  ["Este servidor usa arquitetura '{1}', mas as imagens publicadas do DeskcommCRM hoje são linux/amd64."]="Este servidor usa arquitectura '{1}', pero las imágenes publicadas de DeskcommCRM hoy son linux/amd64."
  ["  Use uma VPS x86_64/amd64. Repetir o download não resolve; ARM64 só será suportado quando houver imagens multi-arquitetura."]="  Usa una VPS x86_64/amd64. Repetir la descarga no soluciona nada; ARM64 solo se admitirá cuando existan imágenes multiarquitectura."
  ["  (rede '{1}' criada — é por ela que o Traefik alcança o CRM)"]="  (red '{1}' creada: por ella Traefik llega al CRM)"
  ["A rede Docker '{1}' (a do Nginx Proxy Manager) não existe.
Rode 'docker network ls', identifique a rede do seu NPM (Settings > a que o
contêiner dele já está conectado) e ponha PROXY_NETWORK_NAME=<nome> no .env
antes de tentar de novo."]="La red Docker '{1}' (la del Nginx Proxy Manager) no existe.
Ejecuta 'docker network ls', identifica la red de tu NPM (Settings > la red a
la que su contenedor ya está conectado) y pon PROXY_NETWORK_NAME=<nombre> en
el .env antes de volver a intentarlo."
  ["Não consegui criar a rede Docker '{1}'. O Docker respondeu:
  {2}"]="No pude crear la red Docker '{1}'. Docker respondió:
  {2}"
  ["A rede Docker '{1}' não existe.
Rode 'docker network ls', identifique a rede do seu Traefik e ponha
TRAEFIK_NETWORK=<nome> no .env antes de tentar de novo."]="La red Docker '{1}' no existe.
Ejecuta 'docker network ls', identifica la red de tu Traefik y pon
TRAEFIK_NETWORK=<nombre> en el .env antes de volver a intentarlo."
  ["A rede '{1}' tem driver '{2}', e o app precisa
de uma bridge para o Traefik alcançar o contêiner. Se o seu Traefik roda em modo
host (é o caso quando 'docker ps' não mostra porta publicada nele), APAGUE a linha
TRAEFIK_NETWORK do .env: o kit cria e usa a rede '{3}'.
Senão, rode 'docker network ls' e ponha a bridge certa em TRAEFIK_NETWORK no .env.
Se for uma overlay do Swarm, ela precisa ter sido criada com --attachable —
sem isso um contêiner de compose comum não consegue entrar nela."]="La red '{1}' tiene el driver '{2}', y la app necesita
una bridge para que Traefik alcance el contenedor. Si tu Traefik corre en modo
host (es el caso cuando 'docker ps' no muestra un puerto publicado en él), BORRA
la línea TRAEFIK_NETWORK del .env: el kit crea y usa la red '{3}'.
Si no, ejecuta 'docker network ls' y pon la bridge correcta en TRAEFIK_NETWORK en el .env.
Si es una overlay de Swarm, tiene que haberse creado con --attachable —
sin eso un contenedor de compose común no puede entrar en ella."
  ["Pausando o sistema para mexer no banco com segurança."]="Pausando el sistema para modificar la base de datos con seguridad."
  ["⛔ PEÇAS DO BANCO NÃO VOLTARAM depois da atualização:"]="⛔ PARTES DE LA BASE DE DATOS NO VOLVIERON después de la actualización:"
  ["   Enquanto elas estiverem paradas, o CRM não consegue ler nem gravar."]="   Mientras estén detenidas, el CRM no puede leer ni escribir."
  ["   Para subir à mão:  docker start {1}"]="   Para levantarlas a mano:  docker start {1}"
  ["   O CRM segue PARADO de propósito. Resolva as regras antes de subir."]="   El CRM sigue DETENIDO a propósito. Resuelve las reglas antes de levantarlo."
  ["Modo single-server sem {1}/.env — rode install-single-server.sh."]="Modo single-server sin {1}/.env — ejecuta install-single-server.sh."
  ["Atualizando o Supabase desta VPS ({1} → {2})"]="Actualizando el Supabase de esta VPS ({1} → {2})"
  ["⚠ O Supabase não foi atualizado; segue na versão {1}. A próxima atualização tenta de novo."]="⚠ Supabase no se actualizó; sigue en la versión {1}. La próxima actualización lo vuelve a intentar."
  ["⚠ As imagens prontas desta versão não servem para esta VPS."]="⚠ Las imágenes listas de esta versión no sirven para esta VPS."
  ["  O motivo mais comum é a arquitetura dela ser diferente da das imagens"]="  El motivo más común es que su arquitectura sea distinta de la de las imágenes"
  ["  publicadas: o registro responde que não tem manifest para a arquitetura"]="  publicadas: el registro responde que no tiene manifest para la arquitectura"
  ["  daqui. Não é problema da sua VPS nem do seu acesso."]="  de aquí. No es un problema de tu VPS ni de tu acceso."
  ["  Vou construir as três imagens aqui, do código desta versão."]="  Voy a construir las tres imágenes aquí, a partir del código de esta versión."
  ["  Leva de 15 a 25 minutos e a tela fica sem novidade nesse tempo —"]="  Toma de 15 a 25 minutos y la pantalla no muestra novedades en ese tiempo —"
  ["  não é travamento, pode deixar rodando."]="  no significa que se colgó, puedes dejarlo corriendo."
  ["✖ A construção das imagens aqui falhou (o erro está logo acima)."]="✖ La construcción de las imágenes aquí falló (el error está justo arriba)."
  ["✖ As imagens foram construídas, mas os serviços não subiram."]="✖ Las imágenes se construyeron, pero los servicios no arrancaron."
  ["Não achei {1}. Rode a partir da pasta do projeto."]="No encontré {1}. Ejecuta esto desde la carpeta del proyecto."
  ["Falta o .env (rode install.sh primeiro)."]="Falta el .env (ejecuta install.sh primero)."
  ["• parte do banco não aplicou (disputa com o app no ar ou conexão instável) — aplicando de novo, é seguro (passada {1} de {2}). O que não aplicou:"]="• parte de la base de datos no se aplicó (disputa con la app activa o conexión inestable) — aplicando de nuevo, es seguro (pasada {1} de {2}). Lo que no se aplicó:"
  ["Usuário não encontrado."]="Usuario no encontrado."
  ["⚠ 'crontab' não encontrado — instale o pacote 'cron' e rode de novo pra ativar as automações."]="⚠ No se encontró 'crontab' — instala el paquete 'cron' y vuelve a ejecutar esto para activar las automatizaciones."
  ["⚠ falta INTERNAL_SECRET/INTERNAL_CRON_SECRET — não ativei o cron das automações."]="⚠ Falta INTERNAL_SECRET/INTERNAL_CRON_SECRET — no activé el cron de las automatizaciones."
  ["⚠ falta NEXT_PUBLIC_APP_URL — não ativei o cron das automações."]="⚠ Falta NEXT_PUBLIC_APP_URL — no activé el cron de las automatizaciones."
  ["⚠ não consegui gravar {1} — não ativei o cron das automações."]="⚠ No pude guardar {1} — no activé el cron de las automatizaciones."
  ["✓ automações ativas (cron do event-log-drain, a cada minuto)"]="✓ Automatizaciones activas (cron del event-log-drain, cada minuto)"
  ["Higienizando eventos pendentes antigos (1ª ativação do cron)"]="Depurando eventos pendientes antiguos (1.ª activación del cron)"
  ["✓ eventos pendentes com mais de 7 dias marcados como concluídos"]="✓ Eventos pendientes con más de 7 días marcados como concluidos"
  ["⚠ não consegui higienizar eventos antigos — confira manualmente a tabela event_log se necessário."]="⚠ No pude depurar eventos antiguos — revisa manualmente la tabla event_log si hace falta."
  ["⚠ não consegui gerar a senha nova das rotinas — tento de novo na próxima atualização."]="⚠ No pude generar la contraseña nueva de las rutinas — lo intento de nuevo en la próxima actualización."
  ["Trocando a senha interna das rotinas (a antiga ficou no log do sistema)"]="Cambiando la contraseña interna de las rutinas (la anterior quedó en el log del sistema)"
  ["⚠ não consegui reiniciar o app com a senha nova — mantive a antiga e tento de novo na próxima atualização."]="⚠ No pude reiniciar la app con la contraseña nueva — mantuve la anterior y lo intento de nuevo en la próxima actualización."
  ["⚠ o app ainda não respondeu depois da troca — a senha nova já está no .env e segue valendo."]="⚠ La app todavía no respondió después del cambio — la contraseña nueva ya está en el .env y sigue vigente."
  ["✓ senha interna das rotinas trocada — a que ficou gravada no log do sistema não abre mais nada"]="✓ Contraseña interna de las rutinas cambiada — la que quedó grabada en el log del sistema ya no abre nada"
  ["  Recomendado (não obrigatório): apagar os logs antigos, onde a senha velha aparece."]="  Recomendado (no obligatorio): borrar los logs antiguos, donde aparece la contraseña anterior."
  ["  Numa VPS Ubuntu/Debian, como root:"]="  En una VPS Ubuntu/Debian, como root:"
  ["⚠ 'crontab' não encontrado — o botão de atualizar pela tela não vai funcionar."]="⚠ No se encontró 'crontab' — el botón de actualizar desde la pantalla no va a funcionar."
  ["⚠ falta INTERNAL_SECRET — não ativei o agente de atualização."]="⚠ Falta INTERNAL_SECRET — no activé el agente de actualización."
  ["⚠ falta NEXT_PUBLIC_APP_URL — não ativei o agente de atualização."]="⚠ Falta NEXT_PUBLIC_APP_URL — no activé el agente de actualización."
  ["✓ atualização pela tela ativa (agente a cada 5 minutos)"]="✓ Actualización desde la pantalla activa (agente cada 5 minutos)"
  ["✓ chave de cifra dos segredos gerada e gravada no .env"]="✓ Clave de cifrado de los secretos generada y guardada en el .env"
  ["✓ chave de cifra ativa no banco (segredos de webhook são guardados cifrados)"]="✓ Clave de cifrado activa en la base de datos (los secretos de webhook se guardan cifrados)"
  ["⚠ não consegui semear a chave de cifra no banco — segredos de webhook não poderão ser salvos até rodar update.sh de novo."]="⚠ No pude sembrar la clave de cifrado en la base de datos — los secretos de webhook no podrán guardarse hasta volver a ejecutar update.sh."

  # ── install.sh: banner() e show_recovery() ──────────────────────────────
  ["  Agentes de IA que atendem no WhatsApp, dentro do seu CRM."]="  Agentes de IA que atienden por WhatsApp, dentro de tu CRM."
  ["  Open-source · roda no seu servidor · os dados são seus."]="  Open-source · corre en tu servidor · los datos son tuyos."
  ["A instalação parou. Nada ficou pela metade sem conserto."]="La instalación se detuvo. Nada quedó a medias sin solución."
  ["Como voltar atrás e recomeçar do zero:"]="Cómo volver atrás y empezar de cero:"
  ["apaga a configuração digitada"]="borra la configuración ingresada"
  ["derruba o que subiu"]="derriba lo que se levantó"
  ["começa de novo"]="empieza de nuevo"
  ["Se o schema chegou a ser aplicado e você quer o banco limpo de novo,"]="Si el esquema llegó a aplicarse y quieres la base de datos limpia de nuevo,"
  ["abra o Supabase > SQL Editor e rode (ATENÇÃO: apaga todos os dados):"]="abre Supabase > SQL Editor y ejecuta (ATENCIÓN: borra todos los datos):"

  # ── install.sh: validadores (v_domain, v_email, v_hex, v_locale, v_supabase_url, v_sb_key, v_db_url, v_anthropic, v_openrouter) ──
  ["Digite só o domínio, sem https:// — ex.: crm.suaempresa.com.br"]="Escribe solo el dominio, sin https:// — ej.: crm.tuempresa.com.mx"
  ["Digite só o domínio, sem barra nem caminho — ex.: crm.suaempresa.com.br"]="Escribe solo el dominio, sin barra ni ruta — ej.: crm.tuempresa.com.mx"
  ["Isso não parece um domínio (falta o ponto) — ex.: crm.suaempresa.com.br"]="Esto no parece un dominio (falta el punto) — ej.: crm.tuempresa.com.mx"
  ["E-mail inválido — precisa ter @ e um domínio, ex.: voce@suaempresa.com.br"]="Correo inválido — necesita @ y un dominio, ej.: tu@tuempresa.com.mx"
  ["Use um código de cor como #7a5cd6 — cerquilha e 6 dígitos —, ou Enter para a cor do sistema"]="Usa un código de color como #7a5cd6 — numeral y 6 dígitos —, o Enter para el color del sistema"
  ["Escolha 1 (Português) ou 2 (Español) — ou Enter para Português"]="Elige 1 (Português) o 2 (Español) — o Enter para Português"
  ["Cole a URL completa, começando com https:// — ex.: https://abcdefgh.supabase.co"]="Pega la URL completa, empezando con https:// — ej.: https://abcdefgh.supabase.co"
  ["A URL precisa começar com https://. Na nuvem ela fica em Settings > API > Project URL (termina em .supabase.co); num Supabase próprio, é o endereço do seu servidor."]="La URL debe empezar con https://. En la nube está en Settings > API > Project URL (termina en .supabase.co); en un Supabase propio, es la dirección de tu servidor."
  ["O modo single-server exige SUPABASE_INTERNAL_URL com http:// ou https:// para validar o Supabase local."]="El modo single-server requiere SUPABASE_INTERNAL_URL con http:// o https:// para validar el Supabase local."
  ["Não consegui alcançar {1} — confira se o projeto existe, está ativo (projeto pausado não responde) e se o VPS tem internet."]="No pude conectar con {1} — revisa que el proyecto exista, esté activo (un proyecto pausado no responde) y que la VPS tenga internet."
  ["Essa é a chave '{1}', e aqui eu preciso da '{2}'. Em Settings > API elas ficam uma embaixo da outra — confira qual copiou."]="Esa es la clave '{1}', y aquí necesito la '{2}'. En Settings > API están una debajo de la otra — revisa cuál copiaste."
  ["Essa chave é de OUTRO projeto Supabase ({1}), e a URL que você deu é do projeto {2}. Copie as duas do mesmo projeto."]="Esa clave es de OTRO proyecto de Supabase ({1}), y la URL que diste es del proyecto {2}. Copia las dos del mismo proyecto."
  ["Isso não parece uma chave do Supabase (elas começam com 'eyJ' ou 'sb_'). Pegue em Settings > API."]="Esto no parece una clave de Supabase (empiezan con 'eyJ' o 'sb_'). Consíguela en Settings > API."
  ["  ⚠ não consegui checar a chave online (sem resposta do Supabase); sigo com ela."]="  ⚠ no pude comprobar la clave en línea (Supabase no respondió); sigo con ella."
  ["O Supabase recusou essa chave (resposta {1}). Confira se copiou a '{2}' inteira, sem espaço no fim."]="Supabase rechazó esa clave (respuesta {1}). Revisa que hayas copiado la '{2}' completa, sin espacio al final."
  ["Resposta inesperada do Supabase ao testar a chave ({1}). Confira a chave e o projeto."]="Respuesta inesperada de Supabase al probar la clave ({1}). Revisa la clave y el proyecto."
  ["A connection string começa com postgresql:// — copie em Settings > Database > Connection string, modo URI."]="La connection string empieza con postgresql:// — cópiala en Settings > Database > Connection string, modo URI."
  ["Você colou a string com o [YOUR-PASSWORD] no meio — troque isso pela senha do banco (a que você definiu ao criar o projeto)."]="Pegaste la cadena con [YOUR-PASSWORD] en el medio — cambia eso por la contraseña de la base de datos (la que definiste al crear el proyecto)."
  ["Essa é a 'Direct connection' do Supabase — ela só existe em IPv6 e o VPS é IPv4, então nunca conecta."]="Esa es la 'Direct connection' de Supabase — solo existe en IPv6 y la VPS es IPv4, así que nunca conecta."
  ["Volte em Settings > Database e copie a do Session pooler (o host termina em .pooler.supabase.com)."]="Vuelve a Settings > Database y copia la del Session pooler (el host termina en .pooler.supabase.com)."
  ["Essa connection string é do projeto '{1}', mas a URL que você deu é do projeto '{2}'. Precisam ser o mesmo projeto."]="Esa connection string es del proyecto '{1}', pero la URL que diste es del proyecto '{2}'. Tienen que ser el mismo proyecto."
  ["Não consegui conectar no banco. O Postgres respondeu:"]="No pude conectar con la base de datos. Postgres respondió:"
  ["Quase sempre é a senha com caractere especial: na URL ela precisa ser codificada."]="Casi siempre es la contraseña con un carácter especial: en la URL debe estar codificada."
  ["Troque  @ por %40   :  por %3A   /  por %2F   ?  por %3F   #  por %23"]="Cambia  @ por %40   :  por %3A   /  por %2F   ?  por %3F   #  por %23"
  ["Senha do banco errada. É a senha do PROJETO (definida ao criá-lo), não a da sua conta Supabase."]="Contraseña de la base de datos incorrecta. Es la contraseña del PROYECTO (definida al crearlo), no la de tu cuenta de Supabase."
  ["Dá pra redefinir em Settings > Database > Reset database password."]="Puedes restablecerla en Settings > Database > Reset database password."
  ["Isso é o problema de IPv6: use a connection string do Session pooler, não a Direct connection."]="Este es el problema de IPv6: usa la connection string del Session pooler, no la Direct connection."
  ["A chave da Anthropic começa com 'sk-ant-'. Pegue em console.anthropic.com > API Keys."]="La clave de Anthropic empieza con 'sk-ant-'. Consíguela en console.anthropic.com > API Keys."
  ["  ⚠ não consegui checar a chave online; sigo com ela."]="  ⚠ no pude comprobar la clave en línea; sigo con ella."
  ["A Anthropic recusou essa chave (401). Confira se está ativa e se copiou inteira."]="Anthropic rechazó esa clave (401). Revisa que esté activa y que la hayas copiado completa."
  ["  ⚠ a Anthropic respondeu {1} ao testar a chave; sigo com ela."]="  ⚠ Anthropic respondió {1} al probar la clave; sigo con ella."
  ["A chave da OpenRouter começa com 'sk-or-'. Pegue em openrouter.ai/keys."]="La clave de OpenRouter empieza con 'sk-or-'. Consíguela en openrouter.ai/keys."
  ["A OpenRouter recusou essa chave (401). Confira se está ativa e se copiou inteira."]="OpenRouter rechazó esa clave (401). Revisa que esté activa y que la hayas copiado completa."
  ["  ⚠ a OpenRouter respondeu {1} ao testar a chave; sigo com ela."]="  ⚠ OpenRouter respondió {1} al probar la clave; sigo con ella."
  ["A chave da OpenAI começa com 'sk-'. Pegue em platform.openai.com > API keys (ou deixe em branco)."]="La clave de OpenAI empieza con 'sk-'. Consíguela en platform.openai.com > API keys (o déjala en blanco)."
  ["A OpenAI recusou essa chave (401). Confira se está ativa e se copiou inteira."]="OpenAI rechazó esa clave (401). Revisa que esté activa y que la hayas copiado completa."
  ["  ⚠ a OpenAI respondeu {1} ao testar a chave; sigo com ela."]="  ⚠ OpenAI respondió {1} al probar la clave; sigo con ella."
  ["Senha muito curta ({1} caracteres). Use pelo menos 8 — é a senha de admin do seu CRM."]="Contraseña muy corta ({1} caracteres). Usa al menos 8 — es la contraseña de admin de tu CRM."

  # ── install.sh: ask_one() — o motor genérico de todas as perguntas ──────
  ["Falta {1} (modo --yes exige .env preenchido)."]="Falta {1} (el modo --yes requiere el .env completo)."
  ["A entrada terminou antes de eu receber {1}. Rode o instalador num terminal interativo."]="La entrada terminó antes de recibir {1}. Ejecuta el instalador en una terminal interactiva."
  ["  Esse campo é obrigatório. (digite 'voltar' para refazer a pergunta anterior)"]="  Este campo es obligatorio. (escribe 'voltar' para rehacer la pregunta anterior)"
  ["  Esse valor parece ter sido colado 2x seguidas (o campo é secreto e não mostra o que você cola). Cole uma vez só."]="  Este valor parece haberse pegado 2 veces seguidas (el campo es secreto y no muestra lo que pegas). Pégalo una sola vez."
  ["  (digite 'voltar' para refazer a pergunta anterior)"]="  (escribe 'voltar' para rehacer la pregunta anterior)"
  ["  ✓ recebido ({1} caracteres)"]="  ✓ recibido ({1} caracteres)"

  # ── install.sh: Fase 1 (Preflight) ───────────────────────────────────────
  ["⚠ Docker não está instalado — é o motor que roda o CRM."]="⚠ Docker no está instalado — es el motor que hace correr al CRM."
  ["  Posso instalar agora? (S/n) "]="  ¿Puedo instalarlo ahora? (S/n) "
  ["  Instalando (get.docker.com — o instalador oficial). Leva 1-2 minutos…"]="  Instalando (get.docker.com — el instalador oficial). Toma 1-2 minutos…"
  ["  Últimas linhas do instalador do Docker:"]="  Últimas líneas del instalador de Docker:"
  ["Não consegui instalar o Docker (log em {1}). Rode 'curl -fsSL https://get.docker.com | sh' e tente de novo."]="No pude instalar Docker (log en {1}). Ejecuta 'curl -fsSL https://get.docker.com | sh' y vuelve a intentarlo."
  ["Docker instalou mas não ficou no PATH. Reabra o terminal e rode de novo."]="Docker se instaló pero no quedó en el PATH. Vuelve a abrir la terminal y ejecuta esto de nuevo."
  ["✓ Docker instalado"]="✓ Docker instalado"
  ["Sem Docker não dá para seguir. Instale com: curl -fsSL https://get.docker.com | sh"]="Sin Docker no se puede continuar. Instálalo con: curl -fsSL https://get.docker.com | sh"
  ["'{1}' não encontrado. Instale antes de continuar."]="No se encontró '{1}'. Instálalo antes de continuar."
  ["'docker compose' (v2) não encontrado."]="No se encontró 'docker compose' (v2)."
  ["O daemon do Docker não está rodando (ou seu usuário não tem permissão)."]="El daemon de Docker no está corriendo (o tu usuario no tiene permiso)."
  ["✓ docker, git, openssl, curl ok"]="✓ docker, git, openssl, curl ok"
  ["⚠ Este servidor tem ~{1}MB de RAM. O CRM sobe, mas fica no limite:"]="⚠ Este servidor tiene ~{1}MB de RAM. El CRM arranca, pero queda al límite:"
  ["  são 7 contêineres e o WhatsApp usa ~150MB por número conectado."]="  son 7 contenedores, y WhatsApp usa ~150MB por número conectado."
  ["  Adicione swap antes de operar — ver docs/runbooks/waha-hostgator.md."]="  Agrega swap antes de operar — consulta docs/runbooks/waha-hostgator.md."
  ["✓ rodando dentro do repositório"]="✓ corriendo dentro del repositorio"
  ["✓ repositório em ./{1}"]="✓ repositorio en ./{1}"
  ["Clonando {1} ..."]="Clonando {1} ..."
  ["Instalação interrompida para não derrubar o CRM que já está no ar nesta VPS."]="Instalación interrumpida para no derribar el CRM que ya está activo en esta VPS."
  ["✓ .env existente carregado"]="✓ .env existente cargado"
  ["✓ retomando: {1} resposta(s) guardadas da tentativa anterior"]="✓ retomando: {1} respuesta(s) guardadas del intento anterior"
  ["  (para responder tudo de novo do zero: rm {1})"]="  (para responder todo de nuevo desde cero: rm {1})"
  ["  (o token do Supabase é de conta e nunca entra no rascunho: ele é perguntado de novo. Enter pula)"]="  (el token de Supabase es de cuenta y nunca entra en el borrador: se vuelve a preguntar. Enter lo salta)"
  ["  (as portas 80/443 já estão com esta instalação — seguindo)"]="  (los puertos 80/443 ya están con esta instalación — continuando)"

  # ── install.sh: detección de proxy (Traefik en modo host, puertos ocupados) ──
  ["imagem"]="imagen"
  ["⚠ As portas {1} estão ocupadas, mas NENHUM contêiner as publica."]="⚠ Los puertos {1} están ocupados, pero NINGÚN contenedor los publica."
  ["  O único Traefik em modo host aqui é '{1}'{2}."]="  El único Traefik en modo host aquí es '{1}'{2}."
  ["  O único Traefik em modo host aqui é '{1}'{2},"]="  El único Traefik en modo host aquí es '{1}'{2},"
  ["  Em modo host o Docker não mostra as portas, então não consigo PROVAR que é ele"]="  En modo host, Docker no muestra los puertos, así que no puedo PROBAR que sea él"
  ["  quem atende o seu domínio — poderia ser um nginx/apache instalado no servidor."]="  quien atiende tu dominio — podría ser un nginx/apache instalado en el servidor."
  ["  Se for ele, o CRM sai publicado por ele e tudo funciona."]="  Si es él, el CRM queda publicado por él y todo funciona."
  ["  Se não for, o site vai subir e não responder — sem erro nenhum na tela."]="  Si no lo es, el sitio va a arrancar y no responderá — sin ningún error en pantalla."
  ["  É o '{1}' que atende o seu site? (s/N) "]="  ¿Es '{1}' quien atiende tu sitio? (s/N) "
  ["Ok, não vou arriscar. Descubra quem está com as portas 80/443 (ex.: 'ss -ltnp | grep :80')
e, se for mesmo um Traefik, ponha REVERSE_PROXY=traefik no .env e rode de novo."]="Ok, no voy a arriesgarme. Descubre quién tiene los puertos 80/443 (ej.: 'ss -ltnp | grep :80')
y, si de verdad es un Traefik, pon REVERSE_PROXY=traefik en el .env y vuelve a ejecutar esto."
  ["✖ As portas {1} estão ocupadas, mas NENHUM contêiner as publica."]="✖ Los puertos {1} están ocupados, pero NINGÚN contenedor los publica."
  ["  e em modo host o Docker não mostra porta — não dá para provar que é ele quem atende."]="  y en modo host Docker no muestra puertos — no se puede probar que sea él quien atiende."
  ["  Publicar o CRM atrás do proxy errado instala 'com sucesso' um site que não responde,"]="  Publicar el CRM detrás del proxy equivocado instala 'con éxito' un sitio que no responde,"
  ["  então em modo --yes eu paro aqui em vez de chutar."]="  así que en modo --yes me detengo aquí en vez de adivinar."
  ["  É esse Traefik mesmo? Ponha no .env e rode de novo:"]="  ¿Es realmente ese Traefik? Ponlo en el .env y vuelve a ejecutar esto:"
  ["  Não é? Confira quem está com as portas: ss -ltnp | grep -E ':80|:443'"]="  ¿No lo es? Revisa quién tiene los puertos: ss -ltnp | grep -E ':80|:443'"
  ["Não consigo identificar com certeza o dono das portas {1} em modo --yes."]="No puedo identificar con certeza quién tiene los puertos {1} en modo --yes."
  ["⚠ Detectei um Traefik já rodando neste VPS (contêiner '{1}', ocupando 80/443)."]="⚠ Detecté un Traefik ya corriendo en esta VPS (contenedor '{1}', ocupando 80/443)."
  ["  Vou publicar o CRM através dele em vez de subir um proxy próprio —"]="  Voy a publicar el CRM a través de él en vez de levantar un proxy propio —"
  ["  desligar o Traefik quebraria o que a sua hospedagem instalou."]="  apagar el Traefik rompería lo que tu hosting instaló."
  ["✖ Já existe um DeskcommCRM NO AR nesta VPS, instalado em {1}."]="✖ Ya existe un DeskcommCRM ACTIVO en esta VPS, instalado en {1}."
  ["  Esta pasta ({1}) é outra cópia do repo. As duas se chamam"]="  Esta carpeta ({1}) es otra copia del repo. Las dos se llaman"
  ["  DeskcommCRM, então o Docker dá às duas o MESMO nome de projeto"]="  DeskcommCRM, así que Docker les da a ambas el MISMO nombre de proyecto"
  ["  ('{1}') — e instalar aqui recriaria os contêineres daquela."]="  ('{1}') — e instalar aquí recrearía los contenedores de aquella."
  ["  Na prática: o CRM que está no ar passaria a rodar com o .env DESTA pasta"]="  En la práctica: el CRM que está activo pasaría a correr con el .env de ESTA carpeta"
  ["  (outro banco, outras chaves), e as conexões de WhatsApp cairiam."]="  (otra base de datos, otras claves), y las conexiones de WhatsApp se caerían."
  ["  Quer atualizar o que já existe? Use aquela pasta:"]="  ¿Quieres actualizar lo que ya existe? Usa aquella carpeta:"
  ["  Quer mesmo uma SEGUNDA instalação nesta VPS? Ela precisa de nome de"]="  ¿De verdad quieres una SEGUNDA instalación en esta VPS? Necesita nombre de"
  ["  projeto e domínio próprios — ponha no .env desta pasta, antes de rodar:"]="  proyecto y dominio propios — ponlos en el .env de esta carpeta, antes de ejecutar:"
  ["Instalação interrompida para não derrubar o DeskcommCRM que está no ar em {1}."]="Instalación interrumpida para no derribar el DeskcommCRM que está activo en {1}."
  ["✖ As portas {1} já estão ocupadas {2}."]="✖ Los puertos {1} ya están ocupados {2}."
  ["✖ A porta {1} já está ocupada {2}."]="✖ El puerto {1} ya está ocupado {2}."
  ["  O CRM precisa dessas duas portas para publicar o site com HTTPS. Subir um"]="  El CRM necesita esos dos puertos para publicar el sitio con HTTPS. Levantar un"
  ["  segundo proxy nelas não funciona: o Docker recusa e a instalação para."]="  segundo proxy en ellos no funciona: Docker lo rechaza y la instalación se detiene."
  ["  Como resolver, na ordem do mais provável:"]="  Cómo resolverlo, en orden de lo más probable:"
  ["  1. Já é outro DeskcommCRM neste servidor? Então use aquele — entre na"]="  1. ¿Ya es otro DeskcommCRM en este servidor? Entonces usa aquel — entra en"
  ["     pasta dele e rode: bash hostgator-setup-kit/update.sh"]="     su carpeta y ejecuta: bash hostgator-setup-kit/update.sh"
  ["  2. Não usa mais o que está ocupando? Desligue e rode este instalador de novo:"]="  2. ¿Ya no usas lo que lo está ocupando? Apágalo y vuelve a ejecutar este instalador:"
  ["       docker stop {1}"]="       docker stop {1}"
  ["  3. Quer manter os dois no ar? Aí o CRM tem de sair por um proxy só, e isso"]="  3. ¿Quieres mantener los dos activos? Entonces el CRM tiene que salir por un solo proxy, y eso"
  ["     é configuração manual — o kit automatiza esse caminho apenas para"]="     es configuración manual — el kit automatiza ese camino solo para"
  ["     Traefik (ponha REVERSE_PROXY=traefik no .env)."]="     Traefik (pon REVERSE_PROXY=traefik en el .env)."
  ["Libere as portas {1} (ou use a instalação que já existe) e rode de novo."]="Libera los puertos {1} (o usa la instalación que ya existe) y vuelve a ejecutar esto."
  ["Libere a porta {1} (ou use a instalação que já existe) e rode de novo."]="Libera el puerto {1} (o usa la instalación que ya existe) y vuelve a ejecutar esto."

  # ── install.sh: Supabase automático + selección de proveedor de IA ─────────
  ["Criando o projeto Supabase automaticamente"]="Creando el proyecto de Supabase automáticamente"
  ["Não consegui criar o projeto Supabase. Crie no painel e rode de novo sem SUPABASE_ACCESS_TOKEN."]="No pude crear el proyecto de Supabase. Créalo en el panel y vuelve a ejecutar esto sin SUPABASE_ACCESS_TOKEN."
  ["O provisionamento não devolveu as 4 credenciais. Crie o projeto no painel e rode de novo sem SUPABASE_ACCESS_TOKEN."]="El aprovisionamiento no devolvió las 4 credenciales. Crea el proyecto en el panel y vuelve a ejecutar esto sin SUPABASE_ACCESS_TOKEN."
  ["✓ Supabase pronto — as 4 credenciais entraram sozinhas"]="✓ Supabase listo — las 4 credenciales se completaron solas"
  ["Qual inteligência artificial vai atender seus clientes?"]="¿Qué inteligencia artificial va a atender a tus clientes?"
  ["[1] OpenRouter  — uma chave, centenas de modelos de vários fabricantes."]="[1] OpenRouter  — una clave, cientos de modelos de varios fabricantes."
  ["O caminho mais simples para experimentar. (openrouter.ai/keys)"]="El camino más simple para experimentar. (openrouter.ai/keys)"
  ["[2] Anthropic   — o Claude. É o que melhor segue instruções longas e usa"]="[2] Anthropic   — Claude. Es el que mejor sigue instrucciones largas y usa"
  ["as ferramentas do CRM. (console.anthropic.com)"]="las herramientas del CRM. (console.anthropic.com)"
  ["[3] OpenAI      — o GPT. (platform.openai.com/api-keys)"]="[3] OpenAI      — GPT. (platform.openai.com/api-keys)"
  ["Dá para trocar depois, e por parte do sistema, em Agente de IA → Provedores."]="Puedes cambiarlo después, y elegir uno distinto para cada parte del sistema, en Agente de IA → Proveedores."
  ["Escolha (Enter = {1}): "]="Elige (Enter = {1}): "
  ["Digite 1, 2 ou 3."]="Escribe 1, 2 o 3."
  ["pelo contêiner '{1}'{2}"]="por el contenedor '{1}'{2}"
  ["por um programa do próprio servidor"]="por un programa del propio servidor"

  # ── install.sh: versión objetivo (canal stable/latest) ──────────────────
  ["⚠ A versão {1} ainda não tem as três imagens publicadas."]="⚠ La versión {1} todavía no tiene las tres imágenes publicadas."
  ["mais recente"]="más reciente"
  ["  Instalando pelo canal 'stable' (a última versão completa)."]="  Instalando por el canal 'stable' (la última versión completa)."
  ["⚠ As imagens do worker e do agendador ainda não estão publicadas."]="⚠ Las imágenes del worker y del agendador todavía no están publicadas."
  ["  Elas serão construídas neste servidor — leva alguns minutos a mais."]="  Se van a construir en este servidor — toma algunos minutos más."
  ["  Rode 'bash hostgator-setup-kit/update.sh' quando a próxima versão sair."]="  Ejecuta 'bash hostgator-setup-kit/update.sh' cuando salga la próxima versión."
  ["⚠ Não consegui descobrir a última versão publicada (rede?)."]="⚠ No pude averiguar la última versión publicada (¿red?)."
  ["  Instalando pelo canal 'latest'. Depois rode: bash hostgator-setup-kit/update.sh"]="  Instalando por el canal 'latest'. Después ejecuta: bash hostgator-setup-kit/update.sh"

  # ── install.sh: FIELDS[] — los prompts de la entrevista, vía field_at() ──
  ["Domínio do CRM (ex: crm.suaempresa.com.br)"]="Dominio del CRM (ej: crm.tuempresa.com.mx)"
  ["Seu e-mail (avisos de SSL)"]="Tu correo (avisos de SSL)"
  ["Imagem Docker do app"]="Imagen Docker de la app"
  ["Supabase Project URL (Settings > API)"]="Supabase Project URL (Settings > API)"
  ["Supabase anon key (Settings > API)"]="Supabase anon key (Settings > API)"
  ["Supabase service_role key (Settings > API)"]="Supabase service_role key (Settings > API)"
  ["Supabase connection string — Session pooler, modo URI (Settings > Database)"]="Supabase connection string — Session pooler, modo URI (Settings > Database)"
  ["Token de acesso do Supabase — configura os links de e-mail (supabase.com/dashboard/account/tokens). NÃO fica salvo. Enter pula"]="Token de acceso de Supabase — configura los enlaces de correo (supabase.com/dashboard/account/tokens). NO se guarda. Enter lo salta"
  ["Chave da OpenRouter — a IA que atende (openrouter.ai/keys; Enter pula: dá para cadastrar depois pela tela, em IA › Credenciais)"]="Clave de OpenRouter — la IA que atiende (openrouter.ai/keys; Enter la salta: puedes registrarla después desde la pantalla, en IA › Credenciales)"
  ["Chave da OpenAI — a IA que atende (platform.openai.com/api-keys; Enter pula: dá para cadastrar depois pela tela, em IA › Credenciais)"]="Clave de OpenAI — la IA que atiende (platform.openai.com/api-keys; Enter la salta: puedes registrarla después desde la pantalla, en IA › Credenciales)"
  ["Chave da Anthropic — a IA que atende (console.anthropic.com; Enter pula: dá para cadastrar depois pela tela, em IA › Credenciais)"]="Clave de Anthropic — la IA que atiende (console.anthropic.com; Enter la salta: puedes registrarla después desde la pantalla, en IA › Credenciales)"
  ["Chave da OpenAI — só para ouvir áudios e usar a base de conhecimento (Enter pula: dá para cadastrar depois pela tela, em IA › Credenciais)"]="Clave de OpenAI — solo para escuchar audios y usar la base de conocimiento (Enter la salta: puedes registrarla después desde la pantalla, en IA › Credenciales)"
  ["E-mail do primeiro admin (dono)"]="Correo del primer admin (dueño)"
  ["Senha do primeiro admin (mínimo 8 caracteres)"]="Contraseña del primer admin (mínimo 8 caracteres)"
  ["Nome que aparece na interface (Enter para o padrão)"]="Nombre que aparece en la interfaz (Enter para el predeterminado)"
  ["Idioma do sistema — 1) Português  2) Español (Enter = Português)"]="Idioma del sistema — 1) Português  2) Español (Enter = Português)"
  ["Cor da sua marca em hex, ex.: #7a5cd6 (Enter usa a cor do sistema)"]="Color de tu marca en hex, ej.: #7a5cd6 (Enter usa el color del sistema)"
  ["E-mail de suporte que SEUS clientes veem (Enter pula)"]="Correo de soporte que ven TUS clientes (Enter lo salta)"
  ["Chave da Resend — envia convite e e-mail de LGPD (resend.com/api-keys, Enter pula)"]="Clave de Resend — envía invitación y correo de LGPD (resend.com/api-keys, Enter la salta)"
  ["Remetente dos e-mails, de um domínio verificado na Resend (Enter pula)"]="Remitente de los correos, de un dominio verificado en Resend (Enter lo salta)"

  # ── install.sh: entrevista y pantalla de confirmación ────────────────────
  ["Dica: em qualquer pergunta, digite 'voltar' para refazer a anterior."]="Consejo: en cualquier pregunta, escribe 'voltar' para rehacer la anterior."
  ["A chave da OpenAI é opcional, mas sem ela a IA não ouve áudio nem consulta a base de conhecimento."]="La clave de OpenAI es opcional, pero sin ella la IA no escucha audio ni consulta la base de conocimiento."
  ["  Essa já é a primeira pergunta."]="  Esa ya es la primera pregunta."
  ["Confira antes de eu escrever a configuração:"]="Revisa antes de que escriba la configuración:"
  ["(vazio)"]="(vacío)"
  ["Está tudo certo? (Enter = continuar / número = corrigir): "]="¿Está todo bien? (Enter = continuar / número = corregir): "
  ["Digite o número do item que quer corrigir, ou Enter para continuar."]="Escribe el número del ítem que quieres corregir, o Enter para continuar."
  ["Número fora da lista."]="Número fuera de la lista."
  ["✖ {1} inválido:"]="✖ {1} inválido:"
  ["Corrija o .env e rode de novo."]="Corrige el .env y vuelve a ejecutar esto."
  ["✓ segredos prontos"]="✓ secretos listos"

  # ── install.sh: red del Traefik, telemetría, escritura del .env ─────────
  ["  (o Traefik roda em modo host, então o CRM publica numa rede própria: {1})"]="  (Traefik corre en modo host, así que el CRM publica en una red propia: {1})"
  ["Não consegui descobrir a rede Docker do seu Traefik. Rode 'docker network ls',
identifique a rede dele e ponha TRAEFIK_NETWORK=<nome> no .env antes de tentar de novo."]="No pude averiguar la red Docker de tu Traefik. Ejecuta 'docker network ls',
identifica su red y pon TRAEFIK_NETWORK=<nombre> en el .env antes de volver a intentarlo."
  ["  (entrypoints do seu Traefik: {1} para HTTP, {2} para HTTPS)"]="  (entrypoints de tu Traefik: {1} para HTTP, {2} para HTTPS)"
  ["Telemetria de erros (opcional)"]="Telemetría de errores (opcional)"
  ["Podemos receber os relatórios de ERRO desta instalação (stack trace) para"]="Podemos recibir los reportes de ERROR de esta instalación (stack trace) para"
  ["corrigir bugs que afetam todo mundo. CPF, telefone e e-mail são substituídos,"]="corregir errores que afectan a todos. El CPF, teléfono y correo se sustituyen,"
  ["cabeçalhos sensíveis removidos e tokens de webhook/convite redigidos da URL."]="se quitan los encabezados sensibles y se redactan los tokens de webhook/invitación de la URL."
  ["NÃO enviamos rastreamento de performance nem replay de sessão."]="NO enviamos rastreo de rendimiento ni repetición de sesión."
  ["Seus dados de clientes, conversas e banco NUNCA saem daqui."]="Tus datos de clientes, conversaciones y base de datos NUNCA salen de aquí."
  ["Você pode mudar depois no .env, a qualquer momento."]="Puedes cambiarlo después en el .env, en cualquier momento."
  ["  Enviar relatórios de erro anonimizados? (s/N) "]="  ¿Enviar reportes de error anonimizados? (s/N) "
  ["✓ Telemetria de erros ligada — obrigado, isso ajuda o projeto."]="✓ Telemetría de errores activada — gracias, esto ayuda al proyecto."
  ["✓ Telemetria desligada — nada será enviado."]="✓ Telemetría desactivada — no se enviará nada."
  ["Escrevendo .env"]="Escribiendo .env"
  ["→ preservando {1} variável(is) que você acrescentou à mão"]="→ preservando {1} variable(s) que agregaste a mano"
  ["⚠ APP_IMAGE está pinado por digest."]="⚠ APP_IMAGE está fijado por digest."
  ["  O worker e o scheduler ficam em 'stable' — ajuste WORKER_IMAGE/SCHEDULER_IMAGE"]="  El worker y el scheduler quedan en 'stable' — ajusta WORKER_IMAGE/SCHEDULER_IMAGE"
  ["  no .env se você precisa deles num digest específico também."]="  en el .env si también los necesitas en un digest específico."

  # ── install.sh: escritura del .env (fin) y verificación de DNS ───────────
  ["✓ .env escrito (permissão 600)"]="✓ .env escrito (permiso 600)"
  ["Conferindo DNS de {1}"]="Revisando el DNS de {1}"
  ["✓ {1} → {2} (aponta pra este VPS)"]="✓ {1} → {2} (apunta a esta VPS)"
  ["⚠ {1} resolve para '{2}' e o IP deste VPS é '{3}'."]="⚠ {1} resuelve a '{2}' y el IP de esta VPS es '{3}'."
  ["nada"]="nada"
  ["desconhecido"]="desconocido"
  ["  O SSL (Let's Encrypt) só será emitido quando o A-record apontar pra cá."]="  El SSL (Let's Encrypt) solo se emitirá cuando el registro A apunte hacia aquí."
  ["  No painel do seu domínio, crie um registro A apontando {1}"]="  En el panel de tu dominio, crea un registro A que apunte {1}"
  ["  para {1}. Costuma valer em poucos minutos."]="  hacia {1}. Suele tardar solo unos minutos en aplicarse."
  ["o IP deste servidor"]="el IP de este servidor"
  ["  Enter = conferir de novo"]="  Enter = revisar de nuevo"
  ["  c     = continuar assim mesmo (o site sobe sem cadeado até o DNS valer)"]="  c     = continuar de todas formas (el sitio arranca sin candado hasta que el DNS surta efecto)"
  ["  s     = sair e voltar depois (o que você já respondeu fica guardado)"]="  s     = salir y volver después (lo que ya respondiste queda guardado)"
  ["  Seguindo sem o DNS pronto — lembre de apontar o A-record."]="  Continuando sin el DNS listo — recuerda apuntar el registro A."
  ["Ajuste o A-record de {1} para {2} e rode o instalador de novo."]="Ajusta el registro A de {1} hacia {2} y vuelve a ejecutar el instalador."
  ["✓ {1} → {2} (agora aponta pra este VPS)"]="✓ {1} → {2} (ahora apunta a esta VPS)"
  ["  Ainda não propagou. Dá pra esperar e tentar de novo."]="  Todavía no se propagó. Puedes esperar y volver a intentarlo."
  ["Aplicando o schema no Supabase (baseline.sql)"]="Aplicando el esquema en Supabase (baseline.sql)"

  # ── install.sh: aplicación del baseline.sql ──────────────────────────────
  ["✓ extensões (vector, citext, pg_trgm) habilitadas no public"]="✓ extensiones (vector, citext, pg_trgm) habilitadas en public"
  ["⚠ não consegui habilitar as extensões — o schema pode falhar abaixo."]="⚠ no pude habilitar las extensiones — el esquema puede fallar más abajo."
  ["  Supabase próprio? Criar extensão exige o dono do banco: rode de novo com"]="  ¿Supabase propio? Crear una extensión requiere ser dueño de la base de datos: vuelve a ejecutar esto con"
  ["• schema já existe — re-aplicando em modo update (erros 'já existe' são esperados e ficam no log)"]="• el esquema ya existe — reaplicando en modo actualización (errores 'ya existe' son esperados y quedan en el log)"
  ["✓ schema re-aplicado (apêndice de migrations incluído)"]="✓ esquema reaplicado (apéndice de migrations incluido)"
  ["⚠ Erros no banco que NÃO são os esperados (log completo: {1}):"]="⚠ Errores en la base de datos que NO son los esperados (log completo: {1}):"
  ["✓ schema aplicado (log: {1})"]="✓ esquema aplicado (log: {1})"
  ["baseline falhou num banco NOVO — o schema ficaria incompleto (sem RLS). Log completo: {1}
     Se o erro fala em permissão: o baseline exige o DONO do banco. Num Supabase próprio,
     rode de novo com SUPABASE_DB_ADMIN_URL='postgresql://<dono>:<senha>@<host>:5432/postgres'
     — ela roda só o schema e NÃO é gravada no .env dos contêineres."]="el baseline falló en una base de datos NUEVA — el esquema quedaría incompleto (sin RLS). Log completo: {1}
     Si el error menciona permisos: el baseline requiere ser el DUEÑO de la base de datos. En un Supabase propio,
     vuelve a ejecutar esto con SUPABASE_DB_ADMIN_URL='postgresql://<dueño>:<contraseña>@<host>:5432/postgres'
     — esa cadena solo aplica el esquema y NO se guarda en el .env de los contenedores."
  ["✓ verificação: {1} tabelas no schema public"]="✓ verificación: {1} tablas en el schema public"
  ["⚠ verificação: só {1} tabelas no schema public — confira {2}"]="⚠ verificación: solo {1} tablas en el schema public — revisa {2}"
  ["⚠ supabase/baseline.sql não encontrado — pulei (aplique o schema manualmente)."]="⚠ no se encontró supabase/baseline.sql — lo salté (aplica el esquema manualmente)."

  # ── install.sh: pendencia_dos_emails() — Supabase en la nube ─────────────
  ["FALTA UM PASSO, e ele é no painel do Supabase"]="FALTA UN PASO, y es en el panel de Supabase"
  ["Os e-mails de acesso (esqueci minha senha, confirmação de cadastro e"]="Los correos de acceso (olvidé mi contraseña, confirmación de registro y"
  ["aceite de convite) ainda não levam para este app. Sem este passo,"]="aceptación de invitación) todavía no llevan a esta app. Sin este paso,"
  ["ninguém consegue redefinir a própria senha."]="nadie puede restablecer su propia contraseña."
  ["O que o passo automático encontrou:"]="Lo que encontró el paso automático:"
  ["Em https://supabase.com/dashboard → seu projeto → Authentication →"]="En https://supabase.com/dashboard → tu proyecto → Authentication →"
  ["URL Configuration, preencha:"]="URL Configuration, completa:"
  ["Depois é só salvar — não precisa reiniciar nada aqui."]="Después solo guarda — no hace falta reiniciar nada aquí."
  ["Para o instalador fazer isso sozinho da próxima vez, rode"]="Para que el instalador haga esto solo la próxima vez, ejecuta"
  ["\`bash hostgator-setup-kit/install.sh\` de novo e informe o token de"]="\`bash hostgator-setup-kit/install.sh\` de nuevo e indica el token de"
  ["acesso quando ele perguntar (supabase.com/dashboard/account/tokens)."]="acceso cuando lo pida (supabase.com/dashboard/account/tokens)."

  # ── install.sh: pendencia_dos_emails_proprio() — Supabase self-hosted ───
  ["FALTA UM PASSO, no SEU Supabase"]="FALTA UN PASO, en TU Supabase"
  ["Os e-mails de acesso (confirmar cadastro e redefinir senha) ainda saem no"]="Los correos de acceso (confirmar registro y restablecer contraseña) todavía salen con la"
  ["modelo padrão do GoTrue. O link desse modelo NÃO fecha a sessão quando o"]="plantilla predeterminada de GoTrue. El enlace de esa plantilla NO cierra la sesión cuando el"
  ["clique vem do webmail — a conta é confirmada e a pessoa entra sem"]="clic viene del webmail — la cuenta se confirma y la persona entra sin"
  ["organização e sem menu."]="organización y sin menú."
  ["Como o seu Supabase é próprio, não há painel na nuvem nem API para isto:"]="Como tu Supabase es propio, no hay panel en la nube ni API para esto:"
  ["a configuração é por variável de ambiente do serviço \`auth\` (GoTrue)."]="la configuración es por variable de entorno del servicio \`auth\` (GoTrue)."
  ["Acrescente ao compose DELE — não a este:"]="Agrégalo al compose DE ÉL — no a este:"
  ["Tem de ser URL http(s)."]="Tiene que ser una URL http(s)."
  ["O GoTrue cola no fim do SITE_URL tudo o que não"]="GoTrue pega al final del SITE_URL todo lo que no"
  ["começa com \`http\` e busca por HTTP — um caminho de arquivo faz o cliente"]="empiece con \`http\` y lo busca por HTTP — una ruta de archivo hace que el cliente"
  ["receber a tela de login dentro do e-mail."]="reciba la pantalla de inicio de sesión dentro del correo."
  ["Depois reinicie só o auth do seu Supabase e confira aqui com:"]="Después reinicia solo el auth de tu Supabase y revísalo aquí con:"

  # ── install.sh: pendencia_da_ia() ────────────────────────────────────────
  ["A IA ainda não atende — falta cadastrar a chave"]="La IA todavía no atiende — falta registrar la clave"
  ["Você deixou a chave de IA para depois, e o CRM está no ar sem ela. O que"]="Dejaste la clave de IA para después, y el CRM está activo sin ella. Lo que"
  ["ainda não funciona é o agente: ele responde quando uma credencial existir."]="todavía no funciona es el agente: responderá en cuanto exista una credencial."
  ["Quando tiver a chave da {1}, cadastre em:"]="Cuando tengas la clave de {1}, regístrala en:"
  ["A chave fica CIFRADA no banco — não precisa mexer no .env nem reiniciar nada."]="La clave queda CIFRADA en la base de datos — no hace falta tocar el .env ni reiniciar nada."

  # ── install.sh: creación del admin, arranque de la stack, healthcheck ───
  ["✓ dono criado e promovido a super-admin"]="✓ dueño creado y promovido a super-admin"
  ["Não consegui promover o admin. Confira a service_role key, a URL e a connection string do Supabase.
     Este passo lê auth.users e escreve em public: num Supabase próprio ele precisa do dono do
     banco — declare SUPABASE_DB_ADMIN_URL e rode de novo."]="No pude promover al admin. Revisa la service_role key, la URL y la connection string de Supabase.
     Este paso lee auth.users y escribe en public: en un Supabase propio necesita ser el dueño de la
     base de datos — declara SUPABASE_DB_ADMIN_URL y vuelve a ejecutar esto."
  ["Colocando o CRM no ar"]="Poniendo el CRM en línea"
  ["Puxando a imagem e subindo os serviços"]="Descargando la imagen y levantando los servicios"
  ["⚠ Não consegui puxar todas as imagens do registro."]="⚠ No pude descargar todas las imágenes del registro."
  ["  Sigo assim mesmo: o que faltar é construído aqui (mais lento, mesmo resultado)."]="  Continúo de todas formas: lo que falte se construye aquí (más lento, mismo resultado)."
  ["Não coloquei o CRM no ar: nem as imagens prontas desta versão nem a construção aqui funcionaram. O erro está logo acima; para reproduzir só a construção: {1}"]="No pude poner el CRM en línea: ni las imágenes listas de esta versión ni la construcción local funcionaron. El error está justo arriba; para reproducir solo la construcción: {1}"
  ["✓ containers no ar"]="✓ contenedores en línea"
  ["  (as três imagens desta versão foram construídas aqui nesta VPS: as prontas"]="  (las tres imágenes de esta versión se construyeron aquí en esta VPS: las ya"
  ["   não servem para a arquitetura dela. É mais lento e não precisa de nada manual.)"]="   listas no sirven para su arquitectura. Es más lento y no requiere nada manual.)"
  ["Aguardando o app ficar saudável"]="Esperando a que la app esté saludable"
  ["✓ app no ar e saudável"]="✓ app en línea y saludable"
  ["⚠ os contêineres subiram, mas o app não respondeu que está saudável."]="⚠ los contenedores arrancaron, pero la app no respondió que está saludable."
  ["  última resposta: {1}"]="  última respuesta: {1}"
  ["Semeando o catálogo de modelos de IA"]="Sembrando el catálogo de modelos de IA"
  ["✓ catálogo de modelos semeado"]="✓ catálogo de modelos sembrado"
  ["⚠ não consegui semear o catálogo de modelos agora; o agendador tenta de novo às 04:15 UTC."]="⚠ no pude sembrar el catálogo de modelos ahora; el agendador lo vuelve a intentar a las 04:15 UTC."
  ["  detalhe: {1}"]="  detalle: {1}"
  ["Ativando as automações"]="Activando las automatizaciones"

  # ── install.sh: pantalla "quase lá" (app no respondió saludable todavía) ─
  ["Quase lá — falta o app responder"]="Ya casi — falta que la app responda"
  ["A configuração está salva e os contêineres estão no ar. Você NÃO precisa"]="La configuración está guardada y los contenedores están en línea. NO necesitas"
  ["refazer nada — falta o app dizer que está saudável."]="rehacer nada — falta que la app diga que está saludable."
  ["O motivo mais comum é uma chave faltando ou errada no .env. O log diz qual:"]="El motivo más común es una clave faltante o incorrecta en el .env. El log dice cuál:"
  ["procure por: [env] Falha de validação"]="busca: [env] Falha de validação"
  ["Diagnóstico completo dos serviços:"]="Diagnóstico completo de los servicios:"
  ["Depois de corrigir o .env, é só subir de novo (nada é perdido):"]="Después de corregir el .env, solo levántalo de nuevo (no se pierde nada):"
  ["Travou? Leve o log para a comunidade — tem gente que já passou por isso:"]="¿Se atascó? Lleva el log a la comunidad — hay gente que ya pasó por esto:"

  # ── install.sh: telemetria_no_banner() ───────────────────────────────────
  ["  Telemetria: DESLIGADA — nenhum relatório de erro sai desta instalação."]="  Telemetría: DESACTIVADA — ningún reporte de error sale de esta instalación."
  ["  Para ligar, apague a linha SENTRY_DSN do .env e rode: {1}"]="  Para activarla, borra la línea SENTRY_DSN del .env y ejecuta: {1}"
  ["  Telemetria: LIGADA — só relatórios de erro anonimizados vão ao Sentry do"]="  Telemetría: ACTIVADA — solo reportes de error anonimizados van al Sentry del"
  ["  projeto. Para desligar, ponha SENTRY_DSN='off' no .env e rode: {1}"]="  proyecto. Para desactivarla, pon SENTRY_DSN='off' en el .env y ejecuta: {1}"

  # ── install.sh: mensaje final "Instalación concluida" (DONE) ────────────
  ["Instalação concluída!"]="¡Instalación completada!"
  ["Acesse:"]="Entra en:"
  ["(o SSL leva ~1min pra emitir no primeiro acesso)"]="(el SSL tarda ~1min en emitirse en el primer acceso)"
  ["Faça login com:"]="Inicia sesión con:"
  ["e-mail:"]="correo:"
  ["senha:"]="contraseña:"
  ["(a que você definiu)"]="(la que definiste)"
  ["Conecte o WhatsApp (2º passo do onboarding):"]="Conecta WhatsApp (2.º paso de la configuración inicial):"
  ["Deixe o WhatsApp JÁ ABERTO em Configurações → Aparelhos conectados"]="Deja WhatsApp YA ABIERTO en Configuración → Dispositivos vinculados"
  ["antes de abrir a tela — o QR code vale só uns minutos. Se expirar,"]="antes de abrir la pantalla — el código QR dura solo unos minutos. Si expira,"
  ["o próprio CRM tem o botão \"Gerar novo QR Code\"."]="el propio CRM tiene el botón \"Generar nuevo código QR\"."
  ["A verificação em duas etapas é OPCIONAL: quem quiser liga em"]="La verificación en dos pasos es OPCIONAL: quien quiera la activa en"
  ["Configurações → Segurança (guarde os códigos de recuperação)."]="Configuración → Seguridad (guarda los códigos de recuperación)."
  ["Perdeu o celular?"]="¿Perdiste el celular?"
  ["A comunidade"]="La comunidad"
  ["É onde saem os avisos de versão nova, os agentes que outras pessoas já"]="Es donde salen los avisos de versión nueva, los agentes que otras personas ya"
  ["configuraram e a resposta de quem roda exatamente este CRM:"]="configuraron y la respuesta de quien corre exactamente este CRM:"
  ["Comandos úteis:"]="Comandos útiles:"
  ["ver logs:"]="ver logs:"
  ["reiniciar:"]="reiniciar:"
  ["atualizar:"]="actualizar:"
  ["backup:"]="backup:"
  ["trocar config:"]="cambiar config:"
  ["(mostra tudo o que você respondeu e deixa corrigir por número)"]="(muestra todo lo que respondiste y permite corregir por número)"
  ["recomeçar:"]="empezar de nuevo:"
  ["(derruba tudo; depois rode o install.sh de novo)"]="(derriba todo; después vuelve a ejecutar install.sh)"

  # ── install.sh: títulos de step() restantes ──────────────────────────────
  ["Verificando dependências"]="Verificando dependencias"
  ["Localizando o projeto"]="Localizando el proyecto"
  ["Configuração"]="Configuración"
  ["Gerando segredos"]="Generando secretos"
  ["Criando o primeiro admin ({1})"]="Creando el primer admin ({1})"
  ["Fase"]="Fase"
  ["Preparando o servidor"]="Preparando el servidor"
  ["Suas informações"]="Tu información"
  ["Banco de dados e domínio"]="Base de datos y dominio"
  ["conferindo"]="verificando"
  ["desconhecida"]="desconocida"
  ["anterior"]="anterior"
)
fi

# t <texto-modelo-em-pt-BR> [valor-de-{1}] [valor-de-{2}]…
# Devolve o texto pronto: em es quando IDIOMA_CLI=es E existe tradução na
# tabela; em pt-BR em qualquer outro caso — padrão do kit, e também a rede de
# segurança de uma mensagem nova ainda sem entrada na tabela (nunca uma tela
# em branco por falta de tradução).
#
# Os {N} são trocados em DUAS passadas: primeiro viram um marcador que texto
# nenhum contém, depois recebem o argumento. Numa passada só, um argumento que
# trouxesse "{2}" dentro (um caminho, uma URL, uma saída de comando) seria
# trocado de novo pelo segundo argumento.
# As atribuições abaixo NÃO levam aspas externas de propósito: em bash 4.2 as aspas
# internas do padrão e da substituição viram literais quando a expansão inteira está
# entre aspas (saía `("1")` em vez de `(x)`); numa atribuição não há separação de
# palavras, então as aspas externas nada protegiam. Chave vazia devolve vazio — em es,
# `_ES[""]` aborta o script com "bad array subscript".
t() {
  local chave="${1-}"; shift || true
  local texto="$chave"
  if [ -n "$chave" ] && [ "$IDIOMA_CLI" = "es" ] && [ "$_I18N_TABELA" = "1" ] && [ "${_ES[$chave]+isset}" = "isset" ]; then
    texto="${_ES[$chave]}"
  fi
  local i arg n=$#
  for ((i = 1; i <= n; i++)); do
    texto=${texto//"{$i}"/$'\x01'"$i"$'\x02'}
  done
  i=1
  for arg in "$@"; do
    texto=${texto//$'\x01'"$i"$'\x02'/"$arg"}
    i=$((i + 1))
  done
  printf '%s' "$texto"
}

# Lê DESKCOMM_IDIOMA_CLI de um .env SEM executá-lo (nunca `source`): só a linha
# exata da chave e só os dois valores válidos. Devolve 1 se não achar.
_i18n_idioma_do_env() {
  local arq="$1" linha val
  [ -f "$arq" ] || return 1
  # A ÚLTIMA ocorrência vence (é o que `load_env` faz) e um fim de linha CRLF não
  # invalida o valor.
  linha="$(grep -E '^DESKCOMM_IDIOMA_CLI=' "$arq" 2>/dev/null | tail -n 1)" || return 1
  [ -n "$linha" ] || return 1
  val="${linha#DESKCOMM_IDIOMA_CLI=}"; val="${val%$'\r'}"
  val="${val#\"}"; val="${val%\"}"; val="${val#\'}"; val="${val%\'}"
  case "$val" in
    pt-BR | es) printf '%s' "$val" ;;
    *) return 1 ;;
  esac
}

# Em bash sem a tabela (< 4.4) o espanhol não existe. Avisa, em português e em
# espanhol e no stderr, só a quem o pediu (variável ou .env) ou a quem seria
# perguntado; quem não pediu nada segue em português sem ruído novo.
_i18n_avisar_bash_antigo() {
  local pediu=0
  [ "${DESKCOMM_IDIOMA_CLI:-}" = "es" ] && pediu=1
  [ "$(_i18n_idioma_do_env ./.env || _i18n_idioma_do_env "${REPO_DIR:-deskcommcrm}/.env" || true)" = "es" ] && pediu=1
  if [ "${NONINTERACTIVE:-0}" != "1" ] && [ -t 0 ]; then pediu=1; fi
  [ "$pediu" = "1" ] || return 0
  printf '%s\n' "Aviso: bash ${BASH_VERSION%%[( ]*} — o espanhol exige bash 4.4 ou superior; a instalação segue em português." >&2
  printf '%s\n' "Aviso: el español requiere bash 4.4 o superior; la instalación seguirá en portugués." >&2
}

# Decide o idioma da CLI — o primeiro passo do install.sh, antes de qualquer
# outra saída, para o resto da instalação já nascer no idioma escolhido.
# Ordem, e a primeira que responder vence:
#   1. DESKCOMM_IDIOMA_CLI (pt-BR ou es) no ambiente — escolha explícita, também
#      para quem roda com --yes ou fora de terminal;
#   2. a linha guardada no .env de uma execução anterior (o da pasta atual ou o
#      de $REPO_DIR): a instalação NÃO pergunta de novo, e uma reexecução com
#      --yes mantém o idioma escolhido em vez de sobrescrevê-lo com pt-BR;
#   3. a pergunta, só se interativo (com --yes ou sem terminal, fica em pt-BR).
perguntar_idioma_cli() {
  local salvo=""
  if [ "$_I18N_TABELA" != "1" ]; then
    _i18n_avisar_bash_antigo
    IDIOMA_CLI=pt-BR
    return 0
  fi
  case "${DESKCOMM_IDIOMA_CLI:-}" in
    pt-BR | es) IDIOMA_CLI="$DESKCOMM_IDIOMA_CLI"; return 0 ;;
  esac
  salvo="$(_i18n_idioma_do_env ./.env || _i18n_idioma_do_env "${REPO_DIR:-deskcommcrm}/.env" || true)"
  if [ -n "$salvo" ]; then
    IDIOMA_CLI="$salvo"; export DESKCOMM_IDIOMA_CLI="$salvo"; return 0
  fi
  [ "${NONINTERACTIVE:-0}" = "1" ] && return 0
  [ -t 0 ] || return 0
  local resp
  printf '%s\n' "Idioma da instalação / Idioma de la instalación:"
  printf '%s\n' "  1) Português"
  printf '%s\n' "  2) Español"
  printf '%s' "Escolha 1 ou 2 (Enter = 1) / Elige 1 o 2 (Enter = 1): "
  read -r resp || resp=""
  case "$resp" in
    2 | es | Es | ES | español | Español) IDIOMA_CLI=es ;;
    *) IDIOMA_CLI=pt-BR ;;
  esac
  export DESKCOMM_IDIOMA_CLI="$IDIOMA_CLI"
}
