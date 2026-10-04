#!/usr/bin/env node
/**
 * Create (or update) the single account for this gallery.
 *
 * Registration is disabled in the app, so this is the only way to make a user.
 * Credentials come from env so the password never lands in shell history or code.
 *
 * Usage:
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-strong-password' npm run create-user
 *
 * Re-running with the same email resets that account's password.
 */
import { supabase } from "../src/db/supabase.js";
import { hashPassword } from "../src/lib/auth.js";

const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || "");

async function main() {
    if (!email || !password) {
        console.error(
            "Set ADMIN_EMAIL and ADMIN_PASSWORD, e.g.\n" +
                "  ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='secret' npm run create-user"
        );
        process.exit(1);
    }
    if (password.length < 8) {
        console.error("ADMIN_PASSWORD must be at least 8 characters.");
        process.exit(1);
    }

    // Warn if other accounts somehow exist — this app is meant for exactly one.
    const { data: others } = await supabase
        .from("users")
        .select("email")
        .neq("email", email);

    if (others && others.length) {
        console.warn(
            `! Note: ${others.length} other account(s) already exist: ` +
                others.map((u) => u.email).join(", ")
        );
    }

    const password_hash = await hashPassword(password);

    const { data: existing } = await supabase
        .from("users")
        .select("id")
        .eq("email", email)
        .maybeSingle();

    if (existing) {
        const { error } = await supabase
            .from("users")
            .update({ password_hash })
            .eq("id", existing.id);

        if (error) {
            throw error;
        }
        console.log(`✓ Updated password for ${email}`);
    } else {
        const { error } = await supabase
            .from("users")
            .insert({ email, password_hash });

        if (error) {
            throw error;
        }
        console.log(`✓ Created account ${email}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
