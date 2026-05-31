# Protocole de test Homebridge Tydom local et fallback

Ce protocole permet de tester une version locale de `homebridge-tydom` dans un Homebridge isolé, sans impacter une installation Homebridge principale. Il couvre deux scénarios principaux : connexion directe à la box Tydom locale, puis fallback du host distant vers le host local.

## Objectifs

- Vérifier que le plugin compilé depuis ce dépôt est bien chargé par Homebridge.
- Vérifier que la connexion locale à la box Tydom fonctionne avec `hostname` pointant vers l'IP locale.
- Vérifier que `localHostname` est utilisé quand `hostname` est indisponible.
- Vérifier que le plugin retente ensuite le `hostname` distant et rebascule dessus lorsqu'il redevient disponible.
- Observer les logs de bascule et les éventuelles limites liées au certificat TLS local.

## Pré-requis

- Node.js compatible avec le projet : Node 20, 22 ou 24 recommandé.
- `pnpm` disponible directement, via `npm`, ou via Corepack.
- Une box Tydom joignable depuis la machine de test.
- L'adresse IP locale de la box Tydom, par exemple `192.168.0.X`.
- Les identifiants Tydom :
  - `username` : adresse MAC Tydom sous la forme `001A25XXXXXX`.
  - `password` : mot de passe Tydom récupéré depuis l'application ou via inspection réseau.

## Préparer le Homebridge de test

Depuis la racine du dépôt :

```sh
cd /Users/cedriceugeni/dev/perso/homebridge-tydom
pnpm install --frozen-lockfile
pnpm run build
mkdir -p .homebridge
```

Si `pnpm` est déjà installé, `corepack` n'est pas nécessaire. Vérifier avec :

```sh
pnpm -v
```

Si `pnpm` n'est pas disponible, l'installer avec `npm` en utilisant la version déclarée par le projet :

```sh
npm install -g pnpm@10.29.3
```

Alternative sans installation globale :

```sh
npx pnpm@10.29.3 install --frozen-lockfile
npx pnpm@10.29.3 run build
```

Le script `pnpm start` lance Homebridge avec ces options :

```sh
NODE_TLS_REJECT_UNAUTHORIZED=0 homebridge -D -U ./.homebridge -P .
```

Cela signifie :

- `NODE_TLS_REJECT_UNAUTHORIZED=0` autorise le certificat auto-signe de la box Tydom locale.
- `-D` active le mode debug Homebridge.
- `-U ./.homebridge` utilise un dossier Homebridge local et isole les accessoires/cache de test.
- `-P .` force Homebridge à charger le plugin depuis le dépôt courant.

## Config de base

Créer le fichier `.homebridge/config.json` avec un bridge de test distinct :

```json
{
  "bridge": {
    "name": "Homebridge Tydom Test",
    "username": "0E:21:1B:E7:27:C9",
    "port": 53619,
    "pin": "031-45-154"
  },
  "accessories": [],
  "platforms": [
    {
      "platform": "Tydom",
      "hostname": "mediation.tydom.com",
      "localHostname": "192.168.0.X",
      "primaryRetryInterval": 300,
      "username": "001A25XXXXXX",
      "password": "YourPassw0rd",
      "debug": true
    }
  ]
}
```

Remplacer :

- `192.168.0.X` par l'IP locale de la box Tydom.
- `001A25XXXXXX` par le username Tydom.
- `YourPassw0rd` par le mot de passe Tydom.

Si le mot de passe ne doit pas apparaitre dans le fichier, utiliser plutôt la variable d'environnement `HOMEBRIDGE_TYDOM_PASSWORD` en base64 et laisser `password` vide ou factice selon la config Homebridge :

```sh
export HOMEBRIDGE_TYDOM_PASSWORD="$(printf '%s' 'YourPassw0rd' | base64)"
```

## Test 1 - Connexion locale directe

Ce test vérifie d'abord que la box locale répond avec le protocole supporté par `tydom-client`.

Dans `.homebridge/config.json`, mettre `hostname` directement sur l'IP locale et supprimer temporairement `localHostname` ou le laisser identique :

```json
{
  "platform": "Tydom",
  "hostname": "192.168.0.X",
  "username": "001A25XXXXXX",
  "password": "YourPassw0rd",
  "debug": true
}
```

Nettoyer le cache Homebridge de test, puis lancer :

```sh
pnpm run clean
DEBUG=homebridge-tydom,tydom-client pnpm start
```

Résultat attendu :

- Homebridge démarre avec le dossier `.homebridge`.
- Les logs `tydom-client` montrent une connexion vers `192.168.0.X`.
- Les accessoires Tydom sont scannés et ajoutés.
- Le QR code ou le pin Homebridge permet d'ajouter ce bridge de test dans l'app Maison.

Critères d'échec typiques :

- Erreur de certificat : vérifier que le lancement passe bien par `pnpm start`, car le script définit `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Erreur `fetch failed` avec `ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED` : certaines box Tydom locales utilisent une renégociation TLS héritée désactivée par OpenSSL/Node. Voir la section suivante.
- Timeout ou `ECONNREFUSED` : vérifier que l'IP locale est correcte et accessible depuis la machine.
- Authentification refusée : vérifier `username` et `password`.

### Autoriser la renégociation TLS héritée

Si les logs affichent une erreur de ce type :

```text
TypeError: fetch failed
ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED
unsafe legacy renegotiation disabled
```

Créer un fichier `.homebridge/openssl-legacy.cnf` :

```ini
openssl_conf = openssl_init

[openssl_init]
ssl_conf = ssl_sect

[ssl_sect]
system_default = system_default_sect

[system_default_sect]
Options = UnsafeLegacyRenegotiation
```

Puis lancer Homebridge avec `NODE_OPTIONS` en plus du debug :

```sh
NODE_OPTIONS="--openssl-shared-config --openssl-config=$PWD/.homebridge/openssl-legacy.cnf" DEBUG=homebridge-tydom,tydom-client pnpm start
```

Cette option doit rester limitée au Homebridge de test ou a un environnement de confiance, car elle assouplit le comportement TLS de Node pour permettre la communication avec l'ancien serveur TLS local de la box.

## Test 2 - Fallback au démarrage

Ce test force l'échec du host principal pour vérifier que `localHostname` prend le relais.

Dans `.homebridge/config.json`, mettre un host distant volontairement invalide :

```json
{
  "platform": "Tydom",
  "hostname": "mediation.tydom.invalid",
  "localHostname": "192.168.0.X",
  "username": "001A25XXXXXX",
  "password": "YourPassw0rd",
  "debug": true
}
```

Relancer depuis un état propre :

```sh
pnpm run clean
DEBUG=homebridge-tydom,tydom-client pnpm start
```

Résultat attendu :

- Le plugin tente d'abord `mediation.tydom.invalid`.
- Les logs indiquent l'échec de connexion au host `primary`.
- Le plugin crée ensuite un client `local` avec `192.168.0.X`.
- Homebridge termine le scan des accessoires depuis la connexion locale.
- Tant que le client actif est local, le plugin retente le `hostname` principal toutes les `primaryRetryInterval` secondes, `300` secondes par défaut.

Exemples de logs à rechercher :

```text
Failed to connect to primary Tydom hostname=...
Creating local tydom client ... hostname=192.168.0.X
Successfully connected to local Tydom hostname=192.168.0.X
Scheduling primary Tydom retry for hostname=mediation.tydom.invalid in 300s while using local fallback
```

Pour tester plus vite le retour distant dans le test suivant, régler temporairement `primaryRetryInterval` à `30`.

## Test 3 - Fallback pendant l'exécution

Ce test est optionnel et plus délicat, car il faut provoquer une panne du chemin distant alors que Homebridge tourne.

Configuration de départ :

```json
{
  "platform": "Tydom",
  "hostname": "mediation.tydom.com",
  "localHostname": "192.168.0.X",
  "username": "001A25XXXXXX",
  "password": "YourPassw0rd",
  "debug": true
}
```

Lancer Homebridge :

```sh
pnpm run clean
DEBUG=homebridge-tydom,tydom-client pnpm start
```

Méthodes possibles pour provoquer la panne distante :

- Couper temporairement l'accès Internet de la machine tout en gardant le réseau local actif.
- Bloquer temporairement `mediation.tydom.com` avec un pare-feu local.
- Modifier la config pour un host distant invalide, puis redémarrer Homebridge. Cette variante teste surtout le fallback au démarrage.

Résultat attendu :

- Une déconnexion du client `primary` est détectée.
- Le contrôleur planifie une reconnexion.
- La reconnexion préfère le host local après une panne du primary.
- Les lectures HomeKit continuent via la box locale après la bascule.
- Pendant l'utilisation du local, le contrôleur sonde périodiquement le host distant et rebascule dessus dès qu'il répond de nouveau.

Logs attendus après rétablissement du distant :

```text
Checking if primary Tydom hostname=mediation.tydom.com is available again...
Successfully connected to primary Tydom hostname=mediation.tydom.com
Restored primary Tydom hostname=mediation.tydom.com, switching back from local fallback
```

Attention : les écritures non idempotentes ne sont pas rejouées aveuglément après une bascule. Par exemple, un ordre `TOGGLE` de garage ne doit pas être envoyé deux fois si la première requête a potentiellement atteint Tydom mais que la réponse s'est perdue.

## Commandes utiles

Compiler le plugin local :

```sh
pnpm run build
```

Lancer Homebridge de test :

```sh
DEBUG=homebridge-tydom,tydom-client pnpm start
```

Nettoyer les accessoires et le cache persistants du Homebridge de test :

```sh
pnpm run clean
```

Vérifier le typecheck :

```sh
pnpm run check
```

Lancer la validation complète du dépôt :

```sh
pnpm run test
```

## Notes de prudence

- Ne pas utiliser le même `bridge.username` que le Homebridge principal.
- Ne pas laisser deux Homebridge piloter la même box Tydom en local pendant longtemps si la box semble instable.
- Pour un test HomeKit réel sur macOS, préférer ce setup local avec `.homebridge` plutôt qu'un conteneur Docker, car Bonjour/mDNS fonctionne mieux hors conteneur.
- Ne pas commiter `.homebridge/config.json` s'il contient des identifiants.

## Nettoyage après test

Arrêter Homebridge avec `Ctrl+C`, puis nettoyer les données locales si nécessaire :

```sh
pnpm run clean
```

Pour repartir de zéro côté app Maison, supprimer le bridge de test depuis l'application Maison avant de le réajouter.
