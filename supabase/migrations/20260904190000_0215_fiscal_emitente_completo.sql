-- ============================================================================
-- 0215 — FISCAL PARA VALER: emitente completo + ambiente + certificado
--
-- A 0213 nasceu mínima (série/natureza/CFOP) porque o único provedor era o
-- stub. O emissor real (sped-nfe via sidecar, `fiscal/sidecar/`) precisa de
-- MAIS: IE, regime tributário (CRT), endereço completo do emitente, ambiente
-- (homologação/produção) e ONDE está o certificado A1 + sua senha cifrada.
--
-- A senha usa a MESMA infra de cifra do resto do repo (`fn_encrypt_oauth` /
-- `fn_decrypt_oauth`, precedente Meta/Zernio em `lib/webhooks/secrets.ts`):
-- RPCs com GRANT só para service_role, chamadas com admin client. Nenhuma
-- função nova, nenhuma chave nova — e plaintext de senha nunca toca o banco.
--
-- `ambiente` CHECK fechado: só homologação ou produção. Produção sem
-- certificado é 422 na rota (não existe "emitir de verdade sem identidade").
-- ============================================================================

alter table public.fiscal_settings
  add column if not exists ie text,
  add column if not exists crt text not null default '1',
  add column if not exists logradouro text,
  add column if not exists numero_end text,
  add column if not exists bairro text,
  add column if not exists municipio text,
  add column if not exists uf text,
  add column if not exists cep text,
  add column if not exists ambiente text not null default 'homologacao',
  add column if not exists provedor text not null default 'stub',
  add column if not exists certificado_path text,
  add column if not exists certificado_senha_encrypted bytea;

alter table public.fiscal_settings
  drop constraint if exists fiscal_settings_ambiente_valido;

alter table public.fiscal_settings
  add constraint fiscal_settings_ambiente_valido
  check (ambiente in ('homologacao', 'producao'));

alter table public.fiscal_settings
  drop constraint if exists fiscal_settings_provedor_valido;

alter table public.fiscal_settings
  add constraint fiscal_settings_provedor_valido
  check (provedor in ('stub', 'spednfe'));

alter table public.fiscal_settings
  drop constraint if exists fiscal_settings_crt_valido;

alter table public.fiscal_settings
  add constraint fiscal_settings_crt_valido
  check (crt in ('1', '2', '3'));

alter table public.invoices
  add column if not exists protocolo text,
  add column if not exists sefaz_cstat text,
  add column if not exists sefaz_xmotivo text;

comment on column public.fiscal_settings.ambiente is
  'homologacao (default, seguro) ou producao. Produção sem certificado é 422 na rota.';
comment on column public.fiscal_settings.provedor is
  'stub (default, honesto sem emissor) ou spednfe (sidecar PHP em fiscal/sidecar/).';
comment on column public.fiscal_settings.certificado_path is
  'Caminho do .pfx A1 DENTRO do volume do sidecar (ex.: /certs/empresa.pfx). Nunca URL pública.';
comment on column public.fiscal_settings.certificado_senha_encrypted is
  'Senha do .pfx cifrada (mesma infra fn_encrypt_oauth). Plaintext nunca toca o banco.';
