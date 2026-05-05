# Deploy on Railway

What happens **without** GitHub connected? Nothing breaks—you deploy by pushing code **from your laptop** (`railway up`) or by redeploying from the Railway dashboard. **With** GitHub connected, each push to your branch can trigger an automatic deploy.

## One-time: Postgres + env vars

If Postgres was removed (e.g. during debugging), add it again: **project → + Add → Database → PostgreSQL**. Wait until it shows **Online**, then on your **web** service add **`DATABASE_URL`** via **Reference** to that Postgres service. Redeploy. Data in the old DB is gone unless you have backups.

1. **Create a Railway project** (dashboard or `railway init` in this folder).
2. Add a **PostgreSQL** database (same project). Railway exposes **`DATABASE_URL`**—attach it to your **web service**:
   - Open your **app service** → **Variables** → add `DATABASE_URL` using **Reference** to your Postgres plugin’s `DATABASE_URL`, or paste the connection string from the Postgres service.
3. On the **web service**, set variables (names match `shopify app env` / your Partner app):

   | Variable | Where it comes from |
   |----------|---------------------|
   | `DATABASE_URL` | Postgres service (reference) |
   | `SHOPIFY_API_KEY` | Partners → App → Client credentials |
   | `SHOPIFY_API_SECRET` | Same |
   | `SCOPES` | Same as `shopify.app.toml`, comma-separated: `read_orders,write_orders,read_products` |
   | `SHOPIFY_APP_URL` | Full URL with **`https://`** (required). Example: `https://YOUR_SERVICE.up.railway.app`. A hostname alone will crash the server unless you deploy code that normalizes it—or paste the full URL in Railway. |
   | `NODE_ENV` | `production` |

4. **Deploy**
   - **CLI (no GitHub required):** from this directory, run `railway link`, pick the project and environment, then at **“Select a service”** press **Esc** to **skip** (do **not** choose **Postgres**). That leaves the folder linked to the project so `railway up` can create or target a **web** service. If you link to Postgres by mistake, `railway up` will try to deploy your app into the **database** service and fail.
   - Then run `railway up`. If log streaming errors in the terminal, open the **Build Logs** URL Railway prints, or use `railway up -d` (detach from the stream).

If **`DATABASE_URL`** is set on the service but **build** still fails with **P1012**, many hosts (including Railway) sometimes **do not inject variables during the build phase**. This repo’s `npm run build` uses [`scripts/railway-build.mjs`](../scripts/railway-build.mjs) so **`prisma generate`** can run without a real DB URL at build time; **runtime** still requires a real **`DATABASE_URL`** (reference Postgres) for **`migrate deploy`**.
   - **GitHub (when github.com is healthy):** Project → **Settings** → connect repo and enable **deploy on push**.

5. After you have a stable URL, run **`shopify app deploy`** from your machine so Shopify registers that URL, webhooks, and scopes.

6. **Install** the app on your store from Partners / Dev Dashboard and open it in Admin to confirm.

## GitHub auto-deploy (optional)

When GitHub’s status is green: Railway → your service → connect the repository and choose the branch. Then **git push** triggers builds. Until then, use **`railway up`** after local changes.

## Local development after Postgres switch

You need a **`DATABASE_URL`** in `.env` (see `.env.example`). Easiest options: Railway Postgres “Connect” string in dev, or a local Docker Postgres, or a free Neon database.

```bash
cp .env.example .env
# edit DATABASE_URL, then:
npx prisma migrate dev
npm run dev
```
