# O caminho por arquivo (para técnico ou agência) — o que existe hoje e o que não existe

## O que foi medido no código (setembro de 2026, v1.17.0)

- A chave de API (`dsk_…`, tela Configurações › Tokens de API) vale **só** na porta do MCP
  (`/api/mcp`). O MCP tem ações de operação (leads, mensagens, agenda, casos, memória), **nenhuma**
  de configuração: não cria agente, versão, roteador, follow-up, fonte de conhecimento nem
  credencial.
- Todas as rotas de configuração (`/api/v1/ai/**`, `/api/v1/pipelines/**`) exigem **sessão de admin
  por cookie** — a mesma que a tela usa — e recusam sessão sem o segundo fator quando a pessoa tem
  verificação em duas etapas ligada.
- Publicar um agente é uma função do banco que só o `service_role` executa, e que valida:
  credencial ativa e validada do mesmo provedor (ou chave da instalação, com uma flag explícita),
  número com status WORKING, modelo existente no catálogo e sem depreciação. Versão publicada é
  **imutável**.
- Fonte de conhecimento criada por SQL **nunca indexa**: a indexação nasce de um evento que só a
  rota emite, e precisa do worker de pé e da chave de embeddings.
- Credencial de IA não nasce por SQL: é cifrada com a chave da instalação (`AI_CRED_AES_KEY`) e só
  vira "validada" quando a validação em segundo plano roda.

Por isso o guia aplica **pela tela**. SQL serve para **ler** (auditar o que foi montado), não para
configurar.

## O que dá para fazer por arquivo hoje

- **Ler e conferir**: com a connection string do `.env` da instalação (`SUPABASE_DB_URL`), consultas
  agregadas mostram o que existe — agentes e versão publicada, roteadores e membros, fluxos ativos,
  fontes e status de indexação, memória publicada. O guia `deskcomm-metricas` traz consultas prontas.
- **Preparar o conteúdo**: todo o pacote (prompt, FAQ em pares, documentos, intenções, fluxos
  descritos) vive em arquivos que a pessoa cola nas telas. É o que este guia gera.
- **Importar skills do produto**: um `.zip` com `SKILL.md` (nome, descrição, palavras-chave) sobe
  em IA › Skills › Importar.

## O que NÃO existe (e é o próximo passo, se o mantenedor decidir)

Um script `pnpm cliente:montar <pacote.json>` que, rodando numa máquina com o repositório,
`node_modules` e um `.env` apontado para a instalação do cliente (service role), chame as mesmas
funções internas que a tela chama — criar funil e etapas com o mapa do agente, subir fontes e
emitir o evento de indexação, publicar memória, guardar credencial e esperar a validação, criar
agente e versão, publicar pela função do banco com a flag certa, criar roteador e membros,
publicar fluxos depois da validação semântica do grafo. O desenho existe (as funções estão
nomeadas na investigação de 10/set/2026 registrada em "Decisão Implementações/DEC-003"); a
implementação e a prova num Supabase local ficaram fora deste ciclo. Até lá, a resposta honesta
para "dá para automatizar?" é: **o conteúdo sim; a aplicação, pela tela**.
