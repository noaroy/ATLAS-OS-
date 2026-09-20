import { SELF_TEST_DOMAIN } from './manual-send-guard.ts';

/**
 * Les entités techniques : ce qui existe pour éprouver ATLAS, pas pour lui
 * rapporter.
 *
 * Le self-test Gmail (v4.5.x) a laissé une vraie conversation, un vrai
 * accusé d'envoi, une vraie réponse — sur `selftest.atlas.invalid`. Ce sont
 * des faits, gardés pour l'audit. Mais un tableau de bord qui les compte
 * comme un contact, une réponse chaude, une conversation à traiter, fait
 * lire un revenu qui n'existe pas et fait travailler le fondateur sur
 * lui-même : relevé en production, l'Autopilot plaçait « traiter 1
 * conversation où quelqu'un attend une réponse » en tête de ses priorités.
 *
 * Un seul prédicat, réutilisé partout où l'on interprète commercialement —
 * jamais recopié en comparaisons de chaînes. Étroit à dessein : le domaine
 * réservé et ses sous-domaines. Ni `gmail.com`, ni une adresse réelle, ni un
 * `.invalid` quelconque : un prospect de test qui ressemble à un prospect
 * doit continuer de compter comme tel dans les épreuves qui le veulent.
 */

const normalise = (domain: string | null | undefined): string =>
  (domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? '';

export function isTechnicalDomain(domain: string | null | undefined): boolean {
  const host = normalise(domain);
  return host === SELF_TEST_DOMAIN || host.endsWith(`.${SELF_TEST_DOMAIN}`);
}

/** Une conversation, un prospect, une ligne de registre : tout ce qui porte un domaine. */
export function isTechnicalEntity(entity: { domain?: string | null; canonicalDomain?: string | null }): boolean {
  return isTechnicalDomain(entity.canonicalDomain ?? entity.domain ?? null);
}
