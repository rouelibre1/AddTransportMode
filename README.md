# AddTransportMode

Page web autonome qui liste les séquences [Panoramax](https://panoramax.fr) d'un territoire
(commune, EPCI ou emprise de carte) **sans tag `transport=`**, afin de les compléter.

## Utilisation

Ouvrir `index.html` dans un navigateur (ou publier le dépôt avec GitHub Pages), puis :

1. **Source** : toutes les instances via le méta-catalogue `api.panoramax.xyz` (par défaut),
   une instance précise (OSM France, IGN) ou une autre URL d'API.
2. **Territoire** : rechercher une commune (nom, code INSEE, code postal) ou un EPCI (nom, SIREN),
   ou utiliser l'emprise visible de la carte.
3. **Rechercher**.

Les résultats peuvent être :

- triés par nombre d'images, décroissant ou croissant (liste déroulante ou clic sur l'en-tête « Images ») ;
- filtrés par nombre d'images minimum et/ou maximum.

Chaque ligne renvoie vers la page de la séquence sur son instance d'origine (`/sequence/<id>`),
où le mode de transport peut être ajouté (connexion requise).

## Fonctionnement

1. Le contour du territoire est récupéré sur [geo.api.gouv.fr](https://geo.api.gouv.fr).
2. Toutes les séquences touchant l'emprise rectangulaire du territoire sont récupérées via
   `GET /api/collections?bbox=…` (toutes les pages).
3. Sont conservées les séquences dont les `semantics` ne contiennent pas de tag `transport`
   avec une valeur non vide, et dont l'emprise touche le contour du territoire.
4. Option *vérification précise* (désactivée par défaut) : pour chaque séquence restante,
   `POST /api/search` (paramètre `intersects`) est envoyé à son instance d'origine pour vérifier
   qu'au moins une photo est dans le contour. Les séquences dont la vérification échoue sont
   conservées et signalées « non vérifiée précisément ».

Aucune installation ni compilation : HTML, CSS et JavaScript, avec Leaflet chargé depuis unpkg.
