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


## Resume and Continue Watching

GlockTV remembers where you got to and offers to put you back there. Progress is
personal: it is not watch-party state, and joining a friend's room neither reads
nor writes it.

### Two layers

| Layer | Who gets it | Where it lives |
| --- | --- | --- |
| Local | everybody, including guests and anonymous sessions | `localStorage`, this device only |
| Cloud | **protected accounts only** | `watch_progress`, across devices |

Nothing here signs anybody in. Pressing play never mints an account, so a
visitor who has not signed in keeps their progress on the device and nowhere
else - the same rule the account layer already follows.

**An anonymous Supabase session is still a guest.** The watch party mints one
the moment somebody opens a room, so "has a session" is not the same question
as "has an account": an anonymous identity lives in this browser's storage, and
syncing it across devices is a promise nothing could keep. Guests keep the
local layer, which is why that layer exists.

That boundary is enforced by RLS, not only by the client - the insert and
update policies refuse a token whose `is_anonymous` claim is true, so a
modified client posting straight to PostgREST with the same publishable key
every visitor holds gets the same answer. The client check exists to avoid
making requests it knows will be rejected.

Protecting a guest account costs nothing and migrates nothing: Supabase keeps
the same uid when an email is attached, so the rows this device already holds
become eligible under the identity they were always keyed to. Nothing is
deleted, and the uid Friends depends on is unchanged.

### Which clock decides

Both layers are read through one sanitizer and merged by one function. The
newer record wins, with one asymmetry the whole design rests on: the cloud's
timestamp is the **database's** clock and the local one is the **browser's**,
so a local stamp from the future does not win and an exact tie goes to the
cloud. Without that, one device with a wrong clock would freeze a title in
place across every other device.

That asymmetry is only real because the cloud side cannot be written by a
browser. `watch_progress.updated_at` is:

- **stamped by a trigger** on every insert and update, so a value that arrives
  in the payload is overwritten rather than stored; and
- **absent from the browser's column grants**, so such a request is refused
  before it gets that far.

The column default alone would not be enough - it applies only when the value
is omitted, and a modified client would simply name it. The browser's own idea
of when it saw a position goes to `observed_at`, which nothing trusts and
nothing compares.

### What the providers actually expose

Position is **observed**, never inferred. Clicking Watch records nothing; only a
player that reports where it is produces an entry.

| Server | Reports position | Resume | Notes |
| --- | --- | --- | --- |
| CineSrc | yes, `cinesrc:*` postMessage, origin-pinned | `?t=` | movies only - `resumeDisabledFor: ['tv']` |
| VidZen backup | yes, `PLAYER_EVENT` / `mplayer` postMessage | `?startAt=` | both media types |
| VidCore | no | none | the TV default, and it emits nothing |

So **TV on the default server has no resume**, because that provider does not
expose a position and GlockTV does not fabricate one. Nothing here scrapes a
cross-origin iframe or works around provider isolation; a server that says
nothing produces no entry, and Continue Watching stays empty rather than
inventing a place in a film nobody watched.

A resume is only offered into the server that observed it, so a position taken
from one provider is never handed to another that would ignore it.

### Rules

- **Worth resuming** at 30 seconds. Below that, resuming is worse than starting.
- **Finished** at whichever comes first of 95% or 90 seconds from the end, so a
  two-hour feature is not "finished" with six minutes left and a 22-minute
  episode is not still in progress during the credits. A finished title leaves
  Continue Watching and starts from the beginning if opened again.
- **No duration, no bar.** A player that reports a position but not a length
  gets a timestamp and no progress bar, because the bar would need an invented
  denominator.
- **Throttled.** At most one cloud write per title per 10 seconds, with an
  immediate send on pause, finish, episode change, player close and the tab
  going away - so the last position is never the one that got throttled away.

### Where to find it

Inside **My List**, as a second tab, and in the desktop sidebar. It is
deliberately not a sixth item in the mobile tab bar, which stays at exactly five
product destinations.

The next episode is offered when one finishes, but only when the season guide
actually lists it - it is an offer rather than an auto-advance, and no episode
number is assumed.

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

## Support tickets

Customers open tickets from the account panel, choose a category, and follow the
conversation. Support is part of the account surface, not a sixth destination -
the mobile tab bar stays at exactly five product slots.

Categories are the product's own areas: Account, Billing, Playback, Live TV,
PPV, Friends, Bug report, Other.

### What a browser cannot do

The design turns on one question: what stops an ordinary account from answering
its own ticket as staff, or marking it resolved? The answer is that neither is
reachable, rather than being guarded by a check the browser is asked to respect.

| Escalation | Why it fails |
| --- | --- |
| make myself staff | `staff_members` has **no grant** to `anon` or `authenticated`, so PostgREST refuses the relation before RLS is consulted. There is no RPC that adds a member. |
| reply as staff | `author_role` is **not read from the payload**. A `BEFORE INSERT` trigger derives it from staff membership, so a request claiming `staff` is overwritten. |
| resolve my own ticket | `authenticated` is granted `select, insert` on `support_tickets` and **no update at all**, so there is no policy mistake that could become self-service. |
| read another customer's ticket | every policy is scoped to `auth.uid()` or `is_support_staff()`; messages are reachable only through a ticket the caller may already see. |
| edit or delete the transcript | no `update` or `delete` grant on `support_messages`. |

`is_support_staff()` is `SECURITY DEFINER` with `search_path` pinned empty. It
answers only about the caller, so it cannot enumerate staff or test anybody
else.

### Staff

Membership is granted out of band by a trusted caller - the service role or the
SQL console:

```sql
insert into public.staff_members (user_id, role) values ('<auth uid>', 'agent');
```

There is deliberately no UI and no RPC for this. **A staff console is not built
here.** The seam it needs exists and is enforced by the database - staff already
read every ticket and their replies are already attributed correctly - so the
remaining work is a console, not a security model. That is the explicit
follow-up.

Status transitions are likewise a staff action with no browser path today. A
customer cannot close their own ticket in V1: allowing it means a status write,
and a narrow one is still a wider surface than none. Worth revisiting once the
staff console exists.

### Guests

A ticket needs somebody who can be reached and who can come back to it, and an
anonymous session that clears its storage loses the ticket and every reply on
it. So a protected account is required. The panel explains this, and the insert
policy enforces it against the JWT's `is_anonymous` claim - because the UI is
not where it is decided.

### Email

There is none, deliberately. No paid email provider is introduced, and the
ticket system works without one: replies appear in the panel. Notification
delivery is a future adapter, not a dependency.

## Reconciling migration history

`supabase db push --dry-run` answers one question: which local versions the
project's migration history does not record. It never says **why** they are
missing, and the two reasons need opposite treatment:

- the change was never made - it needs pushing;
- the change was made another way (by hand, through the dashboard, or under a
  different version string) - its **history** needs repairing, and pushing it
  would re-run DDL against live objects.

The **Apply Supabase migrations** workflow audits before it offers to do
either. It runs `supabase migration list` for what the history records, then
`scripts/audit-supabase-migrations.mjs`, which reads what each local migration
creates - from the migration itself, not a hand-kept list - and asks the
project which of those objects exist. Every statement it sends is a `SELECT`,
and it refuses to send anything else.

### The audit is diagnostic only

It produces **evidence, not authorization**. It never prints or constructs a
`supabase migration repair` command, and no status it reports means "proven
equivalent" — because this parser cannot establish that.

Names and existence are syntax; equivalence is semantics, and the audit reads
only the first. It does **not** verify:

- policy `USING` / `WITH CHECK` expressions
- function bodies, or `EXECUTE` grants on them
- column-level grants, or `REVOKE` state beyond a role holding no table privilege
- constraints added or changed by `ALTER TABLE`, or `FORCE ROW LEVEL SECURITY`
- object ownership
- which function a trigger fires, and when
- index columns, order, uniqueness and predicates

A policy with the right name and an inverted `USING` clause passes every check
the audit makes and grants the world read access. That list is printed with
every run, next to the results, so a "present" column is never read as a clean
bill of health.

You decide which versions may be repaired, and pass that hand-reviewed list to
the workflow's `repair_versions` input. The audit does not produce it.

### Object existence is not equivalence

A migration establishes far more than the objects it names: RLS policies,
grants and revokes, triggers, indexes, and whether a function is
`SECURITY DEFINER` with a pinned `search_path`. Every one of those can be
absent while the table sits there looking correct - and in this repository the
security rests on those parts rather than on the tables. Marking such a
migration applied writes it out of the history with its policies still missing,
and nothing will ever apply them.

So the audit reports every artifact a migration declares, and every verdict
except `history_match` is a lead for a person rather than an instruction:

| Verdict | Meaning |
| --- | --- |
| `history_match` | the exact version is already recorded; no action |
| `same_name_candidate` | a remote entry shares this name under a different version; **manual equivalence review required** |
| `schema_present_candidate` | everything the audit can look for is present, which is suggestive and proves nothing |
| `partial` | some of its primary objects exist; investigate |
| `absent` | none do; clearly pending, push it |
| `unverifiable` | it declares nothing the audit can look for |

Grant evidence keeps **`public` and `anon`** — this repository secures a table
by revoking from exactly those roles and granting narrowly back, so dropping
them would discard the half that matters. A revoke the same migration grants
back to is excluded, because the end state for that role is granted.

The audit also reports two things a dry run cannot:

- **same name, different version** - a lead for a human, never grounds for
  repair on its own. A shared name says somebody applied something with this
  purpose, not that they applied this content.
- **remote-only history entries** - changes the database has that this
  repository does not, which a push touching the same objects could contradict.

### When the dry run and the dashboard disagree

The audit prints the project's identity first - masked ref, name, region,
connected database - because "the history says X" means nothing without knowing
which database said it, and a dry run that contradicts the dashboard is usually
two different projects. Exact version matches are called out separately: if
`db push` lists a version the history already records, the push and the audit
are reading different histories, and that must be resolved before anything is
repaired or pushed.

Supply a **hand-reviewed** list of versions in the workflow's `repair_versions`
input and dispatch it again: repair writes rows into
`supabase_migrations.schema_migrations` and touches **no schema and no data**,
then the dry run re-runs so you can see what genuinely remains.

Repair is opt-in and runs on a dry run too, because repairing and re-checking
the push is the point of doing it. Applying still needs `dry_run` unticked, and
nothing about repairing can trigger an apply.

## Verifying the database boundaries

Everything that stops one account reading another's watch history, stops a
customer answering their own ticket as staff, and stops a browser granting
itself Premium lives in PostgreSQL - in a grant, a policy, a trigger. The test
suite reads those migrations and can prove a rule was **written**. It cannot
prove what a project did with it: a grant can be missing, over-broad, or
changed by hand later, and every source-level assertion would still pass.

`scripts/verify-supabase-permissions.mjs` asks a real project instead. Each
check has a wrong answer that is a privilege escalation.

| Section | Verifies |
| --- | --- |
| `billing` | service-role can execute `apply_billing_provider_state`; publishable key signed out cannot; an ordinary authenticated user cannot |
| `progress` | an account can create, read, update and delete its own progress; it cannot read, insert into, update or delete another's; an anonymous session cannot write cloud progress at all; `updated_at` is database time; a forged future `updated_at` cannot be established |
| `support` | a customer can open and read their own ticket; cannot read another's ticket or messages; cannot set status; cannot read or write `staff_members`; a reply claiming `author_role: 'staff'` is stored as `customer`; a real staff member's reply is stored as `staff`; the transcript cannot be edited or deleted |

### Running it

Export `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
`SUPABASE_PUBLISHABLE_KEY` into your shell - this file deliberately shows no
assignment, so no secret name here is ever one careless edit away from carrying
a real value - then:

```sh
node scripts/verify-supabase-permissions.mjs            # dry run, writes nothing
node scripts/verify-supabase-permissions.mjs --execute
node scripts/verify-supabase-permissions.mjs --execute --only support
```

**Sections are isolated.** Each provisions only what it needs, so
`--only billing` runs on a project where the support migration has not been
applied yet:

| Section | Users | Anonymous session | `staff_members` |
| --- | --- | --- | --- |
| `billing` | A | no | untouched |
| `progress` | A, B | yes - anonymous write rejection is part of what it verifies | untouched |
| `support` | A, B, staff | no | seeded by the service role |

A full run shares A and B across sections rather than provisioning them per
section; the rows each section writes for a given user do not overlap, and one
deletion removes all of them, so coverage is unchanged.

**Test-mode project only.** A run creates only the throwaway auth users its
sections need, writes only rows those users own, and deletes them in a
`finally` - which cascades every row it created. Cleanup removes what was
actually created, so a section that never ran leaves nothing behind. It never grants
Premium: the billing section applies the `free` tier throughout. Credentials
come from the environment only; nothing is written to a file, and the run
refuses to start if a variable is missing or if the service-role and
publishable keys are the same value, which would compare a role against itself.

The staff fixture is seeded through the only path there is - a service-role
insert into `staff_members` - because no browser-reachable way to become staff
exists, which is the property being verified.

`.github/workflows/verify-supabase-permissions.yml` runs it on
`workflow_dispatch` only, never on a push, and defaults to the dry run. It
needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
`SUPABASE_PUBLISHABLE_KEY` as Actions secrets.

The verifier itself is unit-tested with fixtures in
`tests/supabase-verifier.test.ts`: each check is driven with both the safe
answer and the escalating one and asserted to tell them apart, because a check
that reports PASS when a database says "yes, anyone may read that" is worse
than no check at all.

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

These three questions are now the `billing` section of the project-wide
verifier described under **Verifying the database boundaries** below.
