import { z } from 'zod';
import { nowIso } from '@atlas/core';
import { contactUrlsFor, extractContacts } from '@atlas/intelligence';
import type { AtlasTool, ToolContext } from './tool-types.ts';
import { ok, fail } from './tool-types.ts';

/**
 * Recherche de coordonnées professionnelles publiques.
 *
 * Le principe tient en une phrase : ATLAS n'enregistre que ce qu'une page
 * publie réellement. L'outil va chercher les pages où une organisation publie
 * ses coordonnées — contact, Impressum, mentions légales — et relève ce qui s'y
 * trouve, avec l'URL exacte.
 *
 * Ce que l'outil ne fait pas, volontairement : deviner `prenom.nom@societe.de`.
 * Une adresse fabriquée est plausible et fausse, ce qui vaut moins que rien
 * pour une prise de contact commerciale.
 */

const MAX_PAGES = 4;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 400 * 1024;

/** Blocage SSRF identique à celui de http_fetch : les tools ne visent jamais l'hôte. */
const BLOCKED_HOST =
  /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|metadata\.)/i;

export const findContacts: AtlasTool<{ opportunityId: string }> = {
  name: 'find_contacts',
  description:
    "Cherche les coordonnées professionnelles publiques d'un candidat sur son propre site " +
    '(page contact, Impressum, mentions légales) et les enregistre avec leur URL. ' +
    "N'invente jamais d'adresse : ce qui n'est pas publié n'est pas enregistré.",
  category: 'research',
  inputSchema: {
    type: 'object',
    properties: { opportunityId: { type: 'string', maxLength: 40 } },
    required: ['opportunityId'],
    additionalProperties: false,
  },
  parse: z.object({ opportunityId: z.string().min(3).max(40) }),

  async execute(input, ctx) {
    if (!ctx.intelligence) return fail("Le pipeline n'est pas disponible sur ce déploiement.");

    const opportunity = ctx.repos.opportunities.get(input.opportunityId);
    if (!opportunity || (ctx.missionId && opportunity.missionId !== ctx.missionId)) {
      return fail(`Aucune opportunité « ${input.opportunityId} » dans cette mission.`);
    }

    const company = ctx.repos.companies.require(opportunity.companyId);
    const urls = contactUrlsFor(company.website, company.domain);
    if (urls.length === 0) {
      return ok(
        `Aucun site connu pour ${company.name} : impossible de chercher des coordonnées. ` +
          "Signalez-le plutôt que de proposer une adresse plausible.",
        { found: 0, reason: 'no-website' },
      );
    }

    const recorded: string[] = [];
    const visited: string[] = [];
    let pagesRead = 0;

    for (const url of urls) {
      if (pagesRead >= MAX_PAGES) break;
      if (ctx.signal?.aborted) break;

      const page = await fetchText(url, ctx);
      if (!page) continue;
      pagesRead++;
      visited.push(url);

      const contacts = extractContacts(page, { domain: company.domain });
      for (const contact of contacts) {
        if (recorded.some((line) => line.includes(contact.value))) continue;

        // La coordonnée est une observation : elle a été lue à cette URL.
        const evidence = ctx.intelligence.recordEvidence({
          missionId: ctx.missionId,
          opportunityId: opportunity.id,
          companyId: company.id,
          agentKey: ctx.agentKey,
          sourceKind: 'company-website',
          draft: {
            field: 'contact',
            claim: `${contact.kind === 'email' ? 'Adresse' : 'Téléphone'} publié(e) sur ${url} : ${contact.value}`,
            value: { kind: contact.kind, value: contact.value, generic: contact.generic },
            nature: 'observed',
            sourceRef: url,
            sourceTitle: `${company.name} — coordonnées publiques`,
            confidence: contact.generic ? 0.85 : 0.7,
          },
        });

        ctx.repos.companies.addContact({
          companyId: company.id,
          name: contact.generic ? 'Contact général' : 'Contact publié',
          role: contact.kind === 'email' ? 'Adresse publiée' : 'Téléphone publié',
          email: contact.kind === 'email' ? contact.value : null,
          phone: contact.kind === 'phone' ? contact.value : null,
          linkedin: null,
          confidence: contact.generic ? 0.85 : 0.7,
          evidenceId: evidence.id,
        });

        recorded.push(`${contact.kind === 'email' ? '✉' : '☎'} ${contact.value}${contact.generic ? ' (générique)' : ''} — ${url}`);
      }

      // Une boîte générique suffit à ouvrir une conversation B2B.
      if (recorded.some((line) => line.includes('générique'))) break;
    }

    if (recorded.length === 0) {
      return ok(
        `Aucune coordonnée publique trouvée pour ${company.name} après ${pagesRead} page(s) consultée(s) ` +
          `(${visited.join(', ') || 'aucune accessible'}). ` +
          "Consignez l'absence : c'est une information, pas un échec.",
        { found: 0, pagesRead, visited },
      );
    }

    return ok(
      `${recorded.length} coordonnée(s) publique(s) enregistrée(s) pour ${company.name} :\n${recorded.join('\n')}`,
      { found: recorded.length, pagesRead, visited },
    );
  },
};

/** Récupère le texte d'une page, ou null si elle n'est pas exploitable. */
async function fetchText(url: string, ctx: ToolContext): Promise<string | null> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
  if (BLOCKED_HOST.test(target.hostname)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  ctx.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'ATLAS-OS/1.0 (+agent de recherche autonome)',
        accept: 'text/html,text/plain',
      },
    });
    if (!response.ok) return null;

    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('text/html') && !type.includes('text/plain')) return null;

    const raw = (await response.text()).slice(0, MAX_BYTES);
    return decodeEntities(stripTags(raw));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // `mailto:` porte souvent l'adresse que le texte visible masque.
    .replace(/href="mailto:([^"?]+)[^"]*"/gi, ' $1 ')
    .replace(/href="tel:([^"]+)"/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Les sites masquent souvent l'arobase derrière une entité HTML. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#64;|&commat;/gi, '@')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));
}

export const CONTACT_TOOL_FETCH_TIMEOUT_MS = FETCH_TIMEOUT_MS;
export const contactToolNowIso = nowIso;
