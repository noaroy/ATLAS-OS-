import type { ClientBrief } from '@atlas/departments';
import { normaliseDomain } from '@atlas/departments';

/**
 * Le retour du client, traduit en règles — proposées, jamais appliquées.
 *
 * Après un rapport PARTIAL, le client écrit trois lignes : « trop
 * généralistes », « nous préférons ceux qui assurent le SAV », « pas la marque
 * X ». Chacune correspond à un réglage du brief. Ce module fait la
 * traduction et l'écrit noir sur blanc ; c'est le fondateur qui l'applique
 * par `adjust`, après lecture. Une règle qui changerait la mission sans
 * qu'un humain l'ait relue serait une règle inventée.
 */
export interface BriefProposal {
  fromVersion: number;
  toVersion: number;
  feedback: string;
  rules: Array<{ feedback: string; change: string; applied: boolean }>;
  /** Les phrases du retour qu'aucune règle ne sait lire — à traiter à la main. */
  unmapped: string[];
  adjustment: {
    preferSpecialist?: boolean;
    addCompetitors: string[];
    excludeDomains: string[];
    keepDomains: string[];
    addKeywords: string[];
    /** Les critères dont le poids devrait monter, avec le nouveau poids proposé. */
    reweight: Array<{ key: string; label: string; from: number; to: number }>;
    notes: string;
  };
  /** La commande `adjust` équivalente, prête à être relue puis lancée. */
  command: string;
}

const aplatir = (s: string): string => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const MOTS_VIDES = new Set([
  'pour', 'dans', 'avec', 'sans', 'sous', 'entre', 'vers', 'chez', 'leur', 'leurs', 'votre', 'notre', 'cette', 'cela',
  'tout', 'toute', 'tous', 'toutes', 'moins', 'plus', 'ceux', 'celles', 'dont', 'mais', 'donc', 'ainsi', 'aussi',
  'etre', 'sont', 'avoir', 'fait', 'faire', 'peut', 'doit', 'elle', 'elles', 'nous', 'vous', 'ceci', 'meme', 'autre', 'autres',
  'moins', 'presence', 'present', 'presente', 'societe', 'entreprise', 'client', 'clients', 'exemple',
]);

export function proposeBriefAdjustment(brief: ClientBrief, feedback: string): BriefProposal {
  const phrases = feedback.split(/[;\n]|(?<=[.!])\s+/).map((p) => p.trim()).filter(Boolean);
  const rules: BriefProposal['rules'] = [];
  const unmapped: string[] = [];
  const adjustment: BriefProposal['adjustment'] = {
    addCompetitors: [], excludeDomains: [], keepDomains: [], addKeywords: [], reweight: [], notes: '',
  };

  for (const phrase of phrases) {
    const plat = aplatir(phrase);
    let lue = false;

    // « trop généraliste(s) », « trop catalogue » → préférer un spécialiste.
    if (/generalist|trop catalogue|trop larges?|fourre-tout|trop de rayons/.test(plat)) {
      adjustment.preferSpecialist = true;
      rules.push({ feedback: phrase, change: 'preferSpecialist = true — un généraliste établi part en revue, jamais en liste', applied: true });
      lue = true;
    }

    /*
     * « pas la marque X », « ne pas prendre X », « exclure X » → concurrent.
     * Jamais « pas de X » : « pas de généralistes » n'est pas une marque, et
     * le mot devenait une exclusion qui écartait toute page le citant. Un nom
     * de marque commence par une majuscule, ou est un domaine.
     */
    const marque = /(?:pas la marque|ne pas prendre(?: la marque)?|exclure(?: la marque)?|sans la marque)\s+([\p{L}][\p{L}\d&' .-]{1,40}?)(?:\s*[,.;]|$)/u.exec(phrase);
    if (marque && (/^\p{Lu}/u.test(marque[1]!.trim().replace(/^(?:la|le|les|the)\s+/i, '')) || marque[1]!.includes('.'))) {
      const nom = marque[1]!.trim().replace(/^(?:la|le|les|the)\s+/i, '');
      if (nom.includes('.') && normaliseDomain(nom)) {
        adjustment.excludeDomains.push(normaliseDomain(nom)!);
        rules.push({ feedback: phrase, change: `excludedDomains += ${normaliseDomain(nom)}`, applied: true });
      } else {
        adjustment.addCompetitors.push(nom);
        rules.push({ feedback: phrase, change: `competitorExclusions += « ${nom} » — toute page qui la cite écarte la société, citation à l'appui`, applied: true });
      }
      lue = true;
    }

    // « garder X », « conserver X », « X est bien » → keepDomains si c'est un domaine.
    const garder = /(?:garder|conserver|retenir|on prend|bien vu)\s+([a-z0-9.-]+\.[a-z]{2,})/i.exec(phrase);
    if (garder) {
      const d = normaliseDomain(garder[1]!);
      if (d) { adjustment.keepDomains.push(d); rules.push({ feedback: phrase, change: `keepDomains += ${d}`, applied: true }); lue = true; }
    }

    // « nous préférons … SAV / service / installation » → monter le poids du critère qui en parle.
    const preference = /prefer|privilegi|important|priorit|surtout|plutot/.test(plat);
    if (preference) {
      const criteres = [...brief.requiredCriteria, ...brief.preferredCriteria];
      // Les mots-outils d'un libellé — « pour », « dans », « avec » — ne
      // désignent aucun critère ; sans cette liste, « nous préférons ceux qui
      // livrent dans la semaine » relevait le poids de tout critère écrit « dans ».
      const vises = criteres.filter((c) => {
        const mots = aplatir(`${c.label} ${c.hint ?? ''} ${c.key}`).split(/[^a-z0-9]+/)
          .filter((m) => m.length >= 4 && !MOTS_VIDES.has(m));
        return mots.some((m) => plat.includes(m));
      });
      for (const c of vises) {
        adjustment.reweight.push({ key: c.key, label: c.label, from: c.weight, to: Math.min(10, c.weight + 2) });
        rules.push({ feedback: phrase, change: `poids de « ${c.label} » : ${c.weight} → ${Math.min(10, c.weight + 2)}`, applied: false });
        lue = true;
      }
    }

    // « plus de … », « chercher aussi … » → mots-clés.
    const motsCles = /(?:plus de|aussi|egalement|chercher|ajouter)\s+([\p{L}][\p{L}\d -]{2,40}?)(?:\s*[,.;]|$)/u.exec(phrase);
    if (!lue && motsCles) {
      const mot = motsCles[1]!.trim();
      adjustment.addKeywords.push(mot);
      rules.push({ feedback: phrase, change: `productKeywords += « ${mot} »`, applied: true });
      lue = true;
    }

    if (!lue) unmapped.push(phrase);
  }

  adjustment.notes = `retour client v${brief.version} : ${feedback.slice(0, 300)}`;
  const parties = [`npm run client:mission -- adjust --run=<run>`];
  if (adjustment.keepDomains.length) parties.push(`--keep=${adjustment.keepDomains.join(',')}`);
  if (adjustment.excludeDomains.length) parties.push(`--exclude=${adjustment.excludeDomains.join(',')}`);
  if (adjustment.addCompetitors.length) parties.push(`--competitors="${adjustment.addCompetitors.join(',')}"`);
  if (adjustment.addKeywords.length) parties.push(`--keywords="${adjustment.addKeywords.join(',')}"`);
  if (adjustment.preferSpecialist !== undefined) parties.push(`--prefer-specialist=${adjustment.preferSpecialist}`);
  parties.push(`--notes="${adjustment.notes.replace(/"/g, '\'')}"`);
  if (adjustment.reweight.length) parties.push(`# poids à modifier dans le brief JSON : ${adjustment.reweight.map((r) => `${r.key} ${r.from}→${r.to}`).join(', ')}`);

  return {
    fromVersion: brief.version, toVersion: brief.version + 1, feedback, rules, unmapped, adjustment,
    command: parties.join(' '),
  };
}
