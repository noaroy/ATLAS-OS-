import { z } from 'zod';

/**
 * Le brief d'une mission client : ce que le client cherche, dans ses mots.
 *
 * Une mission de recherche de distributeurs se décide sur des critères que le
 * client formule — spécialisation technique, secteurs servis, capacité de
 * service, marques concurrentes à écarter. Le pipeline ne les connaît pas
 * d'avance et ne doit pas les connaître : ACRN n'est pas codé ici, ni aucun
 * autre client. Le brief est un fichier, validé avant tout appel, et ses
 * critères deviennent la grille de qualification telle quelle.
 *
 * Trois natures de critère, et rien d'autre :
 *
 *   required    doit tenir pour retenir la société ; non établi → écartée
 *   preferred   compte dans la note, jamais dans l'exclusion
 *   exclusion   s'il est établi, la société sort — avec la preuve
 *
 * Le brief porte aussi la boucle d'ajustement : une version, des sociétés à
 * conserver telles quelles, des domaines à ne plus retraiter. Un brief v2
 * n'efface pas le travail de la v1 ; il le prolonge.
 */
export const CriterionSchema = z.object({
  /** Un identifiant stable, pour relier verdicts et preuves d'une version à l'autre. */
  key: z.string().min(2).max(40).regex(/^[a-z0-9][a-z0-9-]*$/, 'clé en minuscules, chiffres et tirets'),
  /** La question telle qu'un humain la lirait. */
  label: z.string().min(4).max(200),
  /** Ce qui permettrait d'y répondre sur un site — guide le modèle, ne l'autorise pas à inventer. */
  hint: z.string().max(400).optional(),
  weight: z.number().min(0).max(10).default(1),
});

export const ClientBriefSchema = z.object({
  version: z.number().int().min(1).default(1),
  client: z.object({
    name: z.string().min(1).max(120),
    country: z.string().max(60).optional(),
    offering: z.string().min(4).max(600),
    /** Marqueur explicite : un test technique n'est jamais une mission facturée. */
    internalTest: z.boolean().default(false),
  }),
  market: z.object({
    /** Tel que le planificateur le connaît : « Suède », « Sweden », « SE »… */
    country: z.string().min(2).max(60),
    /** Le pays en français, tel que la corroboration le nomme : « Suède ». */
    countryLabel: z.string().min(2).max(60),
    regions: z.array(z.string().max(80)).default([]),
  }),
  /** Les rôles cherchés, dans le vocabulaire du département : distributor, reseller… */
  targetRoles: z.array(z.string().min(2).max(40)).min(1),
  /** Les mots que le marché emploie ; ils partent tels quels dans les requêtes. */
  productKeywords: z.array(z.string().min(2).max(60)).min(1),
  industries: z.array(z.string().min(2).max(60)).default([]),
  requiredCriteria: z.array(CriterionSchema).min(1),
  preferredCriteria: z.array(CriterionSchema).default([]),
  exclusionCriteria: z.array(CriterionSchema).default([]),
  /** Marques dont la distribution exclut la société. Comparées mot entier, sans casse. */
  competitorExclusions: z.array(z.string().min(2).max(80)).default([]),
  /** Un distributeur spécialisé vaut mieux qu'un catalogue : un généraliste établi est écarté. */
  preferSpecialist: z.boolean().default(true),
  /** Domaines à ne plus retraiter : écartés par le client, ou déjà connus. */
  excludedDomains: z.array(z.string().min(3).max(120)).default([]),
  /** Domaines validés par le client : conservés tels quels d'une version à l'autre. */
  keepDomains: z.array(z.string().min(3).max(120)).default([]),
  notes: z.string().max(2000).optional(),
});

export type ClientBrief = z.infer<typeof ClientBriefSchema>;
export type ClientCriterion = z.infer<typeof CriterionSchema>;

export interface BriefValidation {
  ok: boolean;
  brief: ClientBrief | null;
  errors: string[];
}

/** Lit et valide un brief. Les erreurs sont nommées champ par champ. */
export function parseClientBrief(raw: unknown): BriefValidation {
  const result = ClientBriefSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      brief: null,
      errors: result.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`),
    };
  }
  const brief = result.data;
  const errors: string[] = [];
  const cles = [...brief.requiredCriteria, ...brief.preferredCriteria, ...brief.exclusionCriteria].map((c) => c.key);
  const doublons = cles.filter((k, i) => cles.indexOf(k) !== i);
  if (doublons.length > 0) errors.push(`clés de critère en double : ${[...new Set(doublons)].join(', ')}`);
  const chevauchement = brief.keepDomains.filter((d) => brief.excludedDomains.includes(d));
  if (chevauchement.length > 0) errors.push(`domaines à la fois conservés et exclus : ${chevauchement.join(', ')}`);
  return errors.length > 0 ? { ok: false, brief: null, errors } : { ok: true, brief, errors: [] };
}

/** Tous les critères, avec leur nature, dans l'ordre où le rapport les montre. */
export function allCriteria(brief: ClientBrief): Array<ClientCriterion & { kind: 'required' | 'preferred' | 'exclusion' }> {
  return [
    ...brief.requiredCriteria.map((c) => ({ ...c, kind: 'required' as const })),
    ...brief.preferredCriteria.map((c) => ({ ...c, kind: 'preferred' as const })),
    ...brief.exclusionCriteria.map((c) => ({ ...c, kind: 'exclusion' as const })),
  ];
}

/** Un domaine tel qu'il est comparé : minuscules, sans www ni chemin. */
export function normaliseDomain(value: string): string {
  let d = value.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0]!.split('?')[0]!.split('#')[0]!;
  return d;
}

/**
 * Un brief v2, dérivé de la v1 par ajustement — jamais réécrit à la main sous
 * le même numéro.
 *
 * Le client dit « trop généraliste », « exclure telle marque », « conserver
 * celles-ci ». Chaque ajustement s'exprime ici, et la version monte. Le
 * travail de la v1 reste en base, rattaché à son numéro.
 */
export function adjustBrief(base: ClientBrief, adjustment: {
  keepDomains?: string[];
  excludeDomains?: string[];
  addCompetitors?: string[];
  addKeywords?: string[];
  addRequired?: ClientCriterion[];
  addPreferred?: ClientCriterion[];
  removeCriteriaKeys?: string[];
  preferSpecialist?: boolean;
  notes?: string;
}): ClientBrief {
  const retirer = new Set(adjustment.removeCriteriaKeys ?? []);
  const union = (a: string[], b: string[] = []) => [...new Set([...a, ...b.map((x) => x.trim()).filter(Boolean)])];
  const excluded = union(base.excludedDomains, (adjustment.excludeDomains ?? []).map(normaliseDomain));
  const keep = union(base.keepDomains, (adjustment.keepDomains ?? []).map(normaliseDomain))
    .filter((d) => !excluded.includes(d));
  return {
    ...base,
    version: base.version + 1,
    productKeywords: union(base.productKeywords, adjustment.addKeywords),
    competitorExclusions: union(base.competitorExclusions, adjustment.addCompetitors),
    requiredCriteria: [...base.requiredCriteria.filter((c) => !retirer.has(c.key)), ...(adjustment.addRequired ?? [])],
    preferredCriteria: [...base.preferredCriteria.filter((c) => !retirer.has(c.key)), ...(adjustment.addPreferred ?? [])],
    exclusionCriteria: base.exclusionCriteria.filter((c) => !retirer.has(c.key)),
    preferSpecialist: adjustment.preferSpecialist ?? base.preferSpecialist,
    excludedDomains: excluded,
    keepDomains: keep,
    ...(adjustment.notes !== undefined ? { notes: adjustment.notes } : {}),
  };
}
