// Planificateur (toutes les 5 minutes, clé interne) : rien ne reste bloqué.
// Expiration des demandes, ouverture du contrôle 1 h avant, rappels, absences,
// fins non confirmées (« À vérifier »), nouvel essai des versements, publication des avis.
import { stripe, admin, json, serve, requireInternal, event, notify, notifyAdmins, transition } from "../_shared/clients.ts";
import { releasePayout } from "../_shared/payout.ts";

const H = 3_600_000, iso = (ms: number) => new Date(Date.now() + ms).toISOString();

async function openDossier(b: any, reason: string, desc: string) {
  if (!(await transition(b.id, [b.status], { status: "a_verifier" }))) return false;
  await admin.from("disputes").insert({ booking_id: b.id, opened_by: b.client_id, reason, description: desc, deadline: iso(3 * 24 * H) });
  await event(b.id, "a_verifier", null, reason);
  await notify(b.client_id, `${b.ref} : ${reason}. L'équipe Side by Side examine la situation.`, b.id, "litige");
  await notify(b.companion_id, `${b.ref} : ${reason}. L'équipe Side by Side examine la situation.`, b.id, "litige");
  await notifyAdmins(`À vérifier : ${b.ref} — ${reason}.`, b.id);
  return true;
}

serve(async (req) => {
  requireInternal(req);
  const n: Record<string, number> = {};
  const inc = (k: string) => (n[k] = (n[k] ?? 0) + 1);

  // 1. Demandes sans réponse 12 h avant le rendez-vous : expirées (créneau libéré)
  for (const b of (await admin.from("bookings").select("*").eq("status", "en_attente").lt("starts_at", iso(12 * H))).data ?? []) {
    if (await transition(b.id, ["en_attente"], { status: "expiree" })) {
      await event(b.id, "expiree", null, "sans réponse"); inc("demandes_expirees");
      await notify(b.client_id, `${b.ref} a expiré sans réponse. Aucun montant débité.`, b.id, "reservation");
    }
  }
  // 2. Acceptées mais non payées 2 h avant : expirées, paiement ouvert annulé, carte cadeau libérée
  const { data: st } = await admin.from("settings").select("payment_hold_hours").single();
  const holdLimit = iso(-(st?.payment_hold_hours ?? 24) * H);
  for (const b of (await admin.from("bookings").select("*").eq("status", "acceptee").or(`starts_at.lt.${iso(2 * H)},mission_signed_companion.lt.${holdLimit}`)).data ?? []) {
    if (await transition(b.id, ["acceptee"], { status: "expiree" })) {
      if (b.stripe_payment_intent_id) { try { await stripe.paymentIntents.cancel(b.stripe_payment_intent_id); } catch (_) { /* le webhook rembourse si payé entre-temps */ } }
      await admin.rpc("release_gift", { p_booking: b.id });
      await event(b.id, "expiree", null, "non payée"); inc("non_payees_expirees");
      await notify(b.client_id, `${b.ref} a expiré faute de paiement.`, b.id, "reservation");
      await notify(b.companion_id, `${b.ref} a expiré faute de paiement du client.`, b.id, "reservation");
    }
  }
  // 3. Une heure avant : contrôle préalable ouvert, chacun confirme sa présence
  for (const b of (await admin.from("bookings").select("*").eq("status", "confirmee").lt("starts_at", iso(H))).data ?? []) {
    if (await transition(b.id, ["confirmee"], { status: "controle" })) {
      await event(b.id, "controle", null, "contrôle préalable"); inc("controles_ouverts");
      for (const u of [b.client_id, b.companion_id]) await notify(u, `Rendez-vous ${b.ref} dans 1 h : confirmez votre présence.`, b.id, "rappel");
    }
  }
  // 4. Rappel 30 min avant à qui n'a pas confirmé
  for (const b of (await admin.from("bookings").select("*").eq("status", "controle").lt("starts_at", iso(30 * 60_000)).gt("starts_at", iso(25 * 60_000))).data ?? []) {
    if (!b.presence_client) await notify(b.client_id, `Rappel : confirmez votre présence pour ${b.ref}.`, b.id, "rappel");
    if (!b.presence_companion) await notify(b.companion_id, `Rappel : confirmez votre présence pour ${b.ref}.`, b.id, "rappel");
  }
  // 5. Rencontre non vérifiée 45 min après l'heure prévue : absence à vérifier
  for (const b of (await admin.from("bookings").select("*").eq("status", "controle").lt("starts_at", iso(-45 * 60_000))).data ?? [])
    if (await openDossier(b, "Absence ou rencontre non vérifiée", "Le code de rencontre n'a pas été validé 45 minutes après l'heure prévue.")) inc("absences");
  // 6. Fin non confirmée par les deux, 2 h après la fin prévue : « À vérifier »
  for (const b of (await admin.from("bookings").select("*").in("status", ["en_cours", "double_attente"]).lt("ends_at", iso(-2 * H))).data ?? [])
    if (await openDossier(b, "Fin de mission non confirmée par les deux parties", `Confirmations : client ${b.end_client ? "oui" : "non"}, accompagnateur ${b.end_companion ? "oui" : "non"}.`)) inc("fins_a_verifier");
  // 7. Versements en échec : nouvel essai (au plus 5)
  for (const b of (await admin.from("bookings").select("id, payout_attempts").eq("status", "terminee").is("stripe_transfer_id", null).lt("payout_attempts", 5)).data ?? [])
    if ((await releasePayout(b.id, null)).ok) inc("versements");
  // 8. Litiges dont le délai est dépassé : relance de l'équipe (une fois par jour)
  for (const d of (await admin.from("disputes").select("id, deadline, bookings(ref, id)").eq("status", "ouvert").lt("deadline", new Date().toISOString())).data ?? []) {
    const { count } = await admin.from("notifications").select("id", { count: "exact", head: true }).eq("kind", "relance").eq("booking_id", (d as any).bookings?.id).gt("created_at", iso(-24 * H));
    if (!count) { await notifyAdmins(`Délai dépassé pour le litige sur ${(d as any).bookings?.ref} : décision attendue.`, (d as any).bookings?.id, "relance"); inc("relances_litiges"); }
  }
  // 9. Avis à l'aveugle publiés après 14 jours même si l'autre partie n'a pas répondu
  const { data: rv } = await admin.from("reviews").update({ status: "moderation" }).eq("status", "aveugle").lt("created_at", iso(-14 * 24 * H)).select("id");
  n.avis_liberes = rv?.length ?? 0;
  // 10. Fiscalité DAC7 : consolidation au 1er janvier, contrôles et rappels avant le 31 janvier (aucune transmission automatique)
  const paris = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
  if (paris.getMonth() === 0) {
    const y = paris.getFullYear() - 1, d = paris.getDate(), tag = `fiscal-${y}-${paris.toISOString().slice(0, 10)}`;
    const { count: done } = await admin.from("audit_log").select("id", { count: "exact", head: true }).eq("action", tag);
    if (!done && [1, 8, 15, 22, 27, 29, 30, 31].includes(d)) {
      await admin.from("audit_log").insert({ action: tag, ref: `DAC7 ${y}` });
      const { data: S } = await admin.rpc("tax_year_summary", { p_year: y });
      const { data: decl } = await admin.from("tax_declarations").select("status").eq("year", y).in("status", ["transmise", "acceptee"]).limit(1);
      const missing = (S ?? []).filter((s: any) => !s.birth_date || !s.birth_city || !s.postal_address || !s.nif);
      if (d === 1 || d === 8 || d === 15) for (const s of missing) await notify(s.companion_id, `Informations fiscales ${y} incomplètes : complétez-les dans Revenus → Mes documents fiscaux.`, null, "fiscal");
      if (!decl?.length) await notifyAdmins(d === 1 ? `Revenus ${y} consolidés : ${(S ?? []).length} accompagnateur(s) à déclarer, ${missing.length} dossier(s) incomplet(s). Déclaration DAC7 à transmettre avant le 31 janvier.`
        : `Rappel DAC7 ${y} : déclaration non transmise, date limite le 31 janvier (${(S ?? []).length} accompagnateur(s), ${missing.length} dossier(s) incomplet(s)).`, null, "fiscal");
      inc("rappels_fiscaux");
    }
  }
  // 11. Nettoyage des compteurs de tentatives de plus de 7 jours
  await admin.from("rate_events").delete().lt("created_at", iso(-7 * 24 * H));
  return json({ ok: true, ...n });
});
