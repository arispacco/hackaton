# Pack « appels-offres-cm » — appels d'offres publics au Cameroun (v0.1.0)

Pour : PME du BTP, bureaux d'études, architectes. Code : `lib/packs/appels-offres-cm/` ; dossier : `packs/appels-offres-cm/`.

## Ce que fait le pack

1. **Lecteur de DAO** (texte collé, PDF importé ou fixture) → **fiche d'une page** : référence, autorité
   contractante, objet, coût prévisionnel, éligibilité, caution de soumission, date limite (convertie en heure de
   Douala), ouverture des plis, limites de fichiers et formats, grille (critères éliminatoires / essentiels),
   pièces exigées par enveloppe (A administratives, B technique, C financière). **Chaque champ porte l'extrait
   exact du texte**, vérifié par le vérificateur de citations ; ce qui n'est pas trouvé est listé comme tel.
2. **Montants chiffres / lettres** : les montants écrits « 1 000 000 (un million) » sont recontrôlés ; une
   discordance dans la source est signalée en **alerte** (à faire préciser par l'autorité contractante).
3. **Matrice de conformité** : chaque pièce exigée (dans l'ordre du DAO) × coffre-fort → valide · expire avant
   le dépôt · expirée · à rédiger · manquante, avec l'action à mener ; puis **assemblage** du dossier dans l'ordre.
4. **Recalcul du bordereau (BPU/DQE)** : quantité × prix unitaire, total HT, TVA et TTC **seulement si le taux
   est fourni** (aucun taux supposé), comparaison avec les montants écrits (tolérance 1 FCFA), par l'exécuteur limité.
5. **Coffre-fort de pièces** : dates de validité (celles portées par la pièce, aucune durée supposée), alertes
   avant expiration ou avant la date limite, **brouillons de demande de renouvellement** soumis à approbation
   `envoyer` (envoi simulé, destinataire à compléter, aucun contact réel).

## Mission « Préparer une offre »

| Étape | Action | Critères vérifiés | Risque |
|---|---|---|---|
| Lire le DAO | `ao_lire_dao` | date limite / caution / pièces trouvées ; citations résolues dans le DAO ; montants chiffres-lettres (alerte) | lire |
| Matrice | `ao_matrice` | chaque pièce exigée a un statut | lire |
| Bordereau (si fourni) | `ao_recalcul_bpu` | bordereau corrigé cohérent ; écarts montrés | brouillon |
| Renouvellements (si pièces expirées) | `ao_demande_renouvellement` | — (file d'approbation) | **envoyer** (simulé) |
| Assembler | `ao_assembler` | complétude vs checklist (1 essai, puis décision humaine) | brouillon |
| Dépôt COLEPS | `ao_depot_coleps` | — (file d'approbation) | **payer/déposer** (humain) |

Plafond : 6 000 jetons. **Toujours humain** : dépôt sur COLEPS, paiement de la caution et des frais de DAO,
signature des pièces. Co-founder ne se connecte pas à COLEPS.

## Données : réel ou seed

| Donnée | Origine | Vérifiée le |
|---|---|---|
| AAO n°014/AONO/CS/SIGAMP/CDPM/2026 — pistes agricoles, Sangmélima | Avis public, https://armp.cm/details?type_publication=AO&id_publication=65436 | 2026-10-19 |
| AAO PIDACC/BN — aménagement d'un bas-fond, Guider | Avis public, https://armp.cm/details?type_publication=AO&id_publication=65438 | 2026-10-19 |
| Bordereau `bpu-exemple.json` | **Exemple** (quantités et prix fictifs, une erreur volontaire ligne 103) | — |
| Coffre-fort des entreprises de démonstration | **Exemple** (dates relatives à aujourd'hui) | — |

- Dans les avis ARMP, téléphones, adresses e-mail et noms de signataires ont été retirés.
- Le DAO complet n'a pas pu être téléchargé depuis pridesoft.armp.cm (délai dépassé le 2026-10-19) : les fiches
  sont tirées des avis publiés.
- Constat sur source réelle : l'avis de Guider écrit « 3 500 000 (trois millions cinq mille) » : chiffres et
  lettres divergent ; le pack le signale sans trancher.

## Couverture du corpus (au 2026-10-19 : 54 textes, 6 473 pages)

| Besoin | État |
|---|---|
| Avis d'appels d'offres publiés | couvert (6 textes) |
| Code des marchés publics (texte intégral) | **mentionné seulement** : absent du corpus, **jamais présenté comme cité** |
| Soumission électronique COLEPS | mentionné seulement |
| Cautionnement de soumission / CDEC | mentionné seulement |
| Catégorisation des entreprises du BTP | absent |

## Jeu d'évaluation (`eval/cases.json`)

4 cas : fiche Sangmélima, fiche Guider (dont l'incohérence chiffres/lettres), recalcul du bordereau d'exemple
(total recalculé 38 375 000 FCFA contre 38 465 000 écrit), et non-citation du code des marchés publics.
Lancer depuis l'écran Packs › Évaluation ou `npx vitest run tests/pack-appels-offres.test.ts`.

## Agent

Module agent `appels_offres` (outils `ao_lire_dao`, `ao_recalcul_bpu`, `ao_coffre_alertes`, `ao_preparer_offre`),
chargé quand la demande parle de DAO, soumission, caution, COLEPS, ARMP, bordereau, marchés publics…
