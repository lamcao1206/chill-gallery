# Express Image Gallery

An Express.js rewrite of the FastAPI image gallery. Instead of serving files
from a local folder, media lives in **Amazon S3**, metadata lives in a
**Supabase** (Postgres) database, access is protected by **JWT auth**, and
galleries are created by **uploading a zip file** through the UI.

## Features

- JWT login (httpOnly cookie), all gallery pages require auth. **No public
  sign-up** — a single account is seeded with a script.
- Gallery list with search + pagination, and a paginated per-gallery reader
  (1/2/3 columns, fullscreen, per-user saved settings) — same UX as the original.
- Media served from S3 via short-lived **presigned URLs** (the server never
  proxies image bytes).
- **Upload page**: enter a name + submit a `.zip`; images/videos inside are
  extracted and pushed to S3, and the gallery is recorded in Supabase.
- **Migration script** to move the existing local `images/` folders into S3 + Supabase.
- Dockerfile + compose for EC2 deployment.

## Tech

Express 4 · EJS views · `@supabase/supabase-js` · AWS SDK v3 (S3) ·
`jsonwebtoken` · `bcryptjs` · `multer` + `unzipper`.

---

## 1. Prerequisites

- Node.js 20+
- A Supabase project
- An S3 bucket + AWS credentials (or an EC2 IAM role)

## 2. Database setup

In the Supabase dashboard → **SQL editor**, run [`supabase/schema.sql`](supabase/schema.sql).
It creates `users`, `galleries`, `images`, and `settings`.

> The server connects with the **secret key** (`sb_secret_...`) from a trusted backend, so
> Row Level Security is not required. Never expose that key to the browser.

## 3. S3 bucket setup

1. Create a private bucket (block all public access — images are reached only
   through presigned URLs).
2. The IAM identity the app uses needs, scoped to the bucket:
   `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket`.

Example policy (replace `your-gallery-bucket`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::your-gallery-bucket/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::your-gallery-bucket"
    }
  ]
}
```

> Presigned URLs work with a fully private bucket, so you do **not** need a
> bucket policy or CORS for `<img>`/`<video>` tags. (If you later fetch media
> with `fetch()` from the browser, add a CORS rule allowing `GET` from your origin.)

## 4. Configure

```bash
cp .env.example .env
# then fill in JWT_SECRET, SUPABASE_*, S3_*, AWS_* …
```

Generate a strong `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 5. Install & run

```bash
npm install
```

Create your single account (registration is disabled in the app):

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-strong-password' npm run create-user
```

Then start the server:

```bash
npm start          # or: npm run dev   (auto-reload)
```

Open http://localhost:8000 → you'll be redirected to `/login`. Sign in with the
account you just created. Re-running `create-user` with the same email resets
that password.

---

## 6. Migrate the existing local images

This pushes every sub-folder of the old `images/` directory into S3 + Supabase.
Each sub-folder becomes a gallery (matching the original app, which only listed
folders — loose zip/mp3/pdf files at the top level are ignored).

```bash
# from the express-image-gallery/ directory
LOCAL_IMAGE_ROOT=../images npm run migrate
```

Optional: attribute the migrated galleries to an existing account:

```bash
MIGRATE_OWNER_EMAIL=you@example.com LOCAL_IMAGE_ROOT=../images npm run migrate
```

The script is **idempotent** — galleries whose name already exists are skipped,
so you can safely re-run it.

---

## 7. Deploy on EC2

Two common options:

### A. Docker (recommended)

1. Launch an EC2 instance (Amazon Linux 2023 / Ubuntu). Attach an **IAM role**
   granting the S3 permissions above — then you can leave `AWS_ACCESS_KEY_ID` /
   `AWS_SECRET_ACCESS_KEY` blank in `.env`.
2. Open inbound port 80/443 (and 8000 if testing directly) in the security group.
3. Install Docker, copy this folder up (or `git clone`), create `.env`, then:

```bash
docker compose up -d --build
```

4. Put **nginx** (or an ALB) in front for TLS and proxy to `127.0.0.1:8000`.
   `trust proxy` is enabled in production so secure cookies work behind it.

### B. Node + systemd

```bash
npm install --omit=dev
# create /etc/systemd/system/gallery.service running: node src/server.js
sudo systemctl enable --now gallery
```

Health check endpoint for load balancers: `GET /healthz`.

---

## Routes

| Method | Path                | Auth | Purpose                         |
|--------|---------------------|------|---------------------------------|
| GET    | `/login`            | –    | Login page                      |
| POST   | `/login`            | –    | Authenticate, set JWT cookie    |
| POST   | `/logout`           | –    | Clear cookie                    |
| GET    | `/`                 | ✓    | Gallery list (search/paginate)  |
| GET    | `/gallery/:slug`    | ✓    | Gallery reader                  |
| GET    | `/upload`           | ✓    | Upload form                     |
| POST   | `/upload`           | ✓    | Create gallery from a zip       |
| GET    | `/api/settings`     | ✓    | Read per-user reader settings   |
| PUT    | `/api/settings`     | ✓    | Save per-user reader settings   |
| GET    | `/healthz`          | –    | Health check                    |
