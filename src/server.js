// src/server.js
import app from "./app.js";
import { config } from "./config.js";

app.listen(config.port, () => {
  console.log(`Image gallery listening on port ${config.port}`);
});