# Side by Side — application mobile iOS et Android

Projet **Capacitor** : l'application Side by Side (dossier `src/app.html`) tourne dans une
application native iOS et Android, branchée sur le serveur Supabase (`www/config.js`).

## Ce qui est branché (lot 1)
- Inscription et connexion réelles (e-mail + mot de passe, activation par e-mail, mot de passe oublié)
- Profil créé automatiquement à l'inscription (client, accompagnateur, entreprise ; mineurs refusés)
- Accompagnateurs réels (seulement ceux vérifiés par l'équipe)
- Demande de réservation (prix calculé par le serveur), y compris pour un proche
- Accepter / refuser (accompagnateur), fiche de mission signée par les deux
- Messages en temps réel, annulation avec remboursement selon les règles
- Mise à jour automatique des écrans quand l'autre personne agit

Pas encore branché (lots suivants) : paiement Stripe, code de rencontre et début/fin de mission,
avis, pourboire, factures PDF, Privilège, cartes cadeaux, parrainage, expériences, comptes entreprise,
espace admin, vérification d'identité, SMS, notifications push, photos.
Ces fonctions restent masquées dans l'application tant qu'elles ne sont pas branchées.

## Compiler l'application (développeur)

Prérequis : Node.js 22, Android Studio (Android), Xcode sur Mac (iOS).

```bash
npm install
npm run build                 # prépare www/
npx cap add android           # une seule fois
npx cap add ios               # une seule fois (Mac)
npm run assets                # icônes et écran de démarrage depuis resources/
node scripts/android-permissions.mjs
npm run android               # ouvre Android Studio
npm run ios                   # ouvre Xcode
```
iOS : ajouter les textes d'autorisation de `docs/ios-Info.plist.txt`.

### Sans ordinateur de développement
Mettez ce dossier sur GitHub : le fichier `.github/workflows/build-android.yml` compile
automatiquement l'application Android (fichier .apk à installer sur un téléphone pour tester).

## Après chaque modification de l'application
Remplacer `src/app.html` par la nouvelle version, puis `npm run build && npx cap sync`.

## Identifiants
- Android : `fr.zyntell.sidebyside` · iOS (Bundle ID) : `fr.zyntell.sidebyside`
- Serveur : https://xaogettvtlhfejnvmowk.supabase.co (Paris)
