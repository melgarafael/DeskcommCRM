---
impacto: capacidade_nova
secao: adicionado
titulo: Empresas, pessoas, vínculos e números de voz aceitam token de integração
---

As rotas de empresas (cadastro, consulta de CNPJ e reenriquecimento), de pessoas, de vínculos entre empresa e pessoa e de números de voz passam a aceitar o token `dsk_…` de servidor, além da sessão de navegador. As leituras pedem o escopo `mcp:read` e as escritas pedem `mcp:write`, com o mesmo papel que a tela já exige. Cada chamada filtra a organização pela linha do token, e os ids de empresa, pessoa ou agente que vierem no corpo são conferidos na organização antes de gravar. Quem grava pelo token fica registrado na trilha sem autor humano, com o id do token.
