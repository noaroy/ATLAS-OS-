/**
 * La garde du tout premier envoi réel : en INTERNAL_TEST, seulement vers soi.
 *
 * `sales:send-approved --send` vérifie l'interrupteur et le jeton, réserve
 * une place, puis poste. Rien ne l'empêchait, en `ATLAS_ENGINE_MODE=
 * INTERNAL_TEST`, de poster à un destinataire externe : la politique d'envoi
 * du daemon (`INTERNAL_TEST_MODE`) ne couvre pas ce chemin manuel. Le
 * premier envoi réel doit aller dans notre propre boîte — et un lot qui
 * contient une seule adresse étrangère doit être refusé en entier, avant la
 * première réservation.
 *
 * Trois faits, dans cet ordre : la porte (`ATLAS_OUTBOUND_ENABLED`), qui
 * reste prioritaire ; puis, en INTERNAL_TEST, chaque destinataire comparé à
 * `GMAIL_USER` — strictement, après `trim` et minuscules. Pas de liste
 * d'exceptions, pas de variable de contournement : PRODUCTION est le seul
 * mode où l'on écrit à quelqu'un d'autre.
 *
 * Pur : aucune base, aucun réseau. Le script l'applique avant tout, et le
 * chemin d'envoi l'applique une seconde fois — deux gardes indépendantes.
 */

export const INTERNAL_TEST_RECIPIENT_BLOCKED = 'INTERNAL_TEST_RECIPIENT_BLOCKED';
export const INTERNAL_TEST_RECIPIENT_MESSAGE = "En mode INTERNAL_TEST, un envoi réel n'est autorisé que vers GMAIL_USER.";

export type ManualSendBlockCode = 'OUTBOUND_DISABLED' | typeof INTERNAL_TEST_RECIPIENT_BLOCKED;

export interface ManualSendBlock {
  code: ManualSendBlockCode;
  message: string;
  /** Les destinataires en cause, tels qu'écrits dans le lot. */
  recipients: string[];
}

export interface ManualSendLotInput {
  /** `--send` : un envoi réel est demandé. Sans lui, rien n'est gardé — rien ne part. */
  send: boolean;
  engineMode: 'INTERNAL_TEST' | 'PRODUCTION';
  /** L'interrupteur, tel que le transport le lit. */
  outboundEnabled: boolean;
  /** GMAIL_USER : la seule destination admise hors PRODUCTION. */
  gmailUser: string | null | undefined;
  recipients: readonly string[];
}

export interface ManualSendLotVerdict {
  allowed: boolean;
  blocks: ManualSendBlock[];
  /** Un envoi réel, en INTERNAL_TEST, vers soi seulement : le « self-test ». */
  selfTest: boolean;
}

/** `trim` + minuscules : « NoaRoy@GMAIL.com  » et « noaroy@gmail.com » sont la même boîte. */
export const normaliseAddress = (address: string | null | undefined): string => (address ?? '').trim().toLowerCase();

export const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const na = normaliseAddress(a);
  return na.length > 0 && na === normaliseAddress(b);
};

/**
 * Le domaine réservé au self-test : une clé de registre qui ne ressemble à
 * aucun prospect. Il n'ouvre rien d'autre que l'exception ci-dessous.
 */
export const SELF_TEST_DOMAIN = 'selftest.atlas.invalid';

export interface SelfTestCandidate {
  domain: string;
  recipient: string;
  purpose?: 'FIRST_TOUCH' | 'FOLLOW_UP';
}

/**
 * Le self-test isolé : le seul message pour lequel la recherche générique
 * de réponses « par domaine du destinataire » n'a pas de sens.
 *
 * Relevé en production (v4.5.4) : le self-test vers GMAIL_USER dérivait
 * `gmail.com` du destinataire, cherchait `from:gmail.com` dans la boîte, y
 * trouvait dix messages quelconques et refusait « à lire avant de relancer ».
 * La garde est juste pour un prospect — même un prospect en @gmail.com — et
 * absurde pour soi-même : personne ne « répond » au self-test avant qu'il
 * parte.
 *
 * Quatre conditions, toutes exactes, aucune configurable : INTERNAL_TEST,
 * destinataire = GMAIL_USER (trim + minuscules), domaine = SELF_TEST_DOMAIN
 * strictement, premier contact. Une seule manque : pas d'exception, la garde
 * s'applique comme à n'importe qui. PRODUCTION n'a pas d'exception du tout.
 */
export function isIsolatedSelfTest(input: {
  engineMode: 'INTERNAL_TEST' | 'PRODUCTION';
  gmailUser: string | null | undefined;
  item: SelfTestCandidate;
}): boolean {
  return input.engineMode === 'INTERNAL_TEST'
    && sameAddress(input.item.recipient, input.gmailUser)
    && input.item.domain === SELF_TEST_DOMAIN
    && input.item.purpose === 'FIRST_TOUCH';
}

export function evaluateManualSendLot(input: ManualSendLotInput): ManualSendLotVerdict {
  if (!input.send) return { allowed: true, blocks: [], selfTest: false };

  const blocks: ManualSendBlock[] = [];
  if (!input.outboundEnabled) {
    blocks.push({
      code: 'OUTBOUND_DISABLED',
      message: 'ATLAS_OUTBOUND_ENABLED n’est pas vrai : aucun message réel ne part, quel que soit le destinataire.',
      recipients: [...input.recipients],
    });
  }

  const internal = input.engineMode !== 'PRODUCTION';
  if (internal) {
    const user = normaliseAddress(input.gmailUser);
    const externes = user.length === 0
      ? [...input.recipients]
      : input.recipients.filter((recipient) => !sameAddress(recipient, user));
    if (externes.length > 0) {
      blocks.push({
        code: INTERNAL_TEST_RECIPIENT_BLOCKED,
        message: user.length === 0
          ? `${INTERNAL_TEST_RECIPIENT_MESSAGE} GMAIL_USER est absent : aucune destination admise.`
          : INTERNAL_TEST_RECIPIENT_MESSAGE,
        recipients: externes,
      });
    }
  }

  return { allowed: blocks.length === 0, blocks, selfTest: blocks.length === 0 && internal };
}
