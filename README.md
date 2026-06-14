# Recettes

Mes recettes de cuisine en **application autonome hors-ligne**, extraites du système Home Assistant
(RecetteTek). **352 recettes** : recherche (titre/ingrédient), filtres par catégorie, favoris,
fiche détaillée (ingrédients cochables, étapes numérotées, lien source/vidéo).

- Web pur dans `www/` (HTML/CSS/JS vanilla) = PWA + contenu embarqué dans l'APK.
- Données : `www/data/recipes.json` (100 % hors-ligne ; les images se chargent en ligne, sinon placeholder).
- APK construit par **GitHub Actions** → release auto.
