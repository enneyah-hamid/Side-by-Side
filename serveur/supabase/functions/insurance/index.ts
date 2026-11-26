// Gestion des assurances responsabilité civile des accompagnateurs — réservé aux administrateurs
// (rôle admin + double authentification). Side by Side vérifie l'attestation d'un contrat personnel :
// la plateforme n'est pas assureur et ne fournit aucune garantie.
// Chaque consultation de justificatif, validation et refus est journalisé.
import { admin, json, serve, requireAdmin, audit, notify, notifyAdmins, HttpError } from "../_shared/clients.ts";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });   // AAAA-MM-JJ, heure de Paris
// État affiché : validée et en cours, expire bientôt (≤ 30 jours), expirée, en attente, refusée
export function stateOf(i: { status: string; ends_on: string; starts_on: string }, day = today()) {
  if (i.status === "validee" && i.ends_on < day) return "expiree";
  if (i.status === "validee") {
    const left = (Date.parse(i.ends_on) - Date.parse(day)) / 86_400_000;
    return left <= 30 ? "expire_bientot" : "valide";
  }
  return i.status;
}

serve(async (req) => {
  const me = await requireAdmin(req);
  const body = await req.json();
  switch (body.action) {
    case "list": {                                          // listes, recherche et filtres
      const { data, error } = await admin.from("companion_insurances")
        .select("id, companion_id, insurer, policy_number, starts_on, ends_on, status, refusal_reason, reviewed_at, created_at")
        .order("created_at", { ascending: false }).limit(1000);
      if (error) throw error;
      const ids = [...new Set((data ?? []).map((i: any) => i.companion_id))];
      const { data: ppl } = ids.length ? await admin.from("profiles").select("id, first_name, last_name").in("id", ids) : { data: [] };
      const who = new Map((ppl ?? []).map((p: any) => [p.id, `${p.first_name} ${p.last_name}`]));
      const q = String(body.q ?? "").trim().toLowerCase(), f = String(body.filter ?? "tous");
      const rows = (data ?? []).map((i: any) => ({ ...i, name: who.get(i.companion_id) ?? "", state: stateOf(i) }))
        .filter((i) => !q || `${i.name} ${i.insurer} ${i.policy_number}`.toLowerCase().includes(q))
        .filter((i) => f === "tous" || (f === "assures" ? ["valide", "expire_bientot"].includes(i.state) : f === "attente" ? i.state === "en_attente" : f === "expirees" ? i.state === "expiree" : f === "refusees" ? i.state === "refusee" : f === "bientot" ? i.state === "expire_bientot" : true));
      // Accompagnateurs vérifiés sans aucune attestation valide : non réservables
      const { data: comps } = await admin.from("companions").select("id, verified, profiles!companions_id_fkey(first_name, last_name)").eq("verified", true);
      const insured = new Set((data ?? []).filter((i: any) => ["valide", "expire_bientot"].includes(stateOf(i))).map((i: any) => i.companion_id));
      const uninsured = (comps ?? []).filter((c: any) => !insured.has(c.id)).map((c: any) => ({ companion_id: c.id, name: `${c.profiles?.first_name ?? ""} ${c.profiles?.last_name ?? ""}`.trim() }));
      const { data: affected } = await admin.rpc("insurance_affected_bookings");
      const { data: hist } = await admin.from("insurance_reviews").select("insurance_id, actor_id, decision, reason, created_at").order("created_at", { ascending: false }).limit(200);
      const { data: req0 } = await admin.from("settings").select("insurance_required").single();
      const all = (data ?? []).map((i: any) => stateOf(i));
      return json({ rows, uninsured, affected: affected ?? [], history: hist ?? [], required: req0?.insurance_required ?? true,
        counts: { assures: insured.size, attente: all.filter((s) => s === "en_attente").length, expirees: all.filter((s) => s === "expiree").length, bientot: all.filter((s) => s === "expire_bientot").length, sans: uninsured.length } });
    }
    case "doc": {                                           // consultation du justificatif : lien temporaire de 5 minutes
      const { data: i } = await admin.from("companion_insurances").select("id, doc_path, companion_id").eq("id", body.id).single();
      if (!i) throw new HttpError(404, "Attestation introuvable");
      const { data, error } = await admin.storage.from("insurance").createSignedUrl(i.doc_path, 300);
      if (error) throw new HttpError(404, "Justificatif introuvable");
      await admin.from("insurance_reviews").insert({ insurance_id: i.id, actor_id: me.id, decision: "consultation" });
      await audit(me.id, "Assurance : consultation d'un justificatif", i.id);
      return json({ url: data.signedUrl });
    }
    case "review": {                                        // validation ou refus motivé
      const approve = body.approve === true, reason = String(body.reason ?? "").trim();
      if (!approve && reason.length < 5) throw new HttpError(400, "Indiquez le motif du refus");
      const { data: i } = await admin.from("companion_insurances").update({ status: approve ? "validee" : "refusee", refusal_reason: approve ? null : reason.slice(0, 500), reviewed_by: me.id, reviewed_at: new Date().toISOString() })
        .eq("id", body.id).eq("status", "en_attente").select().single();
      if (!i) throw new HttpError(409, "Attestation déjà traitée ou introuvable");
      if (approve && i.ends_on < today()) {                // contrôle de cohérence : jamais valider une attestation expirée
        await admin.from("companion_insurances").update({ status: "expiree" }).eq("id", i.id);
        throw new HttpError(409, "Attestation expirée : validation impossible");
      }
      await admin.from("insurance_reviews").insert({ insurance_id: i.id, actor_id: me.id, decision: approve ? "validee" : "refusee", reason: approve ? null : reason.slice(0, 500) });
      await audit(me.id, `Assurance ${approve ? "validée" : "refusée"}${approve ? "" : ` : ${reason.slice(0, 120)}`}`, i.id);
      await notify(i.companion_id, approve
        ? `Votre attestation d'assurance (${i.insurer}) est validée jusqu'au ${i.ends_on.split("-").reverse().join("/")}. Vous pouvez recevoir des réservations.`
        : `Votre attestation d'assurance a été refusée : ${reason.slice(0, 200)}. Déposez une nouvelle attestation dans Profil → Mon assurance.`, null, "assurance");
      if (!approve) {
        const { data: aff } = await admin.rpc("insurance_affected_bookings");
        const mine = (aff ?? []).filter((b: any) => b.companion_id === i.companion_id);
        if (mine.length) await notifyAdmins(`Assurance refusée : ${mine.length} réservation(s) à venir de cet accompagnateur ne sont plus couvertes (${mine.map((b: any) => b.ref).join(", ")}).`, null, "assurance");
      }
      return json({ ok: true });
    }
    case "required": {                                      // obligation d'assurance (réglage de la direction)
      const on = body.on !== false;
      await admin.from("settings").update({ insurance_required: on }).eq("id", 1);
      await audit(me.id, `Assurance obligatoire pour réserver : ${on ? "activée" : "désactivée"}`);
      return json({ ok: true, required: on });
    }
    default: throw new HttpError(400, "Action inconnue");
  }
});
