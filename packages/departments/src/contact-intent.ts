/**
 * À quoi sert une boîte, et peut-on lui écrire pour prospecter ?
 *
 * Le résolveur de contacts répond à « cette coordonnée est-elle publiée ? ».
 * Le lot 005 a montré que c'était la mauvaise question à poser seule :
 * `support@groupe-reval.com` est parfaitement publié, et écrire une offre
 * commerciale au service après-vente d'une entreprise ne fait pas seulement
 * perdre le message — cela donne le ton d'un envoi automatique qui n'a lu
 * personne. `sg@mecapole.fr`, relevé dans les mentions légales, est les
 * initiales de quelqu'un chargé de la publication du site.
 *
 * D'où une seconde question, indépendante : à quoi cette boîte est-elle
 * destinée ? Une coordonnée peut rester **observée** — elle existe, elle est
 * sourcée, elle figure dans la fiche — sans être **utilisable** pour un
 * démarchage. Confondre les deux revient à traiter « on a trouvé une adresse »
 * comme « on a trouvé le bon interlocuteur ».
 *
 * Le classement se lit sur la partie locale de l'adresse, et rien d'autre : ce
 * sont des conventions, pas des devinettes. `sav@`, `dpo@`, `webmaster@`
 * veulent dire la même chose partout.
 */

export type ContactIntent =
  /** Commercial, ventes, devis — l'interlocuteur recherché. */
  | 'SALES'
  /** Export, international — commercial, avec un périmètre. */
  | 'EXPORT'
  /** Accueil général : la porte d'entrée, qui redirige. */
  | 'GENERAL'
  /** Après-vente, assistance. Écrire là est une erreur de destinataire. */
  | 'TECHNICAL_SUPPORT'
  /** Juridique, mentions légales, conformité. */
  | 'LEGAL'
  /** Données personnelles, DPO, RGPD. Démarcher cette boîte serait ironique. */
  | 'PRIVACY'
  /** Technique du site : webmaster, postmaster, noreply. */
  | 'WEBMASTER'
  /** Une personne nommée, sans fonction publiée. */
  | 'PERSONAL'
  | 'UNKNOWN';

export type OutreachSuitability =
  /** Destinée à recevoir ce genre de message. */
  | 'HIGH'
  /** Recevable : elle redirigera, ou c'est le seul canal. */
  | 'MEDIUM'
  /** Utilisable en dernier recours, et seulement décidée par un humain. */
  | 'LOW'
  /** Jamais sélectionnée automatiquement. */
  | 'BLOCKED';

/**
 * Les conventions de nommage, par intention.
 *
 * L'ordre de la table compte : `contact-commercial` doit être lu comme
 * commercial, pas comme général, donc les motifs les plus spécifiques sont
 * essayés d'abord.
 */
const MAILBOX_INTENTS: ReadonlyArray<{ intent: ContactIntent; mailboxes: string[] }> = [
  {
    intent: 'EXPORT',
    mailboxes: ['export', 'international', 'worldwide', 'overseas', 'emea'],
  },
  {
    intent: 'SALES',
    mailboxes: [
      'commercial', 'commerce', 'sales', 'vente', 'ventes', 'devis', 'business',
      'businessdevelopment', 'bizdev', 'salesteam', 'prescription', 'partenariat',
      'partenariats', 'partners', 'distribution', 'achat', 'achats', 'appeloffre',
    ],
  },
  {
    intent: 'PRIVACY',
    mailboxes: ['dpo', 'privacy', 'rgpd', 'gdpr', 'confidentialite', 'donneespersonnelles'],
  },
  {
    intent: 'LEGAL',
    mailboxes: ['legal', 'juridique', 'compliance', 'conformite', 'mentions', 'avocat'],
  },
  {
    intent: 'TECHNICAL_SUPPORT',
    mailboxes: [
      'support', 'sav', 'assistance', 'help', 'helpdesk', 'hotline', 'technique',
      'technical', 'maintenance', 'depannage', 'service', 'serviceclient', 'reclamation',
    ],
  },
  {
    intent: 'WEBMASTER',
    mailboxes: [
      'webmaster', 'admin', 'administrator', 'hostmaster', 'postmaster', 'root',
      'noreply', 'nepasrepondre', 'donotreply', 'mailer', 'daemon', 'abuse', 'it',
    ],
  },
  {
    intent: 'GENERAL',
    mailboxes: [
      'contact', 'contacts', 'info', 'infos', 'information', 'accueil', 'hello',
      'bonjour', 'mail', 'courrier', 'secretariat', 'standard', 'administration',
      'bureau', 'office', 'enquiries', 'anfrage', 'kontakt', 'nouscontacter',
    ],
  },
];

/** `jean.dupont`, `j.dupont`, `sg` — une personne, pas une fonction. */
function looksPersonal(mailbox: string): boolean {
  if (/^[a-z]\.[a-z]{2,}$/.test(mailbox)) return true;
  if (/^[a-z]{2,}\.[a-z]{2,}$/.test(mailbox)) return true;
  // Deux ou trois lettres sans séparateur : des initiales.
  if (/^[a-z]{2,3}$/.test(mailbox)) return true;
  return false;
}

const normalise = (mailbox: string): string =>
  mailbox
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z.]/g, '');

/**
 * À quoi sert cette boîte ?
 *
 * `role` est le seul élément qui peut rattraper une adresse personnelle : une
 * personne dont l'entreprise publie la fonction commerciale est un
 * interlocuteur commercial, ce que l'adresse seule ne dit pas.
 */
export function classifyContactIntent(input: {
  value: string;
  kind: 'EMAIL' | 'PHONE' | 'FORM';
  /** La fonction publiée de la personne, si elle l'est. */
  role?: string | null;
  /** L'adresse de la page où la coordonnée a été lue. */
  sourceUrl?: string | null;
  /** Le domaine officiel de l'entreprise, quand il est connu. */
  officialDomain?: string | null;
}): ContactIntent {
  if (input.kind === 'PHONE') return 'GENERAL';
  if (input.kind === 'FORM') {
    return /(commercial|devis|contact-commercial|sales|quote)/i.test(input.value)
      ? 'SALES'
      : 'GENERAL';
  }

  const mailbox = normalise(input.value.split('@')[0] ?? '');
  if (!mailbox) return 'UNKNOWN';

  // Trois passes, de la plus sûre à la plus permissive.
  //
  // La boîte entière d'abord, puis chacun de ses mots — `contact.commercial`
  // est commercial. Le sous-mot en dernier et seulement à partir de six
  // lettres : `e.maillefert` contient « mail », et une reprise du lot 005 a
  // classé cette personne comme boîte d'accueil pour cette seule raison.
  const tokens = mailbox.split('.').filter(Boolean);
  for (const rule of MAILBOX_INTENTS) {
    if (rule.mailboxes.includes(mailbox)) return rule.intent;
  }
  for (const rule of MAILBOX_INTENTS) {
    if (tokens.some((token) => rule.mailboxes.includes(token))) return rule.intent;
  }
  // Une boîte qui porte le nom de la maison est l'accueil de la maison.
  // `spl@spl-france.com` a été lu comme des initiales — trois lettres — alors
  // que c'est l'adresse générale de SPL. La règle des initiales ne doit pas
  // s'appliquer à la marque elle-même.
  const brandOf = (host: string): string => {
    const parts = host.toLowerCase().replace(/^www\./, '').split('.');
    const root = parts.length >= 2 ? parts[parts.length - 2]! : (parts[0] ?? '');
    return root.split('-')[0] ?? '';
  };
  const ownHost = input.value.split('@')[1] ?? '';
  const brands = [brandOf(ownHost), input.officialDomain ? brandOf(input.officialDomain) : '']
    .filter((b) => b.length >= 2);
  if (brands.includes(mailbox)) return 'GENERAL';

  // Une marque suivie d'un service — `fadilec-automation@fauche.com` — est la
  // boîte d'une unité, pas d'une personne. Elle restait UNKNOWN, donc jamais
  // retenue, alors que c'est le bon interlocuteur écrit.
  //
  // L'exception compte autant que la règle : si ce qui suit la marque désigne
  // un support ou un service juridique, la nature de la boîte l'emporte sur
  // son appartenance. `fadilec-services@` reste un après-vente.
  // `normalise` a retiré les tirets : « fadilec-automation » est arrivé ici
  // sous la forme « fadilecautomation », si bien qu'un préfixe cherché avec
  // son séparateur ne correspondait jamais.
  const brandPrefixed = brands.find(
    (brand) => brand.length >= 3 && mailbox.startsWith(brand) && mailbox.length > brand.length + 2,
  );
  if (brandPrefixed) {
    const suffix = mailbox.slice(brandPrefixed.length).replace(/^[.-]/, '');
    const reserved = MAILBOX_INTENTS.filter((rule) =>
      rule.intent === 'TECHNICAL_SUPPORT' || rule.intent === 'LEGAL' ||
      rule.intent === 'PRIVACY' || rule.intent === 'WEBMASTER');
    const conflict = reserved.find((rule) =>
      rule.mailboxes.some((m) => suffix === m || (m.length >= 6 && suffix.includes(m))));
    if (conflict) return conflict.intent;
    return 'GENERAL';
  }

  // La forme d'un nom passe avant le sous-mot : `c.serviceau` a la forme
  // « initiale point patronyme », et cela vaut quelles que soient les lettres
  // du patronyme. Un mot entier, lui, a déjà été reconnu au-dessus.
  if (looksPersonal(mailbox)) {
    // Une fonction commerciale publiée change la nature de l'adresse : c'est
    // l'entreprise elle-même qui désigne cette personne comme interlocuteur.
    if (input.role && /(commercial|vente|sales|business|export|développement)/i.test(input.role)) {
      return 'SALES';
    }
    return 'PERSONAL';
  }

  for (const rule of MAILBOX_INTENTS) {
    for (const candidate of rule.mailboxes) {
      if (candidate.length >= 6 && mailbox.includes(candidate)) return rule.intent;
    }
  }
  return 'UNKNOWN';
}

/**
 * Peut-on écrire là pour prospecter ?
 *
 * `BLOCKED` ne veut pas dire « fausse » ni « à supprimer » : la coordonnée
 * reste observée, sourcée et affichée. Elle ne sera simplement jamais choisie
 * toute seule.
 */
export function outreachSuitability(intent: ContactIntent, hasCommercialRole = false): OutreachSuitability {
  switch (intent) {
    case 'SALES':
      return 'HIGH';
    case 'EXPORT':
      return 'HIGH';
    case 'GENERAL':
      return 'MEDIUM';
    case 'PERSONAL':
      // Une personne nommée sans fonction publiée : un humain peut décider,
      // un automatisme non.
      return hasCommercialRole ? 'MEDIUM' : 'LOW';
    case 'UNKNOWN':
      return 'LOW';
    case 'TECHNICAL_SUPPORT':
    case 'LEGAL':
    case 'PRIVACY':
    case 'WEBMASTER':
      return 'BLOCKED';
  }
}

export interface RankableContact {
  type: 'EMAIL' | 'PHONE' | 'FORM';
  value: string;
  sourceUrl: string;
  intent: ContactIntent;
  suitability: OutreachSuitability;
  /**
   * L'adresse porte-t-elle la marque de l'entreprise ?
   *
   * Une page de contact liste parfois les adresses de sociétés sœurs ou d'un
   * groupe. Elles sont bien publiées sur le site officiel — la reprise du lot
   * 005 a failli retenir `e.maillefert@forgeavia.com` pour Mecapole — mais
   * écrire à une autre société n'est pas écrire à celle-là. Elles restent
   * acceptées, après tout ce qui porte le bon nom.
   */
  sameBrand?: boolean;
}

/**
 * L'ordre de préférence, et rien d'autre.
 *
 * Adresse commerciale, puis export, puis accueil général ; ensuite un
 * formulaire commercial, un formulaire général, un téléphone professionnel ;
 * et seulement à la fin une adresse personnelle dont la fonction commerciale
 * est publiée. Les boîtes bloquées n'y figurent pas : elles ne sont pas
 * dernières, elles sont hors liste.
 */
const own = (c: RankableContact): boolean => c.sameBrand !== false;

const PRIORITY: ReadonlyArray<(c: RankableContact) => boolean> = [
  (c) => c.type === 'EMAIL' && c.intent === 'SALES' && own(c),
  (c) => c.type === 'EMAIL' && c.intent === 'EXPORT' && own(c),
  (c) => c.type === 'EMAIL' && c.intent === 'GENERAL' && own(c),
  // Un formulaire est sur le site de l'entreprise par construction : il passe
  // avant une adresse qui appartient à quelqu'un d'autre.
  (c) => c.type === 'FORM' && c.intent === 'SALES',
  (c) => c.type === 'FORM' && c.intent === 'GENERAL',
  (c) => c.type === 'PHONE',
  (c) => c.type === 'EMAIL' && (c.intent === 'SALES' || c.intent === 'EXPORT'),
  (c) => c.type === 'EMAIL' && c.intent === 'GENERAL',
  // Une personne nommée, en dernier, et seulement si sa fonction commerciale
  // est publiée — c'est `outreachSuitability` qui l'a alors relevée à MEDIUM.
  (c) => c.type === 'EMAIL' && c.intent === 'PERSONAL' && c.suitability === 'MEDIUM',
];

export interface SelectionOutcome {
  selected: RankableContact | null;
  /** Pourquoi celle-ci, ou pourquoi aucune. */
  reason: string;
  /** Ce qui a été écarté et pour quel motif — un refus muet ne s'audite pas. */
  setAside: Array<{ contact: RankableContact; reason: string }>;
}

export function selectOutreachContact(contacts: readonly RankableContact[]): SelectionOutcome {
  const setAside: SelectionOutcome['setAside'] = [];
  const eligible: RankableContact[] = [];

  for (const contact of contacts) {
    if (contact.suitability === 'BLOCKED') {
      setAside.push({
        contact,
        reason: `boîte ${contact.intent.toLowerCase().replace('_', ' ')} : jamais démarchée automatiquement.`,
      });
      continue;
    }
    eligible.push(contact);
  }

  for (const matches of PRIORITY) {
    const hit = eligible.find(matches);
    if (hit) {
      for (const other of eligible) {
        if (other !== hit) {
          setAside.push({ contact: other, reason: 'canal de rang inférieur.' });
        }
      }
      return {
        selected: hit,
        reason: `${hit.type} ${hit.intent} — ${hit.suitability}.`,
        setAside,
      };
    }
  }

  for (const other of eligible) {
    setAside.push({ contact: other, reason: 'aucun rang de la priorité ne le retient.' });
  }
  return {
    selected: null,
    reason:
      contacts.length === 0
        ? 'aucune coordonnée publiée.'
        : 'des coordonnées existent, aucune n’est destinée à un contact commercial.',
    setAside,
  };
}
