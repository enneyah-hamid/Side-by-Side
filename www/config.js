// Connexion au serveur Side by Side (Supabase, région Paris).
// Cette clé « publishable » est faite pour être dans l'application : la sécurité est assurée par le serveur.
// Ne jamais mettre ici la clé service_role ni une clé Stripe secrète.
window.SBS_CONFIG = {
  url: "https://xaogettvtlhfejnvmowk.supabase.co",
  key: "sb_publishable_n8hXjAPnzKKiBns6JxarVA_HVx8ZwXL",
  // Clé PUBLIQUE Stripe (pk_test_… puis pk_live_…) : à renseigner quand le compte Stripe est ouvert.
  // Ne jamais mettre ici une clé secrète (sk_…).
  stripePk: ""
};
