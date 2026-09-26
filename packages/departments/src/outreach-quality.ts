/**
 * La porte qualité d'un premier contact, avant la file d'envoi.
 *
 * Le compositeur (`buildOutreachDraft`) refuse déjà d'écrire sans fait sourcé
 * et sans 2 à 3 recommandations valides. Cette porte relit le texte produit —
 * pas les intentions — et rend des motifs machine-lisibles. Elle est pure :
 * l'appelant lui dit ce qu'il sait du destinataire, elle ne lit rien.
 *
 * Les motifs :
 *
 *   RECIPIENT_UNVERIFIED       l'adresse n'est pas celle lue sur le site officiel
 *   RECOMMENDATIONS_BELOW_2    moins de deux entreprises recommandées, sourcées et citées
 *   PROVENANCE_MISSING         une source sans adresse web ou sans citation
 *   NOT_PERSONALIZED           le texte ne cite pas le fait propre au destinataire
 *   UNSUPPORTED_BUYING_INTENT  une intention d'achat affirmée hors citation
 *   PLACEHOLDER_LEFT           un gabarit non rempli
 *   BODY_TOO_SHORT / BODY_TOO_LONG / SUBJECT_INVALID
 */

export type OutreachQualityReason =
  | 'RECIPIENT_UNVERIFIED'
  | 'RECOMMENDATIONS_BELOW_2'
  | 'PROVENANCE_MISSING'
  | 'NOT_PERSONALIZED'
  | 'UNSUPPORTED_BUYING_INTENT'
  | 'PLACEHOLDER_LEFT'
  | 'BODY_TOO_SHORT'
  | 'BODY_TOO_LONG'
  | 'SUBJECT_INVALID';

export interface OutreachQualityInput {
  recipient: string;
  subject: string;
  body: string;
  /**
   * Les sources du brouillon, dans l'ordre où le compositeur les écrit : la
   * première porte la personnalisation, les suivantes les recommandations.
   */
  sources: ReadonlyArray<{ quote: string; sourceUrl: string }>;
  /** L'adresse observée sur le site officiel du destinataire, et son domaine. */
  observedEmail: string | null;
  domain: string;
}

export interface OutreachQualityVerdict {
  ok: boolean;
  reasons: OutreachQualityReason[];
  detail: string[];
}

export const BODY_MIN_CHARS = 250;
export const BODY_MAX_CHARS = 2_500;

const normalise = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Ce qui, hors citation, affirmerait qu'une entreprise veut acheter. Les
 * citations « … » sont retirées avant l'examen : ce qu'une source publie est
 * sourcé ; ce que le message affirme de lui-même ne l'est pas.
 */
const BUYING_INTENT = [
  // Troisième personne seulement : « je recherche des fournisseurs pour… »
  // décrit notre propre travail, pas l'intention d'un tiers.
  /(?<!\b(?:je|j'|nous|on)\s)\b(cherchent|cherche|recherchent|recherche|souhaitent|souhaite|veulent|veut|comptent|compte|s'apprêtent à|s'apprête à|prévoient d'|prévoit d')\b[^.!?\n]{0,50}\b(achet\w*|fournisseurs?|commander|s'équiper)\b/i,
  /\b(prêts?|prête?s?) à (acheter|commander|signer)\b/i,
  /\b(sont|est) (acheteurs?|en recherche active|en phase d'achat)\b/i,
  /\b(ready|looking) to (buy|purchase)\b/i,
  /\bactively (buying|purchasing|looking for suppliers)\b/i,
];

const words = (t: string): string[] => normalise(t).replace(/[«»"“”.,;:!?]/g, ' ').split(/\s+/).filter(Boolean);

/** Le plus long passage de mots consécutifs de `quote` présent tel quel dans `text` (déjà normalisé). */
function longestSharedRun(quote: string, text: string): number {
  const w = words(quote);
  const hay = ` ${text.replace(/[«»"“”.,;:!?]/g, ' ').replace(/\s+/g, ' ')} `;
  for (let size = w.length; size > 0; size--) {
    for (let i = 0; i + size <= w.length; i++) {
      if (hay.includes(` ${w.slice(i, i + size).join(' ')} `)) return size;
    }
  }
  return 0;
}

export function validateOutreachDraft(input: OutreachQualityInput): OutreachQualityVerdict {
  const reasons: OutreachQualityReason[] = [];
  const detail: string[] = [];
  const add = (reason: OutreachQualityReason, why: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
    detail.push(`${reason}: ${why}`);
  };
  const body = input.body ?? '';
  const flat = normalise(body);

  // ── Le destinataire : l'adresse lue, sur le domaine de l'entreprise ─────
  const recipient = input.recipient.trim().toLowerCase();
  const observed = input.observedEmail?.trim().toLowerCase() ?? null;
  const host = recipient.split('@')[1] ?? '';
  if (!observed || observed !== recipient) add('RECIPIENT_UNVERIFIED', 'adresse différente de celle lue sur le site officiel');
  else if (!(host === input.domain || host.endsWith(`.${input.domain}`))) add('RECIPIENT_UNVERIFIED', `adresse hors du domaine ${input.domain}`);

  // ── La provenance : chaque source a une adresse web et une citation ────
  for (const s of input.sources) {
    if (!/^https?:\/\//i.test(s.sourceUrl ?? '') || !(s.quote ?? '').trim()) {
      add('PROVENANCE_MISSING', `source incomplète (${s.sourceUrl || 'sans adresse'})`);
    }
  }

  // ── La personnalisation : le fait du destinataire, tel quel ────────────
  // Le compositeur habille « nous recherchons X » en « vous indiquez
  // rechercher X » : on exige donc un passage contigu d'au moins cinq mots de
  // la citation (ou la citation entière si elle est plus courte), pas le tout.
  const personal = input.sources[0];
  if (!personal || longestSharedRun(personal.quote, flat) < Math.min(5, words(personal.quote).length)) {
    add('NOT_PERSONALIZED', 'le fait propre au destinataire n’apparaît pas dans le texte');
  }

  // ── Les recommandations : au moins deux, sourcées et citées ────────────
  const recs = input.sources.slice(1).filter((s) => /^https?:\/\//i.test(s.sourceUrl) && s.quote.trim());
  const cited = recs.filter((s) => flat.includes(normalise(s.quote).slice(0, 40)));
  // Deux recommandations distinctes : deux paires (citation, source)
  // différentes — plusieurs partenaires peuvent être publiés sur la même page,
  // ou décrits par la même phrase sur des pages différentes.
  const distinct = new Set(cited.map((s) => `${normalise(s.quote)}|${s.sourceUrl}`));
  if (distinct.size < 2) add('RECOMMENDATIONS_BELOW_2', `${distinct.size} recommandation(s) sourcée(s) et citée(s)`);

  // ── Aucune intention d'achat affirmée hors citation ────────────────────
  const unquoted = body.replace(/«[^»]*»/g, ' ').replace(/"[^"]*"/g, ' ');
  for (const pattern of BUYING_INTENT) {
    const m = pattern.exec(unquoted);
    if (m) { add('UNSUPPORTED_BUYING_INTENT', `« ${m[0]} » affirmé sans source`); break; }
  }

  // ── Forme ──────────────────────────────────────────────────────────────
  if (/\{\{|\}\}|\bundefined\b|\bnull\b|\[(?:nom|name|company|entreprise)\]/i.test(body + input.subject)) {
    add('PLACEHOLDER_LEFT', 'gabarit non rempli');
  }
  if (body.length < BODY_MIN_CHARS) add('BODY_TOO_SHORT', `${body.length} caractères`);
  if (body.length > BODY_MAX_CHARS) add('BODY_TOO_LONG', `${body.length} caractères`);
  const subject = input.subject.trim();
  if (subject.length < 5 || subject.length > 120 || /[\r\n]/.test(subject)) add('SUBJECT_INVALID', `objet de ${subject.length} caractères`);

  return { ok: reasons.length === 0, reasons, detail };
}
