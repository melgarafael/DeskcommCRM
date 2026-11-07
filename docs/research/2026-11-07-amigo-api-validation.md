# Validação da integração Amigo API — 07/11/2026

A integração cobre os 22 contratos documentados e acrescenta seleção/vínculo explícito de pacientes. A área autenticada permite configurar a credencial, consultar catálogos e operar a agenda. Interface, ferramentas da IA e agenda existente usam a mesma fronteira de domínio.

A revisão independente encontrou oito pontos importantes: requisições antigas após trocar conta; fallback após falha de autenticação; desfechos externos recusados pelo banco; projeção que não se reparava; replay que poderia restaurar um estado antigo; gravação direta sobre a autoridade externa; leitura sem efeitos no CRM; ordem de chegada omitida em parte das saídas. Todos receberam correções e verificações específicas. Também foi corrigida a limpeza de opções de oferta e verificado o funcionamento da agenda local antes de provisionar o módulo opcional.

Evidências locais:

- Suíte combinada de contratos, domínio, interface, ferramentas, escopo, lembretes e governança: 942 testes aprovados em 42 arquivos. Uma verificação adicional cobre recuperação dos efeitos no CRM sem duplicação, inclusive ao retornar a um estado anterior.
- Invariantes da persistência: 15 provas transacionais aprovadas antes de provisionar o módulo; testes de autoridade, publicação Google e desfechos externos exercitados novamente após aplicar as migrações locais.
- Prova contra o banco real com dados fictícios: a projeção repetida mantém o identificador e o registro único; cancelamento se reflete localmente; registros de teste removidos ao final.
- Typecheck focado na integração: aprovado. Typecheck do repositório inteiro excedeu o limite de memória; não foi declarado como aprovado. Build de produção não executado.
- ESLint da integração e alterações de domínio: aprovado. A agenda original possui dois avisos anteriores, identificados também na versão base.

As migrações foram aplicadas somente ao Supabase local `deskcomm-clinicas-local`. Não foram alterados os volumes de outros projetos. O aplicativo respondeu em `http://127.0.0.1:3100`.

Limites da prova: o navegador está na tela de login, portanto a jornada visual autenticada permanece pendente. Acesso nativo ao computador não estava permitido. Não houve chamada autenticada para uma conta Amigo real nem inferência com modelo real; as credenciais podem ser cadastradas posteriormente na aplicação. Os testes de transporte usam respostas fictícias dos contratos oficiais, sem enviar dados de pacientes reais.

O worker foi validado também sob Node/tsx e iniciou com `healthz` HTTP 200. Os marcadores `server-only` permanecem nos módulos de credencial; somente o processo de worker recebe uma configuração de resolução própria. A aplicação web conserva sua proteção de importação no cliente. O sincronizador contínuo local não foi iniciado: a revisão automática exige autorização específica para essa ativação futura. A rota de atualização manual e o agendamento distribuído com o sistema estão implementados.

A suíte shell completa foi executada e parou em `hostgator-setup-kit/test-validators.sh`, com falhas de nome com apóstrofo e `release_env[@]: unbound variable`. O diretório do instalador e esse teste estão idênticos à versão base (`git diff HEAD -- hostgator-setup-kit` vazio); não foram alterados para a integração. Os testes específicos do scheduler passaram. As etapas posteriores da cadeia completa não foram declaradas aprovadas.
