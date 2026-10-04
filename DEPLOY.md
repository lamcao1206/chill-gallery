# Deploying to EC2

A step-by-step guide to run this app on an EC2 instance with Docker, including
how to create the `.env` on the server.

---

## 0. Before you start

Have these ready:
- Supabase: `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (`sb_secret_...`)
- An S3 bucket name + its region (e.g. `ap-southeast-1`)
- The schema already applied (run `supabase/schema.sql` in the Supabase SQL editor)

---

## 1. Create the S3 bucket

1. S3 → Create bucket → keep **Block all public access ON** (images are reached
   through presigned URLs, so the bucket stays private).
2. Note the bucket name and region.

---

## 2. Create an IAM role for the instance (recommended)

This lets the app reach S3 **without** putting AWS keys in `.env`.

1. IAM → Policies → Create policy → JSON, paste (replace the bucket name):

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

2. Name it e.g. `gallery-s3-access`.
3. IAM → Roles → Create role → Trusted entity **AWS service → EC2** → attach the
   policy above → name it `gallery-ec2-role`.

You'll attach this role to the instance in the next step.

---

## 3. Launch the EC2 instance

1. EC2 → Launch instance.
2. **AMI:** Ubuntu Server 22.04 LTS (or Amazon Linux 2023).
3. **Type:** `t3.small` is a good start (uploads unzip in memory/temp; `t3.micro`
   works for light use).
4. **Key pair:** create/download one (e.g. `gallery-key.pem`) so you can SSH in.
5. **Network / Security group — inbound rules:**
   - SSH (22) from **your IP only**
   - HTTP (80) from anywhere (if you'll add nginx + a domain)
   - Custom TCP (8000) from your IP — handy for a first smoke test
6. **Advanced details → IAM instance profile:** select `gallery-ec2-role`.
7. Launch. Note the instance's **public IP / DNS**.

---

## 4. SSH in and install Docker

```bash
chmod 400 gallery-key.pem
ssh -i gallery-key.pem ubuntu@YOUR_EC2_PUBLIC_IP     # 'ec2-user' on Amazon Linux
```

On the instance (Ubuntu):

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER
# log out and back in so the group applies:
exit
```

Then SSH back in.

---

## 5. Get the code onto the instance

**Option A — git** (if you've pushed this folder to a repo):

```bash
git clone YOUR_REPO_URL gallery
cd gallery           # cd into express-image-gallery if it's a subfolder
```

**Option B — copy from your laptop** (run this on your LAPTOP, not the server).
Note the trailing slash and that `node_modules` / `.env` are skipped:

```bash
rsync -av --exclude node_modules --exclude .env \
  -e "ssh -i gallery-key.pem" \
  ./express-image-gallery/ \
  ubuntu@YOUR_EC2_PUBLIC_IP:~/gallery/
```

---

## 6. Create the `.env` on the server

On the instance, inside the project folder (`~/gallery`):

```bash
nano .env
```

Paste this and fill in your real values:

```env
PORT=8000
NODE_ENV=production

# Generate a strong one (see command below) and paste it here:
JWT_SECRET=PASTE_A_LONG_RANDOM_STRING
JWT_EXPIRES_IN=7d

SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=sb_secret_xxxxxxxxxxxxxxxxxxxx

AWS_REGION=ap-southeast-1
S3_BUCKET=your-gallery-bucket
S3_PREFIX=galleries
S3_URL_TTL=3600

# Leave AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY OUT entirely —
# the EC2 instance role from step 2 provides credentials automatically.
```

Save in nano: `Ctrl+O`, `Enter`, then `Ctrl+X`.

Generate a strong `JWT_SECRET` (run on the server, copy the output into `.env`):

```bash
openssl rand -hex 48
```

Lock the file down so only you can read it:

```bash
chmod 600 .env
```

> If you did NOT attach an IAM role in step 2, add these two lines to `.env`
> instead (less secure — rotate them if leaked):
> ```env
> AWS_ACCESS_KEY_ID=AKIA...
> AWS_SECRET_ACCESS_KEY=...
> ```

---

## 7. Build and run

```bash
docker compose up -d --build
docker compose logs -f          # watch startup; Ctrl+C to stop watching
```

You should see `Image gallery listening on http://0.0.0.0:8000`.

Smoke test from your laptop browser: `http://YOUR_EC2_PUBLIC_IP:8000/login`
(works only if port 8000 is open to your IP).

---

## 8. Create your login account

Run the seed script **inside the container** (it already has the `.env`):

```bash
docker compose exec -e ADMIN_EMAIL=you@example.com \
  -e ADMIN_PASSWORD='a-strong-password' \
  gallery npm run create-user
```

Now log in at `/login`.

---

## 9. Migrate existing images (optional)

If you want the old local galleries in S3, run the migration. The images must be
reachable from the server — easiest is to run the migration from your **laptop**
(where the `images/` folder lives) with AWS keys + the same `.env`, pointing at
the bucket:

```bash
# on your laptop, in express-image-gallery/
LOCAL_IMAGE_ROOT=../images npm run migrate
```

(On the laptop you need `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `.env`,
since the laptop has no instance role.)

---

## 10. Put nginx + HTTPS in front (recommended)

Running on bare port 8000 has no TLS. For a real domain:

```bash
sudo apt install -y nginx
```

Create `/etc/nginx/sites-available/gallery`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 2048M;   # allow large zip uploads

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable it and add a free TLS cert:

```bash
sudo ln -s /etc/nginx/sites-available/gallery /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Point your domain's DNS A-record at the EC2 public IP first. After this, close
port 8000 in the security group and keep only 80/443.

The app already sets `trust proxy` in production, so secure cookies work behind nginx.

---

## Updating later

```bash
cd ~/gallery
git pull            # or rsync again
docker compose up -d --build
```

## Handy commands

```bash
docker compose ps             # status
docker compose logs -f        # live logs
docker compose restart        # restart
docker compose down           # stop & remove container
```
