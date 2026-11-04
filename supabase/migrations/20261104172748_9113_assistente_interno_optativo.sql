-- manifest: Persistência pessoal isolada do piloto, sem contato/caso comercial.
CREATE TABLE IF NOT EXISTS public.personal_assistant_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 assistant_id text NOT NULL CHECK (assistant_id = 'internal-assistant'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,user_id,assistant_id),
 UNIQUE(id,organization_id,user_id,assistant_id)
);
CREATE TABLE IF NOT EXISTS public.personal_assistant_turns (
 id uuid PRIMARY KEY,
 session_id uuid NOT NULL,
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 assistant_id text NOT NULL,
 request_hash text NOT NULL,
 user_text text NOT NULL CHECK(length(user_text) BETWEEN 1 AND 4000),
 assistant_text text,
 status text NOT NULL CHECK(status IN ('reserved','completed','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '90 days',
 FOREIGN KEY(session_id,organization_id,user_id,assistant_id)
 REFERENCES public.personal_assistant_sessions(id,organization_id,user_id,assistant_id) ON DELETE CASCADE,
 CHECK((status='completed' AND assistant_text IS NOT NULL AND completed_at IS NOT NULL) OR status<>'completed')
);
CREATE UNIQUE INDEX IF NOT EXISTS personal_assistant_one_pending ON public.personal_assistant_turns(session_id) WHERE status='reserved';
CREATE INDEX IF NOT EXISTS personal_assistant_history ON public.personal_assistant_turns(session_id,created_at,id);
ALTER TABLE public.personal_assistant_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personal_assistant_turns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.personal_assistant_sessions,public.personal_assistant_turns FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.personal_assistant_sessions,public.personal_assistant_turns TO authenticated;
DROP POLICY IF EXISTS personal_assistant_owner ON public.personal_assistant_sessions;
CREATE POLICY personal_assistant_owner ON public.personal_assistant_sessions FOR SELECT TO authenticated USING (
 user_id=auth.uid() AND organization_id in (select public.fn_user_org_ids())
 AND EXISTS(SELECT 1 FROM public.user_organizations u JOIN public.organizations o ON o.id=u.organization_id WHERE u.organization_id=personal_assistant_sessions.organization_id AND u.user_id=auth.uid() AND u.accepted_at IS NOT NULL AND u.revoked_at IS NULL AND o.status='active')
 AND EXISTS(SELECT 1 FROM public.user_organizations u WHERE u.organization_id=personal_assistant_sessions.organization_id AND u.user_id=auth.uid() AND u.accepted_at IS NOT NULL AND u.revoked_at IS NULL)
);
DROP POLICY IF EXISTS personal_assistant_owner ON public.personal_assistant_turns;
CREATE POLICY personal_assistant_owner ON public.personal_assistant_turns FOR SELECT TO authenticated USING (
 user_id=auth.uid() AND expires_at>now()
 AND EXISTS(SELECT 1 FROM public.personal_assistant_sessions s WHERE s.id=personal_assistant_turns.session_id)
);
COMMENT ON TABLE public.personal_assistant_turns IS 'Histórico pessoal: 90 dias; reserva antes de inferência. Reservas incertas nunca repetem automaticamente. Escrita somente backend autorizado. Sem eventos de atendimento.';
NOTIFY pgrst,'reload schema';
