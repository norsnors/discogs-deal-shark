# Discogs Deal Shark — Install & Setup

A desktop app that scans your Discogs **wantlist** and shows you copies that are for sale far
under their real market value — with the real media condition (VG+ / NM …), real shipping to your
country, and a direct buy link. The **Scout** tab can also discover valuable records outside your
wantlist and add one only after you explicitly click **Add to wantlist**. The app never adds anything
to a cart and never buys a record.

---

## 1. Install

### Windows

1. Download **`Discogs-Deal-Shark-Setup-<version>.exe`**.
2. Double-click it and follow the installer (you can choose the install folder). It creates a
   Start-menu and desktop shortcut, and an uninstaller.

> **Windows SmartScreen warning.** The installer isn't code-signed (a signing certificate costs
> money), so Windows may show *"Windows protected your PC"*. Click **More info → Run anyway**. This
> is normal for small/independent apps.

The app keeps your settings and scan cache in your per-user app-data folder
(`%APPDATA%\Discogs Deal Shark`), not in the install folder — so it survives upgrades and never
needs admin rights to run. Upgrades from Discogs Deal Watcher automatically keep using the existing
`%APPDATA%\Discogs Deal Watcher` profile, so saved credentials, settings and scan history remain intact.

### macOS (universal — Apple Silicon + Intel)

1. Download **`Discogs-Deal-Shark-<version>-mac.dmg`**, open it, and drag the app into
   **Applications**.
2. The app isn't signed with a paid Apple Developer certificate, so the first launch needs one
   manual unlock:
   - **Right-click the app → Open → Open** (don't double-click the first time — macOS blocks
     unsigned apps opened that way).
   - If macOS still reports it as *"damaged"* or *"can't be opened"* (common on Apple Silicon), open
     **Terminal** and run `xattr -cr "/Applications/Discogs Deal Shark.app"`, then open it normally.

Settings and the scan cache live in `~/Library/Application Support/Discogs Deal Shark`. Upgrades
continue to recognize an existing `~/Library/Application Support/Discogs Deal Watcher` profile.

Each GitHub release also contains `SHA256SUMS.txt`. You can use it to verify that the downloaded
installer is byte-for-byte identical to the file built by GitHub Actions.

---

## 2. First run — connect your Discogs account

On first launch a short **setup wizard** appears asking for:

- **Discogs username** — your account name (the wantlist it scans).
- **Discogs personal access token** — see below.
- **Currency** — the currency prices are shown/compared in (default EUR).

### Getting a Discogs token (free, ~30 seconds)

1. Sign in at [discogs.com](https://www.discogs.com).
2. Go to **Settings → Developers** (or open
   [discogs.com/settings/developers](https://www.discogs.com/settings/developers) — the wizard's
   *"How do I get a token?"* link takes you straight there).
3. Click **Generate new token** and copy the string it gives you.
4. Paste it into the wizard's **token** field.

The token lets the app read *your own* wantlist and Discogs' price information. Scout uses the same
token to add a release only when you explicitly press **Add to wantlist**. Keep the token private
(it's like a password). It's stored locally on your computer only.

Click **Test connection** to confirm it works (it should say *"signed in as … · N releases on the
wantlist"*), then **Save & scan**.

---

## 3. Using it

- **Scan wantlist** — sweeps your whole wantlist. For each release it looks for a copy that is
  genuinely **VG+ or better**, includes the real shipping to your location, refreshes sold medians,
  and compares the total with real sales history. Large wantlists can take a while because Discogs
  rate-limits these requests.
- **Deals** — the daily review queue. Search the results, inspect the discount explanation and price
  history, dismiss records you do not want, and open promising listings on Discogs.
- **Rare gems** — watches wantlist releases that had zero copies for sale and highlights them when a
  copy becomes available. Availability is the signal here, regardless of price.
- **Scout** — choose a Discogs style or genre, set a minimum estimated VG+ value (for example €80),
  and search for valuable releases outside your wantlist. Existing wantlist items are excluded.
  **Add to wantlist** performs exactly that one Discogs action; buying always remains manual.
- **Background scan** (⚙ Settings) — refresh automatically every N hours while the app is open. Set
  it to *Off* to disable it.

Click a deal or Scout result to inspect it on Discogs. The app never adds to cart or buys — you
always complete the purchase yourself.

---

## 4. Where the deals come from

By default the app uses **Local scan only** — everything happens on your PC, no cloud, no account
beyond your Discogs token. This is the recommended mode and needs no extra setup.

The **Source** dropdown in ⚙ Settings also offers two cloud modes — *GitHub Actions* and *Live
server* — but those only do something if you run your **own** always-on cloud watcher (see the
developer `README.md`). Most people should leave it on **Local scan only**.

---

## 5. Optional — 24/7 email alerts (built-in cloud setup)

Local scanning shows deals (and desktop notifications) while the app is open. If you also want
**email alerts around the clock — even when your computer is off** — the app can set that up for
you: it creates your own free copy of the watcher on GitHub and switches it on.

Open **⚙ Settings → "Set up cloud alerts…"**. You need two free accounts (one-time, ~5 minutes):

1. **GitHub** (runs the scans) — sign in at github.com, then click the wizard's token link. It opens
   a "new token" page with the right access already ticked; press **Generate token** and paste the
   result into the wizard.
2. **Resend** (sends the emails) — sign up at resend.com (Google login works), go to **API Keys →
   Create API key**, paste it into the wizard. Use the **same email address** for the alerts as you
   signed up to Resend with — Resend's free sender only delivers to your own address, and the first
   email may land in spam (mark it "not spam" once).

Press **Set it up** and the app does the rest: it creates the copy, stores your settings encrypted
on GitHub, switches the scan on, and starts the first run. The ☁ pill in the top bar then shows
when your cloud watcher last ran. Notes:

- Emails start after the watcher has seen your wantlist a few times (it learns normal prices first,
  so you don't get flooded on day one).
- If the official eBay API is already configured, the same action also stores its App ID and Cert
  ID as encrypted GitHub Secrets. Existing cloud users can instead use **eBay API settings → Connect
  eBay email**; the first eBay cloud scan learns existing listings without emailing them.
- GitHub runs free scheduled tasks roughly every 1–1.5 hours (it delays the requested schedule) —
  that's the alert latency to expect.
- It only ever **reads** Discogs and the official eBay Browse API and emails you; it never buys,
  bids, sends offers or messages. Everything runs on your own
  accounts; re-running the wizard is safe and just repairs/updates the setup.

---

## 6. Uninstall

Use **Settings → Apps → Discogs Deal Shark → Uninstall**, or the uninstaller in the install
folder. To also remove your saved settings/cache, delete `%APPDATA%\Discogs Deal Shark`. If you
upgraded from Deal Watcher, its legacy `%APPDATA%\Discogs Deal Watcher` profile may still be in use.
