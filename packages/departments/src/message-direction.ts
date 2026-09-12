/**
 * D'où vient ce message ?
 *
 * La question paraît triviale, et son absence a produit la panne commerciale la
 * plus coûteuse du projet. Rien, nulle part, ne distinguait un message reçu d'un
 * message que nous avions nous-mêmes envoyé : la requête Gmail listait toute la
 * boîte sans filtre de direction, le rapprochement se faisait par fil — un fil
 * que nous connaissions *parce que nous l'avions ouvert* — et la classification
 * lisait le sujet et le corps sans jamais regarder l'expéditeur.
 *
 * Conséquence : nos propres courriers de prospection revenaient dans le système
 * classés `REPLIED`. Quatre entreprises figuraient au tableau des réponses à
 * traiter alors que leur seul message était le nôtre. Le tableau ne se trompait
 * pas un peu, il annonçait l'inverse de la réalité — et sur cette base, on
 * relance quelqu'un qui n'a jamais répondu, ou on croit avoir des touches qu'on
 * n'a pas.
 *
 * Trois preuves, prises ensemble parce qu'aucune ne suffit seule :
 *
 *   · l'étiquette `SENT` du fournisseur, la plus directe — Gmail la pose
 *     lui-même, sans dépendre du formatage d'un en-tête ;
 *   · l'adresse d'expédition comparée à la nôtre, qui reste vraie chez un
 *     fournisseur qui n'étiquette pas ;
 *   · l'absence de l'étiquette `INBOX`, qui distingue un brouillon ou un envoi
 *     d'un courrier réellement reçu.
 *
 * En cas de doute, le message est traité comme sortant. Un vrai message entrant
 * écarté à tort se retrouve dans « à lire » et sera vu ; un message sortant pris
 * pour une réponse fabrique une réalité commerciale fausse, et personne ne va
 * la vérifier.
 */

export type MessageDirection = 'INBOUND' | 'OUTBOUND';

export interface DirectionVerdict {
  direction: MessageDirection;
  /** Ce qui a tranché, en clair, pour que la décision se relise. */
  reason: string;
}

export interface DirectionInput {
  from: string;
  labels?: readonly string[];
  /** L'adresse de la boîte qu'ATLAS surveille. */
  mailbox: string;
}

/** Extrait l'adresse d'un en-tête `From`, avec ou sans nom affiché. */
export function addressOf(header: string): string {
  const angled = header.match(/<([^>]+)>/);
  return (angled?.[1] ?? header).trim().toLowerCase();
}

/**
 * Deux adresses désignent-elles la même boîte ?
 *
 * Les alias `+quelque-chose` de Gmail et les points dans la partie locale
 * pointent tous vers la même boîte : les ignorer ferait passer un envoi fait
 * depuis un alias pour un message venu de l'extérieur.
 */
export function sameMailbox(a: string, b: string): boolean {
  const normalise = (raw: string): string => {
    const [local = '', domain = ''] = addressOf(raw).split('@');
    const base = local.split('+')[0] ?? '';
    const flat = domain === 'gmail.com' || domain === 'googlemail.com'
      ? base.replace(/\./g, '')
      : base;
    return `${flat}@${domain}`;
  };
  return normalise(a) === normalise(b) && addressOf(a).includes('@');
}

export function directionOf(input: DirectionInput): DirectionVerdict {
  const labels = input.labels ?? [];

  // 1. L'étiquette du fournisseur. La preuve la plus directe qui soit.
  if (labels.includes('SENT')) {
    return { direction: 'OUTBOUND', reason: 'étiquette SENT posée par le fournisseur' };
  }
  if (labels.includes('DRAFT')) {
    return { direction: 'OUTBOUND', reason: 'brouillon, jamais reçu de personne' };
  }

  /**
   * 2. Sans boîte connue, la garde se ferme.
   *
   * `GMAIL_USER` absent rendait `INBOUND` pour tout : la garde de direction se
   * désactivait en silence, et nos propres messages redevenaient des réponses —
   * exactement la panne qu'elle existe pour empêcher. Une garde qui s'ouvre
   * quand sa configuration manque ne garde rien.
   */
  if (!input.mailbox.trim()) {
    return {
      direction: 'OUTBOUND',
      reason: 'boîte de référence inconnue : la direction ne se prouve pas',
    };
  }

  // 3. L'expéditeur. Vraie même chez un fournisseur qui n'étiquette pas.
  if (sameMailbox(input.from, input.mailbox)) {
    return {
      direction: 'OUTBOUND',
      reason: `expédié depuis notre propre boîte (${addressOf(input.from)})`,
    };
  }

  // 4. Un message sans expéditeur lisible ne se prouve pas entrant.
  if (!addressOf(input.from).includes('@')) {
    return { direction: 'OUTBOUND', reason: 'expéditeur illisible : la direction ne se prouve pas' };
  }

  return { direction: 'INBOUND', reason: `reçu de ${addressOf(input.from)}` };
}

/** Raccourci de lecture : ce message vient-il de l'extérieur ? */
export const isInbound = (input: DirectionInput): boolean =>
  directionOf(input).direction === 'INBOUND';
