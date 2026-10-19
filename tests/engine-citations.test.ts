import { describe, expect, it } from "vitest";
import { documentFromText, loadCorpusDocs, verifyCitation, verifyCitations } from "@/lib/engine/citations";
import { corpusCoverage } from "@/lib/engine/coverage";
import { checkReferences, stripPlaceholderRefs } from "@/lib/legal/reference-check";

const LOI = "loi n° 2010/013";

describe("vérificateur de citations déterministe", () => {
  it("vérifie une citation réelle : texte résolu, page, article et extrait mot pour mot", async () => {
    const [r] = await verifyCitations([{ ref: LOI, article: "1", page: 2, quote: "La présente loi régit les communications électroniques" }]);
    expect(r.status).toBe("verifiee");
    expect(r.resolved?.source).toContain("Loi_2010-013");
    expect(r.checks).toEqual({ texte: true, page: true, article: true, extrait: true });
  });

  it("tolère la typographie (casse, accents, apostrophes et tirets) mais pas un mot changé", async () => {
    const docs = await loadCorpusDocs();
    expect(verifyCitation({ ref: LOI, quote: "LA PRESENTE LOI REGIT les communications electroniques" }, docs).status).toBe("verifiee");
    const altered = verifyCitation({ ref: LOI, quote: "La présente loi régit les communications postales" }, docs);
    expect(altered.status).toBe("non_verifiee");
    expect(altered.reasons.join(" ")).toMatch(/mot pour mot/);
  });

  it("marque non vérifiée une page ou un article inexistants", async () => {
    const docs = await loadCorpusDocs();
    const page = verifyCitation({ ref: LOI, page: 9999, quote: "La présente loi régit les communications électroniques" }, docs);
    expect(page.status).toBe("non_verifiee");
    expect(page.checks.page).toBe(false);
    const art = verifyCitation({ ref: LOI, article: "4", page: 2 }, docs); // l'article 4 est en page 3
    expect(art.checks.article).toBe(false);
  });

  it("bloque un texte absent du corpus et les gabarits vides", async () => {
    const [absent, gabarit] = await verifyCitations([
      { ref: "Code des marchés publics", article: "12", quote: "les marchés publics sont passés" },
      { ref: "décret n° … / …" },
    ]);
    expect(absent.status).toBe("bloquee");
    expect(gabarit.status).toBe("bloquee");
  });

  it("résout aussi une citation dans un document fourni (ex. DAO)", () => {
    const dao = documentFromText("dao_1", "DAO test", "", ["Page 1 : objet.", "Le cautionnement de soumission est de 1 500 000 FCFA."]);
    const r = verifyCitation({ ref: "dao_1", page: 2, quote: "cautionnement de soumission est de 1 500 000 FCFA" }, [dao]);
    expect(r.status).toBe("verifiee");
    expect(verifyCitation({ ref: "dao_1", quote: "cautionnement de soumission est de 2 000 000 FCFA" }, [dao]).status).toBe("non_verifiee");
  });
});

describe("post-contrôle des réponses de l'agent", () => {
  it("supprime les gabarits vides (« décret n° … / … », « loi n° ___ », « arrêté n° 2020/... »)", () => {
    const r = stripPlaceholderRefs("Voir le décret n°\u202f…\u202f/\u202f… portant création, la loi n° ___ et l'arrêté n° 2020/... ; la loi n° 2010/013 reste.");
    expect(r.removed).toHaveLength(3);
    expect(r.text).toContain("la loi n° 2010/013 reste");
    expect(r.text).not.toMatch(/…|___|\.\.\./);
  });

  it("signale un article inexistant d'une loi présente dans le corpus, garde un article réel", async () => {
    const r = await checkReferences("Selon l'article 999 de la loi n° 2010/013, et l'article 1er de la loi n° 2010/013.");
    expect(r.articles).toHaveLength(1);
    expect(r.articles?.[0]).toMatch(/article 999/);
    expect(r.text).toContain("article 999 de la loi n° 2010/013 (⚠️ article introuvable");
    expect(r.text).not.toContain("1er de la loi n° 2010/013 (⚠️");
  });
});

describe("carte de couverture du corpus", () => {
  it("décrit le contenu et distingue couvert / mentionné seulement / absent", async () => {
    const map = await corpusCoverage([
      { id: "telecom", label: "Loi sur les communications électroniques", match: ["communications electroniques"] },
      { id: "cmp", label: "Code des marchés publics", match: ["code des marches publics"] },
      { id: "zzz", label: "Texte inexistant", match: ["zorglub quantique"] },
    ]);
    expect(map.totals.documents).toBeGreaterThan(40);
    expect(map.categories.some((c) => c.category === "Appel d'offre")).toBe(true);
    const st = Object.fromEntries(map.needs.map((n) => [n.id, n.status]));
    expect(st).toEqual({ telecom: "couvert", cmp: "mentionne_seulement", zzz: "absent" });
  });
});
