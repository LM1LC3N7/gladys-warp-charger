# WARP Charger pour Gladys

Affiche votre borne de recharge **Tinkerforge WARP** (WARP1, WARP2, WARP3 ou
WARP4, firmware 2.x) dans Gladys par son **API HTTP locale** : sans cloud,
sans compte, directement sur votre réseau.

> **Jamais testé avec une vraie borne.** Sans lien avec Tinkerforge.
> L'intégration suit la documentation officielle de l'API
> (docs.warp-charger.com) et l'intégration Home Assistant
> HomeAssistant-Tinkerforge-Warp-Wallbox-Custom-Component. Une mise à jour du
> firmware peut changer l'API.

## Ce que vous obtenez

Un appareil par borne (repérée par son UID, pas par son adresse IP), avec :

| Fonctionnalité              | Contenu                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------- |
| État                        | Aucun véhicule, branché en attente de libération, prête, en charge, défaut              |
| Connecteur                  | Disponible, occupé, en défaut ou indisponible (catégorie « borne de recharge »)         |
| État de charge              | En charge, en pause par la borne, en pause par le véhicule, inactif                     |
| Véhicule branché            | Oui / non                                                                               |
| Puissance                   | En W (compteur de la borne, « soutirage moins injection »)                              |
| Courant autorisé            | En A, le courant que la borne autorise au véhicule                                      |
| Énergie de la session       | En kWh, un capteur simple (pendant une session)                                         |
| Index d'énergie             | En kWh, l'énergie soutirée depuis la fabrication du compteur, protégé (voir plus bas)   |
| Mode de charge              | Rapide, désactivé, surplus solaire… (gestionnaire d'énergie de la borne, lecture seule) |
| Défaut signalé              | Oui / non                                                                               |
| Démarrer la charge          | Bouton (commandes autorisées seulement)                                                 |
| Arrêter la charge           | Bouton, **toujours disponible**                                                         |
| Régler le courant de charge | Liste de 6 A au plafond (commandes autorisées seulement)                                |

Lecture toutes les 30 secondes par défaut (de 10 s à 10 min, réglable), une
requête à la fois. La puissance, l'énergie, la session, le courant réglé et le
mode de charge sont secondaires : si l'un ne répond pas, les autres valeurs
sont quand même publiées et l'état de l'intégration indique « Non lu cette
fois : … ».

## Installation

1. Donnez une adresse IP fixe à la borne dans votre box.
2. Dans Gladys, installez l'intégration, saisissez l'adresse IP de la borne
   (ou son nom, `warp3-xxxx.local`, éventuellement suivi d'un port).
3. Si vous avez créé des utilisateurs sur la borne (page Utilisateurs), donnez
   le nom et le mot de passe de l'un d'eux : l'intégration répond au défi
   Digest de la borne, le mot de passe lui-même ne circule pas. Le mot de
   passe est gardé par Gladys dans sa base, jamais réaffiché, envoyé
   seulement à la borne.
4. Enregistrez, puis ajoutez la borne depuis l'onglet **Découverte**.

HTTP seulement : si la borne est réglée en HTTPS seul (réglages Réseau),
l'état de l'intégration le dit ; autorisez HTTP. Le WARP Energy Manager n'est
pas une borne et n'est pas pris en charge.

## Arrêter la charge

Le bouton **Arrêter la charge** fait comme le bouton physique de la borne
(`evse/stop_charging`). Il ne dépend pas de l'option des commandes, ni d'une
lecture ou d'une commande en cours (il les interrompt), ni d'une pause après
une erreur 429 ou 5xx, ni d'identifiants refusés, ni de la configuration :
juste après un redémarrage, il part vers l'adresse de la dernière borne lue
(gardée dans `/data`), et un arrêt pas encore vu appliqué avant un
redémarrage est renvoyé dès le démarrage du conteneur. Une commande arrivée
avant lui et pas encore partie est abandonnée.

Il est réussi quand la relecture montre la charge bloquée (ou aucun
véhicule). Sinon la réponse dit pourquoi, et l'arrêt est gardé (dans
`/data`) et vérifié toutes les 15 s :

- **aucune adresse connue** (ni configuration ni borne lue auparavant) :
  rien n'est envoyé ;
- **la borne ne répond pas** pendant 3 s : réessayé toutes les 15 s ;
- **identifiants refusés** : réessayé toutes les 15 s, et tout de suite après
  l'enregistrement de nouveaux identifiants ;
- **pas encore appliqué** (la borne autorise encore la charge) : renvoyé au
  plus 3 fois (écritures acceptées par la borne), puis gardé sans nouvel
  envoi jusqu'à un nouveau clic, redémarrage compris ; l'état de
  l'intégration le signale ;
- **sans confirmation** à temps (4,3 s) : vérifié de la même façon.

Un arrêt qui n'est jamais parti n'est jamais abandonné : réessayé toutes les
15 s, et tout de suite à l'enregistrement de nouveaux identifiants ou au clic
sur **Tester la connexion**.

L'arrêt gardé est levé quand la borne montre la charge bloquée, quand le
véhicule est débranché, ou quand un démarrage cliqué dans Gladys après lui
(option activée) est parti sans refus net (un 401, un autre 4xx, un 429 ou
une redirection le garde ; un 5xx ou une absence de réponse le lève : le
démarrage a pu s'appliquer). Un démarrage encore en route quand l'arrêt est
cliqué ne lève jamais cet arrêt : l'arrêt le coupe et le surveille. Tant
qu'un arrêt est gardé, Démarrer écrit toujours, même si la borne montre déjà
la charge autorisée. Jamais par le temps. Un démarrage envoyé moins de 90 s
avant l'arrêt et arrivé après lui est contré par un nouvel envoi.

## Démarrer la charge et régler le courant (option)

Désactivés par défaut : activez **Autoriser les commandes**. Ce sont un bouton
et une liste, jamais un interrupteur (un « tout éteindre » ne les atteint
pas). Chaque commande relit la borne juste avant (identité, état, emplacements
de courant), part dans les 3,5 s ou pas du tout, et n'est réussie que si la
relecture montre la valeur demandée (« envoyée, pas encore appliquée »
sinon, puis relectures à 5 et 20 s).

- **Démarrer** : refusé sans véhicule, sur un défaut, ou si les réglages de
  la borne (câbles, son courant de charge, commande externe) permettent un
  courant au-dessus du plafond : réglez d'abord le courant. Avec les réglages
  d'usine (32 A) et le plafond par défaut (16 A), le premier démarrage est
  refusé tant que le courant n'est pas réglé. Avec la commande externe
  activée, le contrôleur externe (gestionnaire d'énergie, surplus solaire)
  peut remonter son emplacement après le démarrage, au-dessus du plafond :
  Gladys ne borne pas ce contrôleur.
- **Courant** : de 6 A au plus bas du plafond (16 A par défaut, 32 A au plus)
  et des limites des câbles lues sur la borne. Avec la commande externe
  activée sur la borne, l'intégration écrit son emplacement
  (`evse/external_current`) ; sinon le courant de l'interface web
  (`evse/global_current`), gardé en mémoire flash par la borne : **une
  hausse par minute** au plus (heure gardée dans `/data`), une baisse jamais
  limitée.

Refusés aussi : pendant une pause 429/5xx, avec des identifiants refusés,
avant la lecture de la configuration, pendant une autre commande, ou si un
arrêt a été cliqué entre-temps.

## Index d'énergie (protégé)

L'**index d'énergie** est le compteur de la borne (MeterValueID 209) : Gladys
en tire la consommation et le coût dans son onglet Énergie. Comme Gladys
compte chaque hausse en entier, il passe par une **garde** (celle de
l'intégration P1 Monitor) :

- un index à 0 ou absent n'est jamais publié ;
- une hausse plausible (au plus 25 kW en moyenne depuis la dernière valeur,
  sur l'horloge de la session, qu'un réglage NTP ne déplace pas) passe ;
- un **saut** ou une **baisse** (compteur remis à zéro ou remplacé) est
  **retenu** : rien n'est publié, l'état de l'intégration l'affiche, la
  retenue est gardée dans `/data`. Ni le temps ni la répétition ne la
  confirment ;
- le bouton **Accepter l'index retenu** la prend en **deux clics** : le
  premier montre la valeur, le second (3 s à 5 min après) prend exactement
  cette valeur (plus ce que la borne a pu consommer depuis). Une baisse
  acceptée ne compte rien.

La borne est déjà comptée par votre compteur principal : dans les réglages
Énergie de Gladys, rangez-la **sous** votre compteur principal.

## Bon à savoir

- La borne n'est jamais lue avant l'intervalle : ni par le bouton **Tester la
  connexion**, ni par une Découverte, ni après une reconnexion à Gladys ou un
  redémarrage (l'heure de la dernière lecture est gardée dans `/data`).
  Seules les relectures qui suivent une commande (5 et 20 s) font exception.
- Une valeur de plus de 2 minutes n'est jamais renvoyée comme nouvelle.
- Rien de secret n'est écrit dans `/data` ni dans les journaux.
- La commande OCPP de la borne, l'intégration MQTT de la borne ou une autre
  domotique peuvent aussi la piloter : la dernière écriture gagne.
