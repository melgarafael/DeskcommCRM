# Atualizar o curso com IA

`/deskcomm-curso` conduz a manutenção na sessão do Claude ou do Codex: lê mudanças, revisa
material, corrige seletores, captura o app real e prepara a publicação. O programa
`curso/planejar-atualizacao.ts` faz a triagem determinística; ele não chama modelos, não abre o
app e não publica. Não existe um daemon ou uma cobrança de IA adicional implícita.

**CONFIRMADO:** lições em `curso/licoes/*.json`, roteiros em `curso/demonstracoes/*.json`,
capturadores em `curso/capturar.ts` e `curso/capturar-jornadas.ts`, montagem em `curso/montar.ts`.
O site público pertence a **melgarafael/deskcomm-site**, em outro clone/PR. A fonte canônica da
skill fica em `.agents/skills/deskcomm-curso/`; `pnpm skills:sync` gera o espelho Claude.
`scripts/instalar-guias.sh` instala os guias `deskcomm-*` para Claude e Codex.

Chame **`/deskcomm-curso` no Claude Code** ou **`$deskcomm-curso` no Codex**, seguido do pedido
de atualização. Para disponibilizar o guia fora do clone, rode
`bash scripts/instalar-guias.sh --fonte .` na raiz e abra uma sessão nova do CLI. Ao desenvolver
o guia, esse `--fonte` evita que uma cópia global antiga prevaleça sobre a versão do projeto.

## 1. Escolher a fonte e planejar

Confira `git status`, o worktree e os remotos antes de mudar qualquer coisa. Atualize a branch
conforme a doutrina de `CLAUDE.md`, preservando alterações de outras sessões. Meça o commit da
fonte que o app realmente executará; não presuma que o servidor já aberto usa o checkout atual.
Uma árvore modificada exige registrar primeiro a fonte a ensinar: o plano compara **commits**,
não inclui alterações locais.

O recibo público versionado tem este contrato (os valores abaixo são exemplos, não publicação):

```json
{
  "versao": 1,
  "commit_fonte": "<SHA completo da fonte ensinada>",
  "idiomas": ["pt-BR", "es"],
  "publicado_em": "<data ISO real do deploy concluído>",
  "site_commit": "<SHA completo publicado no deskcomm-site>"
}
```

`curso/publicacao.json` só avança depois de conferir o deploy do site. Compare esse recibo com a
publicação efetiva antes de confiar nele; o planejador valida seu formato e histórico Git, não
consulta a hospedagem. A data de uma foto e uma tag de release não comprovam o último conteúdo
publicado. `package.json` tampouco é a versão do produto.

```bash
pnpm exec tsx curso/planejar-atualizacao.ts --help
pnpm exec tsx curso/planejar-atualizacao.ts --head HEAD --saida curso/saida/plano-atualizacao.json
```

Opções: `--head <ref>` escolhe a fonte; `--idioma pt-BR` / `--idioma es` podem se repetir;
`--base <ref>` fornece uma base manual. Sem idiomas, entram ambos. O JSON é o mesmo no arquivo
e na saída padrão. Não contém conteúdo dos arquivos, conexão, conta ou senha.

- `origem_base=publicacao_versionada`: o recibo está versionado em `head`, aponta para SHA
  existente e ancestral e inclui `site_commit` com SHA completo. Sem esse vínculo com o site,
  o recibo é incompleto e exige rodada completa, com motivo no plano. `base` e `head` são os
  SHAs completos efetivamente comparados.
- `origem_base=informada`: `--base` foi resolvido, mas não comprova publicação; exige revisão IA,
  mesmo com diff vazio. Base ou head explícitos inválidos e base não ancestral falham com exit 1.
- `modo=completa`: não há recibo/base anterior válida, o histórico necessário não está no clone
  ou falta publicação de algum idioma pedido. Todos os módulos/jornadas são candidatos. Sem
  base, `arquivos_alterados=[]` significa **sem intervalo**, não “nada mudou”. Um clone raso pode
  buscar o histórico necessário e executar o plano novamente; não invente a base.
- `modo=candidatos`: há aulas/jornadas para revisar; o recorte final é decidido pela IA depois
  do diff e da observação da interface.
- `modo=sem-recaptura`: não houve mudança visual diretamente mapeada entre os commits. Com base
  publicada conferida e sem pendências, preserve os assets e metadados; não fotografe de novo
  nem altere a data apenas para dizer que o curso foi atualizado.

**INFERIDO, explicitamente:** o mapa usa a rota de cada tela e das aulas, arquivos próprios de
lição/semente e referências declaradas nas jornadas. Não segue imports nem garante cobertura
exata. Componentes compartilhados, inclusive os guardados sob uma rota em `_components`,
bibliotecas, APIs, banco e qualquer arquivo sem mapa
selecionam revisão global e aparecem em `pendencias_nao_mapeadas`. Layouts de área alcançam os
módulos da área; a inferência local da rota só vale para suas entradas do framework. Uma pasta
de tela não prova que seus componentes só sejam consumidos ali. Testes, documentação e o recibo são classificados como sem efeito visual
**direto**; leia o diff deles para identificar uma mudança de contrato ou orientação que exija
revisão textual. Renomes consideram o caminho removido e o novo.

Leia o diff desde a base, os arquivos ligados aos candidatos e a interface real. Inclua
recurso novo, aula ausente ou jornada afetada mesmo que o catálogo antigo não os conheça.
Documente as decisões de alcance e as reduções do recorte em evidência pública sem dados de
cliente. Corrija as aulas e recalcule o plano depois de novo commit/merge que altere a fonte.

Os alvos traduzem os rótulos da interface. Um nome da semente pode coincidir com um desses
rótulos: o plano chamado `Profissional`, por exemplo, continua com esse nome em ES. Marque
esse alvo com `literal: true` para preservá-lo. O sinalizador também vale em `dentro`: um
botão `Salvar` continua sendo traduzido para `Guardar`, mesmo dentro do cartão literal do
plano. Não crie uma expressão regular artificial para escapar da tradução.

## 2. Preparar a bancada isolada

Use um worktree próprio, fora de `/tmp`, com Node 22 e `pnpm install --frozen-lockfile`.
`node_modules` deve ser real, não um symlink. Não copie `.env`/`.env.local` nem dados de um clone
de produção. Reserve `project_id` e portas exclusivos do Supabase em `supabase/config.toml` da
bancada; confirme que nenhum serviço ou worktree de outra sessão será usado ou interrompido.
Trabalhe em shell sem exportações de credenciais de produção.

Não abra, imprima ou copie valores de `.env*` ou de `curso/saida/contas.json`. Os scripts
existentes podem gerar e carregar a configuração de teste sem expor valores no chat. Não rode
`supabase status -o env/json` no terminal visível: esses formatos incluem chaves. Não aponte as
sementes ao banco de um cliente, mesmo que os dados do curso tenham identificadores próprios.

Em uma bancada **nova**, os scripts canônicos preparam Supabase/baseline e o ambiente de teste:

```bash
bash scripts/local-supabase.sh start
E2E_PORT=3460 pnpm e2e:env
pnpm e2e:build
pnpm exec tsx --env-file=.env.e2e scripts/bootstrap-owner.ts
```

O bootstrap usa somente o dono fictício gerado pelo ambiente E2E. O baseline é o mesmo artefato
que o self-hoster instala; não aplique a cadeia histórica de migrations para criar a bancada.
Em macOS/Docker, confirme que o caminho de rede usado pelo script alcança **esse** stack antes
de prosseguir; se o script falhar, corrija a bancada e repita, sem desviar para a nuvem.

Suba o app em outro terminal gerenciado da bancada, mantendo o processo disponível para captura:

```bash
node --env-file=.env.e2e node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3460
```

Os capturadores usam Chromium. Prepare-o com `pnpm exec playwright install chromium`; se já
existe Google Chrome nesta máquina, `CURSO_BROWSER_CHANNEL=chrome` usa esse navegador em um
contexto descartável, sem abrir o perfil pessoal.

Use `next start` com o build de teste, pois `NEXT_PUBLIC_*` entra no bundle no build.
**Mantenha worker e scheduler parados** nesta bancada: mensagens fictícias podem acordar a IA e
disparar efeitos externos. Não pare processos alheios. Quando um caso realmente precisar WAHA,
Redis ou receptor HTTP, use as dependências locais do harness documentado em `CLAUDE.md` e na
spec correspondente, com destinos fictícios. Não conecte um WhatsApp real só para completar foto.

## 3. Corrigir e capturar por idioma

Revise o comportamento observado antes de editar os textos: títulos, instruções, busca, dicas,
papéis, rótulos, ordem dos passos, seletores e o que é clicável. Siga a regra escrita do produto;
se ela não existir, registre a lacuna em vez de inventar uma. Corrija também os roteiros e as
traduções equivalentes no site. Um texto em ES não pode descrever um botão que só existe em PT.

`CURSO_IDIOMA=pt-BR|es` define o idioma real de seed/login/browser. `CURSO_SAIDA` separa manifestos
e fotos; contas de demonstração continuam privadas em `curso/saida/contas.json`. Nunca copie
as caixas medidas de PT para ES: tamanho de palavra, quebra de linha e menu alteram a geometria.
Confira o dicionário real do produto e os catálogos `curso/espanhol-demonstracao.json` e, quando
presente, `curso/espanhol-alvos.json`; frase fictícia nova também precisa de tradução explícita.

Exemplo de uma aula candidata, em espanhol, usando a API dos capturadores existentes:

```bash
CURSO_IDIOMA=es pnpm exec tsx --env-file=.env.e2e curso/semear-demonstracao.ts agenda
CURSO_IDIOMA=es CURSO_SAIDA=curso/saida/es CURSO_URL=http://127.0.0.1:3460 CURSO_ANTES_DA_LICAO='pnpm exec tsx --env-file=.env.e2e curso/semear-demonstracao.ts agenda' pnpm exec tsx --env-file=.env.e2e curso/capturar.ts agenda conhecendo-a-agenda
```

Confirme a versão **real do app fotografado** e defina `CURSO_VERSAO_FOTOS` antes das capturas;
o exemplo não fixa número para não ensinar uma versão velha. A fonte do app precisa corresponder
ao `head` aprovado, com procedência registrada. Defina `CURSO_COMMIT_FOTOS` com o SHA completo do
app executado; o padrão `HEAD` só é correto quando o build e o checkout correspondem. Uma variável
preenchida sem conferir o servidor não é prova. A versão de uma foto não vem automaticamente do
checkout do curso.

Para outro idioma, troque `CURSO_IDIOMA`; em PT a saída usual é `curso/saida`, em ES é
`curso/saida/es`. O segundo argumento opcional de `capturar.ts` limita uma aula; sem ele captura
o módulo. O comando de `CURSO_ANTES_DA_LICAO` é escrito pela sessão a partir de ids validados do
curso, nunca de texto não confiável. Ele restaura o estado antes de cada aula, sem mudar o idioma.

Jornadas relacionadas são uma captura própria, pois seus roteiros semeiam/evoluem o cenário:

A história `e-commerce-consultar-pedido` exige a fonte fictícia real de pedidos, preparada
por `curso/preparar-fonte-loja.ts` conforme [a reprodução das jornadas](../testing/curso-em-acao.md).
Use o Postgres **da bancada** em `SUPABASE_DB_URL`, um IPv4 LAN alcançável pelo app em
`CURSO_FONTE_HOST` e sua porta em `CURSO_FONTE_PORT`; preserve as guardas de destino e de
ownership do helper. A conexão deve existir na organização ativa antes da captura. As fontes
inoperantes das aulas de cadastro não substituem essa integração, nem comprovam uma consulta.

```bash
CURSO_IDIOMA=es CURSO_SAIDA=curso/saida/es CURSO_URL=http://127.0.0.1:3460 pnpm exec tsx --env-file=.env.e2e curso/capturar-jornadas.ts clinicas-primeira-consulta
```

O argumento pode selecionar o nicho ou a jornada. Execute apenas os candidatos confirmados;
sem argumento, a rodada é completa. Não trate roteiro demonstrativo como atendimento executado
pela IA: preserve a distinção do contrato `curso/jornada.ts` e diga quando a resposta foi semeada.

## 4. Retomar uma falha e validar

Falha em seletor, navegação, medição, screenshot ou gravação de manifesto mantém a captura
pendente. Mesmo que o arquivo anterior exista, ele não prova a tentativa atual. Não apague
`falhas` à mão, não copie foto PT para ES, não reescreva data/versão de foto antiga e não remova
uma aula para conseguir montar. Inspecione a tela do idioma afetado, corrija a causa, restaure
a semente e repita **a aula ou jornada inteira afetada**. Preserve as capturas concluídas e as
pendências de outros recortes. Se continuar bloqueado, informe idioma, aula/cena e causa.

Uma foto anterior só pode ser reutilizada com fonte identificável e revisão do intervalo que
comprove ausência de mudança na tela, nos dados relevantes e nas dependências compartilhadas.
Preserve sua data, versão e procedência originais. Sem essa prova, recapture o recorte; não
renomeie uma foto antiga como atual. Um idioma recém-adicionado sempre requer suas próprias fotos.

Depois da captura, monte cada idioma:

```bash
CURSO_IDIOMA=pt-BR CURSO_SAIDA=curso/saida CURSO_BASE=/curso/ pnpm exec tsx curso/montar.ts
CURSO_IDIOMA=es CURSO_SAIDA=curso/saida/es CURSO_BASE=/es/curso/ pnpm exec tsx curso/montar.ts
pnpm exec vitest run curso/atualizacao.test.ts
```

`montar.ts [modulos]` serve para validar um recorte. A publicação completa precisa conservar o
catálogo completo e suas referências, sem omitir jornadas que usam módulos não selecionados.
Não publique um índice parcial como curso completo. Confira as falhas do manifesto e a existência
de cada arquivo de foto referenciado, em cada idioma.

Abra a montagem e depois a integração do site no browser: leitura, simulador, busca, navegação,
jornadas e retorno para aulas, desktop e mobile. Confira posição das caixas/setas, alvo clicável,
idioma da imagem e do texto, carregamento e ausência de conteúdo PT sob páginas ES. Registre a
prova visual e a decisão sobre reuso em `evidence/<entrega>/`, sem credenciais ou dados reais.
`curl` e existência de arquivo não comprovam UX. Rode `pnpm typecheck`, `pnpm lint` e
`pnpm test:unit`; mudanças de UI exigem o E2E relevante e evidência visual conforme `CLAUDE.md`.
Se a correção alcançou schema/RLS, use também o gate de banco exigido pela doutrina.

## 5. Integrar e publicar

No clone do `deskcomm-site`, leia suas instruções e encontre os manifestos, traduções e assets
do curso. Preserve a equivalência de ids/rotas, inclua os arquivos ES próprios e complete o
conteúdo nos dois idiomas. Não crie fallback silencioso para PT; tradução ausente ou asset
faltante é pendência. Execute os checks do site e prove as páginas pela tela. Uma atualização de
tradução no site deve acompanhar a atualização da aula na fonte.

Depois de sincronizar o conteúdo canônico e concluir **todas** as capturas exigidas, rode no CRM:

```bash
pnpm exec tsx curso/exportar-capturas.ts --help
pnpm exec tsx curso/exportar-capturas.ts --idioma es --saida curso/saida/es --site /caminho/do/clone/deskcomm-site
```

O exportador lê os IDs de todos os módulos e jornadas locais, sem fixar uma contagem. Confere os
mesmos IDs no `public/curso/index.html` do site, mas **não altera esse HTML**: sincronizar texto
canônico é uma decisão da revisão. A exportação aceita somente ES, exige manifesto completo com
`falhas=[]`, dimensões, idioma, SHA, versão e datas válidos, inclusive em cada foto. Não inventa
procedência para um manifesto antigo. Fotos reaproveitadas podem preservar SHA/versão/data
anteriores, conforme a revisão de reuso; esses campos não são igualados aos metadados do topo.

Os JPEGs devem ser regulares, não vazios e permanecer dentro da origem; links e caminhos fora
de `capturas/<id>.jpg` são recusados. Os bytes, as medidas de destaques/cliques e os metadados
são preservados. Só o caminho público da foto muda para `/curso/capturas/es/<id>.jpg`.
São preparados exatamente estes destinos:

- `public/curso/capturas/es/<id>.jpg` — fotografias próprias ES;
- `conteudo/curso/es/capturas.json` — manifesto completo, com caminhos públicos absolutos.

A fonte fica intocada. Antes de gravar, o exportador valida o destino existente; uma pasta ES
anterior precisa corresponder ao seu manifesto e não pode conter arquivos alheios. A cópia é
preparada num stage isolado no clone do site e conferida por bytes. Mudanças concorrentes na
fonte, no catálogo do site ou no destino abortam a troca. Uma reserva `.curso-exportar-es.lock`
impede outra exportação simultânea; não remova a reserva de uma sessão ainda em execução.
Editor e Git não participam dessa reserva: a instalação de arquivos e a restauração usam criação
exclusiva, sem sobrescrever um caminho ocupado. Os backups são conferidos depois da tomada.

Se a preparação falhar, os artefatos públicos anteriores permanecem. Se a troca dos dois destinos
falhar, os backups são restaurados. Uma edição concorrente durante a instalação ou o rollback
preserva os bytes encontrados, stage, backups e reserva; a publicação fica bloqueada para
recuperação manual. Em falha também de restauração, os mesmos artefatos são mantidos e o erro
identifica a pasta dos backups. Interrompa a publicação, confira o estado dos dois
destinos e recupere esses backups antes de nova tentativa. Não apague arquivos alheios para
forçar a exportação. Depois de corrigir a causa, execute o mesmo comando novamente.

O resumo do comando não é prova de UX nem publicação. Revise o diff no clone do site, rode os
checks e a revisão visual. Não há commit, push, deploy ou reconstrução de fotos nesse comando.

Prepare PRs nos dois repositórios com fonte/base, idiomas, recorte, reuso justificado, falhas
resolvidas e links da evidência. Confira os checks obrigatórios reais, aguarde o resultado e
resolva as falhas. Siga a autorização de publicação já dada na sessão; se ela ainda não incluir
merge/deploy, deixe os PRs e previews prontos para revisão como último passo.

Depois do deploy aprovado, confira `/curso/` e `/es/curso/`, as imagens e uma aula/jornada
representativa pela tela, incluindo os pontos alterados. Só então avance `curso/publicacao.json`
em PR, com `commit_fonte` exato da fonte ensinada, idiomas efetivamente concluídos, data real e
`site_commit` publicado. O commit que grava o recibo vem depois da fonte e não exige recaptura
por si só. Não avance o recibo em captura parcial, preview não publicado ou tentativa falha.

Na entrega, diferencie fonte revisada, imagens recapturadas, imagens reutilizadas com prova e
publicação observada. Informe links dos PRs/site e qualquer impedimento concreto. Não declare
um número de aulas/fotos memorizado: conte os manifestos e arquivos desta rodada.
