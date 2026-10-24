import "dotenv/config";
import { handle } from "hono/vercel";
import { createApp } from "../src/app.js";

const { app } = await createApp();

const handler = handle(app);
export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
export const HEAD = handler;
