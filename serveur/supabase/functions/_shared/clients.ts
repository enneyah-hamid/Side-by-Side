// Clients partagés par toutes les fonctions serveur Side by Side
import Stripe from "npm:stripe@14.25.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

export const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "cle-stripe-a-configurer", { apiVersion: "2024-06-20" });   // la clé se règle dans les secrets Supabase

// Client « service » : contourne la RLS, uniquement côté serveur
export const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

export const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "null",   // jamais « * » : seul le site Side by Side peut appeler le serveur
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Identifie l'utilisateur à partir de son jeton de connexion Supabase
export async function currentUser(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new Error("Non connecté");
  const { data: profile } = await admin.from("profiles").select("*").eq("id", data.user.id).single();
  if (!profile || profile.suspended) throw new Error("Compte indisponible");
  return profile;
}

export async function event(bookingId: string, status: string | null, actor: string | null, note?: string) {
  await admin.from("booking_events").insert({ booking_id: bookingId, status, actor, note });
}

export const cents = (eur: number) => Math.round(eur * 100);
