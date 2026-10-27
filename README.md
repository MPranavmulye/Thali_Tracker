# Thali — phone app with sync between phones (all free)

This is the same Thali calorie tracker as the one in Claude, installed on your phones like a normal app.

- **Sync:** both phones sign in to one account, and anything logged on either shows up on the other within seconds.
- **Offline:** entries made offline are saved on the phone and upload once you're back online.
- **AI:** meals go straight from your phone to free AI providers (Gemini, then Groq, then OpenRouter) using your keys.
- **Hosting:** the app's code is on GitHub Pages. Your data is in your own free Supabase project, and only your account can read it.

---

## A. Already deployed the earlier version? Update your GitHub repository

Upload these from this folder to your `thali` repository on github.com, under **Add file → Upload files**:
- `index.html`, `shim.js`, `sw.js`, `config.js`, `app.html`, `build.py`, `setup.sql`, `README.md`
- the **`vendor`** folder: drag the whole folder in, and GitHub keeps it as a folder

Click **Commit changes**.

New here? First follow **"Step 1 — Put it online"** at the end of this file, then come back.

## B. Create your free sync database (one time, about 5 minutes, easiest on a computer)

1. Go to **supabase.com → Start your project** and sign in, for example with GitHub.
2. Click **New project**.
   - Name: `thali`.
   - Database password: click **Generate**. You won't need it again.
   - Region: **South Asia (Mumbai)**.
   - Click **Create** and wait about 2 minutes.
3. Left menu → **SQL Editor → New query**. Open `setup.sql` from this folder, copy everything, paste it in, and click **Run**. You should see *Success*.
4. Left menu → **Authentication → URL Configuration**. Set **Site URL** to your app's address, e.g. `https://yourname.github.io/thali/`, and click **Save**. This makes the sign-up confirmation email open your app.
5. Click **Connect** (top of the page), or go to **Project Settings → API Keys**. Copy two values:
   - **Project URL**, like `https://abcdefgh.supabase.co`
   - **Publishable key**, starting with `sb_publishable_`
6. In your GitHub repository, open **`config.js`**, click the ✏️ pencil, and paste both values between the quotes:

   ```js
   supabaseUrl: "https://abcdefgh.supabase.co",
   supabaseKey: "sb_publishable_xxxxxxxx"
   ```

   Click **Commit changes**.

It's safe for both values to be public. The publishable key only lets someone try to sign in, and the security rules in `setup.sql` let each account see only its own data.

## C. Sign in on both phones

**Phone 1** (the one with your existing log):
1. Open Thali. If it doesn't show the new version, close it fully and reopen it once or twice.
2. The **Sync between phones** screen appears. Enter your email and a password, then tap **Create account**.
3. Open the confirmation email, tap the link, and sign in.
4. Your existing log uploads automatically.

**Phone 2:**
1. Open your app address in Chrome and tap **⋮ → Install app**.
2. Open it and tap **Sign in** with the same email and password.
3. Your log, goals and AI keys all arrive. Nothing needs to be entered twice.

To check that it's working, open **☰** on either phone. The bottom line shows e.g. *Synced at 8:42 PM*. You can also open **☰ → Sync between phones** and tap **Sync now**.

## How sync behaves

- **Same entry edited on both phones:** the version saved last wins.
- **Deletes** carry over to the other phone.
- **No signal:** keep logging. The drawer shows *"1 change waiting to upload"*, and it uploads by itself when you're back online.
- **Photos** upload to private storage, so you can open them from either phone. The thumbnail on the card always works, even offline.
- **Signing out** keeps the log on that phone, but it stops syncing.

## Keep in mind

- **Free Supabase pauses** a project after 7 days with no activity. Logging daily keeps it awake. If it ever pauses, open supabase.com and click **Restore project**. Your data is kept.
- **Free storage** is 500 MB of data and 1 GB of photos. That's years of meals, since one photo is about 0.2 MB.
- **Backups:** your log now lives in your Supabase project and on each phone. Downloading an occasional backup from **☰ → Backup & restore** is still a good habit.
- **Privacy on free AI tiers:** providers may use the meal text and photos you send to improve their models.

---

## Step 1 — Put it online (only if you haven't yet)

1. Create a free account at **github.com**.
2. Click **+ → New repository**, name it `thali`, choose **Public**, and click **Create repository**.
3. Click **"uploading an existing file"**. Drag in **everything in this folder**, including the `vendor` folder, and click **Commit changes**.
4. Go to **Settings → Pages**. Set *Source* to **Deploy from a branch**, the branch to **main**, and the folder to **/ (root)**. Click **Save**.
5. After 1–2 minutes, your app is at **`https://yourname.github.io/thali/`**.
6. On each phone, open that address in Chrome and tap **⋮ → Install app**. On an iPhone, use Safari → **Share → Add to Home Screen**.

## AI keys (free, no card)

- Gemini: https://aistudio.google.com/apikey
- Groq: https://console.groq.com/keys
- OpenRouter: https://openrouter.ai/settings/keys

Enter them under **☰ → AI keys** and tap **Test keys**. With sync on, you enter them once and the other phone gets them.

## Updating the app later

If you get a new `app.html`:
1. Replace it in this folder.
2. Run `python build.py`.
3. Upload the new `index.html` to GitHub.

Your data isn't touched.
