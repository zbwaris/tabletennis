# Setting up the ranking website

The website is in the `docs` folder. GitHub hosts it for free (GitHub Pages), and the results
live in `docs/data.json` in the same repository. Viewers just open the link. The recorder's phone
saves results straight to GitHub.

One-off setup takes about 15 minutes.

## 1. Put this folder on GitHub

Using GitHub Desktop:

1. **File → Add local repository**, choose this folder. It isn't a repository yet, so click
   **create a repository**, then **Create repository**.
2. Click **Publish repository**. **Untick "Keep this code private"**: free GitHub Pages needs a
   public repository.

Everything in the folder becomes public, including `agreed-rules.md` and the results (names and
scores). If you'd rather keep the notes private, move them out of the folder first.

## 2. Turn on the website

On github.com, open the repository → **Settings → Pages**.

- Source: **Deploy from a branch**
- Branch: **main**, folder: **/docs** → **Save**

After a minute or two the site is live at `https://<your-username>.github.io/table_tennis_ranking/`.
This is the link to share with the club.

## 3. Make a token for the recorder's phone

The token lets the app save results to this one repository and nothing else.

1. github.com → your picture → **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
2. Name it `tt-recorder`. Set the expiry as long as GitHub allows, and note the date: the app
   stops saving when it expires, and you make a new one.
3. **Repository access → Only select repositories →** `table_tennis_ranking`.
4. **Permissions → Repository permissions → Contents → Read and write.**
5. **Generate token** and copy it (it starts `github_pat_`).

## 4. Sign in on your phone

Open the site → **Recorder sign-in** (at the bottom) → paste the token → **Sign in**. The
repository name is filled in for you. The token stays on that phone only. A helper can sign in
the same way on their phone.

## A Friday night

1. **Record → tick who's here → Start night.** Groups and fixtures are made automatically,
   seeded by rating.
2. Tap a fixture and type each game's score. The dialog shows who won and the rating change
   before you save.
3. When the groups are done: **Make semi-finals**, then **Make final**.
4. **Close night and update ratings.**

Results are saved on the phone immediately and uploaded to GitHub every 5 minutes, because each
upload rebuilds the site and GitHub allows about 10 rebuilds an hour. Closing the night uploads
straight away. Tap the **Upload** button at the top to upload sooner. With no signal, results
stay on the phone and upload when it reconnects.

To correct an old result: **Nights → that night → Reopen**. Fix the score, then close it again.
Everything after it is recalculated.

## Trying it on your computer

From the `docs` folder run `python -m http.server`, then open http://localhost:8000. Viewing
works locally. Recording always saves to GitHub.
