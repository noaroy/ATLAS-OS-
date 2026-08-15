#!/usr/bin/env bash
#
# ATLAS OS — déploiement VPS et smoke test SearXNG.
#
#   sudo bash deployment/vps-deploy.sh
#
# Ce script installe ce qui manque, démarre ATLAS et SearXNG, attend qu'ils
# soient sains, puis effectue UNE SEULE recherche réelle. Il ne lance aucune
# mission et ne fait aucun appel à Anthropic.
#
# Trois principes le gouvernent :
#
#   Idempotent.  Le relancer sur une installation existante ne casse rien et
#                ne réinstalle que ce qui manque.
#   Non destructif. Aucun volume n'est supprimé, aucune base écrasée. Toute
#                opération qui détruirait des données demande confirmation.
#   Bavard sur les faits, muet sur les secrets. Le rapport contient des
#                mesures ; aucune clé n'y apparaît, ni dans les journaux.
#
# En cas d'échec d'une étape critique, il s'arrête immédiatement en disant
# laquelle et pourquoi — une infrastructure à moitié déployée est pire qu'une
# infrastructure absente, parce qu'elle donne l'illusion de fonctionner.

set -Eeuo pipefail

# ─── Repères ────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
ENV_FILE="${ROOT_DIR}/.env"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${ROOT_DIR}/deployment/backups/${STAMP}"
REPORT="${ROOT_DIR}/deployment/rapport-smoke-${STAMP}.txt"
PROJECT="atlas-os"
SMOKE_QUERY="Verpackungsmaschinen Deutschland"

# Combien de temps attendre qu'un conteneur se déclare sain.
HEALTH_TIMEOUT=180

# ─── Sortie ─────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  B=$'\e[1m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; N=$'\e[0m'
else
  B=''; R=''; G=''; Y=''; N=''
fi

# Tout ce qui compte va à la fois à l'écran et dans le rapport.
say()  { printf '%s\n' "$*" | tee -a "${REPORT}"; }
head_() { printf '\n%s%s%s\n' "${B}" "$*" "${N}" | tee -a "${REPORT}"; }
ok()   { printf '  %s✓%s %s\n' "${G}" "${N}" "$*" | tee -a "${REPORT}"; }
warn() { printf '  %s!%s %s\n' "${Y}" "${N}" "$*" | tee -a "${REPORT}"; }
die()  {
  printf '\n  %s✗ ÉCHEC : %s%s\n' "${R}" "$*" "${N}" | tee -a "${REPORT}" >&2
  printf '  Rapport partiel : %s\n' "${REPORT}" >&2
  exit 1
}

trap 'die "interrompu à la ligne ${LINENO}"' ERR

mkdir -p "$(dirname "${REPORT}")"
: > "${REPORT}"

say "ATLAS OS — déploiement VPS et smoke test SearXNG"
say "Horodatage : ${STAMP}"
say "Racine     : ${ROOT_DIR}"

# ─── 1. Audit, avant toute modification ─────────────────────────────────────

head_ "1. Système"

[[ -f /etc/os-release ]] || die "ce script vise Debian/Ubuntu ; /etc/os-release est absent"
# shellcheck disable=SC1091
. /etc/os-release
say "  OS          : ${PRETTY_NAME:-inconnu}"
say "  Noyau       : $(uname -r)"
say "  Architecture: $(uname -m)"

case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) ok "distribution prise en charge" ;;
  *) warn "distribution non testée (${ID:-?}) — le script continue, mais surveillez les installations" ;;
esac

AVAIL_KB="$(df -Pk "${ROOT_DIR}" | awk 'NR==2 {print $4}')"
AVAIL_GB=$(( AVAIL_KB / 1024 / 1024 ))
say "  Disque libre: ${AVAIL_GB} Go sur $(df -Ph "${ROOT_DIR}" | awk 'NR==2 {print $6}')"
# SearXNG et l'image ATLAS pèsent ensemble quelques Go ; en dessous, la
# construction échouerait à mi-chemin, ce qui est le pire moment.
(( AVAIL_GB >= 5 )) || die "moins de 5 Go libres — libérez de l'espace avant de déployer"
ok "espace suffisant"

if [[ "${EUID}" -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || die "ni root ni sudo : impossible d'installer les dépendances"
  SUDO='sudo'
else
  SUDO=''
fi

# ─── 2. Docker ──────────────────────────────────────────────────────────────

head_ "2. Docker"

install_docker() {
  warn "Docker absent — installation depuis le dépôt officiel"
  ${SUDO} apt-get update -qq
  ${SUDO} apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  ${SUDO} install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | ${SUDO} tee /etc/apt/keyrings/docker.asc >/dev/null
    ${SUDO} chmod a+r /etc/apt/keyrings/docker.asc
  fi
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" \
    | ${SUDO} tee /etc/apt/sources.list.d/docker.list >/dev/null
  ${SUDO} apt-get update -qq
  ${SUDO} apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  ${SUDO} systemctl enable --now docker
}

command -v docker >/dev/null 2>&1 || install_docker
docker info >/dev/null 2>&1 || {
  warn "le démon Docker ne répond pas — tentative de démarrage"
  ${SUDO} systemctl start docker || true
  sleep 5
  docker info >/dev/null 2>&1 || die "le démon Docker ne démarre pas ; voir 'journalctl -u docker -n 50'"
}

DOCKER_VERSION="$(docker --version)"
say "  ${DOCKER_VERSION}"

docker compose version >/dev/null 2>&1 || {
  warn "plugin Compose absent — installation"
  ${SUDO} apt-get install -y -qq docker-compose-plugin >/dev/null
}
COMPOSE_VERSION="$(docker compose version)"
say "  ${COMPOSE_VERSION}"
ok "Docker et Compose opérationnels"

# ─── 3. État existant, et ce qu'on s'interdit d'écraser ─────────────────────

head_ "3. Installation existante"

EXISTING_CONTAINERS="$(docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" ps --format '{{.Service}} {{.State}}' 2>/dev/null || true)"
EXISTING_VOLUMES="$(docker volume ls --filter "name=${PROJECT}" --format '{{.Name}}' 2>/dev/null || true)"

if [[ -n "${EXISTING_CONTAINERS}" ]]; then
  say "  Services déjà présents :"
  while IFS= read -r line; do [[ -n "${line}" ]] && say "    ${line}"; done <<< "${EXISTING_CONTAINERS}"
else
  say "  Aucun service ATLAS en fonctionnement"
fi

if [[ -n "${EXISTING_VOLUMES}" ]]; then
  say "  Volumes existants (préservés) :"
  while IFS= read -r v; do [[ -n "${v}" ]] && say "    ${v}"; done <<< "${EXISTING_VOLUMES}"
else
  say "  Aucun volume existant"
fi

# Un port déjà pris par un autre service se voit maintenant, pas au démarrage.
if ! command -v ss >/dev/null 2>&1; then
  warn "'ss' absent — contrôle des ports impossible ; installez iproute2 pour l'activer"
fi
for port in 80 443; do
  if command -v ss >/dev/null 2>&1 && ss -lntp 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}$"; then
    HOLDER="$(ss -lntp 2>/dev/null | awk -v p=":${port}$" '$4 ~ p {print $6; exit}')"
    if [[ -n "${EXISTING_CONTAINERS}" ]]; then
      warn "port ${port} occupé — vraisemblablement par ce déploiement (${HOLDER:-?})"
    else
      die "port ${port} déjà occupé par un autre service (${HOLDER:-?}) ; le déploiement l'écraserait"
    fi
  fi
done
ok "aucun port ne sera pris à un autre service"

# ─── 4. Sauvegarde ──────────────────────────────────────────────────────────

head_ "4. Sauvegarde"

mkdir -p "${BACKUP_DIR}"

if [[ -f "${ENV_FILE}" ]]; then
  # Le .env contient des secrets : la copie est faite en 0600 et reste sur le
  # serveur. Elle n'est ni affichée, ni transmise.
  install -m 0600 "${ENV_FILE}" "${BACKUP_DIR}/.env"
  ok "configuration sauvegardée (droits 0600)"
else
  warn "aucun .env présent — il sera créé plus bas"
fi

cp "${COMPOSE_FILE}" "${BACKUP_DIR}/docker-compose.yml"
{
  echo "# Conteneurs au moment de la sauvegarde"
  docker ps -a --filter "name=${PROJECT}" --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null || true
  echo
  echo "# Volumes au moment de la sauvegarde"
  docker volume ls --filter "name=${PROJECT}" --format '{{.Name}}\t{{.Driver}}' 2>/dev/null || true
} > "${BACKUP_DIR}/inventaire.txt"
ok "inventaire des conteneurs et volumes consigné"

# La base ATLAS vit dans un volume ; on la copie sans arrêter le service.
if docker volume ls --format '{{.Name}}' | grep -qx "${PROJECT}_atlas-data"; then
  if docker run --rm \
      -v "${PROJECT}_atlas-data:/data:ro" \
      -v "${BACKUP_DIR}:/backup" \
      alpine:3 sh -c 'cd /data && tar czf /backup/atlas-data.tgz . 2>/dev/null'; then
    SIZE="$(du -h "${BACKUP_DIR}/atlas-data.tgz" 2>/dev/null | cut -f1)"
    ok "base et données ATLAS sauvegardées (${SIZE:-taille inconnue})"
  else
    die "la sauvegarde des données ATLAS a échoué ; rien n'a été modifié, corrigez avant de reprendre"
  fi
else
  say "  Pas encore de volume de données — première installation"
fi

say "  Sauvegarde : ${BACKUP_DIR}"

# ─── 5. Configuration ───────────────────────────────────────────────────────

head_ "5. Configuration"

# Le .env n'est jamais fabriqué ici, et surtout jamais depuis .env.example.
#
# Ses marques-place passent la validation de format — « change-me-to-a-long-
# random-value-please » fait 41 caractères, largement au-dessus du minimum de
# 16 — et déploieraient donc un ATLAS parfaitement fonctionnel avec un secret
# de session que n'importe qui peut lire dans le dépôt. Un déploiement qui
# démarre mal est pire qu'un déploiement qui refuse de démarrer.
[[ -f "${ENV_FILE}" ]] || die ".env absent — exécutez d'abord : bash deployment/init-env.sh"

chmod 0600 "${ENV_FILE}"
ENV_PERMS="$(stat -c '%a' "${ENV_FILE}" 2>/dev/null || echo '?')"
[[ "${ENV_PERMS}" == "600" ]] || die ".env doit être en droits 0600 (actuellement ${ENV_PERMS})"
ok ".env présent, droits 0600"

# Écrit une clé sans la révéler : la valeur ne passe jamais par la sortie.
set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "${ENV_FILE}"; then
    # Un remplacement par awk plutôt que sed : la valeur peut contenir des
    # caractères que sed interpréterait.
    awk -v k="${key}" -v v="${value}" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' \
      "${ENV_FILE}" > "${ENV_FILE}.tmp"
    mv "${ENV_FILE}.tmp" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
  chmod 0600 "${ENV_FILE}"
}

get_env() { grep -E "^$1=" "${ENV_FILE}" | head -1 | cut -d= -f2- || true; }

set_env ATLAS_SEARCH_PROVIDER          searxng
set_env SEARXNG_BASE_URL               http://searxng:8080
set_env ATLAS_SEARCH_FALLBACK_ENABLED  false
ok "SearXNG configuré comme moteur de recherche"

# Brave doit rester vide et non requis : c'est tout l'intérêt de SearXNG.
if [[ -z "$(get_env BRAVE_SEARCH_API_KEY)" ]]; then
  set_env BRAVE_SEARCH_API_KEY ''
  ok "aucune clé Brave requise"
else
  warn "une clé Brave est renseignée ; elle reste inutilisée sous SearXNG"
fi

# Un secret resté à sa marque-place est plus dangereux qu'un secret absent :
# le second empêche de démarrer, le premier laisse croire que tout va bien.
is_placeholder() {
  case "$1" in
    ''|change-me|change-me-*|'your-key-here') return 0 ;;
    *) return 1 ;;
  esac
}

for key in ATLAS_SESSION_SECRET SEARXNG_SECRET N8N_PASSWORD ATLAS_FOUNDER_PASSWORD; do
  if is_placeholder "$(get_env "${key}")"; then
    die "${key} est vide ou resté à sa valeur d'exemple — exécutez : bash deployment/init-env.sh"
  fi
done
ok "aucun secret d'exemple ne subsiste (valeurs non affichées)"

[[ -n "$(get_env ATLAS_DOMAIN)" ]] || warn "ATLAS_DOMAIN non renseigné — Caddy ne pourra pas obtenir de certificat"

[[ -f "${SCRIPT_DIR}/searxng/settings.yml" ]] || die "deployment/searxng/settings.yml est absent ; le dépôt est incomplet"
grep -q 'json' "${SCRIPT_DIR}/searxng/settings.yml" || die "le format JSON n'est pas activé dans settings.yml"
ok "réglages SearXNG présents, format JSON activé"

# ─── 6. Démarrage ───────────────────────────────────────────────────────────

head_ "6. Construction et démarrage"

say "  Construction de l'image ATLAS (peut prendre plusieurs minutes)…"
docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" build atlas >/dev/null 2>&1 \
  || die "la construction de l'image ATLAS a échoué ; relancez sans '>/dev/null' pour voir la cause"
ok "image ATLAS construite"

# `up -d` sans `--force-recreate` : les conteneurs inchangés sont laissés en
# place, et aucun volume n'est touché.
docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" up -d \
  || die "le démarrage des services a échoué"
ok "services démarrés"

# ─── 7. Santé ───────────────────────────────────────────────────────────────

head_ "7. Healthchecks"

wait_healthy() {
  local service="$1" deadline=$(( SECONDS + HEALTH_TIMEOUT )) cid state
  while (( SECONDS < deadline )); do
    cid="$(docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" ps -q "${service}" 2>/dev/null || true)"
    if [[ -n "${cid}" ]]; then
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${cid}" 2>/dev/null || echo unknown)"
      case "${state}" in
        healthy)  ok "${service} : healthy"; return 0 ;;
        running)  ok "${service} : running (aucun healthcheck déclaré)"; return 0 ;;
        exited|dead) die "${service} s'est arrêté ; voir 'docker compose -p ${PROJECT} logs ${service}'" ;;
      esac
    fi
    sleep 5
  done
  die "${service} n'est pas devenu sain en ${HEALTH_TIMEOUT}s ; voir 'docker compose -p ${PROJECT} logs ${service}'"
}

wait_healthy searxng
wait_healthy atlas

# ─── 8. Réseau et exposition ────────────────────────────────────────────────

head_ "8. Réseau et ports"

NETWORK="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
  "$(docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" ps -q atlas)" | awk '{print $1}')"
say "  Réseau Docker : ${NETWORK}"

say "  Ports publiés :"
docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" ps --format '{{.Service}}\t{{.Publishers}}' \
  | while IFS= read -r line; do [[ -n "${line}" ]] && say "    ${line}"; done

SEARXNG_PORTS="$(docker inspect -f '{{json .NetworkSettings.Ports}}' \
  "$(docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" ps -q searxng)")"
if echo "${SEARXNG_PORTS}" | grep -q 'HostPort'; then
  die "SearXNG expose un port publiquement ; une instance ouverte devient un relais et se fait bloquer"
fi
ok "SearXNG n'expose aucun port public"

# La résolution DNS interne, puis la joignabilité — deux pannes différentes.
docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" exec -T atlas \
  node -e "require('dns').promises.lookup('searxng').then(a=>{console.log(a.address);process.exit(0)}).catch(()=>process.exit(1))" >/dev/null 2>&1 \
  || die "ATLAS ne résout pas le nom 'searxng' sur le réseau Docker"
ok "ATLAS résout 'searxng'"

docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" exec -T atlas \
  node -e "fetch('http://searxng:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
  || die "ATLAS ne joint pas http://searxng:8080"
ok "ATLAS joint http://searxng:8080"

# ─── 9. Smoke test : UNE recherche réelle ───────────────────────────────────

head_ "9. Recherche réelle — « ${SMOKE_QUERY} »"

RAW="${BACKUP_DIR}/searxng-brut.json"
# `%3N` est une extension GNU ; le repli à la seconde reste exploitable.
now_ms() { date +%s%3N 2>/dev/null | grep -qE '^[0-9]+$' && date +%s%3N || echo $(( $(date +%s) * 1000 )); }
SEARCH_START="$(now_ms)"

docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" exec -T atlas node -e "
const u = new URL('http://searxng:8080/search');
u.searchParams.set('q', process.argv[1]);
u.searchParams.set('format', 'json');
u.searchParams.set('categories', 'general');
u.searchParams.set('language', 'de');
fetch(u, { headers: { accept: 'application/json' } })
  .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
  .then(t => { process.stdout.write(t); })
  .catch(e => { console.error(String(e.message)); process.exit(1); });
" "${SMOKE_QUERY}" > "${RAW}" || die "la recherche SearXNG a échoué ; voir 'docker compose -p ${PROJECT} logs searxng'"

SEARCH_MS=$(( $(now_ms) - SEARCH_START ))

command -v python3 >/dev/null 2>&1 || die "python3 est requis pour lire la réponse JSON"

python3 - "${RAW}" "${SEARCH_MS}" <<'PY' | tee -a "${REPORT}"
import json, sys
from urllib.parse import urlparse

raw, elapsed = sys.argv[1], sys.argv[2]
with open(raw, encoding='utf-8') as f:
    try:
        data = json.load(f)
    except Exception as e:
        print(f"  RÉPONSE ILLISIBLE : {e}")
        print("  → vérifiez que 'json' figure dans search.formats de settings.yml")
        sys.exit(1)

results = data.get('results') or []
print(f"  Durée              : {elapsed} ms")
print(f"  Résultats          : {len(results)}")

answered = sorted({e for r in results for e in ([r['engine']] if isinstance(r.get('engine'), str) else (r.get('engines') or []))})
print(f"  Moteurs ayant répondu : {', '.join(answered) if answered else '(aucun)'}")

unresponsive = data.get('unresponsive_engines') or []
if unresponsive:
    print("  Moteurs en erreur/timeout :")
    for item in unresponsive:
        if isinstance(item, (list, tuple)):
            print(f"    - {' : '.join(str(x) for x in item)}")
        else:
            print(f"    - {item}")
else:
    print("  Moteurs en erreur/timeout : aucun")

domains, seen = [], set()
for r in results:
    try:
        host = urlparse(r.get('url', '')).hostname or ''
    except Exception:
        host = ''
    if host.startswith('www.'):
        host = host[4:]
    if host and host not in seen:
        seen.add(host); domains.append(host)
    if len(domains) >= 5:
        break
print("  Cinq premiers domaines :")
for d in domains:
    print(f"    - {d}")

if results:
    first = results[0]
    print(f"  title présent      : {bool((first.get('title') or '').strip())}")
    print(f"  url présent        : {bool((first.get('url') or '').strip())}")
    print(f"  snippet présent    : {bool((first.get('content') or '').strip())}")
else:
    print("  Aucun résultat — impossible de valider title/url/snippet")
    sys.exit(1)
PY

ok "recherche directe aboutie"

# ─── 10. La même requête, par le provider ATLAS ─────────────────────────────

head_ "10. Via SearxngSearchProvider"

# L'étape `build` de l'image contient les sources et les dépendances de
# développement : on y exécute le vrai provider, pas une imitation.
docker build -q --target build -t atlas-probe:latest -f "${SCRIPT_DIR}/Dockerfile" "${ROOT_DIR}" >/dev/null 2>&1 \
  || die "impossible de construire l'image de sonde"

PROBE_JSON="${BACKUP_DIR}/provider-probe.json"
docker run --rm --network "${NETWORK}" \
  -e SEARXNG_BASE_URL=http://searxng:8080 \
  -e "SEARXNG_ENGINES=$(get_env SEARXNG_ENGINES)" \
  -e "PROBE_QUERY=${SMOKE_QUERY}" \
  -w /build atlas-probe:latest \
  node --import tsx scripts/searxng-probe.ts > "${PROBE_JSON}" \
  || die "le provider ATLAS n'a pas obtenu de résultat ; réponse dans ${PROBE_JSON}"

python3 - "${PROBE_JSON}" <<'PY' | tee -a "${REPORT}"
import json, sys
with open(sys.argv[1], encoding='utf-8') as f:
    d = json.load(f)

print(f"  Issue              : {d['outcome']}")
print(f"  Résultats          : {d['resultCount']}")
print(f"  Durée              : {d['elapsedMs']} ms")
print(f"  externalCostUsd    : ${d['externalCostUsd']}")
print(f"  Moteurs contributeurs : {', '.join(d['enginesAnswered']) or '(non renseigné)'}")
shape = d.get('shape') or {}
print("  SearchResult normalisé :")
for field in ('hasTitle', 'hasUrl', 'hasSnippet'):
    print(f"    {field:<12} : {shape.get(field)}")
for field in ('provider', 'rank', 'query', 'retrievedAt'):
    print(f"    {field:<12} : {shape.get(field)}")

problems = []
if d['outcome'] != 'ok': problems.append(f"issue {d['outcome']}")
if d['externalCostUsd'] != 0: problems.append("coût de recherche non nul")
if not all(shape.get(f) for f in ('hasTitle', 'hasUrl', 'hasSnippet')): problems.append("champ manquant")
if problems:
    print("  ANOMALIES : " + " ; ".join(problems))
    sys.exit(1)
PY

ok "provider ATLAS validé — coût de recherche 0 \$"

# ─── 11. Capabilities ───────────────────────────────────────────────────────

head_ "11. /api/discovery/capabilities"

FOUNDER_EMAIL="$(get_env ATLAS_FOUNDER_EMAIL)"
FOUNDER_PASSWORD="$(get_env ATLAS_FOUNDER_PASSWORD)"

if [[ -n "${FOUNDER_EMAIL}" && -n "${FOUNDER_PASSWORD}" ]]; then
  # L'identification se fait dans le conteneur : le mot de passe ne transite
  # ni par la ligne de commande de l'hôte, ni par le rapport.
  docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" exec -T \
    -e A_EMAIL="${FOUNDER_EMAIL}" -e A_PASS="${FOUNDER_PASSWORD}" atlas node -e "
const base = 'http://127.0.0.1:' + (process.env.ATLAS_PORT || 4700);
(async () => {
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.A_EMAIL, password: process.env.A_PASS }),
  });
  if (!login.ok) { console.error('authentification refusée (HTTP ' + login.status + ')'); process.exit(1); }
  const cookie = (login.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const res = await fetch(base + '/api/discovery/capabilities', { headers: { cookie } });
  const body = await res.json();
  const list = body?.data?.providers ?? body?.data ?? [];
  for (const p of list) {
    console.log('    ' + String(p.key).padEnd(16)
      + 'configuré=' + String(p.configured ?? p.usable).padEnd(6)
      + 'santé=' + String(p.health ?? 'n/a').padEnd(10)
      + String(p.reason || '').slice(0, 60));
  }
})().catch(e => { console.error(String(e.message)); process.exit(1); });
" 2>&1 | tee -a "${REPORT}" || warn "capabilities non lisible (voir ci-dessus)"
else
  warn "identifiants fondateur absents du .env — capabilities non interrogé"
fi

say "  Mode d'inférence : $( [[ -n "$(get_env ANTHROPIC_API_KEY)" ]] && echo 'live' || echo 'simulation (ANTHROPIC_API_KEY absente)' )"
say "  Fallback payant  : $(get_env ATLAS_SEARCH_FALLBACK_ENABLED)"
say "  Moteur configuré : $(get_env ATLAS_SEARCH_PROVIDER)"

# ─── 12. Conclusion ─────────────────────────────────────────────────────────

head_ "Conclusion"
ok "SearXNG déployé, sain, joignable par ATLAS, et validé par une recherche réelle"
say ""
say "  Aucune mission n'a été lancée. Aucun appel Anthropic n'a été émis."
say "  Coût de la recherche : 0 \$"
say ""
say "  Rapport    : ${REPORT}"
say "  Sauvegarde : ${BACKUP_DIR}"
say ""
say "  ${B}SearXNG est prêt pour LIVE #006.${N}"

trap - ERR
exit 0
