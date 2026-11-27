// Connexion de l'espace de gestion au serveur Side by Side (même projet Supabase que l'application).
// Clé PUBLIQUE uniquement : la sécurité est assurée par le serveur (rôles, double authentification, RLS).
// Ne jamais mettre ici la clé service_role ni une clé secrète.
window.SBS_CONFIG = {
  url: "https://xaogettvtlhfejnvmowk.supabase.co",
  key: "sb_publishable_n8hXjAPnzKKiBns6JxarVA_HVx8ZwXL",
  stripePk: ""
};
window.SBS_ADMIN_WEB = true;
