-- =====================================================================
-- Side by Side — 0007 : statuts manquants du cahier des charges
-- « À vérifier » (déclarations divergentes ou manquantes) et « Incident ».
-- À appliquer seule, avant 0008 (PostgreSQL exige que les nouvelles valeurs
-- soient enregistrées avant d'être utilisées).
-- =====================================================================
alter type booking_status add value if not exists 'a_verifier';
alter type booking_status add value if not exists 'incident';
