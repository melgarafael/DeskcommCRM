# Integração de hold, restauração, idiomas e curso — 26/10/2026

**Destino:** núcleo para a correção do hold e a infraestrutura comum de idiomas;
infraestrutura e documentação para restauração, curso e CI. Nenhuma especialização de
marketplace ou identidade visual nova. A decisão do documento 198 mantém o turco em
construção; o documento 207 autoriza o diff herdado (+62/−1) do invariante de #2327, mantendo
os cinco casos e onze asserções antigos. O documento 109 preserva a régua de minor,
com aviso ao operador quando `exige_acao` for verdadeiro.

## Proveniência

Base da integração: `028b40c118af6346c759186a40a67bdcf3748b63` (main, release 1.90.0).
Os quatro heads foram incorporados por merge, sem conflito, preservando os commits
e a autoria. As worktrees de origem não foram alteradas.

| Contribuição | Crédito | Head incorporado |
|---|---|---|
| #3370 — leitor de catálogo e turco em construção | @nusretbayindir-stack (Agenterix) | `0d175e3fdc654d00883fb513646fa8e8e18b8148` |
| #3447 — conferir arquivos antes do restore | @samirhvbr | `680677f4cae18b24898a9575180006de901051b7` |
| #3467 — curso de configurações e administração | @melgarafael | `115fe34f89efc993973d3aff35b313457630d481` |
| #2327 — hold do número e retomada dos retornos automáticos | @Sandersono | `22e4211718e1890e8123733aa36a7885de6e4eeb` |

Somente os reparos de CI `5399f824c` e `b6e97ab6b` entraram por cherry-pick,
respectivamente `cd30f887e` e `aaa0b85fb`. A árvore de produto do lote #3462 não foi
importada. O nativo do Supabase é tentado primeiro; quatro tentativas, backoffs,
pino, pipefail, falhas fechadas, tetos e agregadores foram preservados. Apenas
`navegacao.spec.ts` passa da parte 2 para a 7; o multiconjunto das 204 specs declaradas
e a lista de exclusões são idênticos aos da base.

## Alteração própria e prova de integração

`d93feb40b` corrige somente `curso/montar.ts`: fotos antigas não podem permitir a
montagem de um módulo cuja rodada de captura registrou falha. O guard reconhece
falhas de captura e de revogação nos módulos selecionados, preserva a montagem
parcial e aceita manifestos legados sem o campo `falhas`. O erro não repete o texto
capturado; identifica os módulos e para antes de escrever o HTML.

A falha foi reproduzida antes: manifesto sintético com foto existente e falha do
módulo selecionado produzia exit 0 e sobrescrevia o índice. Depois da correção,
seis cenários de CLI passaram: captura falha e revogação falha recusadas com índice
intacto; falha fora da seleção, manifesto legado e lista vazia aceitos; foto ausente
continua recusada. Só foram criadas fixtures na saída ignorada da worktree nova;
elas foram removidas após a prova. Nenhum site foi publicado.

| Medição local dirigida | Árvore/escopo | Resultado |
|---|---|---|
| Contratos do curso + guardas de CI | Depois dos três primeiros merges e do guard, antes de #2327 | 77 + 46 casos, sete arquivos, um worker, PASS em 8,01 s |
| Testes modificados do turco | Mesma combinação de três fontes | 117 casos, nove arquivos, um worker, PASS em 33,91 s |
| Hold + costura dos idiomas | `e7bf13dec35e7a6aa6e0c19a3bce15004380b1ee`, depois dos quatro merges | 62 casos em cinco arquivos, um worker, PASS em 31,38 s |
| Restore com gzip/tar reais e Docker/psql de mentira | Script e testes idênticos ao head #3447 | 63 verificações PASS; nenhum Docker real iniciado |
| Lint do delta próprio, sintaxe Bash e diff | `curso/montar.ts`, restore e integração | PASS |
| Fragmentos de release | Quatro contribuições mais os fragmentos já presentes na base | `release:conferir` PASS, régua minor, sem escrever release |

Os 62 casos da última rodada incluem os 32 testes de unidade do hold e
as guardas da costura de catálogo/espanhol. Há sobreposição entre rodadas; os números
não são somados como se fossem casos distintos. O código principal do hold, o
baseline, a migration 0793 e o invariante autorizado foram comparados por conteúdo
e estão idênticos ao head #2327. Não houve edição adicional de invariantes.

## Provas anteriores e limites

**Prova anterior, atribuída ao head #2327 `22e4211718`:** a coordenação mediu 53 casos
de banco, 32 de unidade, typecheck, lint e build, além da jornada visual e do
verificador de primeiro envio. Essas medições não foram repetidas nesta integração.
A migration `20261026151500_0793_go_live_solta_numero_formado_na_atualizacao.sql` e
seu apêndice no baseline chegam intactos; o novo CI deve provar a aplicação e a
reaplicação da combinação final.

As falhas E2E dos candidatos anteriores ocorreram no preparo de imagens ou no
orçamento, antes de uma prova completa da combinação. Os reparos de CI não substituem
o resultado dos cinco checks obrigatórios do novo head. Não se rodaram Docker,
banco, build do CRM, E2E local ou a suíte de governança inteira nesta worktree.

A leitura de segurança do curso não encontrou credenciais reais nos padrões de alta
confiança aplicados às fontes; os literais de conexão encontrados são fixtures dos
testes. O inventário confirma 61 módulos, 259 lições e 1.097 passos. Os relatos de
leitura/visuais de `ACHADOS` continuam hipóteses ou observações sem reprodução
independente; não se publicam detalhes de exploração nem se afirmam vulnerabilidades
atuais a partir deles. A conferência visual do curso é acompanhada pela coordenação;
esta integração não declara ter fotografado todos os passos novamente.

Logs dirigidos e a prova CLI ficaram na bancada local da revisão. Não há env,
credencial, dump de cliente ou captura real nova neste registro.

## Retomada do CI — dublê do claim (#3481)

No head `366b9ef88`, o `verify-parte (5)` da execução `40376293326` falhou no
caminho feliz de `cliente-que-falha-nao-volta-ao-pool.test.ts`. Não era flake:
o dublê devolvia o job somente quando a consulta continha `with dedup`, mas o
hold passou a abrir o SQL com `with para_reter`. A consulta real executava;
o dublê escolhia a resposta vazia. A reprodução local confirmou 1 falha e 11
casos verdes, com o mesmo `[]` onde se esperava `[{ id: 'job-1' }]`.

O reparo identifica a escrita que muda o job para `running` e cobra os parâmetros
`[2, 'w1']`, preservando as asserções do job retornado, commit e release sem erro.
Não muda SQL, schema, hold nem invariantes. Após o ajuste, sete arquivos dirigidos
passaram: 46 casos em 13,75 s, com um worker, incluindo os dois contratos de
liberação de cliente, claim/hold, watchdog, pre-go-live, aritmética de infinito e
cerca do preparo Supabase. ESLint do teste e `git diff --check` passaram.

Na fotografia anterior ao reparo, `build-and-size`, `invariants`, `e2e` e
`imagens-ok` estavam verdes no GitHub; só `verify` estava vermelho. Essa prova
pertence ao head anterior e não substitui os cinco checks do novo head. Não foram
executados typecheck, build, Docker, banco ou E2E local nesta retomada.
