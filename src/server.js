import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import cookieParser from "cookie-parser";

import { config, isProd } from "./config.js";
import { loadUser, requireAuth } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { galleryRouter } from "./routes/gallery.js";
import { uploadRouter } from "./routes/upload.js";
import { settingsRouter } from "./routes/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Behind an EC2 load balancer / nginx, trust the proxy so secure
// cookies and req.protocol work correctly.
if (isProd) {
    app.set("trust proxy", 1);
}

// Views (EJS) + static assets.
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "..", "public")));

// Parsers.
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// Make req.user available everywhere.
app.use(loadUser);

// Public auth routes.
app.use(authRouter);

// Health check (handy for EC2 / load balancer probes).
app.get("/healthz", (req, res) => res.json({ ok: true }));

// Everything below requires a logged-in user.
app.use(requireAuth);
app.use(galleryRouter);
app.use(uploadRouter);
app.use(settingsRouter);

// 404.
app.use((req, res) => {
    res.status(404).render("error", {
        title: "Not found",
        message: "Page not found.",
    });
});

// Error handler.
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render("error", {
        title: "Error",
        message: isProd ? "Something went wrong." : String(err.message || err),
    });
});

app.listen(config.port, () => {
    console.log(
        `Image gallery listening on http://0.0.0.0:${config.port}`
    );
});
