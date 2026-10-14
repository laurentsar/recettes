# Recettes

Mes recettes de cuisine en **application autonome hors-ligne**, extraites du système Home Assistant
(RecetteTek). **352 recettes** : recherche (titre/ingrédient), filtres par catégorie, favoris,
fiche détaillée (ingrédients cochables, étapes numérotées, lien source/vidéo).

- Web pur dans `www/` (HTML/CSS/JS vanilla) = PWA + contenu embarqué dans l'APK.
- Données : `www/data/recipes.json` (100 % hors-ligne ; les images se chargent en ligne, sinon placeholder).
- APK construit par **GitHub Actions** → release auto.

## Crédits

Les illustrations des recettes sans photo (`www/img/illus/`) utilisent les emojis [Twemoji](https://github.com/jdecked/twemoji) (© Twitter / X et contributeurs, licence [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
