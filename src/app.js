// src/app.js
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import cookieParser from "cookie-parser";

import { isProd } from "./config.js";
import { loadUser, requireAuth } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { galleryRouter } from "./routes/gallery.js";
import { uploadRouter } from "./routes/upload.js";
import { settingsRouter } from "./routes/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

if (isProd) {
  app.set("trust proxy", 1);
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "..", "public")));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

app.use(loadUser);

app.use(authRouter);

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

app.use(requireAuth);
app.use(galleryRouter);
app.use(uploadRouter);
app.use(settingsRouter);

app.use((req, res) => {
  res.status(404).render("error", {
    title: "Not found",
    message: "Page not found.",
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render("error", {
    title: "Error",
    message: isProd
      ? "Something went wrong."
      : String(err.message || err),
  });
});

export default app;