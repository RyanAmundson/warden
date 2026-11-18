import { greet } from "@lib/greet";

export const run = (name: string | undefined): number => name.length + greet("x").length;
