import express from "express";
import type { Server } from "node:http";

export function startHealthServer(isDiscordReady: () => boolean): Server {
  const app = express();
  app.disable("x-powered-by");

  app.get("/", (_request, response) => {
    response
      .type("text/plain")
      .send("Discord Voice Bot is running. Monitor /health for status.");
  });

  app.get("/health", (_request, response) => {
    const discordReady = isDiscordReady();
    response.status(discordReady ? 200 : 503).json({
      status: discordReady ? "ok" : "starting",
      service: "discord-voice-bot",
      discord: discordReady ? "connected" : "connecting",
    });
  });

  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid HTTP server port: ${process.env.PORT}`);
  }

  const server = app.listen(port, "0.0.0.0", () => {
    console.info(`Health web server listening on port ${port}.`);
  });
  server.on("error", (error) => {
    console.error("Health web server error:", error);
  });

  return server;
}
