// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and state names, the status of
// the integration, the answers of the buttons and the command errors. None of
// them ever carries the user name or the password.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts, one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

const kwh = (value) => String(Math.round(value * 1000) / 1000);
const kwhFr = (value) => kwh(value).replace('.', ',');

export const FEATURE_NAMES = {
  [FEATURES.STATUS]: both('Status', 'État'),
  [FEATURES.CONNECTOR]: both('Connector', 'Connecteur'),
  [FEATURES.CHARGING_STATE]: both('Charging state', 'État de charge'),
  [FEATURES.PLUGGED]: both('Vehicle plugged in', 'Véhicule branché'),
  [FEATURES.POWER]: both('Power', 'Puissance'),
  [FEATURES.ALLOWED_CURRENT]: both('Current allowed', 'Courant autorisé'),
  [FEATURES.SESSION_ENERGY]: both('Energy of the session', 'Énergie de la session'),
  [FEATURES.TOTAL_ENERGY]: both('Energy index', "Index d'énergie"),
  [FEATURES.CHARGE_MODE]: both('Charge mode', 'Mode de charge'),
  [FEATURES.ERROR]: both('Fault reported', 'Défaut signalé'),
  [FEATURES.START]: both('Start charging', 'Démarrer la charge'),
  [FEATURES.STOP]: both('Stop charging', 'Arrêter la charge'),
  [FEATURES.SET_CURRENT]: both('Set the charging current', 'Régler le courant de charge'),
};

/** The charger states of `evse/state`, and ours. */
export const STATE_NAMES = {
  not_connected: both('No vehicle', 'Aucun véhicule'),
  waiting: both(
    'Vehicle plugged in, waiting for release',
    'Véhicule branché, en attente de libération',
  ),
  ready: both('Ready, the vehicle does not charge', 'Prête, le véhicule ne charge pas'),
  charging: both('Charging', 'En charge'),
  error: both('Fault', 'Défaut'),
  unknown: both('Unknown state', 'État inconnu'),
  offline: both('Charger unreachable', 'Borne injoignable'),
};

/** The charge modes of `power_manager/charge_mode`. */
export const MODE_NAMES = {
  fast: both('Fast', 'Rapide'),
  off: both('Off', 'Désactivé'),
  pv: both('Solar surplus', 'Surplus solaire'),
  min_pv: both('Minimum + solar surplus', 'Minimum + surplus solaire'),
  min: both('Minimum', 'Minimum'),
  eco: both('Eco', 'Éco'),
  eco_pv: both('Eco + solar surplus', 'Éco + surplus solaire'),
  eco_min: both('Eco + minimum', 'Éco + minimum'),
  eco_min_pv: both('Eco + minimum + solar surplus', 'Éco + minimum + surplus solaire'),
};

const SECONDARY_NAMES = {
  version: both('firmware version', 'version du firmware'),
  meterIds: both('meter values', 'valeurs du compteur'),
  meterValues: both('meter', 'compteur'),
  currentCharge: both('session', 'session'),
  setting: both('current set', 'courant réglé'),
  chargeMode: both('charge mode', 'mode de charge'),
};

export const T = {
  noHost: both(
    'Enter the address of the WARP charger, then save.',
    "Saisissez l'adresse de la borne WARP, puis enregistrez.",
  ),
  invalidHost: (host) =>
    both(
      `"${host}" is not an IPv4 address nor a host name (port optional).`,
      `« ${host} » n'est ni une adresse IPv4 ni un nom d'hôte (port facultatif).`,
    ),
  hostCredentials: both(
    'The address holds a user name or a password: put them in their own fields, the address alone here.',
    "L'adresse contient un nom d'utilisateur ou un mot de passe : mettez-les dans leurs champs, l'adresse seule ici.",
  ),
  httpsNotSupported: both(
    'HTTPS is not supported in this version: enter the address without https:// and keep HTTP open on the charger (Network settings).',
    "HTTPS n'est pas pris en charge dans cette version : saisissez l'adresse sans https:// et gardez HTTP ouvert sur la borne (réglages Réseau).",
  ),
  invalidAuth: both(
    'The user name or the password is not accepted (printable ASCII, 128 characters at most, no colon nor quote in the user name).',
    "Le nom d'utilisateur ou le mot de passe n'est pas accepté (ASCII imprimable, 128 caractères au plus, ni deux-points ni guillemet dans le nom).",
  ),
  incompleteAuth: both(
    'Give both the user name and the password of the charger, or neither.',
    "Indiquez le nom d'utilisateur et le mot de passe de la borne, ou aucun des deux.",
  ),
  configUnreadable: both(
    'The configuration could not be read from Gladys: tried again every 30 s.',
    "La configuration n'a pas pu être lue depuis Gladys : nouvel essai toutes les 30 s.",
  ),
  connecting: both('Connecting to the charger...', 'Connexion à la borne...'),
  connected: (summary) => both(`Connected: ${summary.en}`, `Connecté : ${summary.fr}`),
  summary: ({ name, state, power }) => {
    const watts = power === undefined ? '' : `, ${Math.round(power)} W`;
    return both(`${name}, ${state.en}${watts}.`, `${name}, ${state.fr}${watts}.`);
  },
  commandsOff: both(
    'Start and the current are off (option); the stop always works.',
    "Démarrage et courant désactivés (option) ; l'arrêt fonctionne toujours.",
  ),
  unreachable: (address, wait) =>
    both(
      `The charger does not answer at ${address}: next try in ${wait.en}.`,
      `La borne ne répond pas à ${address} : nouvel essai dans ${wait.fr}.`,
    ),
  failing: (reason, wait) =>
    both(
      `The charger answered with an error (${reason}): next try in ${wait.en}.`,
      `La borne a répondu par une erreur (${reason}) : nouvel essai dans ${wait.fr}.`,
    ),
  redirected: both(
    'The charger redirects to HTTPS, not supported in this version: allow HTTP on it (Network settings).',
    'La borne redirige vers HTTPS, non pris en charge dans cette version : autorisez HTTP sur la borne (réglages Réseau).',
  ),
  notCharger: both(
    'The device at this address is not a WARP charger (a WARP Energy Manager is not supported).',
    "L'appareil à cette adresse n'est pas une borne WARP (le WARP Energy Manager n'est pas pris en charge).",
  ),
  noId: both(
    'The charger gives no readable UID (info/name): nothing is shown.',
    "La borne ne donne pas d'UID lisible (info/name) : rien n'est affiché.",
  ),
  rateLimited: (wait) =>
    both(
      `The charger asks to slow down (429): pause for ${wait.en}, the stop still goes.`,
      `La borne demande de ralentir (429) : pause de ${wait.fr}, l'arrêt passe toujours.`,
    ),
  serverError: (wait) =>
    both(
      `The charger answered a server error (5xx): pause for ${wait.en}, the stop still goes.`,
      `La borne a répondu une erreur serveur (5xx) : pause de ${wait.fr}, l'arrêt passe toujours.`,
    ),
  authRefused: (wait) =>
    both(
      `The charger refuses the user name and password: check them and save (next try in ${wait.en}).`,
      `La borne refuse le nom d'utilisateur et le mot de passe : vérifiez-les et enregistrez (nouvel essai dans ${wait.fr}).`,
    ),
  authAsked: (wait) =>
    both(
      `The charger asks for a user name and a password: enter them and save (next try in ${wait.en}).`,
      `La borne demande un nom d'utilisateur et un mot de passe : saisissez-les et enregistrez (nouvel essai dans ${wait.fr}).`,
    ),
  otherCharger: (names) =>
    both(
      `Another charger answers at this address: ${names} is no longer read (delete it or put its address back).`,
      `Une autre borne répond à cette adresse : ${names} n'est plus lue (supprimez-la ou remettez son adresse).`,
    ),
  notRead: (keys) => {
    const list = (lang) => keys.map((k) => SECONDARY_NAMES[k]?.[lang] ?? k).join(', ');
    return both(`Not read this time: ${list('en')}.`, `Non lu cette fois : ${list('fr')}.`);
  },
  stopPending: both(
    'A stop is not seen applied yet: checked every 15 s.',
    "Un arrêt n'est pas encore vu appliqué : vérifié toutes les 15 s.",
  ),
  stopHeld: both(
    'A stop sent 4 times is still not applied by the charger: no more sent until a new click; check the charger.',
    "Un arrêt envoyé 4 fois n'est toujours pas appliqué par la borne : plus d'envoi avant un nouveau clic ; vérifiez la borne.",
  ),
  held: ({ direction, from, to }) =>
    direction === 'down'
      ? both(
          `Energy index held back: it dropped from ${kwh(from)} to ${kwh(to)} kWh (meter reset or replaced?). "Accept the held index" (configuration, two clicks) takes it, 0 kWh counted.`,
          `Index d'énergie retenu : baisse de ${kwhFr(from)} à ${kwhFr(to)} kWh (compteur remis à zéro ou remplacé ?). « Accepter l'index retenu » (configuration, deux clics) la prend, 0 kWh compté.`,
        )
      : both(
          `Energy index held back: a jump from ${kwh(from)} to ${kwh(to)} kWh (${kwh(to - from)} kWh at stake). "Accept the held index" (configuration, two clicks) takes it.`,
          `Index d'énergie retenu : saut de ${kwhFr(from)} à ${kwhFr(to)} kWh (${kwhFr(to - from)} kWh en jeu). « Accepter l'index retenu » (configuration, deux clics) le prend.`,
        ),
  accept: {
    nothing: both('No energy index is held back.', "Aucun index d'énergie n'est retenu."),
    confirm: ({ direction, from, to }) =>
      both(
        `Held: ${direction === 'down' ? 'a drop' : 'a jump'} from ${kwh(from)} to ${kwh(to)} kWh. Click again in 3 s to 5 min to take it.`,
        `Retenu : ${direction === 'down' ? 'une baisse' : 'un saut'} de ${kwhFr(from)} à ${kwhFr(to)} kWh. Recliquez dans 3 s à 5 min pour le prendre.`,
      ),
    changed: both(
      'The value held changed since the first click: nothing taken. Click again to see it.',
      'La valeur retenue a changé depuis le premier clic : rien de pris. Recliquez pour la voir.',
    ),
    done: ({ direction, from, to }) =>
      both(
        `Taken: ${direction === 'down' ? 'the drop' : 'the jump'} from ${kwh(from)} to ${kwh(to)} kWh, published at the next read.`,
        `Pris : ${direction === 'down' ? 'la baisse' : 'le saut'} de ${kwhFr(from)} à ${kwhFr(to)} kWh, publié à la prochaine lecture.`,
      ),
  },
  test: {
    notSooner: (wait) =>
      both(
        `(The charger is never read sooner than the interval: next read in ${wait.en}.)`,
        `(La borne n'est jamais lue avant l'intervalle : prochaine lecture dans ${wait.fr}.)`,
      ),
  },
};

export const ERRORS = {
  readOnly: both(
    'This feature takes no command.',
    'Cette fonctionnalité ne prend aucune commande.',
  ),
  badButton: both('A button takes the value 1 only.', 'Un bouton ne prend que la valeur 1.'),
  badCurrent: both(
    'The current is a whole number of amperes.',
    "Le courant est un nombre entier d'ampères.",
  ),
  disabled: both(
    'Commands are off: turn on "Allow the commands" in the configuration (the stop always works).',
    "Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration (l'arrêt fonctionne toujours).",
  ),
  stillRunning: both(
    'Another command is running: try again in a few seconds.',
    'Une autre commande est en cours : réessayez dans quelques secondes.',
  ),
  unknownCharger: both(
    'This charger is not the one configured: nothing sent.',
    "Cette borne n'est pas celle configurée : rien envoyé.",
  ),
  otherCharger: both(
    'Another charger answers at the address: nothing sent.',
    'Une autre borne répond à cette adresse : rien envoyé.',
  ),
  notReadYet: both(
    'The configuration is not read yet: nothing sent (the stop always works).',
    "La configuration n'est pas encore lue : rien envoyé (l'arrêt fonctionne toujours).",
  ),
  stopMeanwhile: both(
    'A stop was clicked meanwhile: this command is dropped, nothing sent.',
    'Un arrêt a été cliqué entre-temps : cette commande est abandonnée, rien envoyé.',
  ),
  paused: (wait) =>
    both(
      `The charger asked to slow down: nothing sent before ${wait.en} (the stop always works).`,
      `La borne a demandé de ralentir : rien envoyé avant ${wait.fr} (l'arrêt fonctionne toujours).`,
    ),
  pausedServer: (wait) =>
    both(
      `The charger answered a server error: nothing sent before ${wait.en} (the stop always works).`,
      `La borne a répondu une erreur serveur : rien envoyé avant ${wait.fr} (l'arrêt fonctionne toujours).`,
    ),
  noCredentials: both(
    'The charger refuses the credentials: nothing sent until they are fixed.',
    'La borne refuse les identifiants : rien envoyé avant leur correction.',
  ),
  missing: both(
    'The charger did not give a value this command needs: nothing sent.',
    "La borne n'a pas donné une valeur dont cette commande a besoin : rien envoyé.",
  ),
  noVehicle: both('No vehicle plugged in: nothing sent.', 'Aucun véhicule branché : rien envoyé.'),
  fault: both(
    'The charger reports a fault: no start sent.',
    'La borne signale un défaut : aucun démarrage envoyé.',
  ),
  aboveCeiling: (cap, high) =>
    both(
      `The charger would give ${cap} A, above the ceiling of ${high} A: set the charging current first. Nothing sent.`,
      `La borne donnerait ${cap} A, au-dessus du plafond de ${high} A : réglez d'abord le courant de charge. Rien envoyé.`,
    ),
  outOfBounds: (low, high) =>
    both(
      `The current must be between ${low} and ${high} A: nothing sent.`,
      `Le courant doit être entre ${low} et ${high} A : rien envoyé.`,
    ),
  tooOften: (wait) =>
    both(
      `The charging current is kept in the flash of the charger: one increase a minute, next in ${wait.en}. Nothing sent.`,
      `Le courant de charge est gardé dans la mémoire flash de la borne : une hausse par minute, prochaine dans ${wait.fr}. Rien envoyé.`,
    ),
  notSaved: both(
    'The time of this write could not be kept in /data: nothing sent.',
    "L'heure de cette écriture n'a pas pu être gardée dans /data : rien envoyé.",
  ),
  tooSlow: both(
    'The charger was too slow to answer before sending: nothing sent.',
    "La borne a été trop lente avant l'envoi : rien envoyé.",
  ),
  unknownState: (reason) =>
    both(
      `The state of the charger could not be read (${reason}): nothing sent.`,
      `L'état de la borne n'a pas pu être lu (${reason}) : rien envoyé.`,
    ),
  notSent: (reason) => both(`Not sent (${reason}).`, `Non envoyé (${reason}).`),
  refused: (reason) =>
    both(
      `The charger refused the command (${reason}).`,
      `La borne a refusé la commande (${reason}).`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Sent, without confirmation (${reason}): read again in 5 and 20 s.`,
      `Envoyée, sans confirmation (${reason}) : relue dans 5 et 20 s.`,
    ),
  notApplied: both(
    'Sent, not applied yet: the charger still shows the value before. Read again in 5 and 20 s.',
    "Envoyée, pas encore appliquée : la borne montre encore la valeur d'avant. Relue dans 5 et 20 s.",
  ),
  sentDiffers: both(
    'Sent, but the charger shows another value: read again in 5 and 20 s.',
    'Envoyée, mais la borne montre une autre valeur : relue dans 5 et 20 s.',
  ),
  noAddress: both(
    'No charger address is known yet: nothing sent.',
    "Aucune adresse de borne n'est encore connue : rien envoyé.",
  ),
  stopPending: both(
    'The stop could not leave yet: tried again every 15 s until it is applied.',
    "L'arrêt n'a pas encore pu partir : réessayé toutes les 15 s jusqu'à son application.",
  ),
  stopNotSent: (reason) =>
    both(
      `The stop could not leave (${reason}): tried again every 15 s until it is applied.`,
      `L'arrêt n'a pas pu partir (${reason}) : réessayé toutes les 15 s jusqu'à son application.`,
    ),
  stopRefused: (reason) =>
    both(
      `The charger refused the stop (${reason}): check the credentials; tried again every 15 s.`,
      `La borne a refusé l'arrêt (${reason}) : vérifiez les identifiants ; réessayé toutes les 15 s.`,
    ),
  stopUnconfirmed: both(
    'Stop sent, without confirmation yet: checked every 15 s until it is seen applied.',
    "Arrêt envoyé, sans confirmation pour l'instant : vérifié toutes les 15 s jusqu'à son application.",
  ),
  stopNotApplied: both(
    'Stop sent, not applied yet: the charger still allows the charge. Checked every 15 s.',
    'Arrêt envoyé, pas encore appliqué : la borne autorise encore la charge. Vérifié toutes les 15 s.',
  ),
};
