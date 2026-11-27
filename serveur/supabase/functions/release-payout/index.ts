// Versement à l'accompagnateur : appelé par le planificateur (clé interne) ou par l'équipe (admin + MFA)
import { json, serve, requireAdmin, requireInternal, requireStepUp, audit, HttpError } from "../_shared/clients.ts";
import { releasePayout } from "../_shared/payout.ts";

serve(async (req) => {
  let actor: string | null = null;
  if (req.headers.get("x-internal-key")) requireInternal(req);
  else { const me = await requireAdmin(req); requireStepUp(me); actor = me.id; }
  const { booking_id } = await req.json();
  if (!booking_id) throw new HttpError(400, "Réservation manquante");
  const r = await releasePayout(booking_id, actor);
  if (actor) await audit(actor, "Versement déclenché manuellement", booking_id);
  return json(r);
});
