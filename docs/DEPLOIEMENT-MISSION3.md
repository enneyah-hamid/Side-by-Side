# Side by Side : mise en service de l'espace de gestion (mission 3)

Ce guide explique comment mettre en service la version 3.0 :
- l'espace de gestion sur https://sidebyside.zyntell.fr/gestion ;
- l'application mobile 3.0, avec l'assistance intégrée et sans administration ;
- les migrations 0010 à 0013.

**Les étapes 1 à 3 ne sont pas encore faites.** Elles attendent votre autorisation écrite. Claude les réalise pour vous une fois l'autorisation donnée. Vous n'avez rien à taper dans Supabase, sauf à l'étape 4.

L'ordre ci-dessous est obligatoire : la base de données d'abord, le code ensuite.

| Étape | Qui | Quand |
|---|---|---|
| 1. Sauvegarde de la production | Claude | juste avant l'étape 2 |
| 2. Migrations 0010 → 0013 | Claude, après votre autorisation | — |
| 3. Fusion de la branche `mission3-admin` dans `main` (déploiement automatique des fonctions serveur) | Claude, après votre autorisation | après l'étape 2 |
| 4. Création de l'adresse admin@zyntell.fr et du compte Supabase | Vous | quand la boîte existe |
| 5. Activation du super-administrateur | Claude (une ligne SQL) | après l'étape 4 |
| 6. Mise en ligne du site + /gestion chez Hostinger | Vous | après l'étape 3 |
| 7. Première connexion et double authentification | Vous | après les étapes 5 et 6 |
| 8. Clé de signature Android dans GitHub | Vous | avant de publier l'APK 3.0 |

---

## 1. Sauvegarde (avant toute modification)

Une sauvegarde logique de la production a été faite le 27/11/2026. Elle contient les profils, les réglages, les comptes et les espaces de stockage.

Elle sera refaite juste avant l'application. À ce jour, la production contient 1 profil (le vôtre), 0 administrateur et 0 réservation.

En complément, dans Supabase → **Database** → **Backups**, vous pouvez noter la date de la dernière sauvegarde automatique. La restauration à un instant précis (PITR) est une option payante : elle n'est pas activée et ne le sera pas sans votre accord.

## 2. Migrations 0010 → 0013

Les fichiers sont dans `serveur/supabase/migrations/`. Ils s'appliquent dans cet ordre :

| Migration | Contenu |
|---|---|
| 0010 | Fiscalité DAC7 |
| 0011 | Assurance RC des accompagnateurs et compléments fiscaux |
| 0012 | International (villes, langues, inscription) |
| 0013 | Administration sécurisée : comptes admin et super-admin, sessions de gestion, blocages, journal des connexions, journal inviolable, assistance, modération des photos, annonces, statistiques |

Elles sont **non destructives** : aucune table ni colonne supprimée, aucune donnée effacée. Elles ajoutent des tables, des colonnes, des fonctions et des règles d'accès.

Elles ont été vérifiées par une répétition sur une copie fidèle de la production (`tests/repetition_migrations.sh`, 14/14) :
- aucune ligne perdue ;
- contenu des données identique ;
- restauration complète vers l'état actuel ;
- ré-application possible ensuite.

**Restauration** (uniquement en cas de problème, dans l'ordre) :
1. `serveur/supabase/rollback/0013_down.sql` ramène à l'état 0012 ;
2. `serveur/supabase/rollback/0012_0011_0010_down.sql` ramène à l'état actuel (0009).

Attention : la restauration retire aussi les données créées entre-temps dans les nouvelles tables (demandes d'assistance, journal des connexions…).

## 3. Déploiement des fonctions serveur

La fusion dans `main` déclenche d'abord les tests automatiques, puis le déploiement (« Déployer le serveur »). Elle ne doit **jamais** précéder l'étape 2 : les nouvelles fonctions utilisent les tables de la 0013.

Rien à configurer :
- l'adresse https://sidebyside.zyntell.fr est autorisée dans le code ;
- les alertes de sécurité par e-mail utilisent Resend, s'il est déjà configuré (secret `RESEND_API_KEY`). Sinon, les alertes restent visibles dans l'espace de gestion. Aucun service payant n'est ajouté.

## 4. Votre action : l'adresse admin@zyntell.fr

1. Créez la boîte **admin@zyntell.fr** chez votre hébergeur de messagerie et vérifiez que vous recevez bien les e-mails.
2. Supabase → **Authentication** → **Users** → **Add user** → **Create new user** :
   - e-mail : `admin@zyntell.fr` ;
   - mot de passe : **au moins 14 caractères**, avec minuscules, majuscules, chiffres et symboles, jamais utilisé ailleurs ;
   - cochez **Auto Confirm User**.
3. Gardez ce mot de passe dans un gestionnaire de mots de passe. **Ne l'envoyez jamais dans la conversation** et ne le prenez pas en photo.
4. Prévenez Claude simplement : « admin@zyntell.fr est créé ».

## 5. Activation du super-administrateur (Claude)

Une seule commande, exécutée côté serveur : `select private.bootstrap_super_admin('admin@zyntell.fr');`

Elle ne fonctionne qu'une fois : elle refuse s'il existe déjà un super-administrateur ou si le compte est introuvable. Elle est inscrite au journal.

## 6. Hostinger : site + /gestion

1. hPanel → sidebyside.zyntell.fr → **Gestionnaire de fichiers** → dossier du site.
2. Importez `sidebyside-site-deploiement.zip`, puis faites clic droit → **Extraire** dans ce dossier, en remplaçant les fichiers existants. Supprimez ensuite le ZIP.
3. Vérifiez la présence de `gestion/index.html`, `gestion/app.js`, `gestion/config.js`, `gestion/vendor/supabase.js` et `gestion/.htaccess`. Pour voir `.htaccess` : **Paramètres** → **Afficher les fichiers cachés**.
4. Ouvrez https://sidebyside.zyntell.fr/gestion : la page « Espace de gestion » s'affiche.

Le fichier `gestion/.htaccess` impose :
- HTTPS et HSTS ;
- une politique de sécurité (CSP) stricte : scripts du site uniquement, connexions vers votre seul serveur Supabase ;
- aucune intégration dans un autre site ;
- `noindex` ;
- aucune mise en cache.

L'adresse /gestion n'est liée nulle part sur le site. **Ce n'est pas une protection** : la sécurité repose sur le serveur.

## 7. Première connexion

1. https://sidebyside.zyntell.fr/gestion → e-mail admin@zyntell.fr + mot de passe.
2. Écran « Activer la double authentification » : scannez le QR code avec **Google Authenticator** (ou une application équivalente), puis saisissez le code à 6 chiffres.
3. Les connexions suivantes demandent le mot de passe, puis le code.

Règles actives :
- déconnexion après **15 minutes** sans activité ;
- **nouveau code** demandé avant toute opération sensible : remboursement, suspension, décision de litige, réglages, gestion des admins, fiscalité, assurances ;
- **5 erreurs** = accès bloqué 15 minutes et alerte à l'équipe ;
- chaque connexion est journalisée, et une alerte est émise en cas de nouvel appareil.

### Ajouter un administrateur (super-administrateur uniquement)
Réglages → **Ajouter un administrateur**. Un mot de passe provisoire s'affiche **une seule fois** ; transmettez-le de vive voix.

Le nouvel administrateur :
- active sa double authentification ;
- choisit son propre mot de passe fort ;
- se reconnecte avec ce nouveau mot de passe.

Un administrateur simple ne peut ni modifier les réglages ni gérer l'équipe. Il ne peut pas non plus agir sur le super-administrateur.

### Téléphone perdu ou changé
- **Pour un administrateur** : le super-administrateur ouvre Réglages → équipe → **Réinitialiser la double authentification**. Au prochain accès, un nouveau QR code s'affiche.
- **Pour le super-administrateur** : Supabase → Authentication → Users → admin@zyntell.fr → supprimez le facteur MFA. Au prochain accès à /gestion, un nouveau QR code s'affiche.

Seul le propriétaire du compte Supabase peut faire cette opération : protégez ce compte avec sa propre double authentification.

### Mot de passe oublié
- **Pour un administrateur** : le super-administrateur lui retire l'accès, puis le recrée. Un nouveau mot de passe provisoire est alors fourni.
- **Pour le super-administrateur** : la procédure par e-mail (« Send password recovery » dans Supabase) n'a pas encore été testée de bout en bout. Elle sera vérifiée avec vous lors de l'activation.

## 8. Application Android 3.0 et signature

- L'identifiant **fr.zyntell.sidebyside** est inchangé. La version passe à 3.0.0, et le numéro de version augmente à chaque compilation.
- **Attention** : les secrets GitHub `ANDROID_KEYSTORE_B64` et `ANDROID_KEYSTORE_PASSWORD` **ne sont pas enregistrés** dans le dépôt. Les compilations, y compris celles de `main`, sont donc signées avec une clé temporaire.
- La clé permanente de Side by Side existe : SHA-256 `81:81:CF:67:…:FE:4F`. Elle est conservée hors du dépôt.
- Enregistrez ces deux secrets avant de diffuser l'APK 3.0 : GitHub → dépôt → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Le contenu des deux fichiers vous sera transmis par fichier, jamais dans la conversation.
- Un téléphone qui a installé un APK signé avec une clé temporaire devra désinstaller cette version une fois. Toutes les versions suivantes s'installeront ensuite par-dessus.
