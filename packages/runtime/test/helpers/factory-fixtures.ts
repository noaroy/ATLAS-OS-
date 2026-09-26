import type { Repositories } from '../../../data/src/index.ts';
import type { FetchPages } from '../../src/revenue-factory.ts';

/**
 * Des sites d'entreprise figés, pour éprouver la fabrique sans réseau.
 *
 * Les pages disent ce que disent de vrais sites de PME industrielles : une
 * activité, un appel à distributeurs, l'export, une adresse commerciale sur la
 * page de contact. Rien n'y est deviné par la fabrique : ce qu'elle retient
 * doit être lisible ici, mot pour mot.
 */

export type SiteKind = 'FULL' | 'FORM_ONLY' | 'FREEMAIL' | 'NO_FACTS' | 'DOWN' | 'NO_SIGNAL' | 'PERSONAL_ONLY';

export function site(domain: string, name: string, kind: SiteKind = 'FULL'): Map<string, string> {
  const pages = new Map<string, string>();
  if (kind === 'DOWN') return pages;
  const origin = `https://${domain}`;
  const facts = kind === 'NO_FACTS' || kind === 'NO_SIGNAL'
    ? `<p>${name} est une entreprise familiale installée dans la région.</p>`
    : `<p>${name} conçoit et fabrique des équipements industriels pour les ateliers de production.</p>
       <p>Nous recherchons des distributeurs pour commercialiser nos équipements en Europe du Nord.</p>
       <p>Nous exportons nos machines vers plus de vingt pays grâce à notre service export.</p>`;
  pages.set(`${origin}/`, `<html><head><title>${name}</title></head><body>
    <h1>${name}</h1>${facts}
    <footer><a href="${origin}/contact">Nous contacter</a></footer></body></html>`);
  const contact = kind === 'FULL' || kind === 'NO_FACTS'
    ? `<p>Service commercial : <a href="mailto:commercial@${domain}">commercial@${domain}</a></p>`
    : kind === 'FREEMAIL'
      ? `<p>Écrivez-nous : <a href="mailto:${name.toLowerCase().replace(/\W/g, '')}@gmail.com">${name.toLowerCase().replace(/\W/g, '')}@gmail.com</a></p>`
      : kind === 'PERSONAL_ONLY'
        ? `<p>Délégué à la protection des données : <a href="mailto:rgpd@${domain}">rgpd@${domain}</a></p>`
        : kind === 'NO_SIGNAL'
          ? `<p>Bienvenue.</p>`
          : `<form action="/contact" method="post"><input name="email"><textarea name="message"></textarea><button>Envoyer</button></form>`;
  pages.set(`${origin}/contact`, `<html><body><h1>Contact</h1>${contact}</body></html>`);
  return pages;
}

/** Une lecture de pages figée : ce qui existe revient, le reste échoue — avec une latence mesurable. */
export function fixtureFetch(sites: ReadonlyArray<Map<string, string>>, options: { latencyMs?: number; counter?: { pages: number; calls: number } } = {}): FetchPages {
  const all = new Map<string, string>();
  for (const s of sites) for (const [url, html] of s) all.set(url, html);
  return async (urls, maxPages) => {
    if (options.counter) options.counter.calls += 1;
    if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
    const pages: Array<{ url: string; html: string }> = [];
    const failures: Array<{ url: string }> = [];
    for (const url of urls) {
      if (pages.length >= maxPages) break;
      const html = all.get(url);
      if (html) pages.push({ url, html });
      else failures.push({ url });
    }
    if (options.counter) options.counter.pages += pages.length;
    return { pages, failures };
  };
}

/** Un prospect tel que la découverte le verse : un nom, un domaine, un site — rien d'autre. */
export function discovered(repos: Repositories, domain: string, name: string, at = '2026-09-26T08:00:00.000Z') {
  return repos.sales.discover({
    batchId: 'xpn_fixture', companyName: name, domain, website: `https://${domain}`,
    sourceUrl: `https://${domain}/`, pageType: 'OFFICIAL_COMPANY_SITE', searchProvider: 'expansion', discoveredAt: at,
  }).prospect;
}

/** Les partenaires publiés par le prospect : ce que l'expansion aurait trouvé. */
export function partners(repos: Repositories, domain: string, targets: ReadonlyArray<{ domain: string; name: string; type?: string; status?: 'VERIFIED' | 'INFERRED'; trust?: 'OFFICIAL' | 'SECONDARY'; confidence?: number }>) {
  for (const t of targets) {
    repos.expansion.addRelationship({
      runId: null, sourceKey: domain, sourceName: domain, sourceKind: 'COMPANY',
      targetKey: t.domain, targetName: t.name, relationshipType: t.type ?? 'DISTRIBUTOR',
      confidence: t.confidence ?? 0.85, status: t.status ?? 'VERIFIED',
      evidenceUrl: `https://${domain}/partenaires`, evidenceSummary: `${t.name} distribue les équipements de la société en France.`,
      sourceMethod: 'fixture', sourceTrust: t.trust ?? 'OFFICIAL', country: 'FR', sourceDate: null,
    });
  }
}
