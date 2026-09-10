/**
 * Par quel canal une décision humaine peut réellement être exécutée.
 *
 * La file d'approbation mélangeait des dossiers joignables par courriel et des
 * dossiers dont le seul canal relevé est un numéro de téléphone. Un écran qui
 * propose « envoyer » sur les deux ment sur la moitié : un brouillon d'e-mail
 * adressé à `+33 4 76 45 69 25` ne partira jamais, et le bouton qui l'annonce
 * fait perdre le temps de celui qui clique.
 *
 * Ce module ne devine rien. Il lit le canal enregistré au moment de la
 * résolution de contact et vérifie que la cible correspondante existe vraiment.
 * Quand les deux se contredisent, c'est la disponibilité réelle qui tranche —
 * un canal déclaré sans adresse n'est pas un canal.
 *
 * La règle qui compte le plus est la plus simple : une adresse qui n'a été
 * relevée sur aucune page n'est pas une adresse. Elle a été déduite d'un nom de
 * domaine, ce qui produit `contact@<domaine>` dans neuf cas sur dix — plausible,
 * invérifiable, et parfois la boîte de quelqu'un d'autre.
 */

export type ActionChannel = 'EMAIL' | 'FORM' | 'PHONE' | 'MANUAL' | 'UNAVAILABLE';

export interface ChannelInput {
  email: string | null;
  phone: string | null;
  formUrl: string | null;
  /** Le canal consigné par la résolution de contact : EMAIL, PHONE, FORM… */
  recordedMethod: string | null;
  /**
   * L'adresse a-t-elle été relevée sur une page ?
   *
   * Faux signifie « déduite ». Une adresse déduite d'un nom de domaine est une
   * invention polie, et l'envoyer serait écrire à un inconnu.
   */
  observed: boolean;
}

export interface ChannelVerdict {
  channel: ActionChannel;
  /** Ce qui serait réellement utilisé. `null` quand rien n'est exploitable. */
  target: string | null;
  /** Pourquoi ce canal, pour qu'un humain puisse contester. */
  reason: string;
}

/**
 * Une adresse de courriel plausible et complète.
 *
 * Volontairement stricte : ce qui passe ici devient un destinataire. Un motif
 * trop large laisserait entrer « nom@societe » ou une adresse tronquée, qui
 * échouent au moment de l'envoi — c'est-à-dire trop tard.
 */
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** Un numéro composable : au moins huit chiffres une fois l'habillage retiré. */
const chiffres = (raw: string): number => raw.replace(/\D/g, '').length;

/**
 * Une adresse de formulaire réellement relevée, et non la page d'accueil.
 *
 * Sur asytec.fr la résolution de contact a consigné `FORM` avec pour cible
 * `https://asytec.fr/` — la racine du site. Aucun formulaire n'y a été vu ;
 * c'est le repli « il doit bien y en avoir un quelque part ». Présenter cette
 * adresse comme FORM URL reviendrait à demander à quelqu'un de soumettre un
 * formulaire qui n'existe peut-être pas.
 *
 * Un formulaire observé a un chemin. La racine n'en a pas.
 */
export function isVerifiedFormUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const chemin = new URL(url).pathname.replace(/\/+$/, '');
    return chemin.length > 0;
  } catch {
    return false;
  }
}

const propre = (v: string | null): string | null => {
  const t = v?.trim() ?? '';
  return t.length > 0 ? t : null;
};

export function classifyActionChannel(input: ChannelInput): ChannelVerdict {
  const email = propre(input.email);
  const phone = propre(input.phone);
  const form = propre(input.formUrl);

  const emailUtilisable = email !== null && EMAIL.test(email);
  const phoneUtilisable = phone !== null && chiffres(phone) >= 8;
  const formUtilisable = form !== null && isVerifiedFormUrl(form);

  if (!emailUtilisable && !phoneUtilisable && !formUtilisable) {
    return {
      channel: 'UNAVAILABLE',
      target: null,
      reason: 'aucun canal exploitable relevé',
    };
  }

  /*
   * Une adresse non relevée ne devient jamais un destinataire.
   *
   * Le dossier n'est pas perdu pour autant : il reste une décision à prendre,
   * simplement pas une décision d'envoi. D'où MANUAL plutôt que UNAVAILABLE —
   * quelque chose existe, mais personne ne l'a vu écrit.
   */
  if (!input.observed) {
    return {
      channel: 'MANUAL',
      target: null,
      reason: 'canal non relevé sur une page : il serait deviné',
    };
  }

  /*
   * Le canal consigné fait foi quand sa cible existe.
   *
   * L'inverse — choisir par ordre de préférence — écraserait une décision déjà
   * prise à la résolution de contact. Une entreprise qui publie un formulaire
   * et une adresse générique a pu être classée FORM pour une raison.
   */
  const consigne = (input.recordedMethod ?? '').trim().toUpperCase();
  if (consigne === 'EMAIL' && emailUtilisable) {
    return { channel: 'EMAIL', target: email, reason: 'adresse relevée sur une page du site' };
  }
  if (consigne === 'FORM' && formUtilisable) {
    return { channel: 'FORM', target: form, reason: 'formulaire relevé sur le site' };
  }
  if (consigne === 'PHONE' && phoneUtilisable) {
    return { channel: 'PHONE', target: phone, reason: 'numéro relevé sur le site' };
  }

  // Le canal consigné est absent ou sans cible : on retombe sur ce qui existe,
  // du plus actionnable au moins actionnable.
  if (emailUtilisable) {
    return { channel: 'EMAIL', target: email, reason: 'seule adresse relevée exploitable' };
  }
  if (formUtilisable) {
    return { channel: 'FORM', target: form, reason: 'seul formulaire relevé' };
  }
  if (phoneUtilisable) {
    return { channel: 'PHONE', target: phone, reason: 'seul numéro relevé' };
  }

  return {
    channel: 'UNAVAILABLE',
    target: null,
    reason: 'canal consigné sans cible utilisable',
  };
}

/**
 * Classer un destinataire déjà résolu, dont on ne connaît que la chaîne.
 *
 * Les brouillons de la boucle d'outreach ne portent qu'un champ `recipient` :
 * la forme est la seule information disponible. On ne l'utilise que là, et
 * jamais pour un prospect dont les champs séparés existent.
 */
export function classifyRecipientString(recipient: string | null): ChannelVerdict {
  const t = propre(recipient);
  if (t === null) {
    return { channel: 'UNAVAILABLE', target: null, reason: 'aucun destinataire' };
  }
  if (EMAIL.test(t)) {
    return { channel: 'EMAIL', target: t, reason: 'destinataire de forme électronique' };
  }
  if (/^https?:\/\//i.test(t)) {
    return { channel: 'FORM', target: t, reason: 'destinataire de forme formulaire' };
  }
  if (chiffres(t) >= 8) {
    return { channel: 'PHONE', target: t, reason: 'destinataire de forme téléphonique' };
  }
  return { channel: 'MANUAL', target: t, reason: 'canal humain, forme non reconnue' };
}

/** Ce que l'écran propose comme geste, sachant qu'aucun n'est automatisé. */
export function actionLabelFor(channel: ActionChannel): string {
  switch (channel) {
    case 'EMAIL': return 'EMAIL READY';
    case 'FORM': return 'MANUAL FORM';
    case 'PHONE': return 'PHONE CONTACT — MANUAL';
    case 'MANUAL': return 'MANUAL ACTION REQUIRED';
    case 'UNAVAILABLE': return 'NO CHANNEL';
  }
}

/**
 * Le destinataire appartient-il au domaine du prospect ?
 *
 * Relevé sur un vrai dossier : `diversitech-air.com` publie sur sa propre page
 * de contact l'adresse `info@diversitech.ca`. L'adresse est réelle, observée,
 * valide — et pointe vers un autre domaine. Le cas est banal et souvent
 * légitime : maison mère, filiale, domaine national, marque du groupe.
 *
 * Il n'est donc jamais bloquant. Il est signalé.
 *
 * La distinction qui fonde ce module : qu'une adresse figure sur le site prouve
 * que l'entreprise la publie, pas que les deux *domaines* appartiennent à la
 * même entité. Cette seconde affirmation demande une preuve qui nomme
 * réellement l'autre domaine — mentions légales, page groupe, page officielle.
 * Sans elle, on ne conclut pas : on prévient.
 */
export type DomainMatch = 'MATCH' | 'CROSS_DOMAIN' | 'UNKNOWN';

export interface DomainVerdict {
  match: DomainMatch;
  /** L'hôte du destinataire, isolé. `null` quand il n'est pas lisible. */
  recipientDomain: string | null;
  /** La source qui nomme explicitement l'autre domaine, quand elle existe. */
  relatedDomainEvidence: string | null;
  reason: string;
}

const hote = (v: string): string => v.toLowerCase().replace(/^www\./, '');

/** Le domaine `a` est-il le domaine `b`, ou l'un de ses sous-domaines ? */
function memeDomaine(a: string, b: string): boolean {
  const x = hote(a);
  const y = hote(b);
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

export function classifyRecipientDomain(input: {
  /** L'adresse du destinataire, telle qu'elle sera utilisée. */
  email: string | null;
  /** Le domaine officiel du prospect. */
  prospectDomain: string | null;
  /**
   * Les preuves déjà collectées. Une preuve relie deux domaines quand elle
   * nomme le second — dans sa citation ou dans son adresse.
   */
  evidence: ReadonlyArray<{ claim: string; sourceUrl: string | null }>;
}): DomainVerdict {
  const email = propre(input.email);
  const domaine = propre(input.prospectDomain);

  if (email === null || !EMAIL.test(email) || domaine === null) {
    return {
      match: 'UNKNOWN',
      recipientDomain: null,
      relatedDomainEvidence: null,
      reason: 'adresse ou domaine illisible : aucune conclusion possible',
    };
  }

  const destinataire = hote(email.split('@')[1] ?? '');
  if (destinataire.length === 0) {
    return {
      match: 'UNKNOWN', recipientDomain: null, relatedDomainEvidence: null,
      reason: 'hôte du destinataire illisible',
    };
  }

  if (memeDomaine(destinataire, domaine)) {
    return {
      match: 'MATCH',
      recipientDomain: destinataire,
      relatedDomainEvidence: null,
      reason: 'le destinataire est sur le domaine du prospect',
    };
  }

  /*
   * Une preuve qui nomme l'autre domaine relie les deux.
   *
   * Nommer, pas héberger : une page du site où l'adresse apparaît prouve que
   * l'entreprise la publie. Une page qui écrit l'autre domaine — dans ses
   * mentions légales, sa page groupe — dit que les deux vont ensemble.
   */
  for (const e of input.evidence) {
    const cite = e.claim.toLowerCase().includes(destinataire);
    let heberge = false;
    try {
      heberge = e.sourceUrl !== null && memeDomaine(new URL(e.sourceUrl).hostname, destinataire);
    } catch { heberge = false; }
    if (cite || heberge) {
      return {
        match: 'MATCH',
        recipientDomain: destinataire,
        relatedDomainEvidence: e.sourceUrl,
        reason: `« ${destinataire} » est nommé par une preuve du dossier`,
      };
    }
  }

  return {
    match: 'CROSS_DOMAIN',
    recipientDomain: destinataire,
    relatedDomainEvidence: null,
    reason: `destinataire sur « ${destinataire} », prospect sur « ${hote(domaine)} » — ` +
      'aucune preuve ne relie les deux domaines',
  };
}

/**
 * Les paramètres de suivi marketing, retirés d'une adresse citée.
 *
 * Relevé sur un vrai dossier : la source d'un fait Fujielectric portait
 * `?srsltid=AfmBOoqTIzwHmPR3qVWa…`, un identifiant de session Google Shopping.
 * Collé dans un courriel, il annonce d'où vient la visite, se périme, et donne
 * au destinataire l'impression d'être suivi.
 *
 * Seuls les paramètres dont la fonction est le suivi sont retirés. Un `?id=42`
 * ou un `?lang=fr` porte la page elle-même : les enlever casserait le lien, ce
 * qui est pire que de laisser un paramètre laid.
 */
const SUIVI = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'srsltid', 'dclid',
  'mc_cid', 'mc_eid', 'igshid', 'ttclid', 'twclid', 'yclid', 'ref_src',
  '_hsenc', '_hsmi', 'vero_id', 'oly_anon_id', 'oly_enc_id',
];

export function canonicalUrl(raw: string | null): string | null {
  const t = propre(raw);
  if (t === null) return null;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    // Une adresse illisible est rendue telle quelle : la nettoyer supposerait
    // de la comprendre, et on ne devine pas une URL.
    return t;
  }
  for (const p of [...url.searchParams.keys()]) {
    const nom = p.toLowerCase();
    if (SUIVI.includes(nom) || nom.startsWith('utm_')) url.searchParams.delete(p);
  }
  // Un « ? » orphelin reste sinon en fin d'adresse.
  const query = url.searchParams.toString();
  url.search = query.length > 0 ? `?${query}` : '';
  return url.toString();
}
