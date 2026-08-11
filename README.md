# GlockTV

GlockTV is a mobile-first movie and TV discovery experience powered by TMDB. Its swipeable feed, recommendation score, filters, channel mode, trailer details, and saved list are designed around the supplied TikTok-style product reference.

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local`.
3. Add either `VITE_TMDB_API_KEY` or `VITE_TMDB_READ_TOKEN`.
4. Start the app with `npm run dev`.

## Verify

```powershell
npm test
npm run typecheck
npm run build
```

## GitHub Pages

The workflow in `.github/workflows/deploy-pages.yml` builds and publishes the site whenever `main` changes. Add the TMDB v3 API key as the repository Actions secret `TMDB_API_KEY`, then select **GitHub Actions** as the Pages source.

This product uses the TMDB API but is not endorsed or certified by TMDB.

