# Módulo conectado — F6: atravessar a atualização — Plano de implementação

> **Para quem executa:** uma tarefa por commit, na ordem. Quem codifica não valida: o CI do GitHub é o juiz (nada de pnpm, vitest ou Docker local).

**Meta:** atualizar o CRM nunca depende de módulo conectado, e uma atualização que tire o pacote da faixa `host_api` suspende o módulo de forma visível e sem deixar o token vivo. O que um módulo alcança (áreas, rotas, formatos) vira contrato congelado: mudar de forma incompatível obriga a subir `host_api`.

**Arquitetura:** `autorizarModulo` reavalia `checkCompatibility` a cada chamada (sem cache) e recusa com `module_incompatible`; `/admin/extensoes` mostra o motivo; um teste de contrato compara o conjunto de áreas, as rotas por área e os schemas com um instantâneo versionado.

**Stack:** TypeScript, Vitest (só no CI), Zod existente.

**Spec:** `docs/specs/33-spec-modulo-conectado.md`, seção F6. Depende de F3 (`lib/auth/modulo-autorizado.ts`, `lib/auth/portas-de-token/areas.ts`) e F5 (`/admin/extensoes`, leitura de eventos).

## Medido (05/11, leitura do código na branch f6, topo `c68019a0e`)

- `checkCompatibility` (`lib/extensions/manifest.ts`) já é chamada em `instalada.ts` (lista de gestão e "desfazer"), `service.ts` (instalar, trocar, ativar) e `modulos-na-tela.ts` (o menu: módulo fora da faixa some). **`autorizarModulo` não chamava**: um token vivo continuava valendo depois de o CRM subir de `host_api`.
- `HOST_API_VERSION` era `const` não exportada (`manifest.ts`); passa a `export const` para os testes não copiarem o número.
- O embed do manifesto em `autorizarModulo` já existe, com a FK explícita `extension_installations_artifact_id_fkey`; a tela não precisa de consulta nova para o motivo: `/admin/extensoes` já lê o mesmo embed.
- `/admin/extensoes` não mostrava incompatibilidade nenhuma (só "Desligado nesta instalação" e o atraso).
- A leitura de eventos (`eventos-do-modulo.ts`, `prova-do-modulo.ts`, rota `events`) não consulta o manifesto nem `autorizarModulo`: **não** é bloqueada por incompatibilidade, o que preserva a decisão D2 do plano p10 (a LGPD não fica presa a uma atualização). Um teste agora vigia isso.
- Nenhum código de recusa de módulo está em `lib/extensions/erros-do-banco.ts`: as mensagens de `module_*` moram em `MENSAGEM_DA_RECUSA_DO_MODULO` (`modulo-autorizado.ts`), e é lá que o código novo entra.
- Fixtures de teste do manifesto em `modulo-autorizado.test.ts` não tinham `host_api`: precisam passar a ter, porque manifesto sem faixa legível agora recusa (lado seguro).

## Decisões

- **E1 — código próprio.** `module_incompatible` (403), só quando `checkCompatibility` diz que não. Manifesto sem faixa numérica ou sem lista de permissões é dúvida: `module_authorization_unavailable` (recusa, "nada foi feito"), nunca passa.
- **E2 — a ordem.** Perfil `connected` primeiro; depois compatibilidade; depois a interseção declarado ∩ consentido. Um módulo incompatível nunca vê o código de área.
- **E3 — eventos seguem lendo.** Declarado e vigiado por teste.
- **E4 — contrato por leitura de arquivo.** O instantâneo é derivado de `lib/extensions/areas.ts`, `lib/auth/portas-de-token/areas.ts` e do texto das rotas, sem banco e sem rodar nada. O que não é derivável sem executar fica declarado como não congelado.

## Tarefa 1: suspensão fora da faixa

**Files:** Modify `lib/auth/modulo-autorizado.ts`, `lib/extensions/manifest.ts` (exporta a constante), `app/admin/(protected)/extensoes/page.tsx`, `lib/i18n/dicionario.ts`, `lib/i18n/traducoes/en.json`, `lib/i18n/traducoes/tr.json`; testes em `lib/auth/modulo-autorizado.test.ts`, `lib/extensions/eventos-do-modulo.test.ts`, `app/admin/(protected)/extensoes/page.test.tsx`.

- [ ] Dentro da faixa passa; fora (acima ou abaixo) ⇒ `module_incompatible`; voltar à faixa volta a valer; manifesto ilegível ⇒ recusa; eventos continuam sem consultar a faixa.
- [ ] `/admin/extensoes` mostra, para módulo conectado suspenso, uma frase em português simples (faixa, ilegível, outro motivo), com `t()` literal e es/en/tr.
- [ ] Commit: `feat(modulo): token de modulo recusa fora da faixa host_api com codigo proprio (F6 T1)`.

## Tarefa 2: contrato congelado

**Files:** Create `tests/unit/modulo-contrato-congelado.test.ts`, `tests/unit/__contrato__/modulo-contrato.json`, `evidence/modulo-conectado-f6/declaracoes.md`, `.changes/modulo-conectado-atualizacao.md`.

- [ ] O conjunto de áreas e as 18 permissões `area.<área>.<leitura|escrita>`.
- [ ] Por área, a lista ordenada de `MÉTODO modelo-de-rota` alcançável por módulo, derivada de `areaDaPorta` varrendo `app/api/v1/**/route.ts`.
- [ ] Por rota liberada, o que é derivável sem rodar sobre schema Zod de corpo e resposta, com o que ficou sem congelar declarado.
- [ ] Reprova em português: "subir HOST_API_VERSION (lib/extensions/manifest.ts) e regenerar o instantâneo"; `UPDATE_CONTRATO=1` reescreve; sem script novo no `package.json`.
- [ ] Commit: `test(modulo): contrato congelado por area (F6 T2)`.

## Fora de escopo

Mudar o conteúdo de qualquer rota; congelar o formato de resposta de rota sem schema exportado; migrar módulo de uma faixa para outra (é do módulo).
