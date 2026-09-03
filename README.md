# GlockTV

GlockTV is a mobile-first movie and TV discovery experience powered by TMDB. Its swipeable feed, recommendation score, filters, channel mode, trailer details, saved list, and private Friends watch parties are designed around the supplied TikTok-style product reference.

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local`.
3. Add either `VITE_TMDB_API_KEY` or `VITE_TMDB_READ_TOKEN`.
4. Add the Supabase project URL and publishable key for Friends rooms.
5. Add your authorized public movie and TV embed URL templates.
6. Start the app with `npm run dev`.

## Authorized playback

Set these values in `.env.local`:

```dotenv
VITE_MOVIE_EMBED_URL_TEMPLATE=https://vidcore.org/embed/movie/{tmdb_id}
VITE_TV_EMBED_URL_TEMPLATE=https://vidcore.org/embed/tv/{tmdb_id}/{season_number}/{episode_number}
```

The templates must use HTTPS. GlockTV replaces the placeholders when a viewer selects a movie or TV episode. Because GitHub Pages is a browser-only host, these values are public. Do not put a private API secret in any `VITE_` variable; private-key providers require a serverless proxy.

## Verify

```powershell
npm test
npm run typecheck
npm run build
```

## GitHub Pages

The workflow in `.github/workflows/deploy-pages.yml` builds and publishes the site whenever `main` changes. Add the TMDB v3 API key as the repository Actions secret `TMDB_API_KEY`. Add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` as repository Actions variables. The authorized public movie and TV embed templates are committed directly in the Pages build environment.

This product uses the TMDB API but is not endorsed or certified by TMDB.


## Advertising

Free accounts see ads. Premium does not - that is Premium's V1 benefit. The
decision is made in one place, `shouldShowAds` in `src/lib/account.ts`, and
`src/lib/ads.ts` asks it rather than restating it.

Two separate questions, deliberately not collapsed:

- **May this account be shown ads?** Fails closed. An account whose tier could
  not be learned is treated as free, because the alternative gives away ad-free
  GlockTV on every failed request.
- **Is it yet time to run a third party's script?** Waits for the account layer
  to settle. Rendering while entitlements are in flight would flash an ad at a
  confirmed Premium member on every load - correct by the first rule, and
  exactly what they paid to avoid.

A resolved Premium member runs **no ad code at all**. The slot returns `null`,
so there is no element to fetch the script - not a hidden one that loaded first.

### Isolation

Each slot is a `sandbox="allow-scripts"` iframe with no `allow-same-origin`,
no `allow-popups` and no `allow-top-navigation`. That makes the privacy
properties structural rather than promises:

- the ad script runs at a null origin, so it cannot read this site's
  `localStorage` or its Supabase session;
- it is passed a zone id and nothing else - no email, account id, Stripe
  customer or subscription id, or room code, none of which the slot has;
- `referrerpolicy="no-referrer"` and a `no-referrer` meta, so the network is
  not handed the page URL;
- a popunder or a forced redirect cannot execute even if one is served.

That last point is intentional. Formats that depend on opening a window will
render nothing here rather than hijacking the page.

**On CSP:** GitHub Pages serves no response headers we control, so a real
`Content-Security-Policy` would have to be a `<meta http-equiv>` covering every
existing third party at once - TMDB, Supabase, three playback providers, Google
Fonts. That is worth doing and is not done here; the sandbox above is the
enforcement for the one script this PR adds. Treat a site-wide CSP as
outstanding, not as covered.

### Configuration

Zone identifiers and the snippet URL are **public publisher identifiers**, not
secrets, and they are the only ad values this repository reads:

- `VITE_ADS_SCRIPT_URL` - the per-zone script the HilltopAds dashboard
  generates. There is no hard-coded default: the snippet is account-specific,
  and a plausible-looking guess would either fail silently or load something
  nobody chose.
- `VITE_ADS_ZONE_CONTEXT_RAIL`, `VITE_ADS_ZONE_DETAILS_PANEL` - optional, for a
  publisher running one zone per placement.

The URL must be `https:`, carry no credentials and name a real host; a zone id
must match `[A-Za-z0-9_-]{1,64}`. Anything else is refused rather than
half-loaded. With nothing set, ads are off: no slot, no placeholder, no empty
box, and development and CI run in exactly that state.

### Choosing the zone type - read this before creating one

**Do not use MultiTag Banner.** HilltopAds' own documentation describes it as
containing "two ad formats - Banner and Popup", with the network choosing
between them. Which format a viewer gets is then not the publisher's decision,
and popup is not a format this product ships. Create a **banner/display zone**
instead.

If the only zone type available cannot avoid popup inventory, that is a
provider constraint to raise rather than route around - the sandbox will
suppress the popup half, so the result is paid-for inventory that renders
nothing rather than a working banner.

### Placements

Two, both outside the player and outside the navigation:

| Placement | Where | Size |
| --- | --- | --- |
| `context-rail` | last item in the desktop context column | 300x250 |
| `details-panel` | below the actions in the title details overlay | 300x250 |

Neither overlays anything. The slot's `z-index` is 1, below the bottom
navigation at 40 and dialogs at 80, so an ad cannot cover a control.

### Reporting

There is none, and that is deliberate. Impressions, fill and revenue are the ad
network's to report; this repository does not compute a CPM, and no revenue
figure here would be anything but invented.

## Premium membership

GlockTV Premium is one recurring monthly subscription whose only V1 benefit is
ad-free GlockTV. Free accounts keep the whole product.

Payment state is never taken from the browser. The site can ask the server to
start a checkout or open the billing portal; a member becomes Premium only
because Stripe sent a signed webhook that the server verified. Returning from
Stripe with `?billing=return` re-reads entitlements from the server and grants
nothing on its own.

### Where the trusted parts run

Three Supabase Edge Functions in `supabase/functions`:

| Function | Caller | How it is authorized |
| --- | --- | --- |
| `create-checkout` | the site | Supabase JWT; anonymous accounts refused |
| `create-billing-portal` | the site | Supabase JWT; customer read from the caller's own mapping |
| `stripe-webhook` | Stripe | Stripe signature over the raw body; no JWT |

`.github/workflows/deploy-supabase-functions.yml` deploys them when they change
on `main`. PR checks never deploy.

### Subscription policy

`active`, `trialing` and `past_due` are Premium; `unpaid`, `incomplete`,
`incomplete_expired`, `canceled` and `paused` are Free, as is any status this
build does not recognise. `past_due` staying Premium is deliberate: one failed
renewal attempt should not cost a paying member their membership while Stripe
retries, and Stripe moving the subscription to `unpaid` or `canceled` is what
downgrades them. A subscription set to cancel at period end keeps Premium until
`current_period_end` and is Free after it.

### Secret names

Never commit a value for any of these, and never give one a `VITE_` prefix —
that prefix publishes it in the browser bundle.

Supabase Edge Function secrets, set with `supabase secrets set`:

- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- STRIPE_PRICE_PREMIUM_MONTHLY
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY

GitHub Actions repository secrets, used only to deploy the functions:

- SUPABASE_ACCESS_TOKEN
- SUPABASE_PROJECT_REF

### Setup still required before checkout works

Nothing below is done by this repository:

1. Create the Stripe test-mode product and its recurring monthly price.
2. Set `STRIPE_SECRET_KEY` and `STRIPE_PRICE_PREMIUM_MONTHLY` as Supabase
   function secrets.
3. Apply `supabase/migrations` to the project.
4. Add `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` as Actions secrets and
   let the workflow deploy the functions.
5. Create a Stripe webhook endpoint pointing at the deployed `stripe-webhook`
   URL, subscribed to the `customer.subscription.*` and `checkout.session.completed`
   events, then set the endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`.
6. Set `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL` as function secrets.

Until all six are done the account panel shows Premium as unavailable rather
than failing at the point of payment.

### Smoke test to run once the migrations are applied

`apply_billing_provider_state` writes `account_entitlements` directly, so its
execute permission is the difference between the webhook working and a browser
being able to grant itself Premium. That permission lives in the database, not
in this repository, and no amount of reading the migration proves what the
database actually did with it. Against the test-mode project, confirm both
halves for real:

- calling `/rest/v1/rpc/apply_billing_provider_state` with the **service-role**
  key succeeds;
- the same call with the **publishable** key is refused, both signed out and
  signed in as an ordinary account.

A failure of the first means every webhook silently 500s. A success of the
second means anyone can set their own tier.
