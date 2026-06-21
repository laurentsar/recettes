#!/usr/bin/env bash
# Resync auto : régénère www/data/recipes.json depuis la sortie HA RecetteTek
# (recipes_cache.json, alimenté par la synchro Dropbox de HA) et pousse sur GitHub
# UNIQUEMENT si le contenu a changé. Conçu pour tourner en cron.
set -uo pipefail

REPO="$HOME/recettes-app"
SRC="${1:-$HOME/homeassistant-config/www/recipes/recipes_cache.json}"
LOG="$REPO/tools/autosync.log"

# Verrou : pas de chevauchement entre deux exécutions cron.
exec 9>"$REPO/tools/.autosync.lock" || exit 0
flock -n 9 || exit 0

cd "$REPO" || exit 0
{
  echo "=== $(date '+%F %T') ==="
  if [ ! -s "$SRC" ]; then echo "source absente/vide ($SRC) — skip"; exit 0; fi

  # Aligne sur origin (best effort) pour éviter un push rejeté.
  git fetch -q origin master 2>/dev/null && git merge -q --ff-only origin/master 2>/dev/null || echo "ff-merge ignoré"

  python3 tools/build_recipes_from_recettetek.py "$SRC" || { echo "conversion KO"; exit 0; }

  if git diff --quiet -- www/data/recipes.json; then
    echo "aucun changement → rien à pousser"
  else
    N=$(python3 -c "import json;print(json.load(open('www/data/recipes.json'))['count'])" 2>/dev/null || echo '?')
    git add www/data/recipes.json
    git commit -q -m "data: resync auto RecetteTek ($N recettes, $(date '+%F %T'))"
    if git push -q origin master; then echo "poussé ✅ ($N recettes)"; else echo "PUSH ÉCHOUÉ"; fi
  fi
} >>"$LOG" 2>&1
