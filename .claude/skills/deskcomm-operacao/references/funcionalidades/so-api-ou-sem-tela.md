# Funcionalidades — Só API ou sem tela

O que há aqui: o que só existe por rota, token, variável ou rotina.
Extraído do CHANGELOG até a 1.79.0 e conferido contra o menu e o código em 2026-10-10.
O menu e o código mandam sobre este arquivo; para ver o que mudou depois, use
`bash scripts/buscar.sh <palavra>` (a pasta é a da skill).

| Funcionalidade | Desde | O que se sabe | Evidência |
|---|---|---|---|
| Pedido de plataforma sem conector vira origem genérica | 1.79.0 | Pedido de Tray, Loja Integrada ou WooCommerce entra com origem `external`, id `<plataforma>:<id>` e plataforma no `payload`. Os conectores nativos não mudam. Quem alargou a restrição à mão: pedidos antigos são convertidos sozinhos, mas troque a ponte para gravar `external` ANTES de atualizar — depois, gravar o nome da plataforma é recusado e o pedido novo se perde. | supabase/migrations/20261009175100_0623_pedido_sem_conector_nativo_vira_origem_generica.sql:tabela orders |
| Teto de 36500 dias nos prazos | 1.79.0 | Os dois prazos do arquivo de webhooks com valor exagerado no `.env` não derrubam mais a poda: viram o teto, com aviso no log. | lib/retencao/politica.ts:RETENCAO_TETO_DIAS |
| Prazo de guarda da IA | 1.77.0 | Sete tabelas da IA entram na limpeza diária com prazo configurável por variável no .env. | lib/env.ts:AI_TELEMETRY_RETENTION_DAYS |
| Base de MCP externo | 1.77.0 | O agente pode chamar ferramentas de servidor MCP externo registrado; ainda sem tela. | app/actions/settings/definirServidorMcpExterno.ts |
| Passo IA decide por API | 1.74.0 | Passo que deixa a IA escolher entre opções da regra; ainda sem tela. | lib/automation/ai-decide-da-org.ts |
| Token configura agente | 1.74.0 | Token novo com permissão edita, testa, publica e pausa o agente sem abrir a tela. (Organização → API Tokens) | /app/settings/api-tokens |
| Análise do funil por API | 1.71.0 | Rota responde conversão por etapa, dias até fechar e ganho contra perda por origem. | app/api/v1/metrics/funil/route.ts |
| CA do Supabase no .env | 1.71.0 | Dá para declarar a CA do banco no .env; o diagnóstico testa o TLS. | hostgator-setup-kit/healthcheck.sh:SUPABASE_SSL_ROOT_CERT |
| Token administra fluxos | 1.70.0 | Token admin com papel gerencia follow-ups, agentes, prospecção e tipos de agenda. (Organização → API Tokens) | /app/settings/api-tokens |
| Supabase por endereço interno | 1.59.0 | Dá para declarar endereço só do servidor para falar com o banco pelo caminho curto. | lib/env.ts:SUPABASE_SERVER_URL |
| Canal oficial em servidor de teste | 1.55.0 | Variável aponta o canal oficial para servidor próprio para prova em tela. | lib/env.ts:META_GRAPH_BASE_URL |
| Agenda por período na ferramenta | 1.54.0 | A ferramenta de agenda lê até 62 dias com paginação no fuso da empresa. (Ferramenta crm_list_appointments) | app/api/v1/agenda/agendamentos/route.ts |
| Texto sugerido por integração | 1.52.0 | Integração cria rascunho que abre no campo de resposta para revisar e enviar. (com Idempotency-Key). (API → rascunho sugerido (aparece no Inbox)) | /app/inbox |
| Envio com idempotência e nome | 1.51.0 | Mensagem por API aceita chave e pode sair em nome do atendente via token. (POST /api/v1/messages + token) | app/api/v1/messages/route.ts |
| Respostas prontas na integração | 1.51.0 | API lista compartilhadas com variáveis; link abre o modelo direto na tela. (Respostas prontas: variáveis + link /app/templates?modelo=) | /app/templates |
| Janela fechada vira 422 | 1.51.0 | Texto fora da janela é recusado na hora; falha de entrega emite message.failed. (POST /api/v1/messages (canal oficial) + gatilho) | app/api/v1/messages/route.ts:janela_fechada |
| Lead e agenda por token | 1.48.0 | PATCH de lead e marcar agenda aceitam Bearer com escopo e papel de gerente. (Rotas de lead e agenda + token) | app/api/v1/leads/route.ts |
| Esforço de raciocínio OpenAI | 1.48.0 | Variável regula o raciocínio dos modelos OpenAI para responder mais rápido. | lib/env.ts:OPENAI_REASONING_EFFORT |
| URL própria do webhook Meta | 1.46.0 | Variável separa a URL pública do callback da Meta da URL do app. | lib/env.ts:META_WEBHOOK_BASE_URL |
| Rotas da comanda | 1.41.0 | API abre, lista, lança item, desconta, cancela, finaliza e estorna. (Rotas /api/v1/financeiro/comandas) | app/api/v1/financeiro/comandas/route.ts |
| DeepSeek sem pensar | 1.39.0 | Variável desliga o raciocínio interno para gastar menos e responder antes. | lib/agent-engine/env.ts:DEEPSEEK_THINKING |
| Criar empresa por sistema | 1.39.0 | Rota cria empresa, dona e chave com segredo da instalação; repete sem duplicar. (POST /api/v1/tenants/provision) | app/api/v1/tenants/provision/route.ts |
| Contato guarda ad_id | 1.37.0 | Origem guarda o id do anúncio e o negócio nascido o acompanha. (API de contatos → origem (ad_id)) | app/api/v1/contacts/[id]/hierarquia-do-anuncio/route.ts:ad_id |
| Landing do Google sem tela | 1.35.0 | Rota recebe clique, gera código e manda ao WhatsApp com origem carimbada. (Rota /api/v1/anuncios/google/[org]) | app/api/v1/anuncios/google/[org]/route.ts |
| Clonar funil por API | 1.31.0 | Rota clona para o destino com dados e conta a troca dos dois lados. (botão no quadro desde 1.48.0). (POST /api/v1/leads/[id]/clone (botão hoje no Kanban)) | app/api/v1/leads/[id]/clone/route.test.ts |
| Chave só para transcrever | 1.29.0 | Variáveis ligam transcrição em outro serviço sem trocar a conversa. | lib/env.ts:TRANSCRIPTION_API_KEY |
| Abrir conversa por integração | 1.25.0 | Capacidade cadastra, abre no número escolhido e manda a primeira. (API → iniciar conversa (token)) | lib/mcp/tools/start-conversation.test.ts |
| Token envia mensagem | 1.23.0 | Enviar e abrir conversa aceitam token; empresa sai do token. (POST /api/v1/messages (token)) | app/api/v1/messages/route.ts:dsk |
| Resposta rápida idempotente | 1.22.0 | Repetir criação com a chave devolve a primeira em vez de duplicar. (POST /api/v1/message-templates) | app/api/v1/message-templates/route.ts:Idempotency-Key |
| Nome próprio na OpenRouter | 1.4.0 | Variáveis opcionais assinam o consumo; vazio não envia nada junto. | lib/env.ts:OPENROUTER_APP_URL |
| RLS em toda tabela | 1.0.0 | Cada empresa só enxerga as próprias linhas em toda tabela do sistema. | supabase/baseline.sql:fn_user_org_ids |
| Servidor MCP da casa | 1.0.0 | Ferramentas internas conversam com o sistema por token próprio. (Servidor MCP /api/mcp) | app/api/mcp/route.ts |
