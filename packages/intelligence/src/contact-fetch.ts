import { withDeadline, describeError } from '@atlas/core';
import type { Logger } from '@atlas/core';

/**
 * Récupérer des pages en gardant leur HTML.
 *
 * La récupération de découverte dépouille le HTML — scripts, styles, nav, et
 * surtout `<footer>` — parce que tout cela entre dans le contexte du modèle et
 * y reste. Pour chercher des coordonnées, c'est exactement l'inverse : le pied
 * de page est souvent le seul endroit où l'adresse figure, et un `mailto:` vit
 * dans un attribut que le nettoyage efface.
 *
 * D'où deux fonctions plutôt qu'un drapeau : les deux besoins sont opposés, et
 * un appelant qui se trompe de mode obtient un silence, pas une erreur.
 */

export interface RawPage {
  url: string;
  html: string;
}

/**
 * Pourquoi une page n'a pas ete lue.
 *
 * La distinction n'est pas cosmetique : un 404 dit qu'une page n'existe pas, et
 * les vingt suivantes du meme site existent peut-etre. Un refus de connexion,
 * lui, dit que le site entier ne repond pas — insister coute dix secondes par
 * tentative pour rien. Confondre les deux fait soit abandonner un site vivant,
 * soit s'acharner sur un site mort.
 */
export type FetchErrorKind =
  | 'CONNECTION_REFUSED'
  | 'TIMEOUT'
  | 'DNS_FAILURE'
  | 'TLS_FAILURE'
  | 'HTTP_4XX'
  | 'HTTP_5XX'
  | 'BLOCKED'
  | 'OTHER';

/** Les pannes qui condamnent l'hote entier, par opposition a une seule page. */
const PANNES_DE_DOMAINE: readonly FetchErrorKind[] = [
  'CONNECTION_REFUSED', 'TIMEOUT', 'DNS_FAILURE', 'TLS_FAILURE',
];

export interface RawFetchOutcome {
  pages: RawPage[];
  failures: Array<{ url: string; reason: string; kind: FetchErrorKind }>;
  /** Les hotes abandonnes en cours de route, avec la panne qui les a fermes. */
  aborted: Array<{ host: string; kind: FetchErrorKind; attempts: number }>;
  /** Combien d'adresses ont ete tentees, abandons compris. */
  attempts: number;
  /**
   * Le temps economise par l'abandon, estime.
   *
   * Chaque adresse non tentee aurait coute au pire un delai d'attente complet.
   * L'estimation est donc haute et le dit — mais elle a un ordre de grandeur
   * juste : quatorze tentatives a dix secondes sur un hote mort, c'est deux
   * minutes et demie de cycle pour zero page.
   */
  timeSavedMsEstimate: number;
}

/**
 * Nommer la panne a partir de ce que le moteur a rendu.
 *
 * Les messages varient d'une version de Node a l'autre ; on lit donc le code
 * de cause quand il existe, et le texte seulement en dernier recours.
 */
export function classifyFetchError(error: unknown, status?: number): FetchErrorKind {
  if (status !== undefined) {
    if (status >= 500) return 'HTTP_5XX';
    if (status >= 400) return 'HTTP_4XX';
  }
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause?.code
    ?? (error as { code?: string } | undefined)?.code
    ?? '';
  const texte = String(
    (error as { message?: string } | undefined)?.message ?? error ?? '',
  ).toLowerCase();

  if (cause === 'ECONNREFUSED' || texte.includes('econnrefused')) return 'CONNECTION_REFUSED';
  if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN' || texte.includes('enotfound')) return 'DNS_FAILURE';
  if (cause.startsWith('ERR_TLS') || cause === 'CERT_HAS_EXPIRED' || texte.includes('certificate')
    || texte.includes('tls')) return 'TLS_FAILURE';
  /*
   * Le delai d'ATLAS porte le code 'TIMEOUT' et le message « … exceeded 12000ms
   * and was cancelled ». Ni l'un ni l'autre ne correspondait aux motifs
   * attendus : un vrai timeout ressortait en OTHER, donc hors des pannes qui
   * ferment un domaine — le disjoncteur ne se declenchait jamais sur la panne
   * la plus frequente. Releve sur robaut.fr lors d'un cycle reel.
   */
  if (cause === 'ETIMEDOUT' || cause === 'UND_ERR_CONNECT_TIMEOUT' || cause === 'TIMEOUT'
    || texte.includes('timeout') || texte.includes('expir') || texte.includes('abort')
    || texte.includes('cancelled') || texte.includes('exceeded')) return 'TIMEOUT';
  if (cause === 'ECONNRESET' || texte.includes('econnreset')) return 'CONNECTION_REFUSED';
  return 'OTHER';
}

export interface RawFetchOptions {
  logger: Logger;
  timeoutMs: number;
  /** Combien de pages au maximum. Lire un site n'est pas l'explorer. */
  maxPages: number;
  /**
   * Pannes de transport consecutives avant d'abandonner un hote.
   *
   * Trois par defaut : une panne isolee arrive, deux peuvent etre un reseau
   * capricieux, trois disent que l'hote ne repond plus. En dessous on
   * abandonnerait des sites vivants ; au-dessus on paie le delai d'attente
   * autant de fois.
   */
  maxDomainFailures?: number;
}

/** Hôtes internes, jamais joignables depuis ATLAS. */
const BLOCKED_HOST =
  /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|metadata\.)/i;

const MAX_BYTES = 512 * 1024;

export async function fetchRawPages(
  urls: readonly string[],
  options: RawFetchOptions,
): Promise<RawFetchOutcome> {
  const pages: RawPage[] = [];
  const failures: RawFetchOutcome['failures'] = [];
  const aborted: RawFetchOutcome['aborted'] = [];

  /**
   * Le disjoncteur, par hôte.
   *
   * Relevé sur un cycle réel : `schaeffler.fr` a refusé quatorze connexions
   * d'affilée, dix secondes chacune. Deux minutes trente de cycle pour zéro
   * page, parce que la file des chemins conventionnels se déroulait jusqu'au
   * bout sur un hôte qui ne répondait plus.
   *
   * Seules les pannes de transport comptent. Un 404 dit qu'une page n'existe
   * pas — les vingt suivantes existent peut-être, et couper là ferait perdre
   * des sites vivants dont un seul chemin est faux.
   *
   * Le compteur se remet à zéro dès qu'une page passe : un site lent qui répond
   * une fois sur trois reste lisible.
   */
  const echecs = new Map<string, { kind: FetchErrorKind; n: number }>();
  const ferme = new Set<string>();
  let attempts = 0;
  let ignorees = 0;

  const noter = (host: string, kind: FetchErrorKind): void => {
    if (!PANNES_DE_DOMAINE.includes(kind)) return;
    const courant = echecs.get(host);
    // Deux pannes de natures différentes ne s'additionnent pas : c'est la
    // répétition d'une même panne qui signale un hôte mort.
    const suivant = courant && courant.kind === kind
      ? { kind, n: courant.n + 1 }
      : { kind, n: 1 };
    echecs.set(host, suivant);

    if (suivant.n >= (options.maxDomainFailures ?? 3)) {
      ferme.add(host);
      aborted.push({ host, kind, attempts: suivant.n });
      options.logger.warn('domaine abandonné', {
        host, kind, attempts: suivant.n, reason: 'DOMAIN_FETCH_ABORTED',
      });
    }
  };

  for (const raw of urls) {
    if (pages.length >= options.maxPages) break;

    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      failures.push({ url: raw, reason: 'URL invalide', kind: 'OTHER' });
      continue;
    }

    // L'hôte est fermé : on ne le retente pas, et on ne pénalise personne
    // d'autre — le disjoncteur est strictement par hôte.
    if (ferme.has(target.hostname)) {
      ignorees += 1;
      failures.push({
        url: target.href, reason: 'DOMAIN_FETCH_ABORTED', kind: 'CONNECTION_REFUSED',
      });
      continue;
    }

    if (target.protocol !== 'https:') {
      failures.push({ url: raw, reason: 'seul https est autorisé', kind: 'BLOCKED' });
      continue;
    }
    if (BLOCKED_HOST.test(target.hostname)) {
      failures.push({ url: raw, reason: 'hôte interne ou privé', kind: 'BLOCKED' });
      continue;
    }

    attempts += 1;
    try {
      const response = await withDeadline(
        (signal) =>
          fetch(target, {
            signal,
            redirect: 'follow',
            headers: {
              'user-agent': 'ATLAS-OS/1.0 (+autonomous research agent)',
              accept: 'text/html,application/xhtml+xml',
            },
          }),
        { ms: options.timeoutMs, label: `page ${target.hostname}` },
      );
      if (!response.ok) {
        const kind = classifyFetchError(null, response.status);
        failures.push({ url: target.href, reason: `HTTP ${response.status}`, kind });
        noter(target.hostname, kind);
        continue;
      }
      // Une page qui passe innocente l'hôte : un site lent redevient lisible.
      echecs.delete(target.hostname);
      pages.push({
        url: response.url || target.href,
        html: (await response.text()).slice(0, MAX_BYTES),
      });
    } catch (err) {
      const kind = classifyFetchError(err);
      options.logger.warn('page non récupérée', {
        host: target.hostname, kind, error: describeError(err),
      });
      failures.push({ url: target.href, reason: describeError(err), kind });
      noter(target.hostname, kind);
    }
  }

  return {
    pages,
    failures,
    aborted,
    attempts,
    // Haute par construction : chaque adresse épargnée aurait pu coûter le
    // délai complet. L'ordre de grandeur, lui, est juste.
    timeSavedMsEstimate: ignorees * options.timeoutMs,
  };
}
