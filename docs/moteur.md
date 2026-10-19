# Moteur d'agents par métier (« packs »)

Co-founder devient un moteur générique : chaque métier est un **pack** branchable. Le moteur fournit le socle
(stockage, citations vérifiées, audit chaîné, approbations, missions, exécuteur de calcul) ; le pack apporte
les procédures, modèles, sous-corpus, outils autorisés, vérificateurs et jeu d'évaluation.
Les modules existants du workspace sont inchangés.

## 1. Stockage (`lib/engine/storage/`)

| Adaptateur | Quand | Détail |
|---|---|---|
| Postgres (`postgres.ts`) | `DATABASE_URL` ou `POSTGRES_URL` défini | table `engine_records(company_id, collection, id, value jsonb, updated_at)` ; une transaction par écriture, verrou `pg_advisory_xact_lock(hashtext(scope))` par entreprise |
| JSON (`json.ts`, repli) | sinon | un fichier par entreprise (`ENGINE_DATA_DIR`, défaut `data/engine`, `/tmp/cofounder-engine` sur Vercel), écriture atomique (fichier temporaire + rename), file d'attente par entreprise |

- Isolation : toute lecture/écriture passe par `transaction(companyId, fn)` / `read(companyId, fn)` ; le
  `companyId` est validé (`^[A-Za-z0-9_.:-]{1,80}$`). Une entreprise ne voit jamais les données d'une autre.
- Le store historique du workspace (`lib/workspace/store.ts`) utilise aussi Postgres quand `DATABASE_URL`
  est défini (document unique, scope `_workspace`), sauf si `WORKSPACE_DB_PATH` est fixé. Le chemin JSON est inchangé.
- Sur Vercel **sans** Postgres, le repli JSON écrit dans `/tmp` : il n'est **pas durable** (perdu au redémarrage
  d'une instance). L'écran « Packs » l'indique.

**Brancher Postgres** : sur le projet Vercel, *Storage → Connect Database → Neon (Free)* injecte `DATABASE_URL` /
`POSTGRES_URL` ; le schéma est créé au premier accès. Aucune autre modification n'est nécessaire.

## 2. Citations vérifiées (`lib/engine/citations.ts`, `lib/engine/coverage.ts`)

- `verifyCitation({ ref, article?, page?, quote? })` : le texte doit **exister** dans le corpus (ou dans le
  document fourni, ex. le DAO), la page doit exister, l'article doit apparaître dans le texte, et l'extrait cité
  doit s'y trouver (comparaison normalisée : accents, casse, tirets, apostrophes). Résultat :
  `verifiee` · `non_verifiee` (avec raisons) · `bloquee` (référence vide ou gabarit « décret n° … / … »).
- Le post-contrôle des réponses juridiques (`lib/legal/reference-check.ts`) supprime désormais les références
  gabarits (« décret n° … / … », « loi n° ___ ») et signale un article introuvable dans un texte du corpus.
- **Carte de couverture** `corpusCoverage(needs)` : ce que contient le corpus (catégories, textes, pages) et,
  pour chaque besoin d'un pack, `couvert` (texte présent) · `mentionne_seulement` (cité ailleurs, texte intégral
  absent : **jamais présenté comme cité**) · `absent`.

## 3. Audit chaîné et approbations (`lib/engine/audit.ts`, `lib/engine/approvals.ts`)

- Chaque entrée : `seq`, `at`, `actor`, `action`, `summary`, `data`, `prevHash`,
  `hash = SHA-256(JSON canonique de l'entrée sans hash)`. Genèse : 64 zéros. `verifyChain` renvoie la première
  entrée fautive (modification, suppression, réordonnancement). L'audit est écrit **dans la même transaction**
  que la donnée qu'il décrit.
- Niveaux de risque : `lire` et `brouillon` (automatiques, tracés) ; `envoyer` et `payer_deposer`
  (**approbation humaine**). Chaque approbation montre l'**aperçu exact** et l'**empreinte SHA-256** du contenu ;
  la décision doit renvoyer cette empreinte, sinon elle est refusée (contenu modifié entre-temps).
- Exécution : `envoyer` est **simulé** (aucun envoi réel) ; `payer_deposer` est **humain** (le moteur ne paie et
  ne dépose jamais rien).

## 4. Missions (`lib/engine/missions.ts`)

- **Contrat** : objectif, livrables, hors périmètre, actions externes prévues (avec niveau de risque), plafond de jetons.
- **Boucle** planifier → agir → vérifier → présenter. Chaque étape a des **critères vérifiables** (vérificateurs
  déterministes du moteur ou du pack) ; `maxAttempts` essais (2 par défaut), puis **remontée à l'humain**
  (`attente_humain`) avec trois décisions : réessayer, valider quand même (écarts visibles), abandonner.
- **Reprise** : l'état est enregistré avant chaque action (point de reprise). Après une coupure, `runMission`
  reprend à l'étape en cours sans rejouer les étapes réussies.
- Plafond de coût dépassé ⇒ arrêt et remontée à l'humain.
- Étapes conditionnelles (`when: "$step.matrice.renouveler"`) et références (`$input.x`, `$step.id.champ`).
- L'utilisateur voit le plan, les preuves et les approbations ; jamais de code.

## 5. Exécuteur (`lib/engine/sandbox.ts`)

Interface `Executor.compute(expression, vars)`. Implémentations :
- `LocalExecutor` (par défaut) : analyseur arithmétique écrit à la main (`+ - * / ( )`, `round`, `min`, `max`,
  `sum`), limites de taille et de profondeur, **aucun `eval`**, aucun accès système.
- `VercelSandboxExecutor` : derrière la même interface, activé seulement si `ENGINE_SANDBOX=vercel` **et** si le
  paquet `@vercel/sandbox` est installé (non installé : service facturé à l'usage, non activé sans accord).

## 6. Packs (`packs/<id>/`, `lib/engine/packs/`)

Un pack est un dossier versionné :

```
packs/<id>/manifest.json   identité, version, procédures (étapes + critères), modèles, besoins de corpus,
                           outils autorisés, vérificateurs, évaluation, fixtures (origine + date de vérification)
packs/<id>/templates/*.md  modèles de documents
packs/<id>/eval/cases.json jeu d'évaluation
packs/<id>/fixtures/       données de test (sources publiques datées, ou seed marqué « exemple »)
lib/packs/<id>/            code : actions, vérificateurs, évaluation, outils agent
```

- **Registre** (`registry.ts`) : packs intégrés + brouillons propres à chaque entreprise (collection `pack_drafts`).
  `validateManifest` vérifie actions, vérificateurs, outils, plafond de jetons, et qu'aucune action à risque ne
  contourne la file d'approbation.
- **Générateur** (`generator.ts`) : à partir d'une description en langage courant, produit un brouillon
  `brouillon_a_valider` (procédure type avec actions génériques du moteur, outils sélectionnés parmi les outils
  existants, besoins de corpus et carte de couverture). Déterministe, aucun texte de loi inventé. La validation
  est une décision humaine tracée dans l'audit.
- Actions génériques (`generic.ts`) : recherche dans le corpus, brouillon de document, checklist, préparation
  d'envoi (risque `envoyer`).

## 7. Écrans (niveau « Packs métier » du workspace)

- **Packs** : registre, procédures lisibles (étapes, critères, livrables, hors périmètre, plafond), couverture du
  corpus, données de test, modèles, évaluation, générateur, niveaux de risque, journal d'audit.
- **Appels d'offres (CM)** : voir `docs/packs/appels-offres-cm.md`.
- **Missions & approbations** : lancement, plan et preuves, décisions humaines, file d'approbation (aperçu +
  empreinte), rapport final, état de la chaîne d'audit.

## 8. API

| Route | Rôle |
|---|---|
| `GET/POST/PATCH /api/engine/packs` | registre + état du moteur ; générer un brouillon ; valider un brouillon |
| `GET/POST /api/engine/packs/[id]` | manifeste, couverture, modèles ; lancer l'évaluation |
| `GET/POST /api/engine/missions` | lister ; créer et lancer |
| `GET/POST /api/engine/missions/[id]` | détail ; reprendre ; décision humaine |
| `GET/POST /api/engine/approvals` | file ; approuver/refuser avec l'empreinte |
| `GET /api/engine/audit` | entrées + vérification de la chaîne |
| `/api/packs/appels-offres-cm[/dao-pdf|/vault]` | outils du pack AO |

Toutes les routes exigent la session et l'accès à l'entreprise (`handlePaid` + `assertCompanyAccess`).

## 9. Variables d'environnement

| Variable | Effet |
|---|---|
| `DATABASE_URL` / `POSTGRES_URL` | active Postgres (moteur + workspace) |
| `ENGINE_DATA_DIR` | dossier du repli JSON du moteur |
| `ENGINE_SANDBOX=vercel` | tente Vercel Sandbox (exige `@vercel/sandbox`) ; sinon exécuteur local |

## 10. Tests

`tests/engine-citations.test.ts`, `tests/engine-core.test.ts` (stockage JSON et Postgres via PGlite, isolation,
atomicité, concurrence, audit et falsification, approbations, exécuteur, missions : reprise, remontée, plafond,
coupure en pleine action), `tests/pack-appels-offres.test.ts` (pack AO et générateur).
