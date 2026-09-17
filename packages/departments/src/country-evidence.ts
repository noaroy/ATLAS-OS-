/**
 * Le pays d'une entreprise, établi sur une preuve ou pas du tout.
 *
 * Le lot écrivait `country: 'France'` sur chaque résultat de recherche, parce
 * que la requête était régionalisée en `FR`. Ce n'était pas une mesure : c'était
 * la reformulation de notre propre intention. Zhejiang NPC Machinery, fabricant
 * chinois, et Diversitech Equipment & Sales, société canadienne, sont ainsi
 * entrés en base comme françaises — et le profil ICP, qui vise la France, la
 * Belgique et la Suisse, ne les a jamais écartées.
 *
 * Ce module n'accepte que ce qu'une page publie :
 *
 *   · un identifiant officiel     — SIRET, RCS, BCE, IDE/CHE, VAT
 *   · une métadonnée déclarée     — `addressCountry` en JSON-LD ou microdonnées
 *   · une adresse postale         — le pays écrit dans un bloc d'adresse
 *
 * Et refuse tout le reste. En particulier ce qui semble évident :
 *
 *   · l'extension du domaine      — `.fr` s'achète depuis n'importe où
 *   · la langue de la page        — un fabricant chinois traduit son site
 *   · le pays de la requête       — c'est l'origine du bug
 *   · le moteur, le mot-clé
 *
 * Quand plusieurs pays apparaissent sans qu'on sache lequel désigne l'entité
 * visée, la réponse est `UNKNOWN`. Getinge nomme neuf pays de production sur
 * une seule page : en retenir un serait tirer au sort.
 *
 * `UNKNOWN` n'est pas un échec. C'est le seul état honnête quand la page ne dit
 * rien, et il vaut infiniment mieux qu'un « France » qui désarme le filtre.
 */

/** Ce que les sources permettent de conclure, et sur quoi. */
import { swedishPostalAddresses } from './nordic-address.ts';

export interface CountryVerdict {
  /** Le pays, en français, ou `null` — jamais deviné. */
  country: string | null;
  /** Par quel moyen il a été établi. */
  basis: 'OFFICIAL_ID' | 'DECLARED_METADATA' | 'POSTAL_ADDRESS' | 'NONE';
  /** La page qui le porte. */
  sourceUrl: string | null;
  /** Le fragment exact relevé, pour que la conclusion se relise. */
  quote: string | null;
  /** Les pays vus, quand plusieurs se disputent la place. */
  candidates: string[];
  reason: string;
}

const AUCUN = (reason: string, candidates: string[] = []): CountryVerdict => ({
  country: null, basis: 'NONE', sourceUrl: null, quote: null, candidates, reason,
});

/**
 * Les identifiants d'entreprise qui nomment un pays sans ambiguïté.
 *
 * Un SIRET n'existe qu'en France, un numéro BCE qu'en Belgique, un IDE qu'en
 * Suisse. Ce sont des registres nationaux : porter le numéro, c'est y être
 * inscrit. C'est la preuve la plus forte parce qu'elle ne dépend d'aucune
 * mise en forme.
 */
const IDENTIFIANTS: ReadonlyArray<{ pays: string; motif: RegExp; label: string }> = [
  /*
   * `[^0-9]{0,24}` et non `[\s:.]*` : les pages n'écrivent presque jamais le
   * mot-clé collé au numéro. QG Sécurité publie « SIRET / RCS : 92891442300019 »
   * — le « / RCS » suffisait à faire manquer la reconnaissance, et une PME
   * française prouvant son immatriculation ressortait sans pays.
   *
   * La fenêtre est bornée : elle ne peut pas aller chercher un chiffre à
   * l'autre bout de la page.
   */
  { pays: 'France', motif: /\bSIRET\b[^0-9]{0,24}([0-9][0-9\s.]{12,19})/i, label: 'SIRET' },
  { pays: 'France', motif: /\bSIREN\b[^0-9]{0,24}([0-9][0-9\s.]{7,14})/i, label: 'SIREN' },
  /*
   * `[^0-9]` et non `[^A-Z0-9]` : avec le drapeau `i`, une classe négative sur
   * A-Z exclut aussi a-z. Le motif ne pouvait donc pas franchir le mot
   * « intracommunautaire », et « TVA intracommunautaire : FR17928914423 » — la
   * forme la plus répandue — n'était jamais reconnue.
   */
  { pays: 'France', motif: /\bTVA\b[^0-9]{0,30}FR\s?[0-9A-Z]{2}\s?[0-9]{9}\b/i, label: 'TVA française' },
  { pays: 'France', motif: /\bR\.?C\.?S\.?\b[^0-9]{0,24}[0-9][0-9\s.]{8,}/i, label: 'RCS' },
  { pays: 'Belgique', motif: /\b(?:BCE|KBO)\b[\s:.]*(?:BE\s*)?0[0-9][0-9.\s]{7,12}/i, label: 'BCE' },
  { pays: 'Belgique', motif: /\bTVA\s*[:.]?\s*BE\s*0?[0-9]{9,10}\b/i, label: 'TVA belge' },
  { pays: 'Suisse', motif: /\bCHE[-\s]?[0-9]{3}[.\s]?[0-9]{3}[.\s]?[0-9]{3}\b/i, label: 'IDE suisse' },
  { pays: 'Luxembourg', motif: /\bTVA\s*[:.]?\s*LU\s*[0-9]{8}\b/i, label: 'TVA luxembourgeoise' },
  /*
   * Suède. L'organisationsnummer s'écrit en dix chiffres coupés d'un tiret
   * (556123-4567). Dix chiffres et un tiret ne prouvent rien seuls — un numéro
   * de téléphone suédois a la même forme — donc le mot-clé est exigé, sous ses
   * graphies réelles : « Organisationsnummer », « Org.nr », « Org nr »,
   * « Orgnr ».
   *
   * Le numéro de TVA, lui, se suffit : « SE » suivi de dix chiffres puis
   * « 01 », douze chiffres au total. Aucune autre suite courante n'a cette
   * forme.
   */
  {
    pays: 'Suède',
    motif: /\b(?:organisationsnummer|organisationsnr|org\.?\s?nr\.?|orgnr)\b[^0-9]{0,24}([0-9]{6}-[0-9]{4})\b/i,
    label: 'Organisationsnummer',
  },
  { pays: 'Suède', motif: /\bSE\s?[0-9]{10}\s?01\b/, label: 'TVA suédoise' },
  /*
   * Allemagne : l'USt-IdNr, avec son mot-clé. « DE » suivi de neuf chiffres
   * seul ressemble trop à une référence produit pour conclure. Sur un marché
   * nordique, l'intrus le plus fréquent est allemand ; le nommer permet de
   * l'écarter avec sa preuve au lieu de le laisser en attente.
   */
  { pays: 'Allemagne', motif: /\bUSt[-.\s]?Id(?:\.?\s?Nr)?\.?[^0-9]{0,30}DE\s?[0-9]{9}\b/i, label: 'USt-IdNr' },
];

/**
 * Les noms de pays reconnus, dans les langues où ils s'écrivent réellement.
 *
 * La liste est volontairement close : un pays absent rend `UNKNOWN`, ce qui est
 * sûr, tandis qu'une correspondance approximative rendrait un faux pays, ce qui
 * ne l'est pas.
 */
const PAYS: ReadonlyArray<{ nom: string; formes: string[] }> = [
  { nom: 'France', formes: ['france'] },
  { nom: 'Belgique', formes: ['belgique', 'belgium', 'belgië', 'belgie'] },
  { nom: 'Suisse', formes: ['suisse', 'switzerland', 'schweiz', 'svizzera'] },
  { nom: 'Luxembourg', formes: ['luxembourg'] },
  { nom: 'Canada', formes: ['canada'] },
  { nom: 'Chine', formes: ['chine', 'china', 'p.r. china', 'pr china'] },
  { nom: 'Allemagne', formes: ['allemagne', 'germany', 'deutschland'] },
  { nom: 'Espagne', formes: ['espagne', 'spain', 'españa', 'espana'] },
  { nom: 'Italie', formes: ['italie', 'italy', 'italia'] },
  { nom: 'Pays-Bas', formes: ['pays-bas', 'netherlands', 'nederland'] },
  { nom: 'Royaume-Uni', formes: ['royaume-uni', 'united kingdom', 'england', 'angleterre'] },
  { nom: 'États-Unis', formes: ['états-unis', 'etats-unis', 'united states', 'u.s.a.', 'usa'] },
  { nom: 'Pologne', formes: ['pologne', 'poland', 'polska'] },
  { nom: 'Suède', formes: ['suède', 'suede', 'sweden', 'sverige'] },
  // Les voisins d'un marché suédois : nommés pour être reconnus, jamais confondus.
  { nom: 'Norvège', formes: ['norvège', 'norvege', 'norway', 'norge'] },
  { nom: 'Danemark', formes: ['danemark', 'denmark', 'danmark'] },
  { nom: 'Finlande', formes: ['finlande', 'finland', 'suomi'] },
  { nom: 'Turquie', formes: ['turquie', 'turkey', 'türkiye'] },
  { nom: 'Portugal', formes: ['portugal'] },
  { nom: 'Autriche', formes: ['autriche', 'austria', 'österreich'] },
  { nom: 'Japon', formes: ['japon', 'japan'] },
  { nom: 'Inde', formes: ['inde', 'india'] },
  { nom: 'Brésil', formes: ['brésil', 'bresil', 'brazil'] },
];

/**
 * Les sections d'une page de mentions légales qui ne parlent pas de l'entreprise.
 *
 * Une page de mentions légales décrit plusieurs entités : l'éditeur du site,
 * son hébergeur, parfois son agence. Sur `qg-securite.fr`, la première adresse
 * complète rencontrée était celle d'OVH — « rue Kellermann, 59100 Roubaix » —
 * et la conclusion « France » était juste par accident. Une PME française
 * hébergée en Allemagne, ou une société chinoise hébergée à Roubaix, auraient
 * reçu le pays de leur hébergeur.
 *
 * Une fenêtre qui tombe après l'un de ces marqueurs est ignorée, jusqu'au
 * marqueur d'éditeur suivant s'il en existe un.
 */
const SECTIONS_TIERCES = [
  'hebergeur', 'hebergement', 'heberge par', 'host', 'hosting', 'hosted by',
  'realisation du site', 'conception du site', 'developpement du site',
  'credits', 'credit photo', 'agence web',
];

/**
 * Ce qui ramène à l'entreprise elle-même après une section tierce.
 *
 * `siege social` et `societe` en ont été retirés, et c'est tout le sujet : une
 * section hébergeur nomme le siège social DE L'HÉBERGEUR. Sur
 * `qg-securite.fr`, la page écrit « Hébergeur : … siège social 2 rue
 * Kellermann, 59100 Roubaix » — le marqueur de retour tombait vingt-huit
 * caractères après le marqueur d'hébergeur, refermait la zone avant l'adresse,
 * et celle d'OVH était de nouveau lue comme celle de l'entreprise.
 *
 * Seuls restent les mots qui désignent explicitement le rôle d'éditeur du site.
 */
const RETOUR_EDITEUR = [
  'editeur du site', 'editeur', 'raison sociale', 'proprietaire du site',
  'ce site est edite par', 'publie par',
];

/** Les mots qui annoncent une adresse. Hors de ce voisinage, un pays est un sujet, pas un siège. */
const MARQUEURS_ADRESSE = [
  'siège social', 'siege social', 'siège', 'adresse', 'address', 'headquarters',
  'registered office', 'head office', 'nous trouver', 'our address', 'postal',
  'rue ', 'avenue ', 'boulevard ', 'chemin ', 'route ', 'street', 'road ', 'zone industrielle',
];

const aplatir = (s: string): string =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Le texte lisible d'une page, balises retirées. */
function texteDe(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Le pays nommé dans un fragment, s'il n'y en a qu'un. */
function paysDansFragment(fragment: string): string[] {
  const plat = ` ${aplatir(fragment)} `;
  const vus = new Set<string>();
  for (const p of PAYS) {
    for (const forme of p.formes) {
      // Bornes de mot : « chine » ne doit pas se lire dans « machine », ni
      // « inde » dans « industrie » -- les deux arrivent sur ces pages.
      const motif = new RegExp(`(?:^|[^a-z0-9])${aplatir(forme).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`);
      if (motif.test(plat)) { vus.add(p.nom); break; }
    }
  }
  return [...vus];
}

/** Le pays déclaré en JSON-LD ou en microdonnées schema.org. */
function paysDeclare(html: string): { pays: string; extrait: string } | null {
  const motifs = [
    /"addressCountry"\s*:\s*"([^"]{2,40})"/i,
    /"addressCountry"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]{2,40})"/i,
    /itemprop=["']addressCountry["'][^>]*content=["']([^"']{2,40})["']/i,
    /itemprop=["']addressCountry["'][^>]*>\s*([^<]{2,40})</i,
  ];
  for (const motif of motifs) {
    const m = motif.exec(html);
    const brut = m?.[1]?.trim();
    if (!brut) continue;
    // Un code ISO à deux lettres est une déclaration explicite, pas une
    // deduction : il est écrit par le site, pas lu dans son domaine.
    const iso: Record<string, string> = {
      FR: 'France', BE: 'Belgique', CH: 'Suisse', LU: 'Luxembourg', CA: 'Canada',
      CN: 'Chine', DE: 'Allemagne', ES: 'Espagne', IT: 'Italie', NL: 'Pays-Bas',
      GB: 'Royaume-Uni', UK: 'Royaume-Uni', US: 'États-Unis', PL: 'Pologne',
      SE: 'Suède', TR: 'Turquie', PT: 'Portugal', AT: 'Autriche', JP: 'Japon',
      IN: 'Inde', BR: 'Brésil',
    };
    const parIso = iso[brut.toUpperCase()];
    if (parIso) return { pays: parIso, extrait: `addressCountry = ${brut}` };
    const noms = paysDansFragment(brut);
    if (noms.length === 1) return { pays: noms[0]!, extrait: `addressCountry = ${brut}` };
  }
  return null;
}

/**
 * Le pays écrit dans un bloc d'adresse.
 *
 * On ne balaie pas la page entière : « nos clients en Allemagne » nomme un pays
 * sans rien dire du siège. Seules les fenêtres autour d'un marqueur d'adresse
 * sont lues, et une fenêtre qui nomme deux pays ne conclut pas.
 */
/** Le texte, débarrassé des sections qui décrivent quelqu'un d'autre. */
function horsSectionsTierces(texte: string): string {
  const plat = aplatir(texte);
  let out = texte;
  for (const marqueur of SECTIONS_TIERCES) {
    let depuis = 0;
    for (;;) {
      const debut = plat.indexOf(aplatir(marqueur), depuis);
      if (debut === -1) break;
      depuis = debut + 1;
      const fins = RETOUR_EDITEUR
        .map((m) => plat.indexOf(aplatir(m), debut + marqueur.length))
        .filter((x) => x !== -1);
      const fin = fins.length > 0 ? Math.min(...fins) : texte.length;
      // Même longueur : les positions restent alignées avec `plat`.
      out = out.slice(0, debut) + ' '.repeat(fin - debut) + out.slice(fin);
    }
  }
  return out;
}

function paysDeLAdresse(texte: string): { pays: string; extrait: string } | null {
  const plat = aplatir(texte);
  const trouves = new Map<string, string>();

  /**
   * Les intervalles du texte qui décrivent quelqu'un d'autre.
   *
   * Chaque marqueur de section tierce ouvre un intervalle, refermé par le
   * premier retour à l'éditeur — ou par la fin du texte. Une adresse lue dans
   * un de ces intervalles n'est pas celle de l'entreprise.
   */
  const zonesTierces: Array<[number, number]> = [];
  for (const marqueur of SECTIONS_TIERCES) {
    let depuis = 0;
    for (;;) {
      const debut = plat.indexOf(aplatir(marqueur), depuis);
      if (debut === -1) break;
      depuis = debut + 1;
      const fins = RETOUR_EDITEUR
        .map((m) => plat.indexOf(aplatir(m), debut + marqueur.length))
        .filter((x) => x !== -1);
      zonesTierces.push([debut, fins.length > 0 ? Math.min(...fins) : texte.length]);
    }
  }
  const dansUneZoneTierce = (i: number) => zonesTierces.some(([a, b]) => i >= a && i < b);

  for (const marqueur of MARQUEURS_ADRESSE) {
    let depuis = 0;
    for (;;) {
      const i = plat.indexOf(aplatir(marqueur), depuis);
      if (i === -1) break;
      depuis = i + 1;
      if (dansUneZoneTierce(i)) continue;
      const fenetre = texte.slice(i, i + 180);
      const noms = paysDansFragment(fenetre);
      // Une fenêtre qui en nomme deux ne tranche pas : c'est une liste, pas
      // une adresse.
      if (noms.length === 1) trouves.set(noms[0]!, fenetre.replace(/\s+/g, ' ').trim().slice(0, 120));
    }
  }

  if (trouves.size === 1) {
    const [pays, extrait] = [...trouves.entries()][0]!;
    return { pays, extrait };
  }
  return null;
}

/**
 * Le pays de cette entreprise, d'après ce que ses pages publient.
 *
 * Les preuves sont classées : un identifiant national prime sur une métadonnée,
 * qui prime sur une adresse. Deux preuves de même rang qui se contredisent
 * annulent la conclusion — un site qui affiche deux sièges n'en désigne aucun.
 */
/** Les preuves fortes publiées, rangées par pays et par rang — la matière brute des deux lectures (siège, présence). */
export interface StrongCountryEvidence {
  ids: Map<string, { url: string; extrait: string }>;
  metadata: Map<string, { url: string; extrait: string }>;
  addresses: Map<string, { url: string; extrait: string }>;
}

export function collectStrongCountryEvidence(
  pages: ReadonlyArray<{ url: string; html: string }>,
): StrongCountryEvidence {
  const parIdentifiant = new Map<string, { url: string; extrait: string }>();
  const parMetadonnee = new Map<string, { url: string; extrait: string }>();
  const parAdresse = new Map<string, { url: string; extrait: string }>();

  for (const page of pages) {
    const texte = texteDe(page.html);

    for (const id of IDENTIFIANTS) {
      const m = id.motif.exec(texte);
      if (m) parIdentifiant.set(id.pays, { url: page.url, extrait: `${id.label} : ${m[0].trim().slice(0, 60)}` });
    }

    const declare = paysDeclare(page.html);
    if (declare) parMetadonnee.set(declare.pays, { url: page.url, extrait: declare.extrait });

    const adresse = paysDeLAdresse(texte);
    if (adresse) parAdresse.set(adresse.pays, { url: page.url, extrait: adresse.extrait });
    /*
     * L'adresse suédoise ne nomme pas son pays : « 142 50 Skogås » suffit à
     * un facteur suédois. Reconnue à sa forme et à sa localité, hors des
     * sections tierces (hébergeur, crédits), elle vaut une adresse publiée.
     */
    const suedoise = swedishPostalAddresses(horsSectionsTierces(texte))[0];
    if (suedoise) parAdresse.set('Suède', { url: page.url, extrait: suedoise.extrait });
  }
  return { ids: parIdentifiant, metadata: parMetadonnee, addresses: parAdresse };
}

export function extractCountryEvidence(
  pages: ReadonlyArray<{ url: string; html: string }>,
): CountryVerdict {
  if (pages.length === 0) return AUCUN('aucune page lue');
  const { ids: parIdentifiant, metadata: parMetadonnee, addresses: parAdresse } = collectStrongCountryEvidence(pages);

  const rangs: Array<[CountryVerdict['basis'], Map<string, { url: string; extrait: string }>, string]> = [
    ['OFFICIAL_ID', parIdentifiant, 'identifiant national'],
    ['DECLARED_METADATA', parMetadonnee, 'métadonnée addressCountry'],
    ['POSTAL_ADDRESS', parAdresse, 'adresse postale publiée'],
  ];

  for (const [basis, table, label] of rangs) {
    if (table.size === 1) {
      const [pays, preuve] = [...table.entries()][0]!;
      return {
        country: pays, basis, sourceUrl: preuve.url, quote: preuve.extrait,
        candidates: [pays],
        reason: `${label} : ${preuve.extrait}`,
      };
    }
    if (table.size > 1) {
      const noms = [...table.keys()];
      return AUCUN(
        `${label} : ${noms.join(', ')} — plusieurs pays, aucun ne désigne l'entité de façon certaine`,
        noms,
      );
    }
  }

  return AUCUN('aucune adresse, aucun identifiant national, aucune métadonnée de pays');
}

/**
 * Le pays entre-t-il dans le profil ?
 *
 * `UNKNOWN` n'est ni un oui ni un non : c'est une vérification à faire. Le
 * confondre avec `France` a laissé passer un fabricant chinois ; le confondre
 * avec un refus écarterait des PME françaises dont le site ne publie pas
 * d'adresse, et il y en a.
 */
export type CountryFit = 'IN_SCOPE' | 'OUT_OF_SCOPE' | 'NEEDS_VERIFICATION';

export function countryFit(
  country: string | null | undefined,
  accepted: readonly string[],
): { fit: CountryFit; reason: string } {
  const pays = (country ?? '').trim();
  if (pays === '' || pays.toUpperCase() === 'UNKNOWN') {
    return {
      fit: 'NEEDS_VERIFICATION',
      reason: 'pays non établi : aucune source ne le publie — à vérifier avant tout démarchage',
    };
  }
  const plat = aplatir(pays);
  if (accepted.some((a) => aplatir(a) === plat)) {
    return { fit: 'IN_SCOPE', reason: `${pays} est dans le profil` };
  }
  return {
    fit: 'OUT_OF_SCOPE',
    reason: `${pays} hors du profil (${accepted.join(', ')})`,
  };
}

// ─── LA CORROBORATION ───────────────────────────────────────────────────────

export type CountrySignalType =
  | 'OFFICIAL_ID' | 'DECLARED_METADATA' | 'POSTAL_ADDRESS'
  | 'VAT_PREFIX' | 'PHONE_PREFIX' | 'MENTION_IN_IDENTITY_PAGE';

export interface CountrySignal {
  country: string;
  type: CountrySignalType;
  sourceUrl: string;
  rawValue: string;
  /** Un signal secondaire ne conclut jamais seul. */
  corroborationOnly: boolean;
}

/** Les indicatifs qui nomment un pays sans ambiguite. */
const INDICATIFS: ReadonlyArray<{ pays: string; motif: RegExp }> = [
  { pays: 'France', motif: /(?:^|[^0-9])\+33[\s.\-]?[1-9]/ },
  { pays: 'Belgique', motif: /(?:^|[^0-9])\+32[\s.\-]?[1-9]/ },
  { pays: 'Suisse', motif: /(?:^|[^0-9])\+41[\s.\-]?[1-9]/ },
  { pays: 'Luxembourg', motif: /(?:^|[^0-9])\+352[\s.\-]?[0-9]/ },
  // Corroboration seulement, comme les autres : un +46 seul ne conclut jamais.
  { pays: 'Suède', motif: /(?:^|[^0-9])\+46[\s.\-]?[1-9]/ },
  /*
   * Les voisins, pour voir une contradiction. Kafeko Nordic déclare
   * `addressCountry = SE` sur son site suédois et publie un +358 : sans le
   * préfixe finlandais dans cette table, la contradiction n'existait pas, et
   * la fiche sortait « Suède » sans réserve.
   */
  { pays: 'Finlande', motif: /(?:^|[^0-9])\+358[\s.\-]?[1-9]/ },
  { pays: 'Norvège', motif: /(?:^|[^0-9])\+47[\s.\-]?[1-9]/ },
  { pays: 'Danemark', motif: /(?:^|[^0-9])\+45[\s.\-]?[1-9]/ },
  { pays: 'Allemagne', motif: /(?:^|[^0-9])\+49[\s.\-]?[1-9]/ },
  // Les intrus fréquents d'un marché nordique, pour qu'une mention « China »
  // ou « Deutschland » trouve son second signal : yanbanmachine.com est
  // sorti « pays non prouvé » avec un +86 en pied de page.
  { pays: 'Chine', motif: /(?:^|[^0-9])\+86[\s.\-]?[1-9]/ },
  { pays: 'Royaume-Uni', motif: /(?:^|[^0-9])\+44[\s.\-]?[1-9]/ },
  { pays: 'Pays-Bas', motif: /(?:^|[^0-9])\+31[\s.\-]?[1-9]/ },
  { pays: 'Italie', motif: /(?:^|[^0-9])\+39[\s.\-]?[0-9]/ },
  { pays: 'Espagne', motif: /(?:^|[^0-9])\+34[\s.\-]?[6-9]/ },
  { pays: 'Pologne', motif: /(?:^|[^0-9])\+48[\s.\-]?[1-9]/ },
  { pays: 'Autriche', motif: /(?:^|[^0-9])\+43[\s.\-]?[1-9]/ },
  { pays: 'Turquie', motif: /(?:^|[^0-9])\+90[\s.\-]?[1-9]/ },
  { pays: 'Inde', motif: /(?:^|[^0-9])\+91[\s.\-]?[1-9]/ },
];

/** Les prefixes de TVA intracommunautaire. */
const TVA: ReadonlyArray<{ pays: string; motif: RegExp }> = [
  { pays: 'France', motif: /\bFR\s?[0-9A-Z]{2}\s?[0-9]{9}\b/ },
  { pays: 'Belgique', motif: /\bBE\s?0?[0-9]{9,10}\b/ },
  { pays: 'Luxembourg', motif: /\bLU\s?[0-9]{8}\b/ },
  { pays: 'Suède', motif: /\bSE\s?[0-9]{10}\s?01\b/ },
];

/**
 * Tous les signaux de pays que ces pages publient, forts et faibles.
 *
 * L'extension du domaine n'en fait pas partie. Un `.fr` s'achete depuis
 * n'importe ou, et le retenir meme comme signal secondaire rouvrirait la porte
 * que la correction precedente a fermee : c'est exactement ainsi qu'un
 * fabricant chinois est devenu francais.
 *
 * Un indicatif telephonique ou une mention « France » dans une page d'identite
 * ne concluent jamais seuls : ils confortent une preuve deja etablie.
 */
export function collectCountrySignals(
  pages: ReadonlyArray<{ url: string; html: string }>,
): CountrySignal[] {
  const out: CountrySignal[] = [];
  const fort = extractCountryEvidence(pages);
  if (fort.country && fort.sourceUrl) {
    out.push({
      country: fort.country, type: fort.basis as CountrySignalType,
      sourceUrl: fort.sourceUrl, rawValue: fort.quote ?? fort.reason, corroborationOnly: false,
    });
  }

  for (const page of pages) {
    const texte = texteDe(page.html);
    const chemin = page.url.toLowerCase();
    // « kontakt » et « om-oss » : les pages d'identité suédoises ne s'écrivent
    // ni « contact » ni « à propos ». Sans elles, une mention « Sverige » sur
    // la page de contact d'une société suédoise ne comptait pour rien.
    const pageIdentite = /mentions|legal|contact|propos|qui-sommes|about|kontakt|om-oss|impressum|imprint/.test(chemin);

    for (const t of TVA) {
      const m = t.motif.exec(texte);
      if (m) {
        out.push({
          country: t.pays, type: 'VAT_PREFIX', sourceUrl: page.url,
          rawValue: m[0].trim(), corroborationOnly: false,
        });
      }
    }
    for (const i of INDICATIFS) {
      const m = i.motif.exec(texte);
      if (m) {
        out.push({
          country: i.pays, type: 'PHONE_PREFIX', sourceUrl: page.url,
          rawValue: m[0].trim(), corroborationOnly: true,
        });
      }
    }
    if (pageIdentite) {
      for (const nom of paysDansFragment(texte)) {
        out.push({
          country: nom, type: 'MENTION_IN_IDENTITY_PAGE', sourceUrl: page.url,
          rawValue: nom, corroborationOnly: true,
        });
      }
    }
  }
  return out;
}

export interface CorroboratedCountry {
  country: string | null;
  signals: CountrySignal[];
  reason: string;
}

/**
 * Le pays qu'au moins une preuve etablit, conforte par le reste.
 *
 * Une preuve forte suffit. Deux signaux secondaires concordants suffisent
 * aussi -- un numero en +33 sur une page contact qui nomme la France dit la
 * meme chose deux fois, par deux moyens differents. Un seul signal secondaire
 * ne suffit jamais.
 */
export function corroborateCountry(signals: readonly CountrySignal[]): CorroboratedCountry {
  if (signals.length === 0) return { country: null, signals: [], reason: 'aucun signal de pays' };

  const parPays = new Map<string, CountrySignal[]>();
  for (const s of signals) parPays.set(s.country, [...(parPays.get(s.country) ?? []), s]);

  const candidats = [...parPays.entries()].map(([pays, liste]) => {
    const forts = liste.filter((s) => !s.corroborationOnly);
    const faibles = new Set(liste.filter((s) => s.corroborationOnly).map((s) => s.type));
    return { pays, liste, forts: forts.length, faibles: faibles.size };
  }).sort((a, b) => b.forts - a.forts || b.faibles - a.faibles);

  const [premier, second] = candidats;
  if (!premier) return { country: null, signals: [], reason: 'aucun signal exploitable' };

  const etabli = premier.forts >= 1 || premier.faibles >= 2;
  if (!etabli) {
    return {
      country: null, signals: premier.liste,
      reason: `${premier.pays} n'est appuye que par un signal secondaire — insuffisant`,
    };
  }
  if (second && second.forts === premier.forts && second.faibles === premier.faibles) {
    return {
      country: null, signals: premier.liste,
      reason: `${premier.pays} et ${second.pays} egalement appuyes : aucun ne tranche`,
    };
  }
  return {
    country: premier.pays,
    signals: premier.liste,
    reason: `${premier.forts} preuve(s) directe(s) et ${premier.faibles} corroboration(s) : `
      + [...new Set(premier.liste.map((s) => s.type))].join(', '),
  };
}

// ─── LA HIÉRARCHIE DES PREUVES ──────────────────────────────────────────────

/**
 * Ce que vaut chaque signal quand il s'agit d'en contredire un autre.
 *
 * Le benchmark suédois a montré le coût d'une hiérarchie plate : Angloscand,
 * dont la page de contact porte l'Org.nr, l'adresse de Saltsjöbaden et les
 * numéros de ses agents en Norvège, Finlande, Belgique et Allemagne, sortait
 * « pays contredit ». Un indicatif trouvé dans une page est un signal faible :
 * il conforte, il ne contredit jamais un registre ni une adresse. Seule une
 * preuve d'au moins même rang en contredit une autre.
 *
 *   3  registre national, TVA          — un identifiant ne s'achète pas ailleurs
 *   2  métadonnée déclarée, adresse    — le site le publie de lui-même
 *   1  concordance de signaux faibles  — une présomption
 *   0  indicatif, mention              — jamais seul, jamais contre
 */
export const COUNTRY_SIGNAL_RANK: Record<CountrySignalType, 0 | 2 | 3> = {
  OFFICIAL_ID: 3,
  VAT_PREFIX: 3,
  DECLARED_METADATA: 2,
  POSTAL_ADDRESS: 2,
  PHONE_PREFIX: 0,
  MENTION_IN_IDENTITY_PAGE: 0,
};

/** Ce qu'il faut savoir d'un marché pour y reconnaître une implantation. */
export interface MarketProfile {
  country: string;
  iso: string;
  tld: string;
  phonePrefix: string;
  langs: string[];
}

const MARKET_PROFILES: Record<string, MarketProfile> = {
  suede: { country: 'Suède', iso: 'SE', tld: 'se', phonePrefix: '+46', langs: ['sv'] },
  france: { country: 'France', iso: 'FR', tld: 'fr', phonePrefix: '+33', langs: ['fr'] },
  belgique: { country: 'Belgique', iso: 'BE', tld: 'be', phonePrefix: '+32', langs: ['nl', 'fr'] },
  suisse: { country: 'Suisse', iso: 'CH', tld: 'ch', phonePrefix: '+41', langs: ['de', 'fr', 'it'] },
  luxembourg: { country: 'Luxembourg', iso: 'LU', tld: 'lu', phonePrefix: '+352', langs: ['fr', 'de'] },
  allemagne: { country: 'Allemagne', iso: 'DE', tld: 'de', phonePrefix: '+49', langs: ['de'] },
  norvege: { country: 'Norvège', iso: 'NO', tld: 'no', phonePrefix: '+47', langs: ['no', 'nb'] },
  danemark: { country: 'Danemark', iso: 'DK', tld: 'dk', phonePrefix: '+45', langs: ['da'] },
  finlande: { country: 'Finlande', iso: 'FI', tld: 'fi', phonePrefix: '+358', langs: ['fi'] },
  'pays-bas': { country: 'Pays-Bas', iso: 'NL', tld: 'nl', phonePrefix: '+31', langs: ['nl'] },
};

export function marketProfileOf(label: string): MarketProfile | null {
  const cle = aplatir(label).replace(/\s+/g, '-');
  if (MARKET_PROFILES[cle]) return MARKET_PROFILES[cle]!;
  const parNom = Object.values(MARKET_PROFILES).find((p) => aplatir(p.country) === aplatir(label) || p.iso.toLowerCase() === label.trim().toLowerCase());
  return parNom ?? null;
}

export type PresenceLevel = 'ESTABLISHED' | 'LIKELY' | 'WEAK' | 'NONE';
export type PresenceSignalType =
  | 'LOCAL_ID' | 'LOCAL_METADATA' | 'LOCAL_ADDRESS'
  | 'LOCAL_PHONE' | 'LOCAL_EMAIL_DOMAIN' | 'LOCAL_LANGUAGE_VERSION' | 'LOCAL_TLD';

export interface MarketPresence {
  country: string;
  level: PresenceLevel;
  signals: Array<{ type: PresenceSignalType; rawValue: string; sourceUrl: string }>;
  /** La preuve forte, quand il y en a une : c'est elle qui fait l'implantation. */
  quote: string | null;
  sourceUrl: string | null;
  reason: string;
}

const PRESENCE_NONE = (country: string, reason: string): MarketPresence =>
  ({ country, level: 'NONE', signals: [], quote: null, sourceUrl: null, reason });

/**
 * Un signal de présence dit en clair — « version linguistique (hreflang
 * sv-se) », « téléphone +46 8 500 000 00 » — pour toute phrase qu'un humain
 * lira. Déterministe : même signal, même texte.
 *
 * Relevé au benchmark (Weibang) : la raison d'exclusion interpolait l'objet
 * signal lui-même, et le rapport disait « un seul signal Suède ([object
 * Object]) ». Un rapport ne porte jamais ce texte ; c'est ici qu'on l'assure.
 */
export function describePresenceSignal(signal: { type: PresenceSignalType; rawValue: string }): string {
  const v = String(signal.rawValue ?? '').replace(/\s+/g, ' ').trim();
  switch (signal.type) {
    case 'LOCAL_ID': return `identifiant national ${v}`;
    case 'LOCAL_METADATA': return `pays déclaré par le site (${v})`;
    case 'LOCAL_ADDRESS': return `adresse postale ${v}`;
    case 'LOCAL_PHONE': return `téléphone ${v}`;
    case 'LOCAL_EMAIL_DOMAIN': return `adresse courriel ${v}`;
    case 'LOCAL_LANGUAGE_VERSION': {
      const hreflang = /hreflang=["']([^"']+)["']/i.exec(v)?.[1];
      const lang = /\blang=["']([^"']+)["']/i.exec(v)?.[1];
      const chemin = /href=["']([^"']+)["']/i.exec(v)?.[1];
      return `version linguistique (${hreflang ? `hreflang ${hreflang}` : lang ? `lang ${lang}` : chemin ? `chemin ${chemin}` : v})`;
    }
    case 'LOCAL_TLD': return `domaine national ${v}`;
    default: return v;
  }
}

/**
 * L'implantation d'une société sur le marché visé, distincte de son siège.
 *
 * Cyklop est un groupe dont le pied de page nomme Milan et l'en-tête un numéro
 * de Cologne — et qui sert la Suède depuis Cyklop AB, avec info@cyklop.se, un
 * +46 et une version suédoise du site. Le siège est ailleurs ; la présence est
 * réelle. Une société danoise implantée en Suède est pertinente pour la Suède.
 *
 * Trois niveaux, et ce qu'ils exigent :
 *
 *   ESTABLISHED  une preuve forte locale — Org.nr, adresse postale, métadonnée
 *   LIKELY       au moins deux signaux faibles distincts — téléphone local,
 *                adresse courriel locale, version linguistique, domaine national
 *   WEAK         un seul signal faible
 *
 * Les signaux faibles se lisent dans le HTML entier, attributs compris : le
 * sélecteur de pays de cyklop.com porte le téléphone et le courriel suédois
 * dans des `data-*`, jamais dans le texte visible.
 */
export function assessMarketPresence(
  pages: ReadonlyArray<{ url: string; html: string }>,
  targetCountryLabel: string,
): MarketPresence {
  const profil = marketProfileOf(targetCountryLabel);
  if (!profil) return PRESENCE_NONE(targetCountryLabel, `marché ${targetCountryLabel} sans profil : présence non évaluée`);
  if (pages.length === 0) return PRESENCE_NONE(profil.country, 'aucune page lue');

  const strong = collectStrongCountryEvidence(pages);
  const signals: MarketPresence['signals'] = [];
  const id = strong.ids.get(profil.country);
  if (id) signals.push({ type: 'LOCAL_ID', rawValue: id.extrait, sourceUrl: id.url });
  const meta = strong.metadata.get(profil.country);
  if (meta) signals.push({ type: 'LOCAL_METADATA', rawValue: meta.extrait, sourceUrl: meta.url });
  const adresse = strong.addresses.get(profil.country);
  if (adresse) signals.push({ type: 'LOCAL_ADDRESS', rawValue: adresse.extrait, sourceUrl: adresse.url });

  const vus = new Set<PresenceSignalType>();
  const faible = (type: PresenceSignalType, rawValue: string, sourceUrl: string) => {
    if (vus.has(type)) return;
    vus.add(type);
    signals.push({ type, rawValue, sourceUrl });
  };
  const prefixe = profil.phonePrefix.replace('+', '\\+');
  const telephone = new RegExp(`(?:^|[^0-9])(${prefixe}\\s?\\(?0?\\)?[\\s.\\-]?[1-9][0-9\\s.\\-()]{5,14})`);
  const courriel = new RegExp(`[a-z0-9._%+-]+@[a-z0-9.-]+\\.${profil.tld}\\b`, 'i');
  const langues = profil.langs.map((l) => l.toLowerCase());
  for (const page of pages) {
    const html = page.html;
    const m = telephone.exec(html);
    if (m) faible('LOCAL_PHONE', m[1]!.trim().slice(0, 24), page.url);
    const e = courriel.exec(html);
    if (e) faible('LOCAL_EMAIL_DOMAIN', e[0].toLowerCase(), page.url);
    const hreflang = new RegExp(`hreflang=["'](${langues.join('|')})(?:-${profil.iso})?["']`, 'i').exec(html);
    const langHtml = new RegExp(`<html[^>]*\\slang=["'](${langues.join('|')})(?:-${profil.iso})?["']`, 'i').exec(html);
    const chemin = new RegExp(`href=["'][^"']*/(${langues.join('|')})(?:-${profil.iso.toLowerCase()})?/(?:[^"']*)?["']`, 'i').exec(html);
    if (hreflang || langHtml || chemin) faible('LOCAL_LANGUAGE_VERSION', (hreflang ?? langHtml ?? chemin)![0].slice(0, 60), page.url);
    try {
      const hote = new URL(page.url).hostname.toLowerCase();
      if (hote.endsWith(`.${profil.tld}`)) faible('LOCAL_TLD', hote, page.url);
    } catch { /* URL illisible : pas de signal */ }
  }

  const fort = signals.find((x) => x.type === 'LOCAL_ID' || x.type === 'LOCAL_METADATA' || x.type === 'LOCAL_ADDRESS');
  const faibles = signals.filter((x) => !['LOCAL_ID', 'LOCAL_METADATA', 'LOCAL_ADDRESS'].includes(x.type));
  if (fort) {
    return {
      country: profil.country, level: 'ESTABLISHED', signals, quote: fort.rawValue, sourceUrl: fort.sourceUrl,
      reason: `implantation ${profil.country} établie : ${describePresenceSignal(fort)}`,
    };
  }
  if (faibles.length >= 2) {
    return {
      country: profil.country, level: 'LIKELY', signals, quote: null, sourceUrl: null,
      reason: `présence ${profil.country} probable : ${faibles.map(describePresenceSignal).join(' · ')}`,
    };
  }
  if (faibles.length === 1) {
    return {
      country: profil.country, level: 'WEAK', signals, quote: null, sourceUrl: null,
      reason: `un seul signal ${profil.country} (${describePresenceSignal(faibles[0]!)}) : insuffisant`,
    };
  }
  return PRESENCE_NONE(profil.country, `aucun signal ${profil.country}`);
}

export interface CountryDecision {
  /** Le siège, ou null quand rien ne le prouve ni ne le laisse présumer. */
  country: string | null;
  basis: CountryVerdict['basis'] | 'CORROBORATION';
  quote: string | null;
  sourceUrl: string | null;
  fit: CountryFit;
  fitReason: string;
  /** Ce qui fonde l'entrée dans le marché : le siège, une implantation établie, ou une présence à confirmer. */
  marketFitBasis: 'SEAT' | 'LOCAL_PRESENCE' | 'PRESENCE_LIKELY' | null;
  /** Les seules contradictions qui comptent : une preuve d'au moins même rang, d'un autre pays. */
  contradiction: string[];
  /** Les signaux étrangers faibles — indicatifs, mentions — gardés pour la lecture, jamais contre. */
  foreignSignals: string[];
  presence: MarketPresence | null;
}

/**
 * Le pays d'un candidat et son entrée dans le marché, d'après la hiérarchie.
 *
 *   · le siège est la preuve forte, sinon la concordance ;
 *   · une preuve forte n'est contredite que par une preuve d'au moins même
 *     rang ; un indicatif ou une mention n'y change rien ;
 *   · une contradiction de même rang sur une preuve de rang 2 rend le pays
 *     incertain — deux adresses, deux déclarations : on ne tire pas au sort ;
 *     un identifiant national, lui, tient, et la contradiction reste écrite ;
 *   · une implantation établie sur le marché visé y fait entrer la société,
 *     siège ou pas ; une présence probable en fait une vérification, jamais
 *     une exclusion.
 */
export function decideCountry(input: {
  strong: CountryVerdict;
  signals: readonly CountrySignal[];
  corroboration: CorroboratedCountry;
  presence: MarketPresence | null;
  accepted: readonly string[];
}): CountryDecision {
  const { strong, signals, corroboration, presence } = input;
  let country = strong.country ?? corroboration.country;
  const basis: CountryDecision['basis'] = strong.country ? strong.basis : country ? 'CORROBORATION' : 'NONE';
  const basisRank = strong.country ? COUNTRY_SIGNAL_RANK[strong.basis as CountrySignalType] : 1;

  const etrangers = country ? signals.filter((x) => x.country !== country) : [];
  const libelle = (x: CountrySignal) => `${x.country} (${x.type} ${x.rawValue})`;
  const contradiction = [...new Set(etrangers.filter((x) => COUNTRY_SIGNAL_RANK[x.type] >= 2 && COUNTRY_SIGNAL_RANK[x.type] >= basisRank).map(libelle))];
  const foreignSignals = [...new Set(etrangers.filter((x) => COUNTRY_SIGNAL_RANK[x.type] < 2).map(libelle))];

  // Deux preuves de rang 2 qui se contredisent : le siège devient une question.
  // Un identifiant national (rang 3) tient — la contradiction reste écrite.
  if (country && contradiction.length > 0 && basisRank <= 2) country = null;

  let fit = countryFit(country, input.accepted);
  let marketFitBasis: CountryDecision['marketFitBasis'] = fit.fit === 'IN_SCOPE' ? 'SEAT' : null;
  let fitReason = fit.reason;
  if (presence && fit.fit !== 'IN_SCOPE' && presence.level === 'ESTABLISHED') {
    fit = { fit: 'IN_SCOPE', reason: presence.reason };
    marketFitBasis = 'LOCAL_PRESENCE';
    fitReason = `${presence.reason}${country ? ` — siège ${country}` : ' — siège non prouvé'}`;
  } else if (presence && presence.level === 'LIKELY' && fit.fit !== 'IN_SCOPE') {
    fit = { fit: 'NEEDS_VERIFICATION', reason: presence.reason };
    marketFitBasis = 'PRESENCE_LIKELY';
    fitReason = `${country ? `siège ${country} (${basis})` : 'siège non prouvé'} ; ${presence.reason} — à confirmer, pas à écarter`;
  }

  return {
    country,
    basis: country ? basis : 'NONE',
    quote: country ? (strong.country ? strong.quote : corroboration.signals.map((x) => x.rawValue).join(' · ') || null) : null,
    sourceUrl: country ? (strong.country ? strong.sourceUrl : corroboration.signals[0]?.sourceUrl ?? null) : null,
    fit: fit.fit,
    fitReason,
    marketFitBasis,
    contradiction,
    foreignSignals,
    presence,
  };
}
