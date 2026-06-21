#!/usr/bin/env python3
"""Génère www/data/recipes.json (schéma compact de l'appli) à partir de la sortie
du pipeline Home Assistant RecetteTek (recipes_cache.json, lui-même issu de Dropbox).

Réutilise tout le travail fait côté HA (download Dropbox, dézip, résolution des images,
champs FR) — pas de Dropbox/zip à gérer côté mobile.

Usage :
  python3 tools/build_recipes_from_recettetek.py [chemin/recipes_cache.json]
Défaut : ~/homeassistant-config/www/recipes/recipes_cache.json

Les `id` sont conservés tels quels (dropbox:<id>) => les catégories manuelles et
favoris de l'appli (stockés en localStorage et indexés par id) restent alignés.
"""
import json, os, sys

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
    "~/homeassistant-config/www/recipes/recipes_cache.json")
OUT = os.path.join(os.path.dirname(__file__), "..", "www", "data", "recipes.json")

def pick(*vals):
    for v in vals:
        if v not in (None, "", [], 0):
            return v
    return vals[-1] if vals else ""

def http(s):
    s = str(s or "").strip()
    return s if s.startswith("http") else ""

raw = json.load(open(SRC, encoding="utf-8"))
src = raw.get("recipes", raw) if isinstance(raw, dict) else raw

out = []
for x in src:
    rid = str(x.get("id") or "").strip()
    title = str(pick(x.get("title_fr"), x.get("title"), "")).strip()
    if not rid or not title:
        continue
    ings = x.get("ingredients_fr") or x.get("ingredients") or []
    if not isinstance(ings, list):
        ings = []
    ings = [str(i).strip() for i in ings if str(i).strip()]
    out.append({
        "id": rid,
        "t": title,
        "cat": str(pick(x.get("category_fr"), x.get("category"), "")).strip(),
        "area": str(pick(x.get("area_fr"), x.get("area"), "")).strip(),
        "min": int(x.get("ready_minutes") or 0),
        "serv": int(x.get("servings") or 0),
        "img": http(x.get("image")) or http((x.get("pictures") or [""])[0] if isinstance(x.get("pictures"), list) else x.get("pictures")),
        "url": str(x.get("url") or "").strip(),
        "vid": str(x.get("video") or "").strip(),
        "desc": str(x.get("description") or "").strip(),
        "ing": ings,
        "steps": str(x.get("instructions") or "").strip(),
    })

# version = hash du contenu => le fichier ne change que si les recettes changent (pas de push inutile)
import hashlib
_h = hashlib.md5(json.dumps(out, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:12]
data = {"version": _h, "count": len(out), "recipes": out}
json.dump(data, open(os.path.normpath(OUT), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"OK : {len(out)} recettes -> {os.path.normpath(OUT)}  (avec image: {sum(1 for r in out if r['img'])})")
