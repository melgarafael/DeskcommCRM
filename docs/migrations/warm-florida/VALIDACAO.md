# Validação da migração — 14/09/2026

## Extração, transformação e restauração

- Consultas somente de leitura na origem, com escopo do workspace autorizado e omissão de segredos.
- Backup restaurado em laboratório isolado: 177 tabelas conferidas por contagem e SHA256.
- Unificação dos dois contatos aprovada pelo proprietário, com ambos os IDs preservados. Históricos de conversas agrupados sem eliminar mensagens.
- Testes do extrator/transformação integrados ao Vitest. Controle negativo sem unificação reprovou como esperado.
- Artefato final ensaiado por completo com rollback, preservando FKs e sem criar eventos, jobs ou usuários.

## Banco e aplicação

- 65 testes de banco aprovados: schema, INSTALL/UPDATE, RLS, arquivo histórico e vocabulário.
- Suíte completa em Node 22: 792 arquivos aprovados; falhas nos 5 restantes corrigidas. Repetição dos 10 arquivos afetados: 75 testes aprovados.
- Typecheck e lint sem erros; build local de produção aprovado com Webpack. Três imagens amd64 construídas na VPS.
- E2E local aprovado: Inbox histórico, anexos disponíveis/indisponíveis, download autenticado, vínculo de tarefa e bloqueio de envio com 409 sem criar mensagem.
- Carga definitiva confirmada em produção. Repetição do mesmo artefato criou zero registros.
- Contagens após publicação: 3.089 contatos, 3.239 conversas, 60.448 mensagens, 1.610 tarefas, 30 compromissos, 108 notas, 5 negócios em USD (US$ 13.000), 134.982 registros de arquivo e 92.026 vínculos de contato.
- Storage privado: 7.927 objetos conferidos por download, SHA256 e tamanho; zero divergências.
- Login real, páginas de contato/histórico/tarefas e downloads autenticados verificados. A validação visual identificou timeout na lista/contadores; corrigido com 0245 e JIT desativado na API. Repetição final sem requisições de API falhas, contador 3.239 visível e sem aviso de erro; detalhes em [EXECUCAO.md](EXECUCAO.md).

## Limites preservados

- Captura não transacional, com corte final `2026-09-14T13:38:43.149Z`. Registros da captura anterior ausentes na final foram preservados no histórico.
- 628 referências de arquivo sem binário recuperável continuam marcadas como indisponíveis.
- Os nove membros de origem não receberam acesso. Canais importados são históricos e não enviam mensagens.
- Não houve sincronização contínua nem cutover dos canais do Warm.
- Evidência com dados pessoais permanece apenas em arquivos privados ignorados pelo Git.
