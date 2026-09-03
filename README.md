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

GitHub Actions repository secrets, used only to deploy the functions and to
apply migrations:

- SUPABASE_ACCESS_TOKEN
- SUPABASE_PROJECT_REF
- SUPABASE_DB_PASSWORD

`SUPABASE_DB_PASSWORD` is read only by `apply-supabase-migrations.yml`; the
function deploy does not need it.

### Setup still required before checkout works

Nothing below is done by this repository:

1. Create the Stripe test-mode product and its recurring monthly price.
2. Set `STRIPE_SECRET_KEY` and `STRIPE_PRICE_PREMIUM_MONTHLY` as Supabase
   function secrets.
3. Add `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` and
   `SUPABASE_DB_PASSWORD` as Actions secrets.
4. Apply `supabase/migrations` to the project by running the **Apply Supabase
   migrations** workflow. Leave `dry_run` ticked the first time to see which
   migrations the project is missing, then run it again with `dry_run`
   unticked to apply them. Re-running applies nothing already recorded in the
   project's migration history, so it is safe to repeat.
5. Let **Deploy Supabase Edge Functions** run - it deploys on any push to
   `main` that touches `supabase/functions`, and can also be dispatched by
   hand. It now fails immediately, naming the secret, if step 3 was skipped.
6. Create a Stripe webhook endpoint pointing at the deployed `stripe-webhook`
   URL and subscribe it to exactly these six events, which are the only ones
   the function acts on:

   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`

   The two invoice events are not optional. A renewal that fails moves the
   subscription to `past_due`, which stays Premium while Stripe retries, and
   the invoice events are what tell GlockTV the retry landed. Subscribing to
   the subscription events alone leaves a recovered member waiting for the
   next unrelated subscription change. Any event outside this list is
   accepted, recorded and ignored, so subscribing to more is harmless but
   pointless. Then set the endpoint's signing secret as
   `STRIPE_WEBHOOK_SECRET`.
7. Set `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL` as function secrets.

Until all seven are done the account panel shows Premium as unavailable rather
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

`scripts/verify-billing-permissions.mjs` asks the project all three questions
and exits non-zero if any answer is wrong. Export `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_PUBLISHABLE_KEY` into your shell -
this file deliberately shows no assignment, so no secret name here is ever one
careless edit away from carrying a real value - then run:

```sh
node scripts/verify-billing-permissions.mjs
```

It reads its keys from the environment only - nothing is written to a file and
no key is committed. It signs in anonymously to obtain a real `auth.uid()` to
key the write to, applies the `free` tier under an obvious `smoke_` namespace
so no account is granted Premium by the test, and deletes the rows afterwards.
Run it against the test-mode project after every migration change that touches
the function or its grants.
