/**
 * Un message doit se lire comme écrit par quelqu'un qui a regardé l'entreprise.
 *
 * La règle complète vit dans `docs/SALES_HUMANIZATION_POLICY.md` — source de
 * vérité unique. Ce module n'en est pas une copie : il en rend exécutable la
 * partie vérifiable, et rien de plus. Ce qui relève du jugement reste dans le
 * document.
 *
 * Le contrôle vient APRÈS la vérification factuelle, jamais à sa place. Un
 * message chaleureux et faux reste faux : contact observé, identité, ICP,
 * doublon, DO_NOT_CONTACT et faits sourcés gardent le dernier mot, et aucune
 * règle d'ici ne les assouplit.
 *
 * Le verdict est volontairement peu bavard. Bloquer sur un détail de style
 * ferait de cette garde un obstacle plutôt qu'un filet, et la première réaction
 * serait de la contourner. Elle n'arrête que ce qui se lit comme une machine.
 */

export type HumanizationVerdict = 'PASS' | 'NEEDS_EDIT' | 'BLOCKED';

export interface HumanizationCheck {
  verdict: HumanizationVerdict;
  /** Ce qui se lit comme une machine. */
  blockers: string[];
  /** Ce qui gagnerait à changer sans être rédhibitoire. */
  remarks: string[];
  wordCount: number;
}

export interface MessageToCheck {
  body: string;
  subject?: string | null;
  /** Premier contact ou relance : les longueurs et les attentes diffèrent. */
  kind: 'FIRST_TOUCH' | 'FOLLOW_UP' | 'REPLY';
  /** Les messages déjà envoyés à cette entreprise, pour ne rien répéter. */
  previousMessages?: readonly string[];
}

/**
 * Les tournures qui trahissent un gabarit.
 *
 * Chacune vient d'un message réel ou d'une formule que le document nomme
 * explicitement. La liste est courte à dessein : allongée, elle finirait par
 * bloquer des phrases françaises ordinaires.
 */
const FORMULES_MORTES: ReadonlyArray<{ motif: RegExp; quoi: string }> = [
  { motif: /je me permets de vous contacter/i, quoi: '« je me permets de vous contacter »' },
  { motif: /dans le cadre de (?:notre|nos|la mise)/i, quoi: '« dans le cadre de… »' },
  { motif: /(?:notre|une) (?:solution|approche|offre) innovante/i, quoi: '« solution innovante »' },
  { motif: /r[ée]volutionnaire/i, quoi: '« révolutionnaire »' },
  { motif: /gr[âa]ce [àa] l['’]intelligence artificielle/i, quoi: '« grâce à l’intelligence artificielle »' },
  { motif: /n['’]h[ée]sitez pas [àa] (?:me|nous) contacter/i, quoi: '« n’hésitez pas à me contacter »' },
  { motif: /je souhaiterais vous pr[ée]senter/i, quoi: '« je souhaiterais vous présenter »' },
  { motif: /leader (?:mondial|europ[ée]en) incontest/i, quoi: 'superlatif de pitch' },
];

/**
 * Le vocabulaire interne, qui n'a rien à faire dans un courriel.
 *
 * Le prospect achète un résultat, pas une architecture. Ces mots-là décrivent
 * la machine, et les lire suffit à comprendre qu'on parle à une machine.
 */
const VOCABULAIRE_INTERNE: ReadonlyArray<{ motif: RegExp; quoi: string }> = [
  { motif: /\b(?:intelligence artificielle|\bIA\b|agent(?:s)? IA|LLM|mod[èe]le de langage)\b/i, quoi: 'IA / modèle' },
  { motif: /\b(?:algorithme|scoring|pipeline|automatis(?:ation|é|ee))\b/i, quoi: 'vocabulaire technique' },
  { motif: /\bsearch fabric\b/i, quoi: 'Search Fabric' },
  { motif: /\b(?:notre syst[èe]me|notre plateforme|notre outil) (?:analyse|scanne|parcourt)/i, quoi: 'description de l’outil' },
];

/** Les emojis, quel qu'en soit le bloc Unicode. */
const EMOJI = /\p{Extended_Pictographic}/u;

/** Les longueurs attendues, par nature de message. */
const LONGUEURS: Record<MessageToCheck['kind'], { min: number; max: number }> = {
  /*
   * 55 en plancher, 140 en plafond.
   *
   * La politique vise 70 a 140 mots, mais elle interdit aussi d'allonger un
   * message pour atteindre un compte. Un premier contact naturel de 65 mots --
   * « J'ai vu sur votre page contact que K2TEC recherche des distributeurs. » --
   * est bon ; le signaler pousserait a le diluer, ce que la regle refuse.
   *
   * Le plafond, lui, garde tout son role : c'est un brouillon automatique de
   * 170 mots qui a motive ce chantier.
   */
  FIRST_TOUCH: { min: 55, max: 140 },
  /*
   * Aucun minimum rigide sur une relance.
   *
   * Une relance courte est acceptable, et souvent meilleure. Signaler « trop
   * court » pousserait a rallonger pour atteindre un compte -- exactement ce que
   * la politique interdit. Seul l'exces est remarque.
   */
  FOLLOW_UP: { min: 0, max: 90 },
  // Une réponse s'adapte à ce qu'on lui demande : seul l'excès est signalé.
  REPLY: { min: 10, max: 200 },
};

const mots = (t: string): number => t.trim().split(/\s+/).filter(Boolean).length;

/** Le corps sans la signature : elle ne compte ni en longueur ni en style. */
function sansSignature(body: string): string {
  return body.replace(/\n\s*Bien (?:à vous|cordialement),?\s*\n[\s\S]*$/i, '').trim();
}

/** Les URL présentes dans le texte. */
function urls(t: string): string[] {
  return [...t.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
}

/**
 * Le premier paragraphe parle-t-il de cette entreprise, ou de nous ?
 *
 * C'est le test le plus utile du document : les deux premières lignes doivent
 * faire penser « cette personne a vraiment regardé mon entreprise ». Un message
 * qui commence par ce que nous faisons a déjà perdu.
 */
function ouvertureCentreeSurNous(premier: string): boolean {
  const t = premier.toLowerCase();
  const surEux = /(?:j['’]ai (?:vu|regard[ée]|remarqu[ée]|lu)|vous (?:cherchez|recherchez|proposez|fabriquez|d[ée]veloppez|vendez)|votre (?:site|page|catalogue|gamme|r[ée]seau))/.test(t);
  const surNous = /^(?:je (?:r[ée]alise|propose|d[ée]veloppe|travaille sur|suis)|nous (?:proposons|sommes|d[ée]veloppons))/.test(t.replace(/^bonjour[^,]*,\s*/i, '').trim());
  return surNous && !surEux;
}

/**
 * Le message pose-t-il une question à laquelle on a envie de répondre ?
 *
 * Une porte de sortie — « répondez non merci » — est nécessaire mais ne suffit
 * pas : seule, elle fait du refus la seule réponse évidente.
 */
function questionUtile(corps: string): { present: boolean; seulementSortie: boolean } {
  const questions = corps.split('\n').filter((l) => l.includes('?'));
  const sortie = /non merci|pas le (?:moment|sujet)|ne recevrez plus/i;
  const utiles = questions.filter((q) => !sortie.test(q));
  return { present: questions.length > 0, seulementSortie: questions.length > 0 && utiles.length === 0 };
}

/**
 * Le message se lit-il comme écrit par une personne ?
 *
 * `BLOCKED` est réservé à ce qui trahit franchement la machine. Tout le reste
 * est `NEEDS_EDIT` : un humain relit et tranche, ce qui est exactement le rôle
 * d'Approvals.
 */
export function checkHumanization(input: MessageToCheck): HumanizationCheck {
  const corps = sansSignature(input.body);
  const blockers: string[] = [];
  const remarks: string[] = [];
  const n = mots(corps);

  for (const f of FORMULES_MORTES) {
    if (f.motif.test(corps)) blockers.push(`formule de gabarit : ${f.quoi}`);
  }
  for (const v of VOCABULAIRE_INTERNE) {
    if (v.motif.test(corps)) blockers.push(`parle de l’outil, pas du résultat : ${v.quoi}`);
  }
  if (EMOJI.test(corps)) blockers.push('emoji dans un message commercial');

  const paragraphes = corps.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const premier = paragraphes.find((p) => !/^bonjour/i.test(p) || p.length > 30) ?? paragraphes[0] ?? '';
  if (ouvertureCentreeSurNous(premier)) {
    blockers.push('l’ouverture parle de nous avant de parler d’eux');
  }

  const liens = urls(corps);
  if (liens.length > 1) remarks.push(`${liens.length} URL dans le corps — une suffit, souvent aucune`);

  const q = questionUtile(corps);
  if (!q.present) remarks.push('aucune question : rien n’invite à répondre');
  else if (q.seulementSortie) remarks.push('la seule question est la porte de sortie');

  const bornes = LONGUEURS[input.kind];
  if (n > bornes.max) remarks.push(`${n} mots — au-delà de ${bornes.max} pour ce type de message`);
  if (n < bornes.min) remarks.push(`${n} mots — en deçà de ${bornes.min}, le message dit peu`);

  /*
   * Une relance qui répète le premier message n'est pas une relance.
   *
   * La comparaison porte sur les phrases entières : deux messages partagent
   * toujours « Bonjour » et une signature, ce qui ne prouve rien.
   */
  for (const ancien of input.previousMessages ?? []) {
    const phrases = sansSignature(ancien)
      .split(/(?<=[.!?])\s+/)
      .map((p) => p.trim())
      .filter((p) => p.split(/\s+/).length >= 8);
    const reprises = phrases.filter((p) => corps.includes(p));
    if (reprises.length > 0) {
      blockers.push(`${reprises.length} phrase(s) reprises mot pour mot d’un message précédent`);
      break;
    }
  }

  const verdict: HumanizationVerdict = blockers.length > 0
    ? 'BLOCKED'
    : remarks.length > 0 ? 'NEEDS_EDIT' : 'PASS';

  return { verdict, blockers, remarks, wordCount: n };
}

/**
 * La salutation, d'après ce qui est réellement établi sur la personne.
 *
 * Le prénom seul quand les quatre conditions du document tiennent ; « Bonjour, »
 * dès qu'un doute existe. Un nom inventé ou un rôle supposé n'ont pas de place
 * ici : mieux vaut une salutation neutre qu'une familiarité fausse.
 */
/**
 * L'adresse désigne-t-elle cette personne, ou une boîte de service ?
 *
 * Relevé sur k2tec.com : Pascal Sartori est bien dirigeant, son nom est publié,
 * son rôle est pertinent — mais l'adresse retenue est `contact@k2tec.com`, une
 * boîte générique que lit peut-être un assistant. Écrire « Bonjour Pascal » à
 * un guichet partagé se voit immédiatement : c'est la marque d'un publipostage
 * qui a trouvé un nom quelque part et l'a collé sur la première adresse venue.
 *
 * La partie locale doit donc porter quelque chose de la personne : son prénom,
 * son nom, ou une initiale suivie du nom.
 */
export function addressMatchesPerson(email: string | null | undefined, name: string | null | undefined): boolean {
  const local = (email ?? '').split('@')[0]?.toLowerCase() ?? '';
  const complet = (name ?? '').trim();
  if (local === '' || complet === '') return false;

  const plat = (t: string) => t.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const parties = plat(complet).split(/[^a-z]+/).filter((x) => x.length >= 2);
  if (parties.length === 0) return false;
  const jeton = plat(local).replace(/[^a-z]+/g, ' ').trim();
  if (jeton === '') return false;

  const prenom = parties[0]!;
  const nom = parties[parties.length - 1]!;
  const colle = jeton.replace(/\s+/g, '');

  // « pascal », « sartori », « pascal.sartori », « psartori », « sartorip »…
  if (colle === prenom || colle === nom) return true;
  if (colle === prenom + nom || colle === nom + prenom) return true;
  if (colle === prenom[0] + nom || colle === nom + prenom[0]) return true;
  if (parties.length >= 2 && colle.includes(nom) && colle.includes(prenom[0]!)) return true;
  return false;
}

/**
 * La salutation, d'après ce qui est réellement établi sur la personne.
 *
 * Le prénom seul quand les cinq conditions de la politique tiennent ;
 * « Bonjour, » dès qu'une seule manque. Un nom inventé, un rôle supposé ou une
 * familiarité adressée à un guichet n'ont pas leur place : mieux vaut une
 * salutation neutre qu'une fausse proximité.
 */
export function greetingFor(contact: {
  name?: string | null;
  role?: string | null;
  observed?: boolean;
  /** L'intention du canal, telle que `classifyContactIntent` la rend. */
  intent?: string | null;
  suitability?: string | null;
  /** L'adresse réellement utilisée pour écrire. */
  email?: string | null;
} | null): string {
  const NEUTRE = 'Bonjour,';
  if (!contact) return NEUTRE;
  const nom = (contact.name ?? '').trim();
  if (nom === '' || contact.observed !== true) return NEUTRE;
  if (!contact.role || contact.role.trim() === '') return NEUTRE;
  if (contact.intent === 'PERSONAL' || contact.suitability === 'LOW') return NEUTRE;

  /*
   * La cinquieme condition : l'adresse doit designer la personne.
   *
   * Sans elle, « Bonjour Pascal » partait vers `contact@k2tec.com`.
   */
  if (!addressMatchesPerson(contact.email, nom)) return NEUTRE;

  // Le prénom seul : « Bonjour M. Pascal Sartori » sonne comme un publipostage.
  const prenom = nom.split(/\s+/)[0] ?? '';
  if (prenom.length < 2 || !/^[A-ZÀ-Ý][a-zà-ÿ'’-]+$/.test(prenom)) return NEUTRE;
  return `Bonjour ${prenom},`;
}
