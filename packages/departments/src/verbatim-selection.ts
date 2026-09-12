/**
 * Le catalogue de passages montré au modèle, et ce qu'on accepte en retour.
 *
 * Deux chemins produisent des preuves : le lot de prospection et la reprise
 * d'un dossier déjà collecté. Ils doivent poser exactement la même question et
 * appliquer exactement les mêmes refus — sans quoi l'un des deux finirait par
 * être un peu plus permissif, et ce serait celui qui écrit les messages.
 *
 * Tout ce qui définit l'échange vit donc ici : le catalogue numéroté, le
 * schéma de réponse, la consigne, et la résolution des numéros en citations.
 * Le modèle n'a aucun champ où écrire une phrase de la page ; il rend un
 * entier, et le texte est relu à ce numéro.
 */
import {
  splitIntoBlocks, cleanedText, pageTitle, resolveSelection, quoteExistsInSource,
  type SourceBlock, type SourcedEvidence, type BlockSelection,
} from './evidence-blocks.ts';
import { canonicalUrl } from './action-channel.ts';

/** Une page lue, telle que les fetchers la rendent. */
export interface ReadPage {
  url: string;
  html: string;
}

/** Ce qu'il faut garder sous la main pour relire une citation. */
export interface BlockCatalogue {
  /** Le texte montré au modèle, passages numérotés globalement. */
  text: string;
  /** Combien de passages ont été proposés. */
  size: number;
  /** Numéro global → page et bloc local. */
  index: Map<number, { url: string; blockId: number }>;
  blocksByUrl: Map<string, SourceBlock[]>;
  textByUrl: Map<string, string>;
  titleByUrl: Map<string, string | null>;
}

/**
 * Au-delà, le catalogue coûte plus qu'il ne rapporte.
 *
 * Quarante passages par page suffisent largement à couvrir ce qu'une page
 * d'accueil ou une page « devenir distributeur » publie de commercial. Tout
 * envoyer ferait payer des jetons pour des mentions de cookies.
 */
const MAX_BLOCS_PAR_PAGE = 40;

export function buildBlockCatalogue(pages: readonly ReadPage[], options: { maxBlocksPerPage?: number } = {}): BlockCatalogue {
  const parPage = options.maxBlocksPerPage ?? MAX_BLOCS_PAR_PAGE;
  const index = new Map<number, { url: string; blockId: number }>();
  const blocksByUrl = new Map<string, SourceBlock[]>();
  const textByUrl = new Map<string, string>();
  const titleByUrl = new Map<string, string | null>();
  const lignes: string[] = [];
  let numero = 0;

  for (const page of pages) {
    const url = canonicalUrl(page.url) ?? page.url;
    if (blocksByUrl.has(url)) continue;
    const blocs = splitIntoBlocks(page.html);
    if (blocs.length === 0) continue;
    blocksByUrl.set(url, blocs);
    textByUrl.set(url, cleanedText(page.html));
    titleByUrl.set(url, pageTitle(page.html));
    lignes.push(`\n## ${url}`);
    for (const b of blocs.slice(0, parPage)) {
      numero += 1;
      index.set(numero, { url, blockId: b.id });
      lignes.push(`[${numero}] ${b.text}`);
    }
  }

  return { text: lignes.join('\n'), size: numero, index, blocksByUrl, textByUrl, titleByUrl };
}

/** La consigne, identique pour les deux chemins. */
export const VERBATIM_SYSTEM =
  'Vous sélectionnez, parmi des passages NUMÉROTÉS extraits du site d’une entreprise, '
  + 'ceux qui établissent un fait commercial : ce qu’elle fabrique ou vend, à qui, '
  + 'sur quels marchés, ou une recherche de distributeurs ou de partenaires. '
  + 'Vous ne recopiez JAMAIS le texte d’un passage : vous rendez son NUMÉRO et, '
  + 'séparément, ce qu’il établit en une phrase. '
  + 'evidenceType vaut IDENTITY pour une raison sociale, une forme juridique ou une '
  + 'immatriculation, CONTACT pour une adresse, un téléphone ou un formulaire, '
  + 'OTHER pour le reste. Ne sélectionnez pas deux passages qui disent la même chose.';

/** Ce que le modèle a le droit de rendre : des numéros, pas des phrases. */
export const VERBATIM_SCHEMA = {
  type: 'object',
  properties: {
    selections: {
      type: 'array', minItems: 0, maxItems: 6,
      items: {
        type: 'object',
        properties: {
          evidenceBlockId: { type: 'integer', description: 'Le numéro du passage, tel qu’il est affiché.' },
          normalizedClaim: { type: 'string', maxLength: 200, description: 'Ce que ce passage établit, en une phrase.' },
          evidenceType: { type: 'string', enum: ['COMMERCIAL_FACT', 'IDENTITY', 'CONTACT', 'OTHER'] },
        },
        required: ['evidenceBlockId', 'normalizedClaim', 'evidenceType'],
        additionalProperties: false,
      },
    },
  },
  required: ['selections'],
  additionalProperties: false,
} as const;

export interface ResolvedSelections {
  evidence: SourcedEvidence[];
  /** Ce qui a été refusé, et pourquoi. Un refus muet ne s'audite pas. */
  rejected: string[];
}

/**
 * Les numéros rendus par le modèle, relus dans les pages.
 *
 * Deux contrôles, dans cet ordre : le numéro désigne-t-il un passage existant,
 * et ce passage figure-t-il encore dans le texte de sa page ? Le second peut
 * sembler redondant — le texte vient du bloc — mais il ferme la seule brèche
 * qui resterait si un jour la construction du bloc changeait sans que la
 * vérification suive.
 */
export function resolveSelections(
  selections: readonly BlockSelection[],
  catalogue: BlockCatalogue,
): ResolvedSelections {
  const evidence: SourcedEvidence[] = [];
  const rejected: string[] = [];

  for (const s of selections) {
    const cible = catalogue.index.get(s.evidenceBlockId);
    if (!cible) {
      rejected.push(`bloc ${s.evidenceBlockId} inexistant — aucune citation fabriquée`);
      continue;
    }
    const r = resolveSelection(
      { ...s, evidenceBlockId: cible.blockId },
      catalogue.blocksByUrl.get(cible.url) ?? [],
      { url: cible.url, title: catalogue.titleByUrl.get(cible.url) ?? null },
    );
    if (!r.evidence) { rejected.push(r.reason); continue; }
    if (!quoteExistsInSource(r.evidence.evidenceQuote, catalogue.textByUrl.get(cible.url) ?? '')) {
      rejected.push(`citation introuvable dans ${cible.url}`);
      continue;
    }
    evidence.push(r.evidence);
  }
  return { evidence, rejected };
}

/**
 * Le préfixe sous lequel l'interprétation est rangée dans `basis`.
 *
 * Il existait en deux orthographes — « interpretation : » dans le lot,
 * « interprétation : » dans la reprise — et le lecteur n'en connaissait qu'une.
 * Deux dossiers parfaitement enrichis se sont retrouvés sans observation
 * lisible, donc sans brouillon, pour un accent.
 *
 * Une seule constante l'écrit, une seule fonction le relit.
 */
export const INTERPRETATION_PREFIX = 'interprétation : ';

/** L'interprétation rangée dans `basis`, ou `null`. Tolérante à l'accent. */
export function readNormalizedClaim(basis: string | null | undefined): string | null {
  const t = (basis ?? '').trim();
  const m = /^interpr[ée]tation\s*:\s*([\s\S]+)$/i.exec(t);
  if (!m) return null;
  const claim = (m[1] ?? '').replace(/\s+—\s+page\s+«[\s\S]*$/, '').trim();
  return claim === '' ? null : claim;
}
