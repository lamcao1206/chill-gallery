import { createClient } from "@supabase/supabase-js";

import { config } from "../config.js";

// Server-side client authenticated with the Supabase SECRET key
// (sb_secret_...). supabase-js sends it as the apikey / bearer token, which
// bypasses RLS. This key must NEVER be shipped to the browser.
export const supabase = createClient(
    config.supabase.url,
    config.supabase.secretKey,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    }
);
