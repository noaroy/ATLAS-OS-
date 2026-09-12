/**
 * Qui est cette entreprise, d'après ce que ses pages déclarent.
 *
 * Le nom venait du titre du résultat de recherche. Pour `nincar.fr`, ce titre
 * commençait par « Sous-traitance… » et la base a enregistré une entreprise
 * appelée **« Sous »**. Treize citations verbatim parfaitement vérifiées n'ont
 * produit aucun brouillon : la garde d'identité refusait — à raison — d'écrire
 * à une société dont le nom n'était confirmé par rien.
 *
 * Un titre de moteur n'est pas une déclaration de l'entreprise. C'est une
 * chaîne composée par un tiers, tronquée à longueur variable, souvent préfixée
 * par le métier. Il n'entre donc jamais ici, à aucun titre.
 *
 * Ce qui entre, par ordre de force :
 *
 *   · ce que la page déclare en données structurées — JSON-LD, microdonnées ;
 *   · ce que le site affiche comme son propre nom — `og:site_name`, copyright ;
 *   · ce qu'une page d'identité publie — mentions légales, contact, à propos.
 *
 * Et la règle qui fait tenir l'ensemble : **la confiance ne monte que si
 * plusieurs signaux disent la même chose**. Un signal isolé reste un signal
 * isolé, quelle que soit sa source ; deux signaux qui se contredisent ne
 * s'additionnent pas, ils s'annulent.
 */
import { decodeEntities } from './claim-verification.ts';

/** Le saut de ligne, ecrit ainsi pour survivre a tout outillage de patch. */
const SAUT_DE_LIGNE = String.fromCharCode(10);

/** D'où vient un signal, et ce que cela vaut. */
export type IdentitySourceType =
  | 'JSONLD_ORGANIZATION'
  | 'SCHEMA_LEGAL_NAME'
  | 'OG_SITE_NAME'
  | 'FOOTER_COPYRIGHT'
  | 'LEGAL_NOTICE'
  | 'CONTACT_PAGE'
  | 'ABOUT_PAGE'
  /** Corroboration seulement : jamais une preuve à elle seule. */
  | 'HOMEPAGE_HEADING';

export interface IdentitySignal {
  /** Le nom, nettoyé. */
  value: string;
  /** Le texte exact d'où il sort, pour que la conclusion se relise. */
  rawValue: string;
  sourceType: IdentitySourceType;
  sourceUrl: string;
  confidence: number;
}

/**
 * Le poids de chaque source, isolée.
 *
 * Aucune n'atteint 0,75 seule, et c'est délibéré : un site peut déclarer
 * n'importe quoi dans un `og:site_name`. C'est la concordance qui prouve, pas
 * l'origine.
 */
const POIDS: Record<IdentitySourceType, number> = {
  JSONLD_ORGANIZATION: 0.7,
  SCHEMA_LEGAL_NAME: 0.7,
  LEGAL_NOTICE: 0.7,
  OG_SITE_NAME: 0.6,
  FOOTER_COPYRIGHT: 0.6,
  CONTACT_PAGE: 0.55,
  ABOUT_PAGE: 0.55,
  // Un titre de page n'est pas une déclaration d'identité : il corrobore.
  HOMEPAGE_HEADING: 0.4,
};

/** Les sources qui ne peuvent jamais, seules, établir une identité. */
const CORROBORATION_SEULE: IdentitySourceType[] = ['HOMEPAGE_HEADING'];

const nettoyer = (s: string): string =>
  decodeEntities(s)
    .replace(/\s+/g, ' ')
    .replace(/^[\s|·—–-]+|[\s|·—–-]+$/g, '')
    .trim();

/** La forme comparable d'un nom : c'est elle qui dit si deux signaux concordent. */
export function normalizeCompanyName(name: string): string {
  return decodeEntities(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Les formes juridiques ne distinguent pas deux entreprises : « Harmony
    // Béton SAS » et « Harmony Béton » sont la même déclaration.
    .replace(/\b(?:s\.?a\.?s\.?u?\.?|s\.?a\.?r\.?l\.?|e\.?u\.?r\.?l\.?|s\.?a\.?|sci|snc|gmbh|ltd|inc|bv|nv)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Un nom plausible : ni vide, ni une phrase, ni un slogan. */
function plausible(nom: string): boolean {
  const n = nettoyer(nom);
  if (n.length < 2 || n.length > 60) return false;
  /*
   * Quatre mots au plus.
   *
   * Releve sur nincar.com : le champ `name` du JSON-LD contenait
   * « Sous-traitance industrielle et representation commerciale » -- une
   * accroche, pas une raison sociale. A six mots elle passait, et elle
   * l'emportait sur « Nincar », le nom reellement declare en `og:site_name`.
   */
  if (n.split(/\s+/).length > 4) return false;
  if (/[.!?]{1}\s|[.!?]$/.test(n) && n.split(/\s+/).length > 3) return false;
  return true;
}

/** Les noms qu'aucune entreprise ne porte. */
const NON_NOMS = [
  'accueil', 'home', 'contact', 'mentions legales', 'a propos', 'about',
  'bienvenue', 'welcome', 'index', 'page', 'menu', 'panier',
  // « © Copyright | All rights reserved » : le mot lui-même n'est le nom de personne.
  'copyright', 'all rights reserved', 'tous droits reserves', 'alla rattigheter forbehallna',
  'start', 'startsida', 'hem', 'kontakt', 'om oss', 'valkommen', 'startseite', 'impressum',
];

function retenirNom(brut: string): string | null {
  const n = nettoyer(brut);
  if (!plausible(n)) return null;
  if (NON_NOMS.includes(normalizeCompanyName(n))) return null;
  /*
   * Une annee n'est pas une raison sociale.
   *
   * Releve sur harmony-beton.com : le pied de page rendait « 2026 » comme
   * candidat, parce que le groupe d'annee optionnel n'avait pas absorbe le
   * millesime. Il n'a pas gagne -- deux sources nommaient l'entreprise contre
   * une seule pour l'annee -- mais sur une page ou le nom n'apparait qu'une
   * fois, il l'aurait emporte.
   */
  if (/^[0-9\s.\-–]+$/.test(n)) return null;
  // « Copyright 2024 », « All rights reserved. » : une mention de droits, pas un nom.
  if (/^(?:copyright|all rights|tous droits|alla rattigheter)/i.test(n.normalize('NFKD').replace(/[̀-ͯ]/g, ''))) return null;
  return n;
}

const pousser = (
  out: IdentitySignal[],
  brut: string | undefined | null,
  sourceType: IdentitySourceType,
  sourceUrl: string,
): void => {
  if (!brut) return;
  const nom = retenirNom(brut);
  if (!nom) return;
  out.push({ value: nom, rawValue: nettoyer(brut).slice(0, 120), sourceType, sourceUrl, confidence: POIDS[sourceType] });
};

/**
 * Tous les signaux d'identité que ces pages publient.
 *
 * Le titre du résultat de recherche n'est pas un paramètre de cette fonction,
 * et c'est le point : il ne peut pas entrer par mégarde.
 */
export function collectIdentitySignals(
  pages: ReadonlyArray<{ url: string; html: string }>,
): IdentitySignal[] {
  const out: IdentitySignal[] = [];

  for (const page of pages) {
    const { html, url } = page;
    const estAccueil = (() => {
      try { return new URL(url).pathname.replace(/\/$/, '') === ''; } catch { return false; }
    })();
    const chemin = url.toLowerCase();

    // ── Données structurées ────────────────────────────────────────────────
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      const corps = m[1] ?? '';
      // Analyse textuelle plutôt que JSON.parse : beaucoup de sites publient un
      // JSON-LD légèrement invalide, et le rejeter en bloc perdrait un signal
      // fort pour une virgule.
      if (/"@type"\s*:\s*"(?:Organization|LocalBusiness|Corporation|Store)"/i.test(corps)) {
        pousser(out, /"legalName"\s*:\s*"([^"]{2,80})"/i.exec(corps)?.[1], 'SCHEMA_LEGAL_NAME', url);
        pousser(out, /"name"\s*:\s*"([^"]{2,80})"/i.exec(corps)?.[1], 'JSONLD_ORGANIZATION', url);
      }
    }
    pousser(out, /itemprop=["']legalName["'][^>]*content=["']([^"']{2,80})["']/i.exec(html)?.[1], 'SCHEMA_LEGAL_NAME', url);

    // ── Ce que le site dit être ────────────────────────────────────────────
    pousser(
      out,
      /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{2,80})["']/i.exec(html)?.[1]
        ?? /<meta[^>]+content=["']([^"']{2,80})["'][^>]+property=["']og:site_name["']/i.exec(html)?.[1],
      'OG_SITE_NAME', url,
    );

    // ── Le copyright de pied de page ───────────────────────────────────────
    /*
     * Les frontieres de bloc sont conservees pour le copyright.
     *
     * En ecrasant tout en espaces, « © 2026 Harmony Beton » suivi du H1
     * « Harmony Beton » donnait « Harmony Beton Harmony Beton » : un nom qui ne
     * concordait avec aucun autre signal, et la corroboration echouait sur une
     * page qui la portait pourtant.
     */
    /*
     * Scripts, styles et commentaires d'abord : sur pronovaab.se, la licence
     * d'une bibliothèque CSS embarquée — « Copyright (c) 2015 Daniel Eden » —
     * a fait d'un développeur américain la raison sociale d'une société de
     * Halmstad. Le pied de page se lit dans le texte visible, jamais dans le
     * code.
     */
    const lignes = decodeEntities(
      html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/<\/(?:p|div|li|h[1-6]|section|footer|span|td|tr)>/gi, SAUT_DE_LIGNE)
        .replace(/<br\s*\/?>/gi, SAUT_DE_LIGNE)
        .replace(/<[^>]+>/g, ' '),
    ).replace(/[^\S\n]+/g, ' ');
    const texte = lignes.replace(/\s+/g, ' ');
    /*
     * La capture s'arrete a la premiere frontiere de segment.
     *
     * Sans borne, « © 2026 Harmony Beton — Tous droits reserves » suivi du H1
     * rendait « Harmony Beton Harmony Beton » : un nom qui ne concordait avec
     * aucun autre signal, et la corroboration ne se faisait pas.
     */
    for (const m of lignes.matchAll(/(?:©|\(c\)|copyright)\s*(?:\d{4}(?:\s*[-–]\s*\d{4})?\s*)?([A-Za-zÀ-ÿ0-9][\wÀ-ÿ'’&.\- ]{1,50}?)(?=\s*(?:[|·—–\-]|[.,;]|tous droits|all rights|mentions|$))/gimu)) {
      pousser(out, m[1], 'FOOTER_COPYRIGHT', url);
      break;
    }

    // ── Les pages d'identité ───────────────────────────────────────────────
    const type: IdentitySourceType | null = /mentions|legal|cgv|cgu/.test(chemin)
      ? 'LEGAL_NOTICE'
      : /contact|nous-trouver/.test(chemin)
        ? 'CONTACT_PAGE'
        : /propos|qui-sommes|about|entreprise|societe/.test(chemin)
          ? 'ABOUT_PAGE'
          : null;
    if (type) {
      pousser(out, /(?:raison sociale|d[ée]nomination(?: sociale)?)\s*[:\-–]\s*([^\n<.,;]{2,60})/i.exec(texte)?.[1], type, url);
      pousser(out, /(?:soci[ée]t[ée]|entreprise)\s+([A-ZÀ-Ý][\wÀ-ÿ'’&.\-]{1,30}(?:\s+[A-ZÀ-Ý0-9][\wÀ-ÿ'’&.\-]{1,30}){0,3})\s+(?:S\.?A\.?S|SARL|SA|EURL)/i.exec(texte)?.[1], type, url);
    }

    // ── Le titre et le H1 de l'accueil : corroboration seulement ───────────
    if (estAccueil) {
      const h1 = /<h1[^>]*>([\s\S]{2,90}?)<\/h1>/i.exec(html)?.[1];
      pousser(out, h1 ? h1.replace(/<[^>]+>/g, ' ') : null, 'HOMEPAGE_HEADING', url);
      const titre = /<title[^>]*>([\s\S]{2,120}?)<\/title>/i.exec(html)?.[1];
      // Le premier segment seulement : « Harmony Béton | Béton ciré » nomme
      // l'entreprise avant la barre, jamais après.
      pousser(out, titre ? titre.split(/[|–—:]/)[0] : null, 'HOMEPAGE_HEADING', url);
    }
  }

  return out;
}

export interface CorroboratedIdentity {
  /** Le nom retenu, ou null si rien n'est assez établi. */
  name: string | null;
  confidence: number;
  /** Les signaux qui l'appuient. */
  supporting: IdentitySignal[];
  /** Les noms concurrents, quand plusieurs se disputent la place. */
  conflicting: string[];
  reason: string;
}

/**
 * Le nom que plusieurs sources indépendantes désignent.
 *
 * La confiance ne vient pas de la meilleure source : elle vient du nombre de
 * sources DISTINCTES qui disent la même chose. Une seule, si forte soit-elle,
 * plafonne à son propre poids et ne franchit pas 0,75 — le seuil au-delà
 * duquel un message peut être écrit.
 *
 * Les sources de corroboration seule — titre, H1 — n'ouvrent jamais un compte :
 * elles ne peuvent que renforcer un nom déjà déclaré ailleurs.
 */
export function corroborateIdentity(
  signals: readonly IdentitySignal[],
  domain: string,
): CorroboratedIdentity {
  if (signals.length === 0) {
    return { name: null, confidence: 0, supporting: [], conflicting: [], reason: 'aucun signal d’identité publié' };
  }

  const groupes = new Map<string, IdentitySignal[]>();
  for (const s of signals) {
    const cle = normalizeCompanyName(s.value);
    if (cle === '') continue;
    groupes.set(cle, [...(groupes.get(cle) ?? []), s]);
  }

  const candidats = [...groupes.entries()]
    .map(([cle, liste]) => {
      const sources = new Set(liste.map((s) => s.sourceType));
      const declarantes = [...sources].filter((t) => !CORROBORATION_SEULE.includes(t));
      const meilleur = Math.max(...liste.map((s) => s.confidence));
      /*
       * Deux sources déclarantes concordantes suffisent à dépasser le seuil ;
       * une seule n'y arrive pas. C'est exactement la règle demandée : la
       * confiance monte par concordance, pas par autorité.
       */
      const bonus = declarantes.length >= 3 ? 0.2 : declarantes.length === 2 ? 0.15 : 0;
      const corroboration = sources.size > declarantes.length && declarantes.length >= 1 ? 0.05 : 0;
      /*
       * Une source declarante isolee ne franchit jamais 0,75, corroborations
       * comprises.
       *
       * Sans ce plafond, un JSON-LD a 0,70 plus un titre de page a 0,05
       * atteignait exactement le seuil -- et une accroche relevee une seule
       * fois devenait une identite etablie. La regle annoncee est que la
       * confiance monte par concordance ; elle doit donc etre tenue par le
       * calcul, pas seulement par le commentaire.
       */
      const plafondIsole = 0.74;
      const proche = normalizeCompanyName(domain.replace(/\.[a-z.]{2,8}$/, '')).replace(/\s+/g, '');
      const colle = cle.replace(/\s+/g, '');
      // Le domaine ne prouve rien seul, mais un nom qui le reprend n'est pas
      // un hasard : il conforte une déclaration déjà faite ailleurs.
      const accord = declarantes.length >= 1 && (colle.includes(proche) || proche.includes(colle)) ? 0.05 : 0;
      return {
        cle,
        nom: liste[0]!.value,
        liste,
        declarantes: declarantes.length,
        confidence: declarantes.length === 0
          ? 0
          : Math.min(
              declarantes.length === 1 ? plafondIsole : 0.95,
              meilleur + bonus + corroboration + accord,
            ),
      };
    })
    .filter((x) => x.declarantes > 0)
    .sort((a, b) => b.confidence - a.confidence || b.declarantes - a.declarantes);

  if (candidats.length === 0) {
    return {
      name: null, confidence: 0, supporting: [], conflicting: [],
      reason: 'seuls des titres de page : aucune déclaration d’identité',
    };
  }

  const [premier, second] = candidats;
  const conflicting = candidats.slice(1).map((x) => x.nom);

  /*
   * Deux noms également soutenus ne se départagent pas.
   *
   * Choisir le premier reviendrait à tirer au sort, et un message adressé à la
   * mauvaise société est pire qu'un message non écrit.
   */
  if (second && second.confidence === premier!.confidence && second.declarantes === premier!.declarantes) {
    return {
      name: null, confidence: 0, supporting: premier!.liste, conflicting,
      reason: `signaux contradictoires : ${premier!.nom} et ${second.nom} également soutenus`,
    };
  }

  return {
    name: premier!.nom,
    confidence: Math.round(premier!.confidence * 100) / 100,
    supporting: premier!.liste,
    conflicting,
    reason: `${premier!.declarantes} source(s) déclarante(s) concordante(s) : `
      + [...new Set(premier!.liste.map((s) => s.sourceType))].join(', '),
  };
}
