/** @type {import('next').NextConfig} */
const nextConfig = {
  // Index du corpus (généré par `npm run index-documents`, versionné pour le déploiement)
  // et seed d'exemple : lus via process.cwd(), on force leur inclusion dans les fonctions serverless.
  outputFileTracingIncludes: {
    "/api/**/*": ["./data/documents.json", "./corpus/exemples/**/*.json", "./packs/**/*"],
    "/workspace": ["./data/documents.json", "./corpus/exemples/**/*.json", "./packs/**/*"],
  },
  // Les PDF sources (~550 Mo) ne doivent jamais entrer dans un bundle de fonction :
  // sur Vercel ils sont servis en statique depuis public/sources (scripts/prepare-vercel.mjs).
  outputFileTracingExcludes: {
    "*": ["./reglementation/**/*", "./publications/**/*", "./public/sources/**/*", "./data/*.png"],
  },
};

export default nextConfig;
