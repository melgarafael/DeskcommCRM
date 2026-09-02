"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateTenant } from "@/hooks/useCreateTenant";
import { ApiError } from "@/lib/api/types";

// ---------------------------------------------------------------------------
// Schema (mirrors server Zod; client keeps it in sync)
// ---------------------------------------------------------------------------

const formSchema = z.object({
  display_name: z.string().min(2, "Mínimo 2 caracteres").max(120, "Máximo 120 caracteres"),
  slug: z
    .string()
    .min(2, "Mínimo 2 caracteres")
    .max(40, "Máximo 40 caracteres")
    .regex(/^[a-z0-9-]+$/, "Apenas letras minúsculas, números e hífens"),
  legal_name: z.string().min(2).max(255).optional().or(z.literal("")),
  nuit: z.string().optional().or(z.literal("")),
  plan: z.enum(["standard", "pro", "enterprise"]),
  owner_email: z.string().email("E-mail inválido"),
});

type FormValues = z.infer<typeof formSchema>;

// ---------------------------------------------------------------------------
// Slug helper
// ---------------------------------------------------------------------------

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// NUIT mask
// ---------------------------------------------------------------------------

function maskNuit(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 14);
  if (digits.length <= 2) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  if (digits.length <= 8)
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5)}`;
  if (digits.length <= 12)
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8)}`;
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

// ---------------------------------------------------------------------------
// Form component
// ---------------------------------------------------------------------------

export function NewTenantForm() {
  const router = useRouter();
  const createTenant = useCreateTenant();
  const [slugLocked, setSlugLocked] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      display_name: "",
      slug: "",
      legal_name: "",
      nuit: "",
      plan: "standard",
      owner_email: "",
    },
  });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = form;

  // Auto-generate slug from display_name until user edits slug manually
  const handleDisplayNameChange = (value: string) => {
    setValue("display_name", value);
    if (!slugLocked) {
      setValue("slug", slugify(value), { shouldValidate: true });
    }
  };

  const handleSlugChange = (value: string) => {
    const clean = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    setValue("slug", clean, { shouldValidate: true });
    setSlugLocked(clean.length > 0);
  };

  const handleNuitChange = (value: string) => {
    setValue("nuit", maskNuit(value));
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      const result = await createTenant.mutateAsync({
        display_name: values.display_name,
        slug: values.slug,
        legal_name: values.legal_name || undefined,
        nuit: values.nuit || undefined,
        plan: values.plan,
        owner_email: values.owner_email,
      });

      toast.success("Tenant criado com sucesso!");
      router.push(`/admin/tenants/${result.data.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "conflict") {
          form.setError("slug", { message: "Este slug já está em uso" });
          return;
        }
        toast.error(`Erro ao criar tenant: ${err.message}`);
      } else {
        toast.error("Erro inesperado ao criar tenant");
      }
    }
  });

  const planValue = watch("plan");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Novo Tenant</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Cria um novo tenant com status <em>onboarding</em>.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dados do tenant</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-5" noValidate>
            {/* display_name */}
            <div className="space-y-1.5">
              <Label htmlFor="display_name">
                Nome de exibição <span className="text-error-fg">*</span>
              </Label>
              <Input
                id="display_name"
                placeholder="Loja da Maria"
                {...register("display_name")}
                onChange={(e) => handleDisplayNameChange(e.target.value)}
                aria-invalid={!!errors.display_name}
              />
              {errors.display_name && (
                <p className="text-xs text-error-fg">{errors.display_name.message}</p>
              )}
            </div>

            {/* slug */}
            <div className="space-y-1.5">
              <Label htmlFor="slug">
                Slug <span className="text-error-fg">*</span>
              </Label>
              <Input
                id="slug"
                placeholder="loja-da-maria"
                {...register("slug")}
                onChange={(e) => handleSlugChange(e.target.value)}
                aria-invalid={!!errors.slug}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Apenas letras minúsculas, números e hífens. Gerado automaticamente.
              </p>
              {errors.slug && (
                <p className="text-xs text-error-fg">{errors.slug.message}</p>
              )}
            </div>

            {/* legal_name */}
            <div className="space-y-1.5">
              <Label htmlFor="legal_name">Razão social</Label>
              <Input
                id="legal_name"
                placeholder="Maria da Silva LTDA"
                {...register("legal_name")}
                aria-invalid={!!errors.legal_name}
              />
              {errors.legal_name && (
                <p className="text-xs text-error-fg">{errors.legal_name.message}</p>
              )}
            </div>

            {/* nuit */}
            <div className="space-y-1.5">
              <Label htmlFor="nuit">NUIT</Label>
              <Input
                id="nuit"
                placeholder="00.000.000/0000-00"
                {...register("nuit")}
                onChange={(e) => handleNuitChange(e.target.value)}
                inputMode="numeric"
                maxLength={18}
                aria-invalid={!!errors.nuit}
                className="font-mono"
              />
              {errors.nuit && (
                <p className="text-xs text-error-fg">{errors.nuit.message}</p>
              )}
            </div>

            {/* plan */}
            <div className="space-y-1.5">
              <Label htmlFor="plan">Plano</Label>
              <Select
                value={planValue}
                onValueChange={(v) =>
                  setValue("plan", v as "standard" | "pro" | "enterprise")
                }
              >
                <SelectTrigger id="plan" aria-label="Plano">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="pro">Pro</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
                </SelectContent>
              </Select>
              {errors.plan && (
                <p className="text-xs text-error-fg">{errors.plan.message}</p>
              )}
            </div>

            {/* owner_email */}
            <div className="space-y-1.5">
              <Label htmlFor="owner_email">
                E-mail do responsável <span className="text-error-fg">*</span>
              </Label>
              <Input
                id="owner_email"
                type="email"
                placeholder="responsavel@empresa.com"
                {...register("owner_email")}
                aria-invalid={!!errors.owner_email}
              />
              {errors.owner_email && (
                <p className="text-xs text-error-fg">{errors.owner_email.message}</p>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Criando..." : "Criar tenant"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.back()}
                disabled={isSubmitting}
              >
                Cancelar
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
