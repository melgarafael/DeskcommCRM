---
impacto: capacidade_nova
secao: adicionado
titulo: Contatos, empresas, pessoas, vínculos e números de voz aceitam token de integração
---

As rotas de contatos passam a aceitar o token `dsk_…` de servidor, além da sessão de navegador: a ficha, a edição, as etiquetas de contato, a timeline, o resumo do CRM, as compras, a carteira (leitura), os roteiros, as propostas de dado, os vínculos, o pessoal, o sempre humano, mesclar, duplicados, importar planilha e agenda, e o lote. Cada uma pede `mcp:read` para ler e `mcp:write` para escrever, com o papel que a tela já exige.

Excluir contato, mudar a carteira, ler a pessoa do contato e desfazer o vínculo entre empresa e pessoa continuam só pela sessão.

As rotas de empresas (cadastro, consulta de CNPJ e reenriquecimento), de pessoas, de vínculos entre empresa e pessoa e de números de voz passam a aceitar o token `dsk_…` de servidor, além da sessão de navegador. As leituras pedem o escopo `mcp:read` e as escritas pedem `mcp:write`, com o mesmo papel que a tela já exige. Cada chamada filtra a organização pela linha do token, e os ids de empresa, pessoa ou agente que vierem no corpo são conferidos na organização antes de gravar. Quem grava pelo token fica registrado na trilha sem autor humano, com o id do token.

Contribuição de @paulolimajr77 (Spec 33, fatia 2 de 9).
