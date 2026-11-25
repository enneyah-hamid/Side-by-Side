// Versement à l'accompagnateur : appelé par le planificateur (clé interne) ou par l'équipe (admin + MFA)
import { json, serve, requireAdmin, requireInternal, HttpError } from "../_shared/clients.ts";
import { releasePayout } from "../_shared/payout.ts";

serve(async (req) => {
  let actor: string | null = null;
  if (req.headers.get("x-internal-key")) requireInternal(req);
  else actor = (await requireAdmin(req)).id;
  const { booking_id } = await req.json();
  if (!booking_id) throw new HttpError(400, "Réservation manquante");
  return json(await releasePayout(booking_id, actor));
});
