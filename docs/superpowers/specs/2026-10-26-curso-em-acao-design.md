# Deskcomm em ação — jornadas visuais no curso

**Estado:** aprovado pelo dono em 26/10/2026 ("Pode seguir com isso"). As decisões de apresentação abaixo seguem a recomendação aprovada. Destino: infraestrutura de ensino; não altera o núcleo nem instala extensão nas organizações.

## Objetivo e público

Quem já instalou consegue mostrar a um cliente como um atendimento caminha da primeira mensagem até uma ação concreta e a continuidade pela equipe. Cada história tem contexto de negócio, telas do produto e explicação do benefício, além de um caminho para aprender a configurar.

## Decisões adotadas

- Entrada permanente **Deskcomm em ação** no menu e na abertura do curso existente.
- Dez nichos: clínicas, e-commerce, imobiliárias, seguros, consórcio, infoprodutos, advocacia, contabilidade, escolas/cursos e oficinas/assistência técnica. Três histórias específicas por nicho.
- Dois modos: **Apresentar ao cliente** (uma cena de cada vez, linha do tempo, avançar/voltar, teclado, tela cheia e link direto) e **Entender a montagem** (recursos, requisitos e links para lições existentes).
- O curso continua estático, sem login, sem depender da VPS ou de uma chamada de IA ao ser apresentado. Apresentação por cenas, sem reprodução automática nem duração comercial prometida.
- Cada cena distingue **O cliente**, **Na operação** e **Por que ajuda**. Empresas, pessoas, mensagens, valores e prazos do exemplo são fictícios; não são regras padrão do sistema.
- Usar fotos reais do produto e anotações medidas. Uma história encenada é identificada como **Roteiro demonstrativo**; somente execução observada do motor com provedor real recebe esse nome. Não confundir foto real, roteiro e prova da IA.
- Pilotos de validação: marcação de consulta, consulta de pedido, suporte de infoproduto com passagem à equipe. Dados externos exigem integração configurada; decisões clínicas, jurídicas, fiscais, de crédito e de cobertura são atribuídas à pessoa responsável.

## Contrato e arquitetura

`curso/jornada.ts` valida o conteúdo; `curso/demonstracoes/*.json` guarda um arquivo por nicho. Nicho: `id`, `titulo`, `resumo`, `jornadas`. Jornada: `id`, `titulo`, `empresa`, `contexto`, `resultado`, `tipo` (`roteiro-demonstrativo` ou `execucao-observada`), `nota`, `dependencias` (texto), `montagem` (array de `{modulo, licao, porque}`), `cenas` (array de `{id, titulo, cliente, operacao, valor, captura}`). `captura` é uma chave do manifesto `curso/saida/capturas.json`, nunca HTML nem URL externa.

O montador carrega e valida os nichos, referências às lições, unicidade dos ids e fotos existentes. Inclui só as capturas referenciadas pelo conteúdo montado. O renderizador de jornadas vive em `curso/site/demonstracoes.js` e recebe as utilidades do curso por uma interface pequena; não duplica a geometria/SVG nem altera as rotas existentes. Novas rotas por hash: `#acao`, `#acao.<nicho>`, `#demo.<nicho>.<jornada>.<cena>` e `#montagem.<nicho>.<jornada>`.

## Restrições globais

- Preservar todas as lições existentes, seus hashes, busca, simulador, zoom e progresso.
- Não adicionar dependências de runtime nem rotas/tabelas ao produto.
- Conteúdo privado, contas, sessões, tokens e dados de clientes nunca entram nos assets públicos.
- Nunca executar a semente destrutiva contra hg-vps. Ela só aceita banco local na bancada vps-teste.
- hg-vps / organização Deskcomm Admin foi autorizada para acesso à configuração de IA; chaves ficam opacas e nenhum cliente real recebe mensagem.
- Foto real não prova uma ação de IA. Roteiros e integrações externas devem ser nomeados com precisão.
- Usar PT-BR claro e identidade visual do curso, com contraste, foco visível, celular e redução de movimento.

## Aceite

Todos os dez nichos têm três histórias completas e links válidos para montagem. Cada cena tem foto existente e explica contexto, ação e benefício sem prometer resultado comercial. Apresentação funciona por mouse, teclado, link direto e celular; voltar e sair restauram a navegação. A busca encontra nichos e histórias. O montador recusa foto ou lição ausente. Pilotos são reproduzidos na bancada e a evidência declara exatamente o que foi medido (incluindo o par agente/ferramenta quando houver ação por IA). Prova visual do curso gerado e publicado, com imagens decodificadas e sem erros de navegador.
