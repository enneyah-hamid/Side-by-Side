# Sources de la version 3.0

`python3 build30.py` (depuis ce dossier) produit :

- `compagnon.html` → à copier dans `src/app.html` (application mobile et démonstration, **sans** administration) ;
- `gestion_build/` (index.html, app.js, config.js) → à copier dans `gestion/` ; avec `gestion/vendor/supabase.js`, c'est l'espace de gestion publié sur https://sidebyside.zyntell.fr/gestion.

Fichiers :

- `base_v29.html` : application v2.9 complète (base inchangée) ;
- `v30_mobile.js` : assistance intégrée (« Mes demandes d'assistance »), photos réelles des accompagnateurs, refus de tout accès administrateur dans l'application ;
- `v30_admin.js` : espace de gestion (connexion mot de passe + TOTP, rubriques, confirmation par code pour les opérations sensibles, inactivité 15 min).
