# Mission 3 : administration Side by Side, rapport final

Date : 27 novembre 2026. Branche GitHub : `mission3-admin`. Elle n'est pas encore fusionnée dans `main`.

## Verdict

**L'administration n'est PAS encore en production**, et elle ne doit pas être déclarée prête. Trois points bloquants dépendent de vous :

1. Votre autorisation d'appliquer les migrations 0010 à 0013 en production (anomalie A2), puis de fusionner la branche.
2. La création de l'adresse admin@zyntell.fr, puis l'activation du super-administrateur (anomalie A1).
3. La mise en ligne chez Hostinger, avec un test réel de /gestion en HTTPS : le fichier `.htaccess` ne peut pas être exécuté ici.

Toutes les exigences de sécurité critiques sont développées et testées automatiquement : 184/184 tests sur un vrai serveur Supabase de test.

## 1. Ce qui a été livré

### Espace de gestion web : https://sidebyside.zyntell.fr/gestion

Il reprend le design de l'application et ses fonctions existantes. Il est entièrement branché sur les données réelles du serveur et organisé en 9 rubriques :

| Rubrique | Contenu |
|---|---|
| Tableau de bord | Compteurs réels, sans plafond de 50 ; accès à la gestion des assurances RC et à la fiscalité DAC7 |
| Comptes | Recherche, filtres, fiche complète, suspension et réactivation motivées |
| Vérifications | Identités (refus motivé obligatoire), profils, dossiers administratifs (SIRET, statut), photos des accompagnateurs |
| Réservations | Liste, détail, remboursement |
| Finances | Voir le détail ci-dessous |
| Litiges | Décisions motivées |
| Assistance | Toutes les demandes envoyées depuis l'application, réponses, statuts |
| Journal | Actions de l'équipe et connexions à l'espace de gestion |
| Réglages | Tarifs et règles (super-administrateur, avec trace avant/après), équipe des administrateurs, annonces |

La rubrique Finances donne :
- l'encaissé, les remboursements, les versements et les pourboires ;
- les frais de service (15 %) et la TVA ;
- les commissions (20 % des prestations terminées) ;
- le chiffre d'affaires et les fonds détenus ;
- un graphique sur 12 mois et une répartition par ville ;
- les transactions et un export.

Les montants sont calculés par le serveur à partir du grand livre. Le test M15 vérifie que l'encaissé affiché est identique au grand livre et que les commissions valent 20 %.

### Application mobile 3.0

- **Aucun accès administrateur.** Le lien « Accès administrateur » est retiré. Un compte administrateur qui se connecte dans l'application est refusé, sans QR code, sans tableau de bord et sans appel aux fonctions d'administration.
- **Assistance intégrée** : Mon compte → Aide → « Mes demandes d'assistance ».
  - Clients et accompagnateurs choisissent une catégorie (réservation, paiement, compte, sécurité, accompagnateur…), suivent le statut et échangent avec l'équipe.
  - Le nombre de demandes est limité contre les abus.
  - L'équipe est notifiée.
- **Assistance par e-mail** : contact@zyntell.fr est conservé.
- **Photos des accompagnateurs** : réelles, modérées par l'équipe avant d'être visibles des clients.
- **Contrat et CGU** : l'assurance RC est désormais **obligatoire**. Sans attestation validée, l'accompagnateur ne reçoit aucune réservation. Le même texte figure sur le site vitrine (CGU et FAQ).
- **Identifiants préservés** : l'identifiant `fr.zyntell.sidebyside` est inchangé ; la version passe à 3.0.0. L'APK est compilé avec succès dans GitHub (voir la réserve sur la signature, section 4).

## 2. Anomalies de l'audit

| N° | Anomalie | État |
|---|---|---|
| A1 | Aucun compte admin en production | **Prêt, en attente** : procédure de super-administrateur pour admin@zyntell.fr, à activer après la création de la boîte |
| A2 | Migrations 0010-0012 non appliquées | **En attente de votre autorisation**. 0010-0013 testées, non destructives, restauration prévue |
| A3 | Administration dans l'application mobile | Corrigé : retirée de l'application, espace web /gestion |
| A4 | Dossiers administratifs impossibles à valider | Corrigé (rubrique Vérifications) |
| A5 | Photos non modérées | Corrigé : chaque nouvelle photo attend une validation humaine |
| A6 | Pas de réactivation de compte | Corrigé : suspension et réactivation depuis la fiche, motif obligatoire, nouveau code TOTP exigé |
| A7 | Compteurs plafonnés à 50 | Corrigé : comptage par le serveur |
| A8 | Paramètres non modifiables | Corrigé : super-administrateur, valeurs bornées, journalisées avant/après |
| A9 | Refus d'identité sans motif | Corrigé : motif obligatoire, côté serveur |
| A10 | Bloc en double dans Réglages | Corrigé : Réglages entièrement refaits pour l'équipe |
| A11 | Assurance RC « recommandée » | Corrigé : « obligatoire » dans le contrat, les CGU et le site |

## 3. Sécurité

| N° | Exigence | État | Preuve (tests ; « M » = série administration de integration.mjs) |
|---|---|---|---|
| S1 | Déconnexion après 15 min d'inactivité | Fait : contrôle côté serveur, avertissement à 14 min | M09, G35-G36 |
| S2 | Nouveau code avant les opérations sensibles | Fait (5 min) : remboursement, suspension, litige, réglages, admins, fiscalité, assurances | M08, G45 |
| S3 | Blocage après échecs | Fait : 5 échecs, blocage de 15 min, alerte à 3 échecs | M03, M05, G06 |
| S4 | Journal des connexions | Fait : connexions, échecs, blocages, nouveaux appareils, déconnexions | M04, M09, M22 |
| S5 | Alertes | Fait : notifications à l'équipe, et e-mail si Resend est actif | M03 |
| S6 | Récupération du compte | Procédure écrite (guide, étape 7). Récupération par e-mail du super-administrateur à vérifier lors de l'activation | — |
| S7 | Mot de passe fort | Fait pour l'équipe : 14 caractères, 4 types, vérification des mots de passe divulgués (Have I Been Pwned), changement obligatoire du mot de passe provisoire, reconnexion ensuite. **Reste** : la protection Supabase pour les membres est réservée à l'offre payante, non souscrite | M21, G40-G41 |
| S8 | HTTPS et en-têtes | Préparé (`gestion/.htaccess`, CSP stricte, testée avec la vraie bibliothèque). **À vérifier en ligne** | Site G4, test de fumée |
| S9 | CORS | Fait : l'origine sidebyside.zyntell.fr est autorisée, les imitations sont refusées | C06-C07 |
| S10 | Journal inviolable | Fait : modification et suppression refusées, même avec la clé serveur | M11 |
| S11 | Super-administrateur | Fait : un seul super-administrateur ; protégé contre les autres admins ; seul à gérer l'équipe et les réglages | M06-M07, G38 |
| S12 | Clé interne à temps constant | Fait | — |

Autres points de sécurité :
- **Droits vérifiés côté serveur**, à chaque appel. Un client ou un accompagnateur n'obtient aucune donnée d'administration, même en appelant directement les API (M10).
- **Aucun secret** dans le navigateur ou l'application : seule la clé publique est présente (test site G5).
- **Bibliothèque Supabase auto-hébergée**, en version figée, avec son empreinte SHA-256.
- **Aucun mot de passe** dans les journaux (M22).
- **Une tentative ratée d'un membre** sur /gestion ne déconnecte plus son application. Ce défaut a été trouvé par les tests, puis corrigé.

## 4. Points restants (à connaître)

1. **Signature Android** : les secrets `ANDROID_KEYSTORE_B64` et `ANDROID_KEYSTORE_PASSWORD` ne sont pas dans GitHub. Les APK actuels, y compris ceux de `main`, sont signés avec une clé temporaire. Ajoutez-les avant de diffuser la 3.0 (guide, étape 8).
2. **Tests sur appareil réel** : **non réalisés**. Les tests ont été faits dans des navigateurs automatisés (390 à 1920 px) et en compilation Android, pas sur un téléphone.
3. **`.htaccess`** : il n'est pas exécuté ici. Ses règles ont été reproduites sur un serveur local pour le test de la CSP. À vérifier après la mise en ligne.
4. **Fonctions serveur actuellement en production** : elles attendent déjà la migration 0012 (A2). Le déploiement de la 3.0 doit suivre l'application des migrations, jamais la précéder.
5. **Aucun service payant ajouté.** La restauration à un instant précis (PITR) et la protection des mots de passe divulgués pour les membres sont des options payantes, non activées.

## 5. Résultats des tests

| Série | Résultat |
|---|---|
| Serveur Supabase de test (GitHub) : sécurité, paiements, concurrence, administration M01-M24, fiscalité, RGPD | **184/184** |
| Tests unitaires serveur : déclaration DAC7, e-mails, CORS | 10/10, 6/6, 7/7 |
| Base de données (0011, 0012, 0013) | 34/34, 19/19, 46/46 |
| Répétition des migrations sur une copie de la production, avec restauration | 14/14 |
| Espace de gestion (navigateur) | 46/46 |
| Application mobile 3.0 (assistance, refus admin, photos, contrat) | 11/11 |
| Non-régression de l'application | v29 démo 53/53, connecté 22/22, assurance/fiscalité 35/35, démo 5/5, sécurité connectée 16/16, DAC7 4/4, t5 20/20, t7 17/17, durée 9/9, navigation 11/11, chronologie 0 anomalie, chevauchements 0, onglets OK |
| Site vitrine | 49/49, W3C sans erreur |
| Compilation Android | Réussie (versionName 3.0.0) |

Les tests de l'ancienne administration intégrée à l'application ont été remplacés par des tests qui vérifient son absence. Les fonctions correspondantes sont testées dans l'espace de gestion et sur le serveur.

## 6. Livrables

- `SideBySide-v3.0-mission3.zip` : sources complètes du dépôt (application, espace de gestion, serveur, migrations, scripts de restauration, tests, documentation), sans aucune clé.
- `sidebyside-site-deploiement.zip` : à extraire chez Hostinger (site + /gestion).
- `sidebyside-site-source.zip` : sources du site vitrine.
- `docs/DEPLOIEMENT-MISSION3.md` : guide de mise en service (Supabase, Hostinger, super-administrateur, récupération, Android).
