# Escreve aí — espaço de trabalho

A entrada `/app` oferece uma conversa de leitura com o conteúdo do CRM. A barra lateral mantém Inbox, Funis, Agentes de IA, Contatos e Agenda conforme o perfil. Todas as ferramentas e a busca por teclado usam o catálogo existente; não há remoção de rotas.

## Contratos

`WorkspaceHome` chama `askWorkspace`, uma server action privada. O servidor deriva organização e papel da sessão, exige autenticação/MFA, bloqueia suporte somente leitura e aplica limite de dez perguntas por minuto por pessoa/organização. `loadWorkspaceContext` usa o cliente Supabase da sessão com RLS e filtro explícito da organização. Não usa service role para buscar conteúdo.

O recorte é declarado junto da resposta: até 20 conversas e 80 mensagens recentes, 30 oportunidades recentes, ou 12 trechos por palavras da pergunta entre 100 materiais com versão ativa. Conteúdos de Conhecimento exigem manager+. Contatos anonimizados e mensagens revogadas são excluídos da consulta de conversas. Não é uma busca semântica nem um censo de toda a operação.

A chamada passa por `runModelCall`, com orçamento e registro em `llm_calls` no propósito `workspace_question`. O modelo recebe dados como fontes não confiáveis, sem ferramentas de escrita ou envio. O servidor aceita apenas IDs de fontes consultadas e constrói os links. Não há alteração de lead, publicação de agente nem envio ao cliente.

A conversa fica apenas na sessão da tela; trocar de organização, papel, usuário ou recarregar reinicia o histórico. Uma falha mantém a pergunta para nova tentativa. A consulta vazia retorna uma mensagem explícita sem chamar o modelo.

## Interface

Geist substitui a fonte de interface e IBM Plex Mono permanece para dados técnicos. A casca tem tokens neutros locais, conserva o destaque da marca e respeita o branding personalizado. Ícones Lucide na navegação e GSAP para recolher a barra e entrar na tela. `prefers-reduced-motion` desliga os movimentos. O histórico e os controles continuam utilizáveis por teclado.

## Checklist do sistema vivo

- Entrada: catálogo de navegação e `/app`; sessão e RLS fornecem autoridade.
- Conexões: conversa → fontes do Inbox; oportunidade → Funis; material → Conhecimento.
- Observabilidade: `llm_calls` e registro de propósitos de IA; falhas visíveis e pergunta recuperável.
- Continuidade: a pessoa confere as fontes e segue pelos fluxos existentes; a IA não altera a operação.
- Pendências operacionais: não cria tarefas ou demandas; não há novo fluxo de handoff/expiração.
- Mapa: `docs/architecture/escreve-workspace.architecture.json`.

## Validação local

Testes cobrem permissões, escopo por organização, histórico, fontes inválidas, erros, navegação por teclado, temas, mobile e criação manual de agente. O provedor externo precisa de credencial válida para uma resposta gerada real; a suíte de unidade isola esse serviço, e não constitui prova de geração ao vivo.
