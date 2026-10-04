-- ============================================================
-- Express Image Gallery — Supabase schema
-- Run this in the Supabase SQL editor (or `psql`) once.
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- Users
-- ------------------------------------------------------------
create table if not exists public.users (
    id            uuid primary key default gen_random_uuid(),
    email         text unique not null,
    password_hash text not null,
    created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Galleries (one per folder / uploaded zip)
-- ------------------------------------------------------------
create table if not exists public.galleries (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    slug        text unique not null,
    cover_key   text,                       -- S3 key of the first image
    image_count integer not null default 0,
    created_by  uuid references public.users(id) on delete set null,
    created_at  timestamptz not null default now()
);

create index if not exists galleries_name_idx on public.galleries (lower(name));

-- ------------------------------------------------------------
-- Images (media items inside a gallery)
-- ------------------------------------------------------------
create table if not exists public.images (
    id          uuid primary key default gen_random_uuid(),
    gallery_id  uuid not null references public.galleries(id) on delete cascade,
    s3_key      text not null,              -- full key in the bucket
    filename    text not null,
    media_type  text not null default 'image',  -- 'image' | 'video'
    position    integer not null default 0,
    created_at  timestamptz not null default now()
);

create index if not exists images_gallery_pos_idx on public.images (gallery_id, position);

-- ------------------------------------------------------------
-- Per-user reader settings
-- ------------------------------------------------------------
create table if not exists public.settings (
    user_id    uuid primary key references public.users(id) on delete cascade,
    columns    integer not null default 1,
    fullscreen boolean not null default false,
    page_size  integer not null default 24
);

-- ============================================================
-- NOTE on Row Level Security:
-- This app talks to Supabase with the SECRET key (sb_secret_...) from a
-- trusted Node server only, so RLS is not required for it to work.
-- The secret key bypasses RLS. Do NOT expose that key to browsers.
-- If you later add a browser-side anon client, enable RLS and add
-- policies before doing so.
-- ============================================================
