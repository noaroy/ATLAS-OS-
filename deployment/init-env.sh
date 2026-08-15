#!/usr/bin/env bash
#
# ATLAS OS — création du .env sur le serveur.
#
#   bash deployment/init-env.sh
#
# Les secrets naissent ici, sur la machine qui les utilisera, et n'en sortent
# jamais. Rien n'est transféré depuis un poste de travail : un secret qui a
# voyagé est un secret qu'il faut considérer comme connu.
#
# Deux catégories, traitées différemment :
#
#   Ce que la machine peut décider seule — secret de session, secret SearXNG,
#   mot de passe n8n — est tiré au hasard. Personne n'a besoin de les choisir,
#   et personne ne devrait avoir à s'en souvenir.
#
#   Ce qui vous appartient — clé Anthropic, identifiants fondateur, domaine —
#   vous est demandé. La saisie est masquée et n'apparaît nulle part.
#
# Idempotent : relancer ne remplace aucune valeur déjà renseignée. Seules les
# valeurs absentes ou restées à leur marque-place sont traitées.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
EXAMPLE="${ROOT_DIR}/.env.example"

if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; N=$'\e[0m'; else B=''; G=''; Y=''; N=''; fi
ok()   { printf '  %s✓%s %s\n' "${G}" "${N}" "$*"; }
warn() { printf '  %s!%s %s\n' "${Y}" "${N}" "$*"; }
die()  { printf '\n  ✗ %s\n' "$*" >&2; exit 1; }

printf '%sATLAS OS — configuration des secrets sur ce serveur%s\n\n' "${B}" "${N}"

[[ -f "${EXAMPLE}" ]] || die ".env.example est absent ; le dépôt est incomplet"

# Les marques-place de .env.example. Elles passent la validation de format —
# « change-me-to-a-long-random-value-please » fait bien plus de 16 caractères —
# et déploieraient donc un ATLAS parfaitement fonctionnel avec un secret de
# session que tout le monde peut lire dans le dépôt.
is_placeholder() {
  case "$1" in
    ''|change-me|change-me-*|'your-key-here'|'<'*'>') return 0 ;;
    *) return 1 ;;
  esac
}

if [[ ! -f "${ENV_FILE}" ]]; then
  install -m 0600 "${EXAMPLE}" "${ENV_FILE}"
  ok ".env créé depuis .env.example (droits 0600)"
else
  chmod 0600 "${ENV_FILE}"
  ok ".env existant conservé — aucune valeur renseignée ne sera écrasée"
fi

get_env() { grep -E "^$1=" "${ENV_FILE}" | head -1 | cut -d= -f2- || true; }

# Écrit sans jamais faire passer la valeur par la sortie ni par argv d'un
# processus tiers.
set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "${ENV_FILE}"; then
    awk -v k="${key}" -v v="${value}" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' \
      "${ENV_FILE}" > "${ENV_FILE}.tmp"
    mv "${ENV_FILE}.tmp" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
  chmod 0600 "${ENV_FILE}"
}

random_secret() {
  openssl rand -hex 32 2>/dev/null \
    || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' \
    || die "impossible de générer un secret (ni openssl ni /dev/urandom)"
}

# ─── 1. Ce que la machine décide seule ──────────────────────────────────────

printf '\n%s1. Secrets techniques%s\n' "${B}" "${N}"

for key in ATLAS_SESSION_SECRET SEARXNG_SECRET N8N_PASSWORD; do
  current="$(get_env "${key}")"
  if is_placeholder "${current}"; then
    set_env "${key}" "$(random_secret)"
    ok "${key} généré (valeur non affichée)"
  else
    ok "${key} déjà renseigné — conservé"
  fi
done

# ─── 2. Ce qui vous appartient ──────────────────────────────────────────────

printf '\n%s2. Vos identifiants%s\n' "${B}" "${N}"
printf '  La saisie est masquée. Laissez vide pour conserver la valeur actuelle.\n\n'

ask_secret() {
  local key="$1" prompt="$2" value=''
  local current; current="$(get_env "${key}")"

  if ! is_placeholder "${current}"; then
    ok "${key} déjà renseigné — conservé"
    return 0
  fi

  read -r -s -p "  ${prompt} : " value
  printf '\n'
  if [[ -z "${value}" ]]; then
    warn "${key} laissé vide"
    return 0
  fi
  set_env "${key}" "${value}"
  unset value
  ok "${key} enregistré (valeur non affichée)"
}

ask_plain() {
  local key="$1" prompt="$2" value=''
  local current; current="$(get_env "${key}")"

  if ! is_placeholder "${current}"; then
    ok "${key} = ${current}"
    return 0
  fi

  read -r -p "  ${prompt} : " value
  [[ -n "${value}" ]] && set_env "${key}" "${value}" && ok "${key} = ${value}"
}

ask_plain  ATLAS_FOUNDER_EMAIL    'Adresse e-mail du fondateur'
ask_secret ATLAS_FOUNDER_PASSWORD 'Mot de passe du fondateur (min. 6 caractères)'
ask_plain  ATLAS_DOMAIN           'Domaine public (ex. atlas.exemple.fr) — vide pour ignorer'
ask_secret ANTHROPIC_API_KEY      'Clé Anthropic — vide pour rester en mode simulation'

# ─── 3. Le moteur de recherche ──────────────────────────────────────────────

printf '\n%s3. Moteur de recherche%s\n' "${B}" "${N}"

set_env ATLAS_SEARCH_PROVIDER         searxng
set_env SEARXNG_BASE_URL              http://searxng:8080
set_env ATLAS_SEARCH_FALLBACK_ENABLED false
ok "SearXNG configuré, aucun repli payant"

if [[ -n "$(get_env BRAVE_SEARCH_API_KEY)" ]]; then
  warn "une clé Brave est présente ; elle restera inutilisée sous SearXNG"
else
  ok "aucune clé Brave requise"
fi

# ─── 4. Contrôle final ──────────────────────────────────────────────────────

printf '\n%s4. Contrôle%s\n' "${B}" "${N}"

problems=0
for key in ATLAS_SESSION_SECRET SEARXNG_SECRET N8N_PASSWORD ATLAS_FOUNDER_PASSWORD; do
  if is_placeholder "$(get_env "${key}")"; then
    warn "${key} n'est toujours pas renseigné"
    problems=$(( problems + 1 ))
  fi
done

if [[ -z "$(get_env ANTHROPIC_API_KEY)" ]]; then
  warn "ANTHROPIC_API_KEY absente — ATLAS démarrera en mode simulation"
  warn "  (suffisant pour le smoke test SearXNG, insuffisant pour une mission réelle)"
fi

PERMS="$(stat -c '%a' "${ENV_FILE}" 2>/dev/null || stat -f '%Lp' "${ENV_FILE}" 2>/dev/null)"
[[ "${PERMS}" == "600" ]] || die ".env n'est pas en 0600 (actuellement ${PERMS})"
ok ".env en droits 0600, lisible par son seul propriétaire"

if (( problems > 0 )); then
  die "${problems} secret(s) manquant(s) — relancez ce script ou éditez ${ENV_FILE} à la main"
fi

printf '\n  %sConfiguration prête.%s Aucun secret n\x27a été affiché.\n' "${B}" "${N}"
printf '  Étape suivante : sudo bash deployment/vps-deploy.sh\n'
