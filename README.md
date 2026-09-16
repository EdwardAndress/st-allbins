# St Allbins

Am I putting out the landfill or recycling bin this week? A tiny St Albans bin-day app.

The whole district follows one of only two fortnightly schedules ("Week 1" or "Week 2"), so this is a static site — no backend, no scraping at runtime. A GitHub Action refreshes `schedule.json` from the council's PDFs every Monday.

## Run locally

```sh
npm install
npm run build   # fetch council PDFs → schedule.json
npm run serve   # open http://localhost:8765
```

## Deploy to GitHub Pages

1. Push to GitHub.
2. Repo → Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Settings → Actions → General → Workflow permissions: **Read and write permissions** (so the update workflow can commit).

The `update-schedule` workflow runs weekly and commits any change to `schedule.json`, which triggers a Pages rebuild.

## Which week am I?

Look up your road on the [council site](https://www.stalbans.gov.uk/rubbish-collections) — it tells you whether you're on Week 1 or Week 2. The app remembers your choice in `localStorage`.

## What it does

- Reads today's date.
- Finds the current week in `schedule.json`.
- Shows a big brown bin (landfill), black bin (recycling), and — if you have a garden waste subscription — a green bin on recycling weeks (except the festive break).

## Colours

- 🟫 Landfill — brown
- ⬛ Recycling — black
- 🟩 Garden waste — green
